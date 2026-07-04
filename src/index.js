import showdown from 'showdown';
import compression from 'compression';
import express from 'express';
import localtunnel from 'localtunnel';
import { rateLimit } from 'express-rate-limit';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import config from './lib/config.js';
import cache, { redisClient, vacuum as vacuumCache, clean as cleanCache } from './lib/cache.js';
import * as meta from './lib/meta.js';
import * as icon from './lib/icon.js';
import * as debrid from './lib/debrid.js';
import { getIndexers } from './lib/jackett.js';
import * as jackettio from "./lib/jackettio.js";
import { cleanTorrentFolder, createTorrentFolder } from './lib/torrentInfos.js';
import * as torrentInfos from './lib/torrentInfos.js';
import { ensureTorrentReady, waitForBuffer, getPlayableLocalFile, streamTorrentFile, isConfigured as isQbitConfigured } from './lib/providers/qbittorrent.js';
import { startRssPoller, CATALOG_KEY, updateCatalog } from './lib/rssPoller.js';
import { enrichMetaPtBr } from './lib/metadata.js';
import { getExtraTrackers } from './lib/torrentEnrich.js';
/**
 * ==================================================
 * CORREÇÃO OBRIGATÓRIA PARA ES MODULES (Node 18)
 * ==================================================
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * ==================================================
 */

const converter = new showdown.Converter();
const welcomeMessageHtml = config.welcomeMessage
  ? `${converter.makeHtml(config.welcomeMessage)}<div class="my-4 border-top border-secondary-subtle"></div>`
  : '';

const addon = JSON.parse(readFileSync('./package.json'));
const app = express();

// --- INICIO DO BLOQUEIO POR SENHA (BASIC AUTH) ---
app.use((req, res, next) => {
  if (!process.env.ACCESS_PASSWORD) return next();

  if (
    req.path.includes('/manifest.json') ||
    req.path.startsWith('/stream') ||
    req.path.startsWith('/download') ||
    req.path.length > 64
  ) {
    return next();
  }

  if (req.path.endsWith('.png') || req.path.endsWith('.jpg') || req.path.endsWith('.ico')) {
    return next();
  }

  const auth = { login: 'admin', password: process.env.ACCESS_PASSWORD };
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login && password && password === auth.password) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Jackettio Protegido"');
  res.status(401).send('<h1>Acesso Negado</h1><p>Você precisa da senha configurada no .env para acessar o gerador.</p>');
});
// --- FIM DO BLOQUEIO ---

const respond = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send(data);
};

const RSS_CACHE_VERSION = "v12-native-debrid";
const rssCatalogRebuilds = new Map();

function normalizeRssImdbId(id) {
  const str = String(id || "").trim();
  if (!str) return "";
  const match = str.match(/tt\d+/i);
  if (match) return match[0].toLowerCase();
  return /^\d+$/.test(str) ? "tt" + str : "";
}

