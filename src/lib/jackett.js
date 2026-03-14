import crypto from 'crypto';
import {Parser} from "xml2js";
import config from './config.js';
import cache from './cache.js';
import {numberPad, parseWords} from './util.js';

export const CATEGORY = {
  MOVIE: 2000,
  SERIES: 5000
};

// --- CONFIGURAÇÃO MULTI-CLIENTE (Jackett / Prowlarr) ---
const rawUrls = (process.env.JACKETT_URL || config.jackettUrl || 'http://jackett:9117').split(',');
const rawKeys = (process.env.JACKETT_API_KEY || config.jackettApiKey || '').split(',');

const jackettClients = rawUrls.map((url, index) => ({
  id: index,
  url: url.trim().replace(/\/$/, ''),
  apiKey: (rawKeys[index] || rawKeys[0] || '').trim(),
  type: 'unknown',
  sourceName: null,
  isCache: false
})).filter(c => c.url.startsWith('http'));

// --- CLIENTES TORZNAB DIRETOS (StremThru, Bitmagnet, Zilean) ---
// Fontes marcadas como isCache=true têm seus resultados tratados como já cacheados no debrid.
// StremThru e Zilean indexam conteúdo de caches de debrid, portanto isCached=true por padrão.
// Bitmagnet é um indexador geral (P2P), tratado como não-cacheado normalmente.
const TORZNAB_SOURCES = [
  { name: 'stremthru', urlKey: 'STREMTHRU_URL', keyKey: 'STREMTHRU_API_KEY', isCache: true  },
  { name: 'bitmagnet', urlKey: 'BITMAGNET_URL',  keyKey: 'BITMAGNET_API_KEY', isCache: false },
  { name: 'zilean',    urlKey: 'ZILEAN_URL',      keyKey: 'ZILEAN_API_KEY',    isCache: true  },
];

const torznabClients = [];
let _torznabIdStart = jackettClients.length;

TORZNAB_SOURCES.forEach(({ name, urlKey, keyKey, isCache }) => {
  const url = (process.env[urlKey] || config[`${name}Url`] || '').trim();
  if (url && url.startsWith('http')) {
    torznabClients.push({
      id: _torznabIdStart++,
      url: url.replace(/\/$/, ''),
      apiKey: (process.env[keyKey] || config[`${name}ApiKey`] || '').trim(),
      type: 'torznab',
      sourceName: name,
      isCache
    });
    console.log(`[TORZNAB] Fonte registrada: ${name} → ${url} (isCache=${isCache})`);
  }
});

// Lista unificada de todos os clientes
const clients = [...jackettClients, ...torznabClients];

// --- DETECÇÃO ---
async function detectClientType(client) {
  // Clientes torznab já têm o tipo definido na inicialização
  if (client.type !== 'unknown') return client.type;
  try {
    const url = `${client.url}/api/v2.0/indexers/all/results/torznab/t?apikey=${client.apiKey}&t=indexers&configured=true`;
    const res = await fetch(url);
    if (res.ok && (await res.text()).includes('<indexers>')) return client.type = 'jackett';
  } catch (e) {}
  try {
    const url = `${client.url}/api/v1/indexer?apikey=${client.apiKey}`;
    const res = await fetch(url);
    if (res.ok && Array.isArray(await res.json())) return client.type = 'prowlarr';
  } catch (e) {}
  return client.type = 'error';
}

