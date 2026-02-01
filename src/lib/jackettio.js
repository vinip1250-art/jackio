import pLimit from 'p-limit';
import { parseWords, numberPad, sortBy, bytesToSize, wait, promiseTimeout } from './util.js';
import config from './config.js';
import cache, { vacuum as vacuumCache, clean as cleanCache } from './cache.js';
import { updateUserConfigWithMediaFlowIp, applyMediaflowProxyIfNeeded } from './mediaflowProxy.js';
import * as meta from './meta.js';
import * as jackett from './jackett.js';
import * as debrid from './debrid.js';
import * as torrentInfos from './torrentInfos.js';

/**
 * =========================================================
 * PRIORIZAÇÃO DE IDIOMA (ADIÇÃO COMPATÍVEL COM UPSTREAM)
 * =========================================================
 */

function hasLanguage(torrent, langs) {
  return torrent.languages?.some(l => langs.includes(l.value));
}

function reorderByLanguage(torrents, preferredLangs) {
  if (!preferredLangs || preferredLangs.length === 0) return torrents;

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

/**
 * =========================================================
 */

const slowIndexers = {};

const actionInProgress = {
  getTorrents: {},
  getDownload: {}
};

function parseStremioId(stremioId) {
  const [id, season, episode] = stremioId.split(':');
  return { id, season: parseInt(season || 0), episode: parseInt(episode || 0) };
}

async function getMetaInfos(type, stremioId, language) {
  const { id, season, episode } = parseStremioId(stremioId);
  if (type === 'movie') return meta.getMovieById(id, language);
  if (type === 'series') return meta.getEpisodeById(id, season, episode, language);
  throw new Error(`Unsupported type ${type}`);
}

async function mergeDefaultUserConfig(userConfig) {
  config.immulatableUserConfigKeys.forEach(key => delete userConfig[key]);
  userConfig = Object.assign({}, config.defaultUserConfig, userConfig);
  userConfig = await updateUserConfigWithMediaFlowIp(userConfig);
  return userConfig;
}

/**
 * =========================================================
 * FUNÇÃO ORIGINAL DO UPSTREAM (NÃO REMOVIDA)
 * =========================================================
 */
function priotizeItems(allItems, priotizeItems, max) {
  max = max || 0;
  if (typeof priotizeItems === 'function') {
    priotizeItems = allItems.filter(priotizeItems);
    if (max > 0) priotizeItems.splice(max);
  }
  if (priotizeItems && priotizeItems.length) {
    allItems = allItems.filter(item => !priotizeItems.includes(item));
    allItems.unshift(...priotizeItems);
  }
  return allItems;
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
  const start = new Date();
  const res = await promiseTimeout(promise, timeout).catch(() => []);
  const duration = new Date() - start;
  if (timeout > config.slowIndexerDuration) {
    slowIndexers[indexerId] = slowIndexers[indexerId] || [];
    if (duration > config.slowIndexerDuration) {
      slowIndexers[indexerId].push({ duration, date: new Date() });
    } else {
      slowIndexers[indexerId] = [];
    }
  }
  return res;
}

async function getTorrents(userConfig, metaInfos, debridInstance) {
  while (actionInProgress.getTorrents[metaInfos.stremioId]) {
    await wait(500);
  }
  actionInProgress.getTorrents[metaInfos.stremioId] = true;

  try {
    let {
      qualities,
      excludeKeywords,
      maxTorrents,
      sortCached,
      sortUncached,
      priotizeLanguages,
      indexerTimeoutSec
    } = userConfig;

    const { season, episode, type, stremioId, year } = metaInfos;

    console.log(`${stremioId} : Searching torrents ...`);

    const sortSearch = [['seeders', true]];

    const filterSearch = torrent => {
      if (!qualities.includes(torrent.quality)) return false;
      const words = parseWords(torrent.name.toLowerCase());
      if (excludeKeywords.find(w => words.includes(w))) return false;
      return true;
    };

    const filterYear = torrent => !torrent.year || torrent.year === year;

    let indexers = (await jackett.getIndexers()).filter(i => i.searching[type].available);

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
      const ep = indexers.map(i =>
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
      torrents = [].concat(...(await Promise.all(ep)), ...(await Promise.all(packs)).flat());
    }

    torrents = torrents.filter(filterYear).filter(filterSearch).sort(sortBy(...sortSearch));

    /**
     * 🔹 AQUI É A ÚNICA MUDANÇA DE COMPORTAMENTO
     * 🔹 Idioma selecionado vem primeiro
     * 🔹 Multi como fallback
     */
    torrents = reorderByLanguage(torrents, userConfig.languages || []);

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
      const cachedTorrents = (await debridInstance.getTorrentsCached(torrentsWithHash)).map(t => {
        t.isCached = true;
        return t;
      });

      let uncachedTorrents = torrents.filter(t => !cachedTorrents.includes(t));

      let orderedCached = reorderByLanguage(
        cachedTorrents.sort(sortBy(...sortCached)),
        userConfig.languages
      );

      let orderedUncached = reorderByLanguage(
        uncachedTorrents.sort(sortBy(...sortUncached)),
        userConfig.languages
      );

      torrents = [
        ...priotizeItems(orderedCached, null),
        ...priotizeItems(orderedUncached, null)
      ].slice(0, maxTorrents);
    }

    return torrents;
  } finally {
    delete actionInProgress.getTorrents[metaInfos.stremioId];
  }
}

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
        ? config.qualities.find(q => q.value === torrent.quality)?.label
        : '';

    const langs = (torrent.languages || [])
      .map(l => `${l.emoji} ${l.value.toUpperCase()}`)
      .join(' ');

    const size = `📂 ${bytesToSize(file.size || torrent.size)}`;
    const seeds = `👤 ${torrent.seeders || 0}`;
    const indexer = `⚙️ ${torrent.indexerId || 'Unknown'}`;
    const cached = torrent.isCached ? '⚡' : '';

    const title = [size, cached, seeds, indexer, langs, file.name || torrent.name]
      .filter(Boolean)
      .join('\n');

    const serviceName = torrent.shortName || debridInstance.shortName;
    const name = `[${serviceName}${cached}] Jackio ${quality}`;

    return {
      name,
      title,
      url: torrent.disabled
        ? '#'
        : `${publicUrl}/${btoa(JSON.stringify(userConfig))}/download/${type}/${stremioId}/${torrent.id}/${file.name || torrent.name}`
    };
  });
}