function toBase64Url(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function rssCatalogMetaId(item, catalogType) {
  const imdb = normalizeRssImdbId(item?.ImdbId);
  if (!imdb) return null;
  return catalogType === "movie" ? "rssmovie:" + imdb : "rssmeta:" + catalogType + ":" + imdb.replace(/^tt/i, "");
}

async function loadRssItemsForType(_prefs, rssType) {
  if (!redisClient || redisClient.status !== "ready") return [];
  const keys = await redisClient.keys("rss:" + RSS_CACHE_VERSION + ":*:" + rssType + ":*").catch(() => []);
  if (!keys.length) return [];
  const lists = await Promise.all(keys.map(async key => {
    try {
      const value = await cache.get(key);
      if (!value) return [];
      return typeof value === "string" ? JSON.parse(value) : value;
    } catch {
      return [];
    }
  }));
  return lists.flat();
}

async function rebuildRssCatalog(catalogType, rssItems) {
  const current = rssCatalogRebuilds.get(catalogType);
  if (current) return current;
  const task = updateCatalog(rssItems)
    .finally(() => rssCatalogRebuilds.delete(catalogType));
  rssCatalogRebuilds.set(catalogType, task);
  return task;
}

function parseRssMetaId(id) {
  const str = String(id || "");
  if (!str.startsWith("rssmeta:")) return null;
  const parts = str.split(":");
  if (parts.length < 3) return null;
  const rawId = parts.slice(2).join(":");
  return { catalogType: parts[1], metaId: /^\d+$/.test(rawId) ? "tt" + rawId : rawId };
}

function parseRssItemId(id) {
  if (!String(id || "").startsWith("rssitem:")) return null;
  const parts = String(id).split(":");
  if (parts.length < 5) return null;
  const season = parseInt(parts[3], 10);
  const episode = parseInt(parts[4], 10);
  return {
    catalogType: parts[1],
    metaId: parts[2],
    season: Number.isFinite(season) ? season : null,
    episode: Number.isFinite(episode) ? episode : null,
  };
}

function isCompletePack(title) {
  return /\b(complete|season|temporada|pack|batch|full)\b/i.test(String(title || ""));
}

function extractSeriesFeedMarker(title) {
  const text = String(title || "");
  let match = text.match(/\bS(\d{1,2})E(\d{1,3})\b/i) || text.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10), label: "S" + String(match[1]).padStart(2, "0") + "E" + String(match[2]).padStart(2, "0"), pack: false };
  match = text.match(/\b(?:S|Season\s?|Temporada\s?)(\d{1,2})\b/i);
  if (match && isCompletePack(text)) return { season: parseInt(match[1], 10), episode: 0, label: "Temporada " + String(match[1]).padStart(2, "0") + " (Pack RSS)", pack: true };
  return null;
}

function extractAnimeFeedMarker(title) {
  const text = String(title || "").replace(/\./g, " ");
  const match = text.match(/-\s*0*(\d{1,3})(?:v\d+)?\b/i) || text.match(/\[(\d{1,3})(?:v\d+)?\]/i) || text.match(/\bE(?:p(?:isode)?)?\s*0*(\d{1,3})\b/i);
  if (match) return { season: 1, episode: parseInt(match[1], 10), label: "Episodio " + String(match[1]).padStart(2, "0"), pack: false };
  if (isCompletePack(text)) return { season: 1, episode: 0, label: "Temporada/Batch RSS", pack: true };
  return null;
}

function buildRssVideos(items, catalogType, metaId) {
  const matched = items.filter(item => normalizeRssImdbId(item.ImdbId) === normalizeRssImdbId(metaId));
  const seen = new Set();
  const videos = [];
  for (const item of matched) {
    const marker = catalogType === "anime" ? extractAnimeFeedMarker(item.Title) : extractSeriesFeedMarker(item.Title);
    if (!marker) continue;
    const key = marker.season + ":" + marker.episode;
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push({
      id: "rssitem:" + catalogType + ":" + normalizeRssImdbId(metaId) + ":" + (marker.season ?? 1) + ":" + (marker.episode ?? 0),
      title: marker.label,
      season: marker.season ?? 1,
      episode: marker.episode ?? 0,
      released: item.PublishDate || null,
      overview: item.Title || null,
    });
  }
  videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode) || String(b.released || "").localeCompare(String(a.released || "")));
  return videos;
}

function matchRssItemsByMarker(items, catalogType, metaId, season, episode) {
  return items.filter(item => {
    if (normalizeRssImdbId(item.ImdbId) !== normalizeRssImdbId(metaId)) return false;
    const marker = catalogType === "anime" ? extractAnimeFeedMarker(item.Title) : extractSeriesFeedMarker(item.Title);
    if (!marker) return false;
    if (marker.season === season && marker.episode === episode) return true;
    if (marker.pack === true && marker.season === season) return true;
    return false;
  });
}

function rssMagnetInfoHash(value) {
  const match = String(value || "").match(/btih:([a-fA-F0-9]{40})/i);
  return match ? match[1].toLowerCase() : null;
}

