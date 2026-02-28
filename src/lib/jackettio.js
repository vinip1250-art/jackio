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
const PT_GROUPS_REGEX = /brremux|cza|freddiegellar|sgf|asc|dual-bioma|dual-c76|fly|tossato|7sprit7|c\.a\.a|c0ral|cbr|dual-nogroup|dual-pia|xor|g4ris|sigma|andrehsa|riper|sigla|sh4down|gjumandi|silveira|tontom|eck|arcanjo|hurtom|bj-share|epik|gusta|crime|universal|maestro|bludv|ingram|dublado|nacional|hdtv-br|bdrip-br|batata|cinefoot|savana|coala|nyne|hmax/i;

// Seeds mínimos para exibir torrents não cacheados
const MIN_SEEDS_UNCACHED = 2;

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
        const isStremThru = indexer.includes('stremthru');
        if (isStremThru) {
          return PT_GROUPS_REGEX.test(t.name || '');
        }
        return true;
      })
      .sort(sortBy('seeders', true));

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
        const notCached = !cached.find(c => c.id === t.id || c.id === `rd:${t.id}` || c.id === `tb:${t.id}`);
        if (!notCached) return false;

        // Bloqueia torrents privados — TorBox não consegue baixar sem credenciais do tracker
        const isPrivate = t.type === 'private' || t.infos?.private === true;
        if (isPrivate) return false;

        // Exige seeds mínimos para não travar o TorBox tentando torrents mortos
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

  let files;
  const isHybrid = debridInstance.constructor.id === 'hybrid';
  
  const getFilesForService = async (serviceInstance) => {
    // CORREÇÃO: Prioriza magnetUrl real antes de tentar baixar .torrent
    // O magnetUrl do Prowlarr é uma URL HTTP, não um magnet real — verificamos isso em getFilesFromMagnet
    if (infos.magnetUrl && infos.magnetUrl.startsWith('magnet:')) {
        console.log(`[jackettio] Usando magnetUrl real: ${infos.magnetUrl.slice(0, 60)}...`);
        return await serviceInstance.getFilesFromMagnet(infos.magnetUrl, infos.infoHash);
    }

    // Tenta baixar o arquivo .torrent via link HTTP
    if (infos.link && !infos.link.startsWith('magnet:')) {
        try {
            console.log(`Baixando .torrent de: ${infos.link}`);
            const response = await fetch(infos.link);
            if (response.ok) {
                const buffer = await response.arrayBuffer();
                return await serviceInstance.getFilesFromBuffer(Buffer.from(buffer), infos.infoHash);
            }
        } catch(e) {
            console.error('Falha ao baixar .torrent, fallback para magnet:', e.message);
        }
    }

    // Fallback: usa magnetUrl (mesmo que seja URL HTTP — getFilesFromMagnet trata isso)
    if (infos.magnetUrl) {
        return await serviceInstance.getFilesFromMagnet(infos.magnetUrl, infos.infoHash);
    } else {
        return await serviceInstance.getFilesFromHash(infos.infoHash);
    }
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