// --- BUSCA UNIFICADA ---
async function searchAllClients(query) {
  let targetClients = clients;
  let specificIndexerId = query.indexer || 'all';

  if (specificIndexerId !== 'all' && specificIndexerId.includes(':')) {
    const parts = specificIndexerId.split(':');
    const cId = parseInt(parts[0]);
    specificIndexerId = parts.slice(1).join(':'); 
    targetClients = clients.filter(c => c.id === cId);
  }

  const promises = targetClients.map(async (client) => {
    const type = await detectClientType(client);
    if (type === 'error') return [];

    try {
      if (type === 'jackett') {
        const params = new URLSearchParams({
           apikey: client.apiKey,
           t: query.t,
           cat: query.cat || '',
           q: query.q || ''
        });
        const apiPath = specificIndexerId === 'all' 
            ? '/api/v2.0/indexers/all/results/torznab/api' 
            : `/api/v2.0/indexers/${specificIndexerId}/results/torznab/api`;
        const url = `${client.url}${apiPath}?${params.toString()}`;
        
        const t0 = Date.now();
        let data;
        const res = await fetch(url);
        if(res.headers.get('content-type')?.includes('application/json')){
          data = await res.json();
        } else {
          const text = await res.text();
          const parser = new Parser({explicitArray: false, ignoreAttrs: false});
          data = await parser.parseStringPromise(text);
        }

        if (query.t === 'indexers') return normalizeIndexers(data?.indexers?.indexer || [], client.id);
        const items = normalizeItems(data?.rss?.channel?.item || [], client.id);

        // Log de timing e resultado por indexador
        if (query.t !== 'indexers') {
          const elapsed = Date.now() - t0;
          const byIndexer = items.reduce((acc, i) => {
            const name = i.indexerId || 'unknown';
            acc[name] = (acc[name] || 0) + 1;
            return acc;
          }, {});
          const indexerSummary = Object.entries(byIndexer).map(([k, v]) => `${k}:${v}`).join(', ');
          console.log(`[JACKETT] client=${client.id} | ${elapsed}ms | total=${items.length} | q="${query.q || ''}" | ${indexerSummary || 'sem resultados'}`);
        }

        return items;

      } else if (type === 'prowlarr') {
        if (query.t === 'indexers') {
            const url = `${client.url}/api/v1/indexer?apikey=${client.apiKey}`;
            const json = await (await fetch(url)).json();
            return normalizeProwlarrIndexers(json, client.id);
        } else {
            const params = new URLSearchParams();
            params.append('apikey', client.apiKey);
            
            if (query.cat === CATEGORY.MOVIE) {
                params.append('type', 'movie');
            } else if (query.cat === CATEGORY.SERIES) {
                params.append('type', 'tvSearch');
                const q = query.q || '';
                const sMatch = q.match(/S(\d+)/i);
                const eMatch = q.match(/E(\d+)/i);
                if (sMatch) params.append('seasonNumber', parseInt(sMatch[1]));
                if (eMatch) params.append('episodeNumber', parseInt(eMatch[1]));
            } else {
                params.append('type', 'search');
            }

            let cleanQuery = query.q || '';
            cleanQuery = cleanQuery.replace(/S\d+E\d+/i, '').replace(/S\d+/i, '').trim();
            if (cleanQuery) params.append('query', cleanQuery);

            if (specificIndexerId !== 'all') params.append('indexerIds', specificIndexerId);

            const url = `${client.url}/api/v1/search?${params.toString()}`;
            const t0 = Date.now();
            const json = await (await fetch(url)).json();
            const items = normalizeProwlarrItems(json);

            const elapsed = Date.now() - t0;
            const byIndexer = items.reduce((acc, i) => {
              const name = i.indexerId || 'unknown';
              acc[name] = (acc[name] || 0) + 1;
              return acc;
            }, {});
            const indexerSummary = Object.entries(byIndexer).map(([k, v]) => `${k}:${v}`).join(', ');
            console.log(`[PROWLARR] client=${client.id} | ${elapsed}ms | total=${items.length} | q="${cleanQuery}" | ${indexerSummary || 'sem resultados'}`);

            return items;
        }
      }
      // Clientes torznab (stremthru, zilean, bitmagnet) não participam da busca —
      // são usados exclusivamente como verificadores de cache em searchCacheSources().
    } catch (e) { return []; }
  });

  const results = await Promise.all(promises);
  return results.flat();
}

// --- EXPORTAÇÕES ---
export async function searchMovieTorrents({indexer, name, year}){
  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:movie:${indexer}:${name}:${year}`;
  let items = await cache.get(cacheKey);
  if(!items){
    items = await searchAllClients({t: 'search', cat: CATEGORY.MOVIE, q: name, indexer: indexer});
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }
  return items;
}
export async function searchSerieTorrents({indexer, name, year}){
  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:serie:${indexer}:${name}:${year}`;
  let items = await cache.get(cacheKey);
  if(!items){
    items = await searchAllClients({t: 'search', cat: CATEGORY.SERIES, q: `${name}`, indexer: indexer});
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }
  return items;
}
export async function searchSeasonTorrents({indexer, name, year, season}){
  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:season:${indexer}:${name}:${year}:${season}`;
  let items = await cache.get(cacheKey);
  if(!items){
    items = await searchAllClients({t: 'search', cat: CATEGORY.SERIES, q: `${name} S${numberPad(season)}`, indexer: indexer});
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }
  return items;
}
export async function searchEpisodeTorrents({indexer, name, year, season, episode}){
  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:episode:${indexer}:${name}:${year}:${season}:${episode}`;
  let items = await cache.get(cacheKey);
  if(!items){
    items = await searchAllClients({t: 'search', cat: CATEGORY.SERIES, q: `${name} S${numberPad(season)}E${numberPad(episode)}`, indexer: indexer});
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }
  return items;
}

