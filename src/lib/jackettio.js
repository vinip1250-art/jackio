import pLimit from 'p-limit';
import { parseWords, numberPad, sortBy, bytesToSize, wait, promiseTimeout } from './util.js';
import config from './config.js';
import cache from './cache.js';
import { updateUserConfigWithMediaFlowIp, applyMediaflowProxyIfNeeded } from './mediaflowProxy.js';
import * as meta from './meta.js';
import * as jackett from './jackett.js';
import * as debrid from './debrid.js';
import * as torrentInfos from './torrentInfos.js';

/**
 * ===============================
 * PRIORIZAÇÃO DE IDIOMA (CORRETA)
 * ===============================
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
 * ===============================
 */

const slowIndexers = {};

const actionInProgress = {
  getTorrents: {},
  getDownload: {}
};

function parseStremioId(stremioId){
  const [id, season, episode] = stremioId.split(':');
  return { id, season: parseInt(season || 0), episode: parseInt(episode || 0) };
}

async function getMetaInfos(type, stremioId, language){
  const { id, season, episode } = parseStremioId(stremioId);
  if(type === 'movie'){
    return meta.getMovieById(id, language);
  } else if(type === 'series'){
    return meta.getEpisodeById(id, season, episode, language);
  }
  throw new Error(`Unsupported type ${type}`);
}

async function mergeDefaultUserConfig(userConfig){
  config.immulatableUserConfigKeys.forEach(key => delete userConfig[key]);
  userConfig = Object.assign({}, config.defaultUserConfig, userConfig);
  userConfig = await updateUserConfigWithMediaFlowIp(userConfig);
  return userConfig;
}

function searchEpisodeFile(files, season, episode){
  return files.find(file => file.name.includes(`S${numberPad(season, 2)}E${numberPad(episode, 3)}`))
    || files.find(file => file.name.includes(`S${numberPad(season, 2)}E${numberPad(episode, 2)}`))
    || files.find(file => file.name.includes(`${season}${numberPad(episode, 2)}`))
    || files.find(file => file.name.includes(`${numberPad(episode, 2)}`))
    || false;
}

async function timeoutIndexerSearch(indexerId, promise, timeout){
  const start = new Date();
  const res = await promiseTimeout(promise, timeout).catch(() => []);
  const duration = new Date() - start;
  if(timeout > config.slowIndexerDuration){
    if(duration > config.slowIndexerDuration){
      slowIndexers[indexerId] = slowIndexers[indexerId] || [];
      slowIndexers[indexerId].push({ duration, date: new Date() });
    } else {
      slowIndexers[indexerId] = [];
    }
  }
  return res;
}