async function buildRssStreamsForItems(userConfig, type, stremioId, items, publicUrl) {
  const encodedConfig = Buffer.from(JSON.stringify(userConfig)).toString("base64");
  const streams = [];

  for (const item of items.slice(0, 20)) {
    const token = toBase64Url(item.InfoHash || item.Guid || item.Link || item.MagnetUri || item.Title || Date.now());
    const torrentId = "rss-" + token;
    const link = item.MagnetUri || item.Link || "";
    const magnetUrl = link.startsWith("magnet:") ? link : (item.MagnetUri || "");
    const infoHash = item.InfoHash || rssMagnetInfoHash(magnetUrl);

    try {
      await torrentInfos.get({
        link,
        id: torrentId,
        magnetUrl,
        infoHash,
        name: item.Title || torrentId,
        size: Number(item.Size || 0),
        type: "private"
      });
    } catch (err) {
      console.warn("[RSS] Falha ao preparar torrent " + torrentId + ": " + err.message);
      continue;
    }

    const streamTitle = [
      item.Size ? "Tamanho: " + item.Size : "",
      item.Seeders != null ? "Seeds: " + item.Seeders : "",
      item._indexerName || item.Tracker || "RSS",
      item.Title || "RSS"
    ].filter(Boolean).join("\n");

    if (!isQbitConfigured()) {
      streams.push({ name: "[RSS] Jackio", title: streamTitle + "\nqBittorrent nao configurado", url: "#" });
      continue;
    }

    streams.push({
      name: "[QBIT] Jackio RSS",
      title: streamTitle,
      url: publicUrl + "/" + encodedConfig + "/qbit/" + type + "/" + stremioId + "/" + torrentId + "/" + encodeURIComponent(item.Title || torrentId)
    });
  }

  return streams;
}

async function buildRssCatalogStreams(userConfig, type, stremioId, publicUrl) {
  if (stremioId.startsWith("rssmovie:")) {
    const metaId = stremioId.slice("rssmovie:".length);
    const items = (await loadRssItemsForType({}, "movie")).filter(item => normalizeRssImdbId(item.ImdbId) === normalizeRssImdbId(metaId));
    return buildRssStreamsForItems(userConfig, type, stremioId, items, publicUrl);
  }

  const rssMeta = parseRssMetaId(stremioId);
  if (rssMeta) {
    const rssType = rssMeta.catalogType || (type === "anime" ? "anime" : "series");
    const hits = await loadRssItemsForType({}, rssType);
    const items = hits.filter(item => normalizeRssImdbId(item.ImdbId) === normalizeRssImdbId(rssMeta.metaId));
    return buildRssStreamsForItems(userConfig, type, stremioId, items, publicUrl);
  }

  const rssItem = parseRssItemId(stremioId);
  if (rssItem) {
    const rssType = rssItem.catalogType || (type === "anime" ? "anime" : "series");
    const hits = await loadRssItemsForType({}, rssType);
    const items = matchRssItemsByMarker(hits, rssType, rssItem.metaId, rssItem.season ?? 1, rssItem.episode ?? 0);
    return buildRssStreamsForItems(userConfig, type, stremioId, items, publicUrl);
  }

  return null;
}
const limiter = rateLimit({
  windowMs: config.rateLimitWindow * 1000,
  max: config.rateLimitRequest,
  legacyHeaders: false,
  standardHeaders: 'draft-7',
  keyGenerator: (req) => req.clientIp || req.ip,
  handler: (req, res, next, options) => {
    if (req.route.path === '/:userConfig/stream/:type/:id.json') {
      const resetInMs = new Date(req.rateLimit.resetTime) - new Date();
      return res.json({
        streams: [{
          name: `${config.addonName}`,
          title: `🛑 Too many requests, please try in ${Math.ceil(resetInMs / 1000 / 60)} minute(s).`,
          url: '#'
        }]
      });
    } else {
      return res.status(options.statusCode).send(options.message);
    }
  }
});

app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  req.clientIp = req.get('CF-Connecting-IP') || req.ip;
  next();
});

app.use(compression());

