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

  // --- FORMATAÇÃO VISUAL ESTILO DEBRIDIO ---
    return torrents.map(torrent => {
        const file = getFile(torrent.infos.files || [], type, season, episode) || {};
        const quality = torrent.quality > 0 ? config.qualities.find(q => q.value == torrent.quality).label : '';
    
        const serviceName = torrent.shortName || debridInstance.shortName;
        const cachedSign = torrent.isCached ? '⚡' : '';
        const seeds = torrent.seeders || 0;
        const size = bytesToSize(file.size || torrent.size);
        const indexer = torrent.indexerName || torrent.indexerId || 'Unknown';
    
        const d = torrent.details || { audio: [], video: [], other: [] };
        const score = getLanguageScore(torrent);
    
        let langTag = '';
        if (score === 3) langTag = '🇧🇷';
        else if (score === 2) langTag = '🌐';
        else if (score === 1) langTag = '💬';
    
        let audioInfos = d.audio.join(' ');
        if (!audioInfos && (torrent.name.match(/5\.1/))) audioInfos = '5.1';
    
        let extraInfos = [audioInfos, d.video.join(' '), d.other.join(' ')].filter(Boolean).join(' | ');

        const row1 = [`📂 ${size}`, `👤 ${seeds}`, `⚙️ ${indexer}`].filter(Boolean).join(' | ');
        const row2 = [langTag, extraInfos ? `🔊 ${extraInfos}` : ''].filter(Boolean).join(' | ');
        const row3 = file.name || torrent.name;

        const title = [row1, row2, row3].filter(Boolean).join('\n');
        const name = `[${serviceName}${cachedSign}] Jackio ${quality}`;

     return {
          name: name,
          title: title,
          url: torrent.disabled ? '#' : `${publicUrl}/${btoa(JSON.stringify(userConfig))}/download/${type}/${stremioId}/${torrent.id}/${file.name || torrent.name}`
      };
  });
}

export async function getDownload(userConfig, type, stremioId, torrentId){
  userConfig = await mergeDefaultUserConfig(userConfig);
  const debridInstance = debrid.instance(userConfig);

  let cleanId = torrentId;
  if (cleanId.includes(':') && (cleanId.startsWith('rd:') || cleanId.startsWith('tb:') || cleanId.startsWith('hy:'))) {
     const parts = cleanId.split(':');
     if(parts.length > 1) cleanId = parts.slice(1).join(':');
  }

  const infos = await torrentInfos.getById(cleanId);
  const {id, season, episode} = parseStremioId(stremioId);
  const cacheKey = `download:2:${await debridInstance.getUserHash()}${userConfig.enableMediaFlow ? ':mfp': ''}:${stremioId}:${torrentId}`;
  
  let files;
  let download;
  let waitMs = 0;

  while(actionInProgress.getDownload[cacheKey]){
    await wait(Math.min(300, waitMs+=50));
  }
  actionInProgress.getDownload[cacheKey] = true;

  try {
    if(type == 'series' && userConfig.forceCacheNextEpisode){
      getMetaInfos(type, stremioId, userConfig.metaLanguage).then(metaInfos => prepareNextEpisode(userConfig, metaInfos, debridInstance));
    }

    download = await cache.get(cacheKey);
    if(download)return download;

    console.log(`${stremioId} : ${debridInstance.shortName} : ${infos.infoHash} : get files ...`);
    
    if (debridInstance.id == 'hybrid' && torrentId.includes(':')) {
        const prefix = torrentId.split(':')[0];
        if (prefix === 'tb') {
            files = await getDebridFiles(userConfig, infos, debridInstance.tb);
            files = files.map(f => ({...f, id: `tb:${f.id}`}));
        } else if (prefix === 'rd') {
            files = await getDebridFiles(userConfig, infos, debridInstance.rd);
            files = files.map(f => ({...f, id: `rd:${f.id}`}));
        } else {
            files = await getDebridFiles(userConfig, infos, debridInstance);
        }
    } else {
        files = await getDebridFiles(userConfig, infos, debridInstance);
    }

    console.log(`${stremioId} : ${debridInstance.shortName} : ${infos.infoHash} : ${files.length} files found`);
    download = await debridInstance.getDownload(getFile(files, type, season, episode));

    if(download){
      download = applyMediaflowProxyIfNeeded(download, userConfig);
      await cache.set(cacheKey, download, {ttl: 3600});
      return download;
    }
    throw new Error(`No download for type ${type} and ID ${torrentId}`);
  }finally{
    delete actionInProgress.getDownload[cacheKey];
  }
}