// Retorna apenas indexadores Jackett/Prowlarr — fontes torznab são usadas
// exclusivamente como verificadores de cache em searchCacheSources().
export async function getIndexers(){
  return searchAllClients({t: 'indexers', configured: 'true'});
}

/**
 * Busca nas fontes torznab (StremThru, Zilean, Bitmagnet) pelo título
 * e retorna um Set com todos os infoHashes encontrados.
 *
 * Esses hashes são comparados com os torrents vindos do Jackett para
 * determinar quais já estão cacheados no debrid — sem precisar chamar
 * a API do debrid para cada um.
 */
export async function searchCacheSources({ q }) {
  if (torznabClients.length === 0) return new Set();

  const results = await Promise.all(
    torznabClients.map(async (client) => {
      try {
        const params = new URLSearchParams({ t: 'search', q });
        if (client.apiKey) params.set('apikey', client.apiKey);
        const url = `${client.url}?${params.toString()}`;
        const t0 = Date.now();

        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`[TORZNAB:${client.sourceName.toUpperCase()}] HTTP ${res.status} | q="${q}"`);
          return [];
        }

        const text = await res.text();
        let data;
        try {
          const parser = new Parser({ explicitArray: false, ignoreAttrs: false });
          data = await parser.parseStringPromise(text);
        } catch (parseErr) {
          console.error(`[TORZNAB:${client.sourceName.toUpperCase()}] Erro parse XML: ${parseErr.message}`);
          return [];
        }

        const rawItems = data?.rss?.channel?.item;
        const itemList = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : [];

        const hashes = itemList.map(raw => {
          try {
            const item = mergeDollarKeys(raw);
            const attrRaw = item['torznab:attr'];
            const attrs = {};
            if (attrRaw) {
              const attrList = Array.isArray(attrRaw) ? attrRaw : [attrRaw];
              for (const a of attrList) {
                const merged = mergeDollarKeys(a);
                if (merged.name) attrs[merged.name] = merged.value;
              }
            }
            let hash = (attrs.infohash || '').toLowerCase();
            const magnet = attrs.magneturl || item.link || '';
            if (!hash && magnet) hash = extractHash(magnet);
            return hash || null;
          } catch { return null; }
        }).filter(Boolean);

        console.log(`[TORZNAB:${client.sourceName.toUpperCase()}] ${Date.now()-t0}ms | hashes=${hashes.length} | q="${q}"`);
        return hashes;
      } catch (e) {
        console.error(`[TORZNAB:${client.sourceName.toUpperCase()}] Erro: ${e.message}`);
        return [];
      }
    })
  );

  const allHashes = new Set(results.flat());
  console.log(`[TORZNAB] total hashes de cache sources: ${allHashes.size}`);
  return allHashes;
}

// --- NORMALIZADORES E EXTRAÇÃO DE DETALHES ---

function extractHash(magnet) {
    if(!magnet) return '';
    try { magnet = decodeURIComponent(magnet); } catch(e){}
    const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    return match ? match[1].toLowerCase() : '';
}

// EXTRAÇÃO VISUAL (Tags)
function extractDetails(title) {
    const details = { audio: [], video: [], other: [] };
    if (!title) return details;
    
    title = title.toUpperCase();

    // Áudio
    if (title.match(/\b(DUAL|MULTI)\b/)) details.audio.push('DUAL');
    if (title.match(/\b(DUB|DUBLADO)\b/)) details.audio.push('DUB');
    if (title.match(/\b(LEG|LEGENDADO)\b/)) details.audio.push('LEG');
    if (title.match(/\b(5\.1)\b/)) details.audio.push('5.1');
    if (title.match(/\b(7\.1)\b/)) details.audio.push('7.1');
    if (title.match(/\b(ATMOS)\b/)) details.audio.push('ATMOS');

    // Vídeo
    if (title.match(/\b(2160P|4K)\b/)) details.video.push('4K');
    else if (title.match(/\b(1080P|FHD)\b/)) details.video.push('1080p');
    else if (title.match(/\b(720P|HD)\b/)) details.video.push('720p');
    
    if (title.match(/\b(HDR|HDR10)\b/)) details.video.push('HDR');
    if (title.match(/\b(DV|DOLBY VISION)\b/)) details.video.push('DV');
    if (title.match(/\b(IMAX)\b/)) details.video.push('IMAX');

    // Codecs
    if (title.match(/\b(H265|X265|HEVC)\b/)) details.other.push('HEVC');
    else if (title.match(/\b(H264|X264|AVC)\b/)) details.other.push('x264');

    return details;
}