/**
 * ✅ CORREÇÃO APLICADA AQUI
 */
app.use(
  express.static(
    path.join(__dirname, 'static'),
    { maxAge: 86400e3 }
  )
);

app.get('/', (req, res) => {
  res.redirect('/configure');
});

app.get('/icon', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.sendFile(icon.iconPath);
});

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path.replace(/\/eyJ[\w\=]+/g, '/*******************')}`);
  next();
});

app.get('/:userConfig?/configure', async(req, res) => {
  let indexers = (await getIndexers().catch(() => []))
    .map(indexer => ({
      value: indexer.id, 
      label: indexer.title, 
      types: ['movie', 'series'].filter(type => indexer.searching[type].available)
    }));
  const templateConfig = {
    debrids: await debrid.list(),
    addon: {
      version: addon.version,
      name: config.addonName
    },
    userConfig: req.params.userConfig || '',
    defaultUserConfig: config.defaultUserConfig,
    qualities: config.qualities,
    languages: config.languages.map(l => ({value: l.value, label: l.label})).filter(v => v.value != 'multi'),
    metaLanguages: await meta.getLanguages(),
    sorts: config.sorts,
    indexers,
    passkey: {enabled: false},
    immulatableUserConfigKeys: config.immulatableUserConfigKeys
  };
  if(config.replacePasskey){
    templateConfig.passkey = {
      enabled: true,
      infoUrl: config.replacePasskeyInfoUrl,
      pattern: config.replacePasskeyPattern
    }
  }
  let template = readFileSync(`./src/template/configure.html`).toString()
    .replace('/** import-config */', `const config = ${JSON.stringify(templateConfig, null, 2)}`)
    .replace('<!-- welcome-message -->', welcomeMessageHtml);
  return res.send(template);
});

// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/advanced.md#using-user-data-in-addons
app.get("/:userConfig?/manifest.json", async(req, res) => {
  const hostname = process.env.REPLIT_DEV_DOMAIN || req.hostname;
  const protocol = hostname.includes('replit.dev') || (req.hostname != 'localhost' && req.hostname != '127.0.0.1') ? 'https' : 'http';
  
  const manifest = {
    id: config.addonId,
    version: addon.version,
    name: config.addonName,
    description: config.addonDescription,
    icon: `${protocol}://${hostname}/icon`,
    resources: [
      "catalog",
      { name: "meta", types: ["movie", "series", "anime"], idPrefixes: ["rssmovie:", "rssmeta:", "rssitem:"] },
      { name: "stream", types: ["movie", "series", "anime"] }
    ],
    types: ["movie", "series", "anime"],
    idPrefixes: ["tt", "kitsu:", "rssmovie:", "rssmeta:", "rssitem:"],
    catalogs: [
      { type: "movie", id: "rss_movies", name: "Recentes", extra: [{ name: "skip", isRequired: false }] },
      { type: "series", id: "rss_series", name: "Recentes", extra: [{ name: "skip", isRequired: false }] },
      { type: "anime", id: "rss_anime", name: "Recentes", extra: [{ name: "skip", isRequired: false }] }
    ],
    behaviorHints: {configurable: true}
  };
  if(req.params.userConfig){
    const userConfig = JSON.parse(Buffer.from(req.params.userConfig, 'base64').toString('utf8'));
    const debridInstance = debrid.instance(userConfig);
    manifest.name += ` ${debridInstance.shortName}`;
  }
  respond(res, manifest);
});

