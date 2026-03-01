import crypto from 'crypto';
import {Parser} from "xml2js";
import config from './config.js';
import cache from './cache.js';
import {numberPad, parseWords} from './util.js';

export const CATEGORY = {
  MOVIE: 2000,
  SERIES: 5000
};

// --- CONFIGURAÇÃO MULTI-CLIENTE ---
const rawUrls = (process.env.JACKETT_URL || config.jackettUrl || 'http://jackett:9117').split(',');
const rawKeys = (process.env.JACKETT_API_KEY || config.jackettApiKey || '').split(',');

const clients = rawUrls.map((url, index) => ({
  id: index,
  url: url.trim().replace(/\/$/, ''),
  apiKey: (rawKeys[index] || rawKeys[0] || '').trim(),
  type: 'unknown'
})).filter(c => c.url.startsWith('http'));

// --- DETECÇÃO ---
async function detectClientType(client) {
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

        let data;
        const res = await fetch(url);
        if (res.headers.get('content-type')?.includes('application/json')) {
          data = await res.json();
        } else {
          const text = await res.text();
          const parser = new Parser({explicitArray: false, ignoreAttrs: false});
          data = await parser.parseStringPromise(text);
        }

        if (query.t === 'indexers') return normalizeIndexers(data?.indexers?.indexer || [], client.id);
        return normalizeItems(data?.rss?.channel?.item || [], client.id);

      } else if (type === 'prowlarr') {
        if (query.t === 'indexers') {
          const url = `${client.url}/api/v1/indexer?apikey=${client.apiKey}`;
          const json = await (await fetch(url)).json();
          return normalizeProwlarrIndexers(json, client.id);
        } else {
          const params = new URLSearchParams();
          params.append('apikey', client.apiKey);

          const isSeries = query.cat === CATEGORY.SERIES;
          const isMovie = query.cat === CATEGORY.MOVIE;

          // Tenta busca específica (tvSearch/movie) primeiro, com fallback para search genérico
          // Necessário porque indexadores como StremThru/Zilean não suportam tvSearch
          const attemptSearch = async (useGeneric) => {
            const p = new URLSearchParams();
            p.append('apikey', client.apiKey);

            if (useGeneric || (!isSeries && !isMovie)) {
              p.append('type', 'search');
              // Na busca genérica mantém S01E01 na query para que o indexador filtre
              if (query.q) p.append('query', query.q);
            } else if (isMovie) {
              p.append('type', 'movie');
              if (query.q) p.append('query', query.q);
            } else {
              // tvSearch: envia season/episode como parâmetros e query sem SxxExx
              p.append('type', 'tvSearch');
              const q = query.q || '';
              const sMatch = q.match(/S(\d+)/i);
              const eMatch = q.match(/E(\d+)/i);
              if (sMatch) p.append('seasonNumber', parseInt(sMatch[1]));
              if (eMatch) p.append('episodeNumber', parseInt(eMatch[1]));
              let cleanQuery = q.replace(/S\d+E\d+/i, '').replace(/S\d+/i, '').trim();
              if (cleanQuery) p.append('query', cleanQuery);
            }

            if (specificIndexerId !== 'all') p.append('indexerIds', specificIndexerId);

            const url = `${client.url}/api/v1/search?${p.toString()}`;
            console.log(`[Prowlarr] GET ${url}`);
            const res = await fetch(url);
            const json = await res.json();

            // Prowlarr retorna objeto com "message" quando há erro
            if (!Array.isArray(json)) {
              console.warn(`[Prowlarr] Resposta não é array (indexer=${specificIndexerId}):`, json?.message || JSON.stringify(json).slice(0, 200));
              return null; // sinaliza falha
            }
            console.log(`[Prowlarr] resultados: ${json.length}`);
            return json;
          };

          let json = null;

          if (isSeries) {
            // Tenta tvSearch primeiro; se falhar (erro ou 0 resultados com erro), usa search genérico
            json = await attemptSearch(false);
            if (json === null) {
              console.log(`[Prowlarr] tvSearch falhou, tentando search genérico...`);
              json = await attemptSearch(true);
            }
          } else {
            json = await attemptSearch(false);
            if (json === null) json = [];
          }

          return normalizeProwlarrItems(json || [], query.cat);
        }
      }
    } catch (e) {
      console.error(`[jackett.js] Erro na busca:`, e.message);
      return [];
    }
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
    items = await searchAllClients({t: 'search', cat: CATEGORY.MOVIE, q: name, indexer});
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }
  return items;
}
export async function searchSerieTorrents({indexer, name, year}){
  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:serie:${indexer}:${name}:${year}`;
  let items = await cache.get(cacheKey);
  if(!items){
    items = await searchAllClients({t: 'search', cat: CATEGORY.SERIES, q: name, indexer});
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }
  return items;
}
export async function searchSeasonTorrents({indexer, name, year, season}){
  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:season:${indexer}:${name}:${year}:${season}`;
  let items = await cache.get(cacheKey);
  if(!items){
    items = await searchAllClients({t: 'search', cat: CATEGORY.SERIES, q: `${name} S${numberPad(season)}`, indexer});
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }
  return items;
}
export async function searchEpisodeTorrents({indexer, name, year, season, episode}){
  indexer = indexer || 'all';
  const cacheKey = `jackettItems:2:episode:${indexer}:${name}:${year}:${season}:${episode}`;
  let items = await cache.get(cacheKey);
  if(!items){
    items = await searchAllClients({t: 'search', cat: CATEGORY.SERIES, q: `${name} S${numberPad(season)}E${numberPad(episode)}`, indexer});
    cache.set(cacheKey, items, {ttl: items.length > 0 ? 3600*36 : 60});
  }
  return items;
}
export async function getIndexers(){
  return searchAllClients({t: 'indexers', configured: 'true'});
}

