import pLimit from 'p-limit';
import { parseWords, numberPad, sortBy, bytesToSize, wait, promiseTimeout } from './util.js';
import config from './config.js';
import cache from './cache.js';
import { updateUserConfigWithMediaFlowIp, applyMediaflowProxyIfNeeded } from './mediaflowProxy.js';
import * as meta from './meta.js';
import * as jackett from './jackett.js';
import * as debrid from './debrid.js';
import * as torrentInfos from './torrentInfos.js';

// ... (código anterior de idiomas e torrents permanece igual, pulei para economizar espaço) ...
// ... (Copie a parte de cima do arquivo anterior até chegar em getDownload) ...

/* =========================================================
 * IDIOMA – DETECÇÃO, PRIORIZAÇÃO E DEBUG
 * ======================================================= */

const PTBR_KEYWORDS = [
  'pt-br', 'ptbr', 'portuguese', 'português',
  'brazilian', 'brasileiro', 'brasil',
  'dublado', 'nacional', 'por', 'pob',
  'multi-audio', 'multi audio', 'dual audio'
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

/* =========================================================
 * TORRENTS
 * ======================================================= */

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
      indexerTimeoutSec = 4,
      languages = [],
      indexers: userIndexers,
      debug
    } = userConfig;

    languages = normalizeLanguages(languages);

    const filterSearch = t => {
      if (!qualities.includes(t.quality)) return false;
      const words = parseWords(t.name.toLowerCase());
      if (excludeKeywords.find(w => words.includes(w))) return false;
      return !t.year || t.year === year;
    };

    let indexers = (await jackett.getIndexers())
      .filter(i => i.searching[type].available && (userIndexers.includes('all') || userIndexers.includes(i.id)));

    if (debug) {
      console.log(`[INDEXERS] ${indexers.map(i => i.title).join(', ')}`);
    }

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

    torrents = torrents.filter(filterSearch).sort(sortBy('seeders', true));

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

      let uncached = torrents.filter(t => !cached.find(c => c.id === t.id));
      
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

/* =========================================================
 * DOWNLOAD (Correção Aplicada AQUI)
 * ======================================================= */

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
  
  // Função auxiliar para baixar buffer ou magnet
  const getFilesForService = async (serviceInstance) => {
    // 1. Tenta baixar o arquivo .torrent se existir link e não for magnet
    if (infos.link && !infos.link.startsWith('magnet:')) {
        try {
            console.log(`Baixando .torrent de: ${infos.link}`);
            const response = await fetch(infos.link);
            if (response.ok) {
                const buffer = await response.arrayBuffer();
                // Passa o buffer para o debrid (Torbox agora suporta isso)
                return await serviceInstance.getFilesFromBuffer(Buffer.from(buffer), infos.infoHash);
            }
        } catch(e) {
            console.error('Falha ao baixar .torrent, fallback para magnet:', e.message);
        }
    }
    
    // 2. Fallback: Usa Magnet
    if (infos.magnetUrl) {
        return await serviceInstance.getFilesFromMagnet(infos.magnetUrl, infos.infoHash);
    } else {
        return await serviceInstance.getFilesFromHash(infos.infoHash);
    }
  };

  if (isHybrid && torrentId.startsWith('tb:')) {
      // Torbox via Hybrid
      files = await getFilesForService(debridInstance.tb);
      files = files.map(f => ({...f, id: `tb:${f.id}`}));
  } 
  else if (isHybrid && torrentId.startsWith('rd:')) {
      // Real-Debrid via Hybrid
      files = await getFilesForService(debridInstance.rd);
      files = files.map(f => ({...f, id: `rd:${f.id}`}));
  } 
  else {
      // Single Instance (Só Torbox ou Só RD)
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
