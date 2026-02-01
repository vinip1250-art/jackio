import pLimit from 'p-limit';
import {
  parseWords,
  numberPad,
  sortBy,
  bytesToSize,
  wait,
  promiseTimeout
} from './util.js';

import config from './config.js';
import cache from './cache.js';
import { updateUserConfigWithMediaFlowIp, applyMediaflowProxyIfNeeded } from './mediaflowProxy.js';
import * as meta from './meta.js';
import * as jackett from './jackett.js';
import * as debrid from './debrid.js';
import * as torrentInfos from './torrentInfos.js';

/* =========================================================
 * IDIOMA – PRIORIZAÇÃO (UPSTREAM-SAFE)
 * ======================================================= */

function hasLanguage(torrent, langs) {
  return torrent.languages?.some(l => langs.includes(l.value));
}

function reorderByLanguage(torrents, preferredLangs) {
  if (!preferredLangs || !preferredLangs.length) return torrents;

  const primary = [];
  const fallback = [];
  const others = [];

  for (const t of torrents) {
    if (hasLanguage(t, preferredLangs)) {
      primary.push(t);
    } else if (hasLanguage(t, ['multi'])) {
      fallback.push(t);
    } else {
      others.push(t);
    }
  }

  return [...primary, ...fallback, ...others];
}

/* ========================================================= */

const slowIndexers = {};
const actionInProgress = { getTorrents: {}, getDownload: {} };

function parseStremioId(stremioId) {
  const [id, season, episode] = stremioId.split(':');
  return {
    id,
    season: parseInt(season || 0),
    episode: parseInt(episode || 0)
  };
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
  return (
    files.find(f => f.name.includes(`S${numberPad(season, 2)}E${numberPad(episode, 3)}`)) ||
    files.find(f => f.name.includes(`S${numberPad(season, 2)}E${numberPad(episode, 2)}`)) ||
    files.find(f => f.name.includes(`${season}${numberPad(episode, 2)}`)) ||
    files.find(f => f.name.includes(`${numberPad(episode, 2)}`)) ||
    false
  );
}

async function timeoutIndexerSearch(indexerId, promise, timeout) {
  const start = Date.now();
  const res = await promiseTimeout(promise, timeout).catch(() => []);
  const duration = Date.now() - start;

  if (timeout > config.slowIndexerDuration) {
    slowIndexers[indexerId] ||= [];
    if (duration > config.slowIndexerDuration) {
      slowIndexers[indexerId].push({ duration, date: new Date() });
    } else {
      slowIndexers[indexerId] = [];
    }
  }
  return res;
}

/* =========================================================
 * BUSCA DE TORRENTS
 * ======================================================= */

async function getTorrents(userConfig, metaInfos, debridInstance) {
  while (actionInProgress.getTorrents[metaInfos.stremioId]) {
    await wait(300);
  }
  actionInProgress.getTorrents[metaInfos.stremioId] = true;

  const t0 = Date.now();

  try {
    let {
      qualities,
      excludeKeywords,
      maxTorrents,
      sortCached,
      sortUncached,
      indexerTimeoutSec,
      languages
    } = userConfig;

    indexerTimeoutSec = 4;

    const { type, stremioId, year, season, episode } = metaInfos;
    console.log(`${stremioId} : searching torrents...`);

    const filterSearch = torrent => {
      if (!qualities.includes(torrent.quality)) return false;
      const words = parseWords(torrent.name.toLowerCase());
      return !excludeKeywords.find(w => words.includes(w));
    };

    const filterYear = torrent => !torrent.year || torrent.year === year;

    let indexers = (await jackett.getIndexers()).filter(i => i.searching[type].available);
    console.log(`${stremioId} : ${indexers.length} indexers`);

    let torrents = [];

    if (type === 'movie') {
      const promises = indexers.map(i =>
        timeoutIndexerSearch(
          i.id,
          jackett.searchMovieTorrents({ ...metaInfos, indexer: i.id }),
          indexerTimeoutSec * 1000
        )
      );
      torrents = [].concat(...(await Promise.all(promises)));
    } else {
      const eps = indexers.map(i =>
        timeoutIndexerSearch(
          i.id,
          jackett.searchEpisodeTorrents({ ...metaInfos, indexer: i.id }),
          indexerTimeoutSec * 1000
        )
      );
      const packs = indexers.map(i =>
        timeoutIndexerSearch(
          i.id,
          jackett.searchSerieTorrents({ ...metaInfos, indexer: i.id }),
          indexerTimeoutSec * 1000
        )
      );
      torrents = [].concat(...(await Promise.all(eps)), ...(await Promise.all(packs)).flat());
    }

    torrents = torrents
      .filter(filterYear)
      .filter(filterSearch)
      .sort(sortBy('seeders', true));

    torrents = reorderByLanguage(torrents, languages);
    torrents = torrents.slice(0, maxTorrents + 2);

    const limit = pLimit(5);
    torrents = await Promise.all(
      torrents.map(t =>
        limit(async () => {
          try {
            t.infos = await promiseTimeout(torrentInfos.get(t), indexerTimeoutSec * 1000);
            return t;
          } catch {
            return false;
          }
        })
      )
    );

    torrents = torrents.filter(t => t && t.infos).slice(0, maxTorrents);

    if (debridInstance) {
      const torrentsWithHash = torrents.filter(t => t.infos.infoHash);
      const cached = (await debridInstance.getTorrentsCached(torrentsWithHash)).map(t => {
        t.isCached = true;
        return t;
      });

      const uncached = torrents.filter(t => !cached.includes(t));

      console.log(
        `${stremioId} : ${cached.length} cached / ${uncached.length} uncached on ${debridInstance.shortName}`
      );

      torrents = [
        ...reorderByLanguage(cached.sort(sortBy(...sortCached)), languages),
        ...reorderByLanguage(uncached.sort(sortBy(...sortUncached)), languages)
      ].slice(0, maxTorrents);
    }

    console.log(
      `${stremioId} : ${torrents.length} results returned in ${(Date.now() - t0) / 1000}s`
    );

    return torrents;
  } finally {
    delete actionInProgress.getTorrents[metaInfos.stremioId];
  }
}

