import pLimit from 'p-limit';
import { parseWords, numberPad, sortBy, bytesToSize, wait, promiseTimeout } from './util.js';
import config from './config.js';
import cache from './cache.js';
import { updateUserConfigWithMediaFlowIp, applyMediaflowProxyIfNeeded } from './mediaflowProxy.js';
import * as meta from './meta.js';
import Kitsu from './meta/kitsu.js';
import * as jackett from './jackett.js';
import * as debrid from './debrid.js';
import * as torrentInfos from './torrentInfos.js';

const kitsuClient = new Kitsu();

const PTBR_KEYWORDS = [
  'pt-br', 'ptbr', 'portuguese', 'português',
  'brazilian', 'brasileiro', 'brasil',
  'dublado', 'nacional', 'por', 'pob',
  'multi-audio', 'multi audio', 'dual audio' , 
  'dual-bioma' , 'dual-c76' , 'andrehsa'
];

function normalizeLanguages(langs) {
  if (!Array.isArray(langs)) return [];
  return langs.map(l => String(l).toLowerCase());
}

function detectPtBr(torrent) {
  const name = (torrent.name || '').toLowerCase();
  return PTBR_KEYWORDS.some(k => name.includes(k));
}

function detectMulti(torrent) {
  return torrent.languages?.some(l => l.value === 'multi')
    || /multi/.test((torrent.name || '').toLowerCase());
}

function languageScore(torrent, preferredLangs) {
  if (detectPtBr(torrent)) return 3;
  if (detectMulti(torrent)) return 2;
  if (torrent.languages?.some(l => preferredLangs.includes(l.value))) return 1;
  return 0;
}