app.get([
  "/catalog/:type/:id.json",
  "/catalog/:type/:id/:extra.json",
  "/:userConfig/catalog/:type/:id.json",
  "/:userConfig/catalog/:type/:id/:extra.json"
], async (req, res) => {
  const { id, extra } = req.params;
  const catalogTypeMap = {
    rss_movies: "movie",
    rss_series: "series",
    rss_anime:  "anime",
  };
  const catalogType = catalogTypeMap[id];
  if (!catalogType) return respond(res, { metas: [] });

  try {
    let skip = 0;
    if (extra) {
      const match = extra.match(/skip=([0-9]+)/);
      if (match) skip = parseInt(match[1], 10);
    }

    const activeRssItems = await loadRssItemsForType({}, catalogType);
    let raw = await cache.get(`${CATALOG_KEY}:${catalogType}`);
    let items = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
    if (!items.length && activeRssItems.length) {
      console.log(`[Catalog-Debug] reconstruindo ${catalogType} a partir de ${activeRssItems.length} itens RSS`);
      await rebuildRssCatalog(catalogType, activeRssItems);
      raw = await cache.get(`${CATALOG_KEY}:${catalogType}`);
      items = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
    }
    if (!items.length) {
      console.log(`[Catalog-Debug] /catalog/${catalogType}/${id}.json - catálogo RSS vazio`);
      return respond(res, { metas: [] });
    }

    const activeMetaIds = new Set(activeRssItems.map(item => rssCatalogMetaId(item, catalogType)).filter(Boolean));
    const visibleItems = activeMetaIds.size ? items.filter(m => activeMetaIds.has(m.id)) : items;
    const metas = await Promise.all(visibleItems.map(async m => {
      const imdbId = m.id?.startsWith("rssmovie:")
        ? m.id.slice("rssmovie:".length)
        : m.id?.startsWith("rssmeta:")
          ? `tt${m.id.split(":").slice(2).join(":").replace(/^tt/i, "")}`
          : null;
      const enriched = await enrichMetaPtBr(m, imdbId, catalogType);
      return {
        id:          m.id,
        type:        catalogType,
        name:        enriched.name || m.name,
        poster:      enriched.poster || m.poster,
        background:  enriched.background || m.background || null,
        description: enriched.description || m.description || null,
        releaseInfo: enriched.releaseInfo || m.releaseInfo || null,
        imdbRating:  enriched.imdbRating || m.imdbRating || null,
        genres:      enriched.genres || m.genres || null,
      };
    }));

    const filteredMetas = metas.filter(m => m?.id);
    console.log(`[Catalog-Debug] /catalog/${catalogType}/${id}.json - catalog items: ${items.length}, active ids: ${activeMetaIds.size}, filtered: ${filteredMetas.length}`);
    respond(res, { metas: filteredMetas.slice(skip, skip + 100) });  } catch (err) {
    console.error("[Catalog]", err);
    respond(res, { metas: [] });
  }
});

app.get("/:userConfig/meta/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  try {
    if (id.startsWith("rssmovie:")) {
      const ttId = id.slice("rssmovie:".length);
      const r = await fetch(`https://v3-cinemeta.strem.io/meta/movie/${ttId}.json`).then(r => r.json());
      if (r?.meta) return respond(res, { meta: { ...(await enrichMetaPtBr(r.meta, ttId, "movie")), id, type: "movie" } });
      return respond(res, { meta: null });
    }

    const rssMeta = parseRssMetaId(id);
    if (rssMeta) {
      const targetType = "series";
      let baseMeta = {};
      try {
        const r = await fetch(`https://v3-cinemeta.strem.io/meta/series/${rssMeta.metaId}.json`).then(r => r.json());
        baseMeta = r?.meta || {};
      } catch {}
      baseMeta = await enrichMetaPtBr(baseMeta, rssMeta.metaId, targetType);

      const rssItems = await loadRssItemsForType({}, rssMeta.catalogType);
      const videos = buildRssVideos(rssItems, rssMeta.catalogType, rssMeta.metaId);
      if (!baseMeta.name && !videos.length) return respond(res, { meta: null });

      const { videos: _videos, imdb_id: _imdb, moviedb_id: _tmdb, slug: _slug, trailers: _tr, credits_cast: _cc, credits_crew: _cr, ...rest } = baseMeta;
      return respond(res, {
        meta: {
          ...rest,
          id,
          type: "series",
          videos,
          behaviorHints: { hasScheduledVideos: false },
        }
      });
    }

    const cleanId = id.match(/tt\d+/i) ? id.match(/tt\d+/i)[0] : id;
    const targetType = type === "movie" ? "movie" : "series";
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${targetType}/${cleanId}.json`).then(r => r.json());
    if (r?.meta) r.meta = await enrichMetaPtBr(r.meta, cleanId, targetType);
    return respond(res, r || { meta: null });
  } catch (err) {
    console.error("[Meta]", err);
    return respond(res, { meta: null });
  }
});

app.get("/:userConfig/stream/:type/:id.json", limiter, async(req, res) => {

  try {


    const hostname = process.env.REPLIT_DEV_DOMAIN || req.hostname;
    const protocol = hostname.includes('replit.dev') || (req.hostname != 'localhost' && req.hostname != '127.0.0.1') ? 'https' : 'http';

    const publicUrl = `${protocol}://${hostname}`;
    const userConfig = Object.assign(JSON.parse(Buffer.from(req.params.userConfig, 'base64').toString('utf8')), {ip: req.clientIp});

    const rssStreams = await buildRssCatalogStreams(userConfig, req.params.type, req.params.id, publicUrl);
    const streams = rssStreams !== null
      ? rssStreams
      : await jackettio.getStreams(userConfig, req.params.type, req.params.id, publicUrl);

    return respond(res, {streams});

  }catch(err){

    console.log(req.params.id, err);
    return respond(res, {streams: []});

  }

  });