/* =========================================================
 * STREAMS PARA O STREMIO
 * ======================================================= */

function getFile(files, type, season, episode) {
  files = files.sort(sortBy('size', true));
  if (type === 'movie') return files[0];
  return searchEpisodeFile(files, season, episode) || files[0];
}

export async function getStreams(userConfig, type, stremioId, publicUrl) {
  userConfig = await mergeDefaultUserConfig(userConfig);

  const { season, episode } = parseStremioId(stremioId);
  const debridInstance = debrid.instance(userConfig);
  const metaInfos = await getMetaInfos(type, stremioId, userConfig.metaLanguage);

  const torrents = await getTorrents(userConfig, metaInfos, debridInstance);

  return torrents.map(torrent => {
    const file = getFile(torrent.infos.files || [], type, season, episode) || {};
    const quality =
      torrent.quality > 0
        ? config.qualities.find(q => q.value === torrent.quality)?.label || ''
        : '';

    const serviceName = torrent.shortName || debridInstance.shortName;
    const cachedSign = torrent.isCached ? '⚡' : '';

    const languageBadges = (torrent.languages || [])
      .map(l => l.emoji)
      .join(' ');

    const isArchive =
      torrent.infos.files?.length > 1 ||
      file.name?.match(/\.(zip|rar|7z)$/i);

    const sizeLabel = isArchive
      ? `📦 ${bytesToSize(
          torrent.infos.files.reduce((s, f) => s + (f.size || 0), 0)
        )}`
      : `📂 ${bytesToSize(file.size || torrent.size)}`;

    const indexer = torrent.indexerName || torrent.indexerId || 'Unknown';

    const row1 = [
      sizeLabel,
      `👤 ${torrent.seeders || 0}`,
      `⚙️ ${indexer} ${languageBadges}`
    ]
      .filter(Boolean)
      .join('  ');

    const row2 = file.name || torrent.name;

    return {
      name: `[${serviceName}${cachedSign}] Jackio ${quality}`,
      title: [row1, row2].filter(Boolean).join('\n'),
      url: torrent.disabled
        ? '#'
        : `${publicUrl}/${btoa(
            JSON.stringify(userConfig)
          )}/download/${type}/${stremioId}/${torrent.id}/${file.name || torrent.name}`
    };
  });
}

/* =========================================================
 * DOWNLOAD
 * ======================================================= */

export async function getDownload(userConfig, type, stremioId, torrentId) {
  userConfig = await mergeDefaultUserConfig(userConfig);
  const debridInstance = debrid.instance(userConfig);

  let cleanId = torrentId;
  if (cleanId.includes(':')) cleanId = cleanId.split(':').slice(1).join(':');

  const infos = await torrentInfos.getById(cleanId);
  const { season, episode } = parseStremioId(stremioId);

  const cacheKey = `download:${await debridInstance.getUserHash()}:${stremioId}:${torrentId}`;

  let files;
  let download;

  while (actionInProgress.getDownload[cacheKey]) {
    await wait(200);
  }
  actionInProgress.getDownload[cacheKey] = true;

  try {
    download = await cache.get(cacheKey);
    if (download) return download;

    files = await debridInstance.getFiles(infos);
    download = await debridInstance.getDownload(
      getFile(files, type, season, episode)
    );

    if (download) {
      download = applyMediaflowProxyIfNeeded(download, userConfig);
      await cache.set(cacheKey, download, { ttl: 3600 });
      return download;
    }

    throw new Error('No download');
  } finally {
    delete actionInProgress.getDownload[cacheKey];
  }
}
