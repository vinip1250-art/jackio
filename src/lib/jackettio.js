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
   🔤 NORMALIZAÇÃO + PRIORIZAÇÃO DE IDIOMA (UPSTREAM SAFE)
   ========================================================= */

const LANG_PATTERNS = {
  ptbr: /\b(pt-br|ptbr|brazilian|brasileiro|dublado|nacional|por|pob|bioma)\b/i,
  multi: /\b(multi|multi[- ]?audio)\b/i
};

function normalizeTorrentLanguages(torrent, file) {
  if (torrent.languages && torrent.languages.length) return;

  const haystack = `${torrent.name || ''} ${file?.name || ''}`.toLowerCase();

  if (LANG_PATTERNS.ptbr.test(haystack)) {
    torrent.languages = [{ value: 'portuguese', emoji: '🇧🇷', reason: 'name/file match' }];
  } else if (LANG_PATTERNS.multi.test(haystack)) {
    torrent.languages = [{ value: 'multi', emoji: '🌐', reason: 'multi-audio keyword' }];
  } else {
    torrent.languages = [{ value: 'english', emoji: '🇺🇸', reason: 'fallback' }];
  }
}

function languageRank(lang) {
  if (!lang) return 99;
  if (lang === 'portuguese') return 0;
  if (lang === 'multi') return 1;
  if (lang === 'english') return 2;
  return 50;
}

function reorderByLanguage(torrents, preferred) {
  if (!preferred || !preferred.length) return torrents;

  return torrents
    .map(t => {
      const lang = t.languages?.[0]?.value;
      return {
        torrent: t,
        rank: languageRank(lang)
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .map(e => e.torrent);
}

/* ========================================================= */

const slowIndexers = {};
const actionInProgress = { getTorrents: {}, getDownload: {} };

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
  return (
    files.find(f => f.name.includes(`S${numberPad(season, 2)}E${numberPad(episode, 2)}`)) ||
    files[0]
  );
}

/* =========================================================
   🔎 TORRENTS
   ========================================================= */

async function getTorrents(userConfig, metaInfos, debridInstance) {
  while (actionInProgress.getTorrents[metaInfos.stremioId]) await wait(300);
  actionInProgress.getTorrents[metaInfos.stremioId] = true;

  try {
    let {
      qualities,
      excludeKeywords,
      maxTorrents,
      sortCached,
      sortUncached,
      indexerTimeoutSec,
      languages,
      debug
    } = userConfig;

    indexerTimeoutSec = indexerTimeoutSec || 4;

    const { type, stremioId, year } = metaInfos;

    console.log(`[SEARCH] ${stremioId} | languages=${languages.join(', ')}`);

    const indexers = (await jackett.getIndexers())
      .filter(i => i.searching[type].available);

    const searchPromises = indexers.map(i =>
      promiseTimeout(
        type === 'movie'
          ? jackett.searchMovieTorrents({ ...metaInfos, indexer: i.id })
          : jackett.searchEpisodeTorrents({ ...metaInfos, indexer: i.id }),
        indexerTimeoutSec * 1000
      ).catch(() => [])
    );

    let torrents = (await Promise.all(searchPromises)).flat();

    torrents = torrents
      .filter(t => qualities.includes(t.quality))
      .filter(t => !excludeKeywords.some(k => parseWords(t.name.toLowerCase()).includes(k)))
      .filter(t => !t.year || t.year === year)
      .sort(sortBy('seeders', true));

    /* 🔤 normalização antes da ordenação */
    torrents.forEach(t => normalizeTorrentLanguages(t));

    torrents = reorderByLanguage(torrents, languages).slice(0, maxTorrents + 2);

    const limit = pLimit(5);
    torrents = (await Promise.all(torrents.map(t =>
      limit(async () => {
        try {
          t.infos = await torrentInfos.get(t);
          normalizeTorrentLanguages(t, t.infos?.files?.[0]);
          return t;
        } catch {
          return null;
        }
      })
    ))).filter(Boolean);

    if (debug) {
      torrents.forEach(t => {
        console.log(
          `[LANG] ${t.name} → ${t.languages?.[0]?.value} (${t.languages?.[0]?.reason})`
        );
      });
    }

    if (debridInstance) {
      const cached = (await debridInstance.getTorrentsCached(
        torrents.filter(t => t.infos?.infoHash)
      )).map(t => ({ ...t, isCached: true }));

      const uncached = torrents.filter(t => !cached.includes(t));

      torrents = [
        ...reorderByLanguage(cached.sort(sortBy(...sortCached)), languages),
        ...reorderByLanguage(uncached.sort(sortBy(...sortUncached)), languages)
      ].slice(0, maxTorrents);
    }

    return torrents;
  } finally {
    delete actionInProgress.getTorrents[metaInfos.stremioId];
  }
}

/* =========================================================
   🎬 STREAMS (LAYOUT 3 COLUNAS)
   ========================================================= */

export async function getStreams(userConfig, type, stremioId, publicUrl) {
  userConfig = await mergeDefaultUserConfig(userConfig);
  const { season, episode } = parseStremioId(stremioId);
  const debridInstance = debrid.instance(userConfig);
  const metaInfos = await getMetaInfos(type, stremioId, userConfig.metaLanguage);

  const torrents = await getTorrents(userConfig, metaInfos, debridInstance);

  return torrents.map(t => {
    const file = t.infos?.files?.[0] || {};
    const isZip = file.name?.endsWith('.zip');
    const size = bytesToSize(file.size || t.size || 0);
    const seeds = t.seeders || 0;

    const lang = t.languages?.[0];
    const langTag = lang?.emoji || '';

    const indexer = t.indexerName || t.indexerId || 'Indexer';
    const service = t.shortName || debridInstance.shortName;
    const cached = t.isCached ? '⚡' : '';

    const col1 = `${isZip ? '📦' : '📂'} ${size} | 👤 ${seeds}`;
    const col2 = `⚙️ ${indexer} ${langTag}`;
    const col3 = file.name || t.name;

    return {
      name: `[${service}${cached}] Jackio`,
      title: `${col1}\n${col2}\n${col3}`,
      url: `${publicUrl}/${btoa(JSON.stringify(userConfig))}/download/${type}/${stremioId}/${t.id}/${file.name || t.name}`
    };
  });
}

/* =========================================================
   ⬇️ DOWNLOAD (inalterado do upstream)
   ========================================================= */

export async function getDownload(userConfig, type, stremioId, torrentId) {
  userConfig = await mergeDefaultUserConfig(userConfig);
  const debridInstance = debrid.instance(userConfig);
  const infos = await torrentInfos.getById(torrentId);
  const { season, episode } = parseStremioId(stremioId);

  const files = await debridInstance.getFilesFromMagnet(
    infos.magnetUrl,
    infos.infoHash
  );

  const file =
    type === 'movie'
      ? files[0]
      : searchEpisodeFile(files, season, episode);

  let download = await debridInstance.getDownload(file);
  return applyMediaflowProxyIfNeeded(download, userConfig);
}