app.use('/:userConfig/qbit/:type/:id/:torrentId/:name?', async(req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }
  try {
    const torrentId = req.params.torrentId;
    let cleanId = torrentId.includes(':') && (torrentId.startsWith('rd:') || torrentId.startsWith('tb:') || torrentId.startsWith('oc:'))
      ? torrentId.split(':').slice(1).join(':')
      : torrentId;

    const infos = await torrentInfos.getById(cleanId);
    if (!infos || !infos.infoHash) {
      return res.status(404).send('Torrent not found or infoHash missing');
    }
    const rssItemForQbit = parseRssItemId(req.params.id);
    const parsedForQbit = rssItemForQbit
      ? { season: rssItemForQbit.season ?? 0, episode: rssItemForQbit.episode ?? 0 }
      : jackettio.parseStremioId(req.params.id);
    const { season, episode } = parsedForQbit;
    const file = jackettio.getFile(infos.files || [], req.params.type, season, episode) || {};
    const fileIdx = file.idx ?? null;
    const fileName = file.name || null;

    let torrentBuffer = null;
    let magnet = null;

    if (infos.torrentLocation) {
      try {
        torrentBuffer = readFileSync(infos.torrentLocation);
      } catch(err) {
        console.warn("[qBit] Falha ao ler arquivo .torrent local:", err.message);
      }
    }

    if (!torrentBuffer) {
      if (infos.magnetUrl && infos.magnetUrl.startsWith('magnet:')) {
        magnet = infos.magnetUrl;
      } else if (infos.link && infos.link.startsWith('magnet:')) {
        magnet = infos.link;
      } else {
        magnet = `magnet:?xt=urn:btih:${infos.infoHash}`;
      }
      const trackers = getExtraTrackers();
      for (const tr of trackers) {
        if (!magnet.includes(encodeURIComponent(tr))) {
          magnet += `&tr=${encodeURIComponent(tr)}`;
        }
      }
    }

    await ensureTorrentReady(infos.infoHash, {
      torrentBuffer, magnet, fileIdx, fileName, creds: null
    });

    await waitForBuffer(infos.infoHash, fileIdx, fileName, null);
    
    let playable = await getPlayableLocalFile(infos.infoHash, fileIdx, fileName, null);
    if (!playable) {
      res.setHeader("Retry-After", "5");
      return res.status(503).send("Aguardando buffer do qBittorrent...");
    }

    await streamTorrentFile(req, res, infos.infoHash, fileIdx, fileName, null);

  } catch (err) {
    console.error(`[qBit] Falha ao processar:`, err);
    if (!res.headersSent) res.status(503).send(`qBittorrent: ${err.message}`);
  }
});

