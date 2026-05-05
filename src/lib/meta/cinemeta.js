import cache from '../cache.js';
import { wait } from '../util.js';

const CINEMETA_BASE_URLS = [
  'https://v3-cinemeta.strem.io',
  'https://cinemeta-live.strem.io'
];
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAYS_MS = [300, 900];
const TRANSIENT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
]);

function isTransientError(err) {
  return err?.name === 'AbortError'
    || TRANSIENT_ERROR_CODES.has(err?.code)
    || TRANSIENT_ERROR_CODES.has(err?.cause?.code);
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url;
}

export default class Cinemeta {

  static id = 'cinemeta';
  static name = 'Cinemeta';

  async getMovieById(id){
    
    const data = await this.#request('GET', `/meta/movie/${id}.json`, {}, {key: id, ttl: 3600*3});
    const meta = data.meta;

    return {
      name: meta.name,
      year: parseInt(meta.releaseInfo),
      imdb_id: meta.imdb_id,
      type: 'movie',
      stremioId: id,
      id,
    };

  }

  async getEpisodeById(id, season, episode){

    const data = await this.#request('GET', `/meta/series/${id}.json`, {}, {key: id, ttl: 3600*3});
    const meta = data.meta;

    return {
      name: meta.name,
      year: parseInt(`${meta.releaseInfo}`.split('-').shift()),
      imdb_id: meta.imdb_id,
      type: 'series',
      stremioId: `${id}:${season}:${episode}`,
      id,
      season,
      episode,
      episodes: (meta.videos || []).map(video => {
        return {
          season: video.season,
          episode: video.number,
          stremioId: video.id
        }
      })
    };

  }

  async getLanguages(){
    return [];
  }

  async #fetchJson(baseUrl, method, path, opts){
    const url = buildUrl(baseUrl, path, opts.query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        ...opts,
        method,
        signal: controller.signal
      });
      const text = await res.text();
      let data;

      try {
        data = JSON.parse(text);
      } catch {
        const err = new Error(`Invalid Cinemeta api result from ${baseUrl}: non-json response`);
        err.status = res.status;
        throw err;
      }

      if (!res.ok) {
        const err = new Error(`Invalid Cinemeta api result from ${baseUrl}: ${JSON.stringify(data)}`);
        err.status = res.status;
        throw err;
      }

      if (!data?.meta) {
        throw new Error(`Invalid Cinemeta api result from ${baseUrl}: missing meta`);
      }

      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #request(method, path, opts, cacheOpts){

    cacheOpts = Object.assign({key: '', ttl: 0}, cacheOpts || {});
    opts = opts || {};
    opts = Object.assign({}, opts, {
      headers: Object.assign(opts.headers || {}, {
        'accept': 'application/json'
      })
    });

    let data;

    if(cacheOpts.key){
      data = await cache.get(`cinemeta:${cacheOpts.key}`);
      if(data)return data;
    }

    const errors = [];

    for (const baseUrl of CINEMETA_BASE_URLS) {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          data = await this.#fetchJson(baseUrl, method, path, opts);

          if(data && cacheOpts.key && cacheOpts.ttl > 0){
            await cache.set(`cinemeta:${cacheOpts.key}`, data, {ttl: cacheOpts.ttl})
          }

          return data;
        } catch (err) {
          errors.push(`${baseUrl}: ${err.message}`);

          const canRetrySameHost = isTransientError(err) || err.status >= 500 || err.status === 429;
          if (!canRetrySameHost) break;
          if (attempt < RETRY_DELAYS_MS.length) await wait(RETRY_DELAYS_MS[attempt]);
        }
      }
    }

    throw new Error(`Cinemeta request failed after fallbacks: ${errors.join(' | ')}`);

  }

}