async function getTorrents(userConfig, metaInfos, debridInstance){

  while(actionInProgress.getTorrents[metaInfos.stremioId]){
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
      indexerTimeoutSec
    } = userConfig;

    indexerTimeoutSec = 4;

    const { season, episode, type, stremioId, year } = metaInfos;

    console.log(`${stremioId} : Searching torrents ...`);

    const sortSearch = [['seeders', true]];
    const filterSearch = (torrent) => {
      if(!qualities.includes(torrent.quality)) return false;
      const words = parseWords(torrent.name.toLowerCase());
      if(excludeKeywords.find(word => words.includes(word))) return false;
      return true;
    };

    const filterYear = torrent => !torrent.year || torrent.year === year;

    let indexers = (await jackett.getIndexers()).filter(i => i.searching[type].available);

    let torrents = [];

    if(type === 'movie'){
      const promises = indexers.map(i =>
        timeoutIndexerSearch(i.id, jackett.searchMovieTorrents({ ...metaInfos, indexer: i.id }), indexerTimeoutSec * 1000)
      );
      torrents = [].concat(...(await Promise.all(promises)));
    } else {
      const ep = indexers.map(i =>
        timeoutIndexerSearch(i.id, jackett.searchEpisodeTorrents({ ...metaInfos, indexer: i.id }), indexerTimeoutSec * 1000)
      );
      const packs = indexers.map(i =>
        timeoutIndexerSearch(i.id, jackett.searchSerieTorrents({ ...metaInfos, indexer: i.id }), indexerTimeoutSec * 1000)
      );
      torrents = [].concat(...(await Promise.all(ep)), ...(await Promise.all(packs)).flat());
    }

    torrents = torrents.filter(filterYear).filter(filterSearch).sort(sortBy(...sortSearch));

    const preferredLanguages = userConfig.languages || [];
    torrents = reorderByLanguage(torrents, preferredLanguages);

    torrents = torrents.slice(0, maxTorrents + 2);

    const limit = pLimit(5);
    torrents = await Promise.all(torrents.map(t => limit(async () => {
      try {
        t.infos = await promiseTimeout(torrentInfos.get(t), indexerTimeoutSec * 1000);
        return t;
      } catch {
        return false;
      }
    })));

    torrents = torrents.filter(t => t && t.infos).slice(0, maxTorrents);

    if(debridInstance){
      const torrentsWithHash = torrents.filter(t => t.infos.infoHash);
      const cached = (await debridInstance.getTorrentsCached(torrentsWithHash)).map(t => ({ ...t, isCached: true }));
      const uncached = torrents.filter(t => !cached.includes(t));

      let orderedCached = reorderByLanguage(cached.sort(sortBy(...sortCached)), preferredLanguages);
      let orderedUncached = reorderByLanguage(uncached.sort(sortBy(...sortUncached)), preferredLanguages);

      torrents = [...orderedCached, ...orderedUncached].slice(0, maxTorrents);
    }

    return torrents;

  } finally {
    delete actionInProgress.getTorrents[metaInfos.stremioId];
  }
}

function getFile(files, type, season, episode){
  files = files.sort(sortBy('size', true));
  if(type === 'movie') return files[0];
  return searchEpisodeFile(files, season, episode) || files[0];
}

export async function getStreams(userConfig, type, stremioId, publicUrl){
  userConfig = await mergeDefaultUserConfig(userConfig);
  const { season, episode } = parseStremioId(stremioId);
  const debridInstance = debrid.instance(userConfig);
  const metaInfos = await getMetaInfos(type, stremioId, userConfig.metaLanguage);

  const torrents = await getTorrents(userConfig, metaInfos, debridInstance);

  return torrents.map(torrent => {
    const file = getFile(torrent.infos.files || [], type, season, episode) || {};
    const quality = torrent.quality > 0 ? config.qualities.find(q => q.value === torrent.quality)?.label : '';
    const langs = (torrent.languages || []).map(l => `${l.emoji} ${l.value.toUpperCase()}`).join(' ');
    const size = `📂 ${bytesToSize(file.size || torrent.size)}`;
    const seeds = `👤 ${torrent.seeders || 0}`;
    const cached = torrent.isCached ? '⚡' : '';

    const title = [size, cached, seeds, langs, file.name || torrent.name].filter(Boolean).join('\n');

    return {
      name: `[${debridInstance.shortName}] Jackio ${quality}`,
      title,
      url: torrent.disabled ? '#' : `${publicUrl}/${btoa(JSON.stringify(userConfig))}/download/${type}/${stremioId}/${torrent.id}/${file.name || torrent.name}`
    };
  });
}

export async function getDownload(userConfig, type, stremioId, torrentId){
  userConfig = await mergeDefaultUserConfig(userConfig);
  const debridInstance = debrid.instance(userConfig);
  const infos = await torrentInfos.getById(torrentId);
  const { season, episode } = parseStremioId(stremioId);

  let files = await debridInstance.getFilesFromHash(infos.infoHash);
  const download = await debridInstance.getDownload(getFile(files, type, season, episode));
  return applyMediaflowProxyIfNeeded(download, userConfig);
}