app.get("/stream/:type/:id.json", async(req, res) => {

  return respond(res, {streams: [{
    name: config.addonName,
    title: `ℹ Kindly configure this addon to access streams.`,
    url: '#'
  }]});

});

app.use('/:userConfig/download/:type/:id/:torrentId/:name?', async(req, res, next) => {

  if (req.method !== 'GET' && req.method !== 'HEAD'){
    return next();
  }

  try {

    const url = await jackettio.getDownload(
      Object.assign(JSON.parse(Buffer.from(req.params.userConfig, 'base64').toString('utf8')), {ip: req.clientIp}),
      req.params.type, 
      req.params.id, 
      req.params.torrentId
    );

    const parsed = new URL(url);
    const cut = (value) => value ?  `${value.substr(0, 5)}******${value.substr(-5)}` : '';
    console.log(`${req.params.id} : Redirect: ${parsed.protocol}//${parsed.host}${cut(parsed.pathname)}${cut(parsed.search)}`);
    
    res.status(302);
    res.set('location', url);
    res.send('');

  }catch(err){

    console.log(req.params.id, err);

    switch(err.message){
      case debrid.ERROR.NOT_READY:
        res.status(302);
        res.set('location', `/videos/not_ready.mp4`);
        res.send('');
        break;
      case debrid.ERROR.EXPIRED_API_KEY:
        res.status(302);
        res.set('location', `/videos/expired_api_key.mp4`);
        res.send('');
        break;
      case debrid.ERROR.NOT_PREMIUM:
        res.status(302);
        res.set('location', `/videos/not_premium.mp4`);
        res.send('');
        break;
      case debrid.ERROR.ACCESS_DENIED:
        res.status(302);
        res.set('location', `/videos/access_denied.mp4`);
        res.send('');
        break;
      case debrid.ERROR.TWO_FACTOR_AUTH:
        res.status(302);
        res.set('location', `/videos/two_factor_auth.mp4`);
        res.send('');
        break;
      default:
        res.status(302);
        res.set('location', `/videos/error.mp4`);
        res.send('');
    }

  }

});

app.use((req, res) => {
  if (req.xhr) {
    res.status(404).send({ error: 'Page not found!' })
  } else {
    res.status(404).send('Page not found!');
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack)
  if (req.xhr) {
    res.status(500).send({ error: 'Something broke!' })
  } else {
    res.status(500).send('Something broke!');
  }
})

const server = app.listen(config.port, async () => {

  console.log('───────────────────────────────────────');
  console.log(`Started addon ${addon.name} v${addon.version}`);
  console.log(`Server listen at: http://localhost:${config.port}`);
  console.log('───────────────────────────────────────');

  let tunnel;
  if(config.localtunnel){
    let subdomain = await cache.get('localtunnel:subdomain');
    tunnel = await localtunnel({port: config.port, subdomain});
    await cache.set('localtunnel:subdomain', tunnel.clientId, {ttl: 86400*365});
    console.log(`Your addon is available on the following address: ${tunnel.url}/configure`);
    tunnel.on('close', () => console.log("tunnels are closed"));
  }

  const intervals = [];
  createTorrentFolder();
  intervals.push(setInterval(cleanTorrentFolder, 3600e3));
  
  if (config.jackettUrl && config.jackettApiKey) {
    startRssPoller(config.jackettUrl, config.jackettApiKey);
  }

  vacuumCache().catch(err => console.log(`Failed to vacuum cache: ${err}`));
  intervals.push(setInterval(() => vacuumCache(), 86400e3*7));

  cleanCache().catch(err => console.log(`Failed to clean cache: ${err}`));
  intervals.push(setInterval(() => cleanCache(), 3600e3));

  function closeGracefully(signal) {
    console.log(`Received signal to terminate: ${signal}`);
    if(tunnel)tunnel.close();
    intervals.forEach(interval => clearInterval(interval));
    server.close(() => {
      console.log('Server closed');
      process.kill(process.pid, signal);
    });
  }
  process.once('SIGINT', closeGracefully);
  process.once('SIGTERM', closeGracefully);

});
