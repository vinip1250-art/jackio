/**
 * stremthruCache.js — Verificação de cache debrid via API REST do StremThru
 *
 * Usa o endpoint: GET /v0/store/magnets/check?magnet=h1,h2,...
 * Header: X-StremThru-Store-Name: realdebrid | torbox | alldebrid | ...
 * Header: X-StremThru-Store-Authorization: Bearer <debridApiKey>
 *
 * IMPORTANTE: o <debridApiKey> é a chave do SERVIÇO DEBRID do usuário,
 * não a chave do StremThru. O StremThru age como proxy para a API do debrid.
 *
 * A STREMTHRU_URL é o endpoint torznab (ex: https://host/v0/torznab/api).
 * A base para o cache check é derivada removendo o path torznab.
 * Ex: "https://host/v0/torznab/api" → base "https://host"
 *     "https://host/stremthru/torznab/api" → base "https://host"
 */

import config from '../config.js';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const CHUNK_SIZE    = 100;   // hashes por requisição (reduzido para evitar URLs gigantes e timeouts)
const CONCURRENCY   = 4;     // chunks simultâneos por store
const TIMEOUT_MS    = 10_000;
const MAX_RETRIES   = 2;
const RETRY_BASE_MS = 300;   // dobra a cada retry: 300ms → 600ms
const CACHE_TTL_MS  = 5 * 60 * 1000; // 5 minutos de cache em memória

const STORE_NAME_MAP = {
  realdebrid: 'realdebrid',
  torbox:     'torbox',
  alldebrid:  'alldebrid',
  premiumize: 'premiumize',
  debridlink: 'debridlink',
};

// ---------------------------------------------------------------------------
// Base URL (resolvida uma única vez — lazy singleton)
// ---------------------------------------------------------------------------

let _baseUrl = undefined;

function getStremThruBase() {
  if (_baseUrl !== undefined) return _baseUrl;
  const raw = process.env.STREMTHRU_URL || config.stremthruUrl || '';
  if (!raw) { _baseUrl = null; return null; }
  // Extrai só o host: "https://host/v0/torznab/api" → "https://host"
  const m = raw.match(/^(https?:\/\/[^/]+)/);
  _baseUrl = m ? m[1] : null;
  return _baseUrl;
}

// ---------------------------------------------------------------------------
// Cache local em memória: evita re-consultas para hashes já verificados
// Chave: `${storeName}:${hash}` → { cached: boolean, expiresAt: number }
// ---------------------------------------------------------------------------

const _memCache = new Map();

function _getLocal(store, hash) {
  const entry = _memCache.get(`${store}:${hash}`);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _memCache.delete(`${store}:${hash}`); return undefined; }
  return entry.cached;
}

function _setLocal(store, hash, cached) {
  _memCache.set(`${store}:${hash}`, { cached, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Limpa entradas expiradas do cache em memória (opcional, para controle de memória). */
export function purgeExpiredCache() {
  const now = Date.now();
  for (const [key, entry] of _memCache) {
    if (now > entry.expiresAt) _memCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidHash(h) {
  return typeof h === 'string' && /^[0-9a-fA-F]{40}$/.test(h);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Verifica um chunk de hashes contra o StremThru com retry + backoff exponencial.
 * @returns {Set<string>} hashes cacheados (lowercase)
 */
async function fetchChunk(base, storeName, apiKey, chunk) {
  // Endpoint correto da API StremThru: GET /v0/store/magnets/check?magnet=hash1,hash2,...
  // (não /v0/store/cached/check que não existe e retorna 404)
  const url = `${base}/v0/store/magnets/check?magnet=${chunk.join(',')}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'X-StremThru-Store-Name':          storeName,
          'X-StremThru-Store-Authorization': `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        console.warn(`[StremThruCache] HTTP ${res.status} store=${storeName} tentativa ${attempt + 1}`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_MS * 2 ** attempt); continue; }
        return new Set();
      }

      const data = await res.json();
      const result = new Set();
      for (const item of (data?.data?.items ?? [])) {
        if (item.status === 'cached' && item.hash) {
          result.add(item.hash.toLowerCase());
        }
      }
      return result;

    } catch (e) {
      console.warn(`[StremThruCache] Erro store=${storeName} tentativa ${attempt + 1}: ${e.message}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  return new Set();
}

/**
 * Executa tasks[] com no máximo `limit` em paralelo.
 */
async function pLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Verifica quais hashes estão em cache num serviço debrid via StremThru.
 *
 * @param {string[]} hashes    - Array de infoHashes hex (40 chars)
 * @param {string}   store     - ID do serviço ('realdebrid', 'torbox', 'alldebrid', ...)
 * @param {string}   apiKey    - API key do serviço debrid do usuário (NÃO a do StremThru)
 * @returns {Promise<Set<string>>} Set de hashes cacheados (lowercase hex)
 */
export async function checkCacheViaStremThru(hashes, store, apiKey, baseUrl) {
  const base = baseUrl || getStremThruBase();
  if (!base || !hashes.length || !apiKey) return new Set();

  const storeName = STORE_NAME_MAP[store] ?? store;
  const cachedSet = new Set();

  // Separa hashes já resolvidos pelo cache local de memória
  const toFetch = [];
  for (const h of hashes) {
    if (!isValidHash(h)) continue;
    const lower = h.toLowerCase();
    const local = _getLocal(storeName, lower);
    if (local === undefined) {
      toFetch.push(lower);
    } else if (local === true) {
      cachedSet.add(lower);
    }
  }

  if (toFetch.length === 0) {
    return cachedSet;
  }

  // Divide em chunks e despacha em paralelo
  const chunks = [];
  for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
    chunks.push(toFetch.slice(i, i + CHUNK_SIZE));
  }

  const tasks = chunks.map(chunk => () => fetchChunk(base, storeName, apiKey, chunk));
  const chunkResults = await pLimit(tasks, CONCURRENCY);

  // Consolida resultados e popula cache local (hits e misses)
  for (const result of chunkResults) {
    for (const h of result) cachedSet.add(h);
  }
  for (const h of toFetch) {
    _setLocal(storeName, h, cachedSet.has(h));
  }

  console.log(
    `[StremThruCache] store=${storeName} | ${cachedSet.size} cached de ${hashes.length} hashes` +
    ` (${toFetch.length} consultados, ${hashes.length - toFetch.length} do cache local)`
  );
  return cachedSet;
}

/**
 * Verifica cache em múltiplos stores simultaneamente.
 * Útil para serviços hybrid que usam mais de um debrid.
 *
 * @param {string[]} hashes
 * @param {{ store: string, apiKey: string }[]} stores
 * @returns {Promise<Map<string, Set<string>>>} Map de store → Set de hashes cacheados
 */
export async function checkCacheMultiStore(hashes, stores) {
  const entries = await Promise.all(
    stores.map(async ({ store, apiKey }) => [
      store,
      await checkCacheViaStremThru(hashes, store, apiKey)
    ])
  );
  return new Map(entries);
}