// --- NORMALIZADORES ---

function extractHash(magnet) {
  if (!magnet) return '';
  try { magnet = decodeURIComponent(magnet); } catch(e) {}
  const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
  return match ? match[1].toLowerCase() : '';
}

function extractDetails(title) {
  const details = { audio: [], video: [], other: [] };
  if (!title) return details;
  title = title.toUpperCase();

  if (title.match(/\b(DUAL|MULTI)\b/)) details.audio.push('DUAL');
  if (title.match(/\b(DUB|DUBLADO)\b/)) details.audio.push('DUB');
  if (title.match(/\b(LEG|LEGENDADO)\b/)) details.audio.push('LEG');
  if (title.match(/\b5\.1\b/)) details.audio.push('5.1');
  if (title.match(/\b7\.1\b/)) details.audio.push('7.1');
  if (title.match(/\bATMOS\b/)) details.audio.push('ATMOS');

  if (title.match(/\b(2160P|4K)\b/)) details.video.push('4K');
  else if (title.match(/\b(1080P|FHD)\b/)) details.video.push('1080p');
  else if (title.match(/\b(720P|HD)\b/)) details.video.push('720p');

  if (title.match(/\bHDR10?\b/)) details.video.push('HDR');
  if (title.match(/\b(DV|DOLBY VISION)\b/)) details.video.push('DV');
  if (title.match(/\bIMAX\b/)) details.video.push('IMAX');

  if (title.match(/\b(H265|X265|HEVC)\b/)) details.other.push('HEVC');
  else if (title.match(/\b(H264|X264|AVC)\b/)) details.other.push('x264');

  return details;
}