function reorderByLanguage(torrents, preferredLangs, debug = false) {
  const scored = torrents.map(t => {
    const score = languageScore(t, preferredLangs);
    if (debug) {
      console.log(
        `[LANG] ${t.name?.slice(0, 80)} | score=${score} | langs=${(t.languages || []).map(l => l.value).join(',')}`
      );
    }
    return { t, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .map(o => o.t);
}

const actionInProgress = {
  getTorrents: {},
  getDownload: {}
};

function parseStremioId(stremioId) {
  // Kitsu IDs: "kitsu:12345:6" (animeId:episodioAbsoluto) ou "kitsu:12345" (filme/OVA)
  if (stremioId.startsWith('kitsu:')) {
    const parts = stremioId.split(':');
    const id = `kitsu:${parts[1]}`;
    // Kitsu usa numeração absoluta — sem temporada separada
    // parts[2] pode ser episódio absoluto ou temporada dependendo do cliente Stremio
    // Tratamos parts[2] como episódio absoluto e season=1 por padrão
    const episode = Number(parts[2] || 0);
    const season = Number(parts[3] || 1); // alguns clientes enviam season em parts[3]
    return { id, season, episode, isKitsu: true };
  }
  const [id, season, episode] = stremioId.split(':');
  return { id, season: Number(season || 0), episode: Number(episode || 0), isKitsu: false };
}

async function getMetaInfos(type, stremioId, language) {
  const parsed = parseStremioId(stremioId);
  const { id, season, episode, isKitsu } = parsed;

  // Kitsu: chama diretamente, sem passar por meta.js
  if (isKitsu) {
    const info = await kitsuClient.getEpisodeById(id, season, episode);
    return { ...info, isKitsu: true, episode, season };
  }

  const resolvedType = type === 'anime' ? 'series' : type;
  if (resolvedType === 'movie') return { ...await meta.getMovieById(id, language), isKitsu: false };
  if (resolvedType === 'series') return { ...await meta.getEpisodeById(id, season, episode, language), isKitsu: false };
  throw new Error(`Unsupported type ${type}`);
}

async function mergeDefaultUserConfig(userConfig) {
  config.immulatableUserConfigKeys.forEach(k => delete userConfig[k]);
  userConfig = Object.assign({}, config.defaultUserConfig, userConfig);
  return updateUserConfigWithMediaFlowIp(userConfig);
}

function searchEpisodeFile(files, season, episode) {
  return files.find(f => f.name.includes(`S${numberPad(season,2)}E${numberPad(episode,2)}`))
    || files[0];
}

// Seeds mínimos para exibir torrents não cacheados
const MIN_SEEDS_UNCACHED = 1;

/**
 * Extrai o infoHash real de um buffer de arquivo .torrent.
 * O infoHash é o SHA1 do value bencoded da chave "info" do dicionário raiz.
 */
async function extractInfoHashFromBuffer(buffer) {
  try {
    const { createHash } = await import('crypto');

    // Bencode parser mínimo para localizar o value da chave "info"
    // Formato: d...4:info<bencode_value>...e
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const str = buf.toString('binary');

    // Localiza "4:info" seguido do valor bencoded
    const infoKey = '4:info';
    const idx = str.indexOf(infoKey);
    if (idx === -1) return null;

    const infoStart = idx + infoKey.length;

    // Encontra o fim do value bencoded da chave info
    // Precisa parsear o tamanho correto do bencode a partir de infoStart
    const infoEnd = findBencodeEnd(buf, infoStart);
    if (infoEnd === -1) return null;

    const infoSlice = buf.slice(infoStart, infoEnd);
    const hash = createHash('sha1').update(infoSlice).digest('hex');
    return hash;
  } catch (e) {
    console.error('[jackettio] Falha ao extrair infoHash do buffer:', e.message);
    return null;
  }
}

/**
 * Encontra o índice de fim de um valor bencoded começando em `start`.
 * Retorna o índice exclusivo (após o último byte do valor).
 */
function findBencodeEnd(buf, start) {
  try {
    const ch = String.fromCharCode(buf[start]);

    if (ch === 'd') {
      // Dicionário: d...e
      let i = start + 1;
      while (i < buf.length && buf[i] !== 0x65 /* 'e' */) {
        const keyEnd = findBencodeEnd(buf, i);
        if (keyEnd === -1) return -1;
        const valEnd = findBencodeEnd(buf, keyEnd);
        if (valEnd === -1) return -1;
        i = valEnd;
      }
      return i + 1; // skip 'e'
    }

    if (ch === 'l') {
      // Lista: l...e
      let i = start + 1;
      while (i < buf.length && buf[i] !== 0x65 /* 'e' */) {
        const end = findBencodeEnd(buf, i);
        if (end === -1) return -1;
        i = end;
      }
      return i + 1;
    }

    if (ch === 'i') {
      // Inteiro: i<digits>e
      const end = buf.indexOf(0x65 /* 'e' */, start + 1);
      return end === -1 ? -1 : end + 1;
    }

    if (ch >= '0' && ch <= '9') {
      // String: <len>:<data>
      const colon = buf.indexOf(0x3a /* ':' */, start);
      if (colon === -1) return -1;
      const len = parseInt(buf.slice(start, colon).toString('ascii'), 10);
      return colon + 1 + len;
    }

    return -1;
  } catch {
    return -1;
  }
}

async function getTorrents(userConfig, metaInfos, debridInstance) {
  const { stremioId, type, season, episode, year } = metaInfos;

  while (actionInProgress.getTorrents[stremioId]) {
    await wait(300);
  }
  actionInProgress.getTorrents[stremioId] = true;

  try {
    let {
      qualities,
      excludeKeywords,
      maxTorrents,
      sortCached,
      sortUncached,
      indexerTimeoutSec = 5,
      languages = [],
      indexers: userIndexers,
      hideUncached,
      debug
    } = userConfig;

    languages = normalizeLanguages(languages);

    const isAnime = type === 'anime' || metaInfos.isKitsu;
    const searchType = isAnime ? 'series' : type;

    const filterSearch = t => {
      if (!qualities.includes(t.quality)) return false;
      const words = parseWords(t.name.toLowerCase());
      if (excludeKeywords.find(w => words.includes(w))) return false;

      if (searchType === 'series' && episode > 0) {
        const nameUpper = t.name.toUpperCase();

        // Verifica padrão SxxExx (usado por séries normais e animes do Nyaa)
        const sMatch = nameUpper.match(/S(\d{1,2})E(\d{1,4})(?:-?E?(\d{1,4}))?/);
        if (sMatch) {
          const fileEpStart = parseInt(sMatch[2]);
          const fileEpEnd = sMatch[3] ? parseInt(sMatch[3]) : fileEpStart;
          if (episode < fileEpStart || episode > fileEpEnd) return false;
          if (!isAnime) {
            // Para séries normais, também valida a temporada
            const fileSeason = parseInt(sMatch[1]);
            if (fileSeason !== season) return false;
          }
          return !t.year || t.year === year;
        }

        // Sem SxxExx: para anime tenta numeração absoluta (ex: " - 09 " ou "[09]")
        if (isAnime) {
          const absMatch = nameUpper.match(/(?:^|\s|-|\[)0*(\d{1,4})(?:\s|-|\]|$)/g);
          if (absMatch) {
            const nums = absMatch.map(m => parseInt(m.replace(/\D/g, '')));
            if (!nums.includes(episode)) return false;
          }
          return !t.year || t.year === year;
        }

        // Série normal sem SxxExx: filtra por episódio sozinho
        const eMatch = nameUpper.match(/E(\d{1,4})(?:-?E?(\d{1,4}))?/);
        if (eMatch) {
          const fileEpStart = parseInt(eMatch[1]);
          const fileEpEnd = eMatch[2] ? parseInt(eMatch[2]) : fileEpStart;
          if (episode < fileEpStart || episode > fileEpEnd) return false;
        }
      }

      return !t.year || t.year === year;
    };

    let indexers = (await jackett.getIndexers())
      .filter(i => i.searching[searchType]?.available && (userIndexers.includes('all') || userIndexers.includes(i.id)));

    console.log(`[${stremioId}] type=${type} indexers=${indexers.length} name="${metaInfos.name}"${episode ? ` ep=S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : ''}`);

    let torrents = [];

    if (searchType === 'movie') {
      torrents = (await Promise.all(
        indexers.map(i =>
          promiseTimeout(
            jackett.searchMovieTorrents({ ...metaInfos, indexer: i.id }),
            indexerTimeoutSec * 1000
          ).catch(() => [])
        )
      )).flat();
    } else {
      const searches = isAnime
        ? indexers.map(i =>
            promiseTimeout(
              jackett.searchSerieTorrents({ ...metaInfos, indexer: i.id }),
              indexerTimeoutSec * 1000
            ).catch(() => [])
          )
        : indexers.map(i =>
            promiseTimeout(
              jackett.searchEpisodeTorrents({ ...metaInfos, indexer: i.id }),
              indexerTimeoutSec * 1000
            ).catch(() => [])
          );

      torrents = (await Promise.all(searches)).flat();
    }

    torrents = torrents
      .filter(filterSearch)
      .sort(sortBy('seeders', true));

    torrents = reorderByLanguage(torrents, languages, debug)
      .slice(0, maxTorrents + 3);

    const t0Infos = Date.now();
    const limit = pLimit(5);
    torrents = (await Promise.all(
      torrents.map(t => limit(async () => {
        try {
          t.infos = await promiseTimeout(torrentInfos.get(t), 30_000);
          return t;
        } catch(e) {
          return null;
        }
      }))
    )).filter(Boolean);
    console.log(`[${stremioId}] torrentInfos: ${torrents.length} em ${Date.now()-t0Infos}ms | sem hash: ${torrents.filter(t => !t.infos?.infoHash).length}`);

    if (debridInstance) {
      const torrentsWithHash = torrents.filter(t => t.infos?.infoHash);

      const imdbId = metaInfos.id?.startsWith('tt') ? metaInfos.id : null;
      const cacheQ = (searchType === 'series' && episode > 0)
        ? `${metaInfos.name} S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`
        : metaInfos.name;

      const t0Cache = Date.now();
      const [cacheSourceHashes, cachedFromDebrid] = await Promise.all([
        jackett.searchCacheSources({ q: cacheQ, imdbId }),
        debridInstance.getTorrentsCached(torrentsWithHash)
      ]);

      const debridCachedIds    = new Set(cachedFromDebrid.map(t => t.id));
      const debridCachedHashes = new Set(cachedFromDebrid.map(t => (t.infos?.infoHash || t.infoHash || '').toLowerCase()).filter(Boolean));

      // Log de diagnóstico: mostra os hashes dos torrents vs amostra dos hashes torznab
      if (cacheSourceHashes.size > 0) {
        const torrentHashes = torrentsWithHash.map(t => (t.infos?.infoHash || '').toLowerCase()).filter(Boolean);
        const sample = [...cacheSourceHashes].slice(0, 3);
        console.log(`[${stremioId}] hash check | torrents=[${torrentHashes.slice(0,2).join(', ')}] | torznab sample=[${sample.join(', ')}]`);
      }

      const cached = torrentsWithHash
        .filter(t => {
          const hash = (t.infos?.infoHash || '').toLowerCase();
          const inDebrid  = debridCachedIds.has(t.id) || debridCachedIds.has(`rd:${t.id}`) || debridCachedIds.has(`tb:${t.id}`)
                         || (hash && debridCachedHashes.has(hash));
          const inSources = hash && cacheSourceHashes.has(hash);
          return inDebrid || inSources;
        })
        .map(t => ({ ...t, isCached: true }));

      const viaSourceOnly = cached.filter(t => {
        const hash = (t.infos?.infoHash || '').toLowerCase();
        return hash && cacheSourceHashes.has(hash) && !debridCachedHashes.has(hash) && !debridCachedIds.has(t.id);
      }).length;

      let uncached = torrents.filter(t => {
        const isCached = cached.find(c => c.id === t.id || c.id === `rd:${t.id}` || c.id === `tb:${t.id}`);
        if (isCached) return false;
        return (t.seeders || 0) >= MIN_SEEDS_UNCACHED;
      });

      if (debridInstance.constructor.id === 'hybrid') {
        const rdUncached = uncached.map(t => ({ ...t, id: `rd:${t.id}`, shortName: 'RD', name: `[RD] ${t.name}` }));
        const tbUncached = uncached.map(t => ({ ...t, id: `tb:${t.id}`, shortName: 'TB', name: `[TB] ${t.name}` }));
        uncached = [...rdUncached, ...tbUncached];
      } else if (debridInstance.constructor.id === 'hybridoc') {
        const tbUncached = uncached.map(t => ({ ...t, id: `tb:${t.id}`, shortName: 'TB', name: `[TB] ${t.name}` }));
        const ocUncached = uncached.map(t => ({ ...t, id: `oc:${t.id}`, shortName: 'OC', name: `[OC] ${t.name}` }));
        uncached = [...tbUncached, ...ocUncached];
      }

      if (hideUncached) uncached = [];

      torrents = [
        ...reorderByLanguage(cached.sort(sortBy(...sortCached)), languages, debug),
        ...reorderByLanguage(uncached.sort(sortBy(...sortUncached)), languages, debug)
      ].slice(0, maxTorrents);

      console.log(`[${stremioId}] cache ${Date.now()-t0Cache}ms | cached=${cached.length} (debrid=${cached.length - viaSourceOnly} torznab=${viaSourceOnly}) uncached=${uncached.length} | final=${torrents.length}`);
    }

    return torrents;

  } finally {
    delete actionInProgress.getTorrents[stremioId];
  }
}

function getFile(files, type, season, episode) {
  files = files.sort(sortBy('size', true));
  return type === 'movie'
    ? files[0]
    : searchEpisodeFile(files, season, episode);
}

export async function getStreams(userConfig, type, stremioId, publicUrl) {
  userConfig = await mergeDefaultUserConfig(userConfig);
  const { season, episode } = parseStremioId(stremioId);
  const debridInstance = debrid.instance(userConfig);

  const metaInfos = await getMetaInfos(type, stremioId, userConfig.metaLanguage);
  const torrents = await getTorrents(userConfig, metaInfos, debridInstance);

  return torrents.map(t => {
    const file = getFile(t.infos.files || [], type, season, episode) || {};
    const size = bytesToSize(file.size || t.size);
    const seeds = t.seeders || 0;

    const isZip = /\.(zip|rar|7z)$/i.test(file.name || t.name);
    const sizeStr = isZip ? `📦 ${size}` : `📂 ${size}`;

    const langFlag = detectPtBr(t) ? '🇧🇷' : detectMulti(t) ? '🌐' : '';

    const col1 = `${sizeStr} | 👤 ${seeds}`;
    const col2 = `⚙️ ${t.indexerName || t.indexerId} ${langFlag}`;
    const col3 = file.name || t.name;

    // Para hybrid, o shortName já está definido por torrent (TB/OC/RD).
    // Para serviço simples, usa o shortName da instância.
    const service = t.shortName || debridInstance.shortName;
    const cacheSign = t.isCached ? '⚡' : '';

    return {
      name: `[${service}${cacheSign}] Jackio`,
      title: [col1, col2, col3].join('\n'),
      url: t.disabled
        ? '#'
        : `${publicUrl}/${btoa(JSON.stringify(userConfig))}/download/${type}/${stremioId}/${t.id}/${file.name || t.name}`
    };
  });
}

export async function getDownload(userConfig, type, stremioId, torrentId) {
  userConfig = await mergeDefaultUserConfig(userConfig);
  const debridInstance = debrid.instance(userConfig);

  let cleanId = torrentId.includes(':') && (torrentId.startsWith('rd:') || torrentId.startsWith('tb:') || torrentId.startsWith('oc:'))
    ? torrentId.split(':').slice(1).join(':')
    : torrentId;

  const infos = await torrentInfos.getById(cleanId);
  const { season, episode } = parseStremioId(stremioId);

  const cacheKey = `download:${await debridInstance.getUserHash()}:${stremioId}:${torrentId}`;
  let download = await cache.get(cacheKey);
  if (download) return download;

  // === LÓGICA DE ROTEAMENTO E UPLOAD DE .TORRENT ===
  let files;
  const isHybrid   = debridInstance.constructor.id === 'hybrid';
  const isHybridOC = debridInstance.constructor.id === 'hybridoc';

  /**
   * Tenta obter os arquivos do torrent para um serviço debrid.
   *
   * Estratégia em cascata:
   *   1. Baixar o .torrent via HTTP e fazer upload do buffer
   *      → extrai o infoHash real do buffer para enriquecer o magnetUrl fallback
   *   2. Se o download/upload falhar, usar o magnetUrl original do Jackett
   *      (que já contém o infoHash correto no xt=urn:btih)
   *   3. Se não houver magnetUrl, construir magnet a partir do infoHash do torrentInfos
   */
  const getFilesForService = async (serviceInstance) => {
    // --- Tentativa 1: baixar e fazer upload do arquivo .torrent ---
    if (infos.link && !infos.link.startsWith('magnet:')) {
      try {
        console.log(`[jackettio] Baixando .torrent de: ${infos.link}`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);

        const response = await fetch(infos.link, { signal: controller.signal });
        clearTimeout(timeout);

        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          const buffer = Buffer.from(await response.arrayBuffer());

          // Valida que é realmente um arquivo .torrent (começa com 'd' em bencode)
          const isTorrentFile = contentType.includes('torrent')
            || contentType.includes('octet-stream')
            || buffer[0] === 0x64; // 'd' em ASCII

          if (isTorrentFile && buffer.length > 50) {
            console.log(`[jackettio] .torrent baixado (${buffer.length} bytes), fazendo upload...`);

            // Extrai o infoHash real do buffer para usar como fallback
            const realHash = await extractInfoHashFromBuffer(buffer);
            if (realHash) {
              console.log(`[jackettio] infoHash extraído do .torrent: ${realHash}`);
              infos.realInfoHash = realHash;
            }

            return await serviceInstance.getFilesFromBuffer(buffer, realHash || infos.infoHash);
          } else {
            console.warn(`[jackettio] Resposta não é .torrent (content-type: ${contentType}, bytes: ${buffer.length}), pulando upload.`);
          }
        } else {
          console.warn(`[jackettio] HTTP ${response.status} ao baixar .torrent, usando fallback.`);
        }
      } catch (e) {
        console.error(`[jackettio] Falha ao baixar/upload .torrent: ${e.message}`);
      }
    }

    // --- Tentativa 2: usar o magnetUrl original do Jackett/Prowlarr ---
    // O magnetUrl do Jackett já tem o infoHash correto no xt=urn:btih
    const magnetUrl = infos.magnetUrl || infos.magnet;
    if (magnetUrl && magnetUrl.startsWith('magnet:')) {
      console.log(`[jackettio] Usando magnetUrl original: ${magnetUrl.slice(0, 80)}...`);
      // Extrai o hash do próprio magnet para log/debug
      const hashFromMagnet = magnetUrl.match(/xt=urn:btih:([a-fA-F0-9]{40})/i)?.[1];
      if (hashFromMagnet) {
        console.log(`[jackettio] infoHash do magnetUrl: ${hashFromMagnet}`);
      }
      return await serviceInstance.getFilesFromMagnet(magnetUrl, hashFromMagnet || infos.infoHash);
    }

    // --- Tentativa 3: construir magnet a partir do infoHash ---
    const hashToUse = infos.realInfoHash || infos.infoHash;
    if (hashToUse) {
      console.log(`[jackettio] Construindo magnet a partir do infoHash: ${hashToUse}`);
      return await serviceInstance.getFilesFromHash(hashToUse);
    }

    throw new Error(`[jackettio] Sem link, magnetUrl ou infoHash disponível para o torrent.`);
  };

  if (isHybrid && torrentId.startsWith('tb:')) {
    files = await getFilesForService(debridInstance.tb);
    files = files.map(f => ({...f, id: `tb:${f.id}`}));
  }
  else if (isHybrid && torrentId.startsWith('rd:')) {
    files = await getFilesForService(debridInstance.rd);
    files = files.map(f => ({...f, id: `rd:${f.id}`}));
  }
  else if (isHybridOC && torrentId.startsWith('tb:')) {
    files = await getFilesForService(debridInstance.tb);
    files = files.map(f => ({...f, id: `tb:${f.id}`}));
  }
  else if (isHybridOC && torrentId.startsWith('oc:')) {
    files = await getFilesForService(debridInstance.oc);
    files = files.map(f => ({...f, id: `oc:${f.id}`}));
  }
  else {
    files = await getFilesForService(debridInstance);
  }

  download = await debridInstance.getDownload(
    getFile(files, type, season, episode)
  );

  if (!download) throw new Error('No download');

  download = applyMediaflowProxyIfNeeded(download, userConfig);
  await cache.set(cacheKey, download, { ttl: 3600 });

  return download;
}