function normalizeItems(items, clientId){
  return forceArray(items).map(item => {
    item = mergeDollarKeys(item);
    const attr = item['torznab:attr'].reduce((obj, item) => {
      obj[item.name] = item.value;
      return obj;
    }, {});
    const quality = item.title.match(/(2160|1080|720|480|360)p/);
    const title = parseWords(item.title).join(' ');
    const year = item.title.replace(quality ? quality[1] : '', '').match(/(19|20[\d]{2})/);
    
    let infoHash = attr.infohash || extractHash(attr.magneturl);
    let magnet = attr.magneturl || '';
    if (!magnet && item.link && item.link.startsWith('magnet:')) {
        magnet = item.link;
        if (!infoHash) infoHash = extractHash(magnet);
    }

    return {
      name: item.title,
      guid: item.guid,
      indexerId: item.jackettindexer.id || item.jackettindexer, 
      id: crypto.createHash('sha1').update(item.guid).digest('hex'),
      size: parseInt(item.size),
      link: item.link,
      seeders: parseInt(attr.seeders || 0),
      peers: parseInt(attr.peers || 0),
      infoHash: infoHash,
      magneturl: magnet, 
      type: item.type,
      quality: quality ? parseInt(quality[1]) : 0,
      year: year ? parseInt(year.pop()) : 0,
      languages: config.languages.filter(lang => title.match(lang.pattern)),
      details: extractDetails(item.title) // Injeta os detalhes
    };
  });
}

function normalizeIndexers(items, clientId){
  return forceArray(items)
    .filter(item => item.configured === 'true' || item.configured === true)
    .map(item => {
      item = mergeDollarKeys(item);
      const searching = item.caps.searching;
      return {
        id: `${clientId}:${item.id}`,
        configured: true,
        title: item.title,
        language: item.language,
        type: item.type,
        categories: forceArray(item.caps.categories.category).map(category => parseInt(category.id)),
        searching: {
          movie: { available: searching['movie-search'].available == 'yes', supportedParams: searching['movie-search'].supportedParams.split(',') },
          series: { available: searching['tv-search'].available == 'yes', supportedParams: searching['tv-search'].supportedParams.split(',') }
        }
      };
  });
}

function normalizeProwlarrItems(items){
  return items.map(item => {
    const quality = item.title.match(/(2160|1080|720|480|360)p/);
    const title = parseWords(item.title).join(' ');
    const year = item.title.replace(quality ? quality[1] : '', '').match(/(19|20[\d]{2})/);
    
    const guid = item.downloadUrl || item.magnetUrl || item.infoHash;
    let infoHash = item.infoHash || extractHash(item.magnetUrl || item.downloadUrl);

    return {
      name: item.title,
      guid: guid,
      indexerId: item.indexer,
      id: crypto.createHash('sha1').update(guid).digest('hex'),
      size: parseInt(item.size),
      link: item.downloadUrl || item.magnetUrl,
      seeders: item.seeders || 0,
      peers: item.leechers || 0,
      infoHash: infoHash,
      magneturl: item.magnetUrl || item.downloadUrl || '', 
      type: 'movie', 
      quality: quality ? parseInt(quality[1]) : 0,
      year: year ? parseInt(year.pop()) : 0,
      languages: config.languages.filter(lang => title.match(lang.pattern)),
      details: extractDetails(item.title) // Injeta os detalhes
    };
  });
}

function normalizeProwlarrIndexers(items, clientId){
    return items.filter(item => item.enable === true).map(item => ({
        id: `${clientId}:${item.id}`,
        configured: true,
        title: item.name,
        language: item.language || 'en-US',
        type: 'public',
        categories: [2000, 5000],
        searching: { movie: { available: true, supportedParams: ['q'] }, series: { available: true, supportedParams: ['q'] } }
    }));
}

function mergeDollarKeys(item){
  if(item.$){ item = {...item.$, ...item}; delete item.$; }
  for(let key in item){ if(typeof(item[key]) === 'object'){ item[key] = mergeDollarKeys(item[key]); } }
  return item;
}
function forceArray(value){ return Array.isArray(value) ? value : [value]; }
