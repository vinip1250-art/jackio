import pLimit from 'p-limit';
import { parseWords, numberPad, sortBy, bytesToSize, wait, promiseTimeout } from './util.js';
import config from './config.js';
import cache from './cache.js';
import { updateUserConfigWithMediaFlowIp, applyMediaflowProxyIfNeeded } from './mediaflowProxy.js';
import * as meta from './meta.js';
import * as jackett from './jackett.js';
import * as debrid from './debrid.js';
import * as torrentInfos from './torrentInfos.js';

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
  const [id, season, episode] = stremioId.split(':');
  return { id, season: Number(season || 0), episode: Number(episode || 0) };
}

async function getMetaInfos(type, stremioId, language) {
  const { id, season, episode } = parseStremioId(stremioId);
  if (type === 'movie') return meta.getMovieById(id, language);
  if (type === 'series') return meta.getEpisodeById(id, season, episode, language);
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

// Regex dos grupos PT-BR — aplicada apenas para torrents do indexador StremThru
const PT_GROUPS_REGEX = /brremux|-cza|c0ral|-cory|cypher|-tars|freddiegellar|sgf|asc|alfahd|kallango|-lcd|dual-bioma|dual-c76|-ff|-fly|anitsu|potatin|vinci|gueira|tossato|7sprit7|c\.a\.a|cbr|-nogroup|dual-brpny|-pia|-xor|g4ris|sigma|andrehsa|riper|sigla|sh4down|gjumandi|silveira|tontom|eck|arcanjo|bj-share|epik|gusta|crime|maestro|ingram|hdtv-br|bdrip-br|batata|cinefoot|savana|coala|nyne|hmax/i;

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
      indexerTimeoutSec = 10,
      languages = [],
      indexers: userIndexers,
      debug
    } = userConfig;

    languages = normalizeLanguages(languages);

    const filterSearch = t => {
      if (!qualities.includes(t.quality)) return false;
      const words = parseWords(t.name.toLowerCase());
      if (excludeKeywords.find(w => words.includes(w))) return false;

      if (type === 'series') {
        const nameUpper = t.name.toUpperCase();
        const sMatch = nameUpper.match(/S(\d{1,2})/);
        if (sMatch) {
          const fileSeason = parseInt(sMatch[1]);
          if (fileSeason !== season) return false;
        }
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
      .filter(i => i.searching[type].available && (userIndexers.includes('all') || userIndexers.includes(i.id)));

    let torrents = [];

    if (type === 'movie') {
      torrents = (await Promise.all(
        indexers.map(i =>
          promiseTimeout(
            jackett.searchMovieTorrents({ ...metaInfos, indexer: i.id }),
            indexerTimeoutSec * 1000
          ).catch(() => [])
        )
      )).flat();
    } else {
      torrents = (await Promise.all(
        indexers.map(i =>
          promiseTimeout(
            jackett.searchEpisodeTorrents({ ...metaInfos, indexer: i.id }),
            indexerTimeoutSec * 1000
          ).catch(() => [])
        )
      )).flat();
    }

    torrents = torrents
      .filter(filterSearch)
      .filter(t => {
        const indexer = (t.indexerName || t.indexerId || t.indexer || '').toLowerCase().trim();
        console.log(`[INDEXER_ID] "${indexer}" | ${t.name?.slice(0, 60)}`); 
        const isStremThru = indexer.includes('stremthru');
        if (isStremThru) {
          return PT_GROUPS_REGEX.test(t.name || '');
        }
        return true;
      })
      .sort(sortBy('seeders', true));

    console.log(`[DEBUG] após filtros: ${torrents.length}`);

    torrents = reorderByLanguage(torrents, languages, debug)
      .slice(0, maxTorrents + 3);

    const limit = pLimit(5);
    torrents = (await Promise.all(
      torrents.map(t => limit(async () => {
        try {
          t.infos = await promiseTimeout(torrentInfos.get(t), 30_000);
          return t;
        } catch {
          return null;
        }
      }))
    )).filter(Boolean);

    if (debridInstance) {
      const cached = (await debridInstance.getTorrentsCached(
        torrents.filter(t => t.infos?.infoHash)
      )).map(t => ({ ...t, isCached: true }));

      let uncached = torrents.filter(t => {
        const isCached = cached.find(c => c.id === t.id || c.id === `rd:${t.id}` || c.id === `tb:${t.id}`);
        if (isCached) return false;
        return (t.seeders || 0) >= MIN_SEEDS_UNCACHED;
      });

      if (debridInstance.constructor.id === 'hybrid') {
        const rdUncached = uncached.map(t => ({
          ...t,
          id: `rd:${t.id}`,
          shortName: 'RD',
          name: `[RD] ${t.name}`
        }));
        const tbUncached = uncached.map(t => ({
          ...t,
          id: `tb:${t.id}`,
          shortName: 'TB',
          name: `[TB] ${t.name}`
        }));
        uncached = [...rdUncached, ...tbUncached];
      }

      torrents = [
        ...reorderByLanguage(cached.sort(sortBy(...sortCached)), languages, debug),
        ...reorderByLanguage(uncached.sort(sortBy(...sortUncached)), languages, debug)
      ].slice(0, maxTorrents);
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

  let cleanId = torrentId.includes(':') && (torrentId.startsWith('rd:') || torrentId.startsWith('tb:'))
    ? torrentId.split(':').slice(1).join(':')
    : torrentId;

  const infos = await torrentInfos.getById(cleanId);
  const { season, episode } = parseStremioId(stremioId);

  const cacheKey = `download:${await debridInstance.getUserHash()}:${stremioId}:${torrentId}`;
  let download = await cache.get(cacheKey);
  if (download) return download;

  // === LÓGICA DE ROTEAMENTO E UPLOAD DE .TORRENT ===
  let files;
  const isHybrid = debridInstance.constructor.id === 'hybrid';

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