function normalizeItems(items, clientId){
  return forceArray(items).map(item => {
    item = mergeDollarKeys(item);
    const attr = (item['torznab:attr'] || []).reduce((obj, a) => {
      obj[a.name] = a.value;
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
      indexerId: item.jackettindexer?.id || item.jackettindexer,
      indexerName: item.jackettindexer?._ || '',
      id: crypto.createHash('sha1').update(String(item.guid)).digest('hex'),
      size: parseInt(item.size),
      link: item.link,
      seeders: parseInt(attr.seeders || 0),
      peers: parseInt(attr.peers || 0),
      infoHash,
      magnetUrl: magnet,
      magneturl: magnet,
      type: item.type || 'public',
      quality: quality ? parseInt(quality[1]) : 0,
      year: year ? parseInt(year.pop()) : 0,
      languages: config.languages.filter(lang => title.match(lang.pattern)),
      details: extractDetails(item.title)
    };
  });
}

function normalizeIndexers(items, clientId){
  return forceArray(items)
    .filter(item => item.configured === 'true' || item.configured === true)
    .map(item => {
      item = mergeDollarKeys(item);
      const searching = item.caps?.searching || {};
      return {
        id: `${clientId}:${item.id}`,
        configured: true,
        title: item.title,
        language: item.language,
        type: item.type,
        categories: forceArray(item.caps?.categories?.category || []).map(c => parseInt(c.id)),
        searching: {
          movie: { available: searching['movie-search']?.available === 'yes', supportedParams: (searching['movie-search']?.supportedParams || '').split(',') },
          series: { available: searching['tv-search']?.available === 'yes', supportedParams: (searching['tv-search']?.supportedParams || '').split(',') }
        }
      };
    });
}

function normalizeProwlarrItems(items, cat){
  if (!Array.isArray(items)) return [];
  // Deriva o tipo a partir da categoria da busca (não do item individual)
  const isSeriesSearch = cat === CATEGORY.SERIES;

  return items.map(item => {
    const quality = (item.title || '').match(/(2160|1080|720|480|360)p/);
    const title = parseWords(item.title || '').join(' ');
    const year = (item.title || '').replace(quality ? quality[1] : '', '').match(/(19|20[\d]{2})/);

    const guid = item.guid || item.downloadUrl || item.magnetUrl || item.infoHash || item.title;
    let infoHash = item.infoHash || extractHash(item.magnetUrl || item.downloadUrl);

    const downloadUrl = item.downloadUrl && !item.downloadUrl.startsWith('magnet:')
      ? item.downloadUrl
      : '';
    const magnetUrl = item.magnetUrl || (item.downloadUrl?.startsWith('magnet:') ? item.downloadUrl : '') || '';

    const isPrivate = item.protocol === 'torrent' && (
      item.indexerFlags?.includes('private') ||
      item.indexerFlags?.some?.(f => typeof f === 'string' && f.toLowerCase().includes('private'))
    );

    return {
      name: item.title,
      guid,
      indexerId: item.indexer,
      indexerName: item.indexer,
      id: crypto.createHash('sha1').update(String(guid)).digest('hex'),
      size: parseInt(item.size) || 0,
      link: downloadUrl,
      magnetUrl,
      magneturl: magnetUrl,
      seeders: item.seeders || 0,
      peers: item.leechers || 0,
      infoHash,
      // Usa a categoria da busca para determinar o tipo — não hardcoda 'movie'
      type: isPrivate ? 'private' : 'public',
      quality: quality ? parseInt(quality[1]) : 0,
      year: year ? parseInt(year.pop()) : 0,
      languages: config.languages.filter(lang => title.match(lang.pattern)),
      details: extractDetails(item.title)
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
    // Prowlarr suporta ambos os tipos de busca
    searching: {
      movie: { available: true, supportedParams: ['q'] },
      series: { available: true, supportedParams: ['q'] }
    }
  }));
}

function mergeDollarKeys(item){
  if (item.$) { item = {...item.$, ...item}; delete item.$; }
  for (let key in item) {
    if (typeof item[key] === 'object') { item[key] = mergeDollarKeys(item[key]); }
  }
  return item;
}
function forceArray(value){ return Array.isArray(value) ? value : (value ? [value] : []); }
