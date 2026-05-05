import Redis from 'ioredis';
import config from './config.js';

const redisUri = process.env.REDIS_URI || config.redisUri || 'redis://localhost:6379';

// Fallback em memória usado quando Redis está indisponível
const memCache = new Map(); // key → { value, expiresAt }

let redisReady = false;

const client = new Redis(redisUri, {
  retryStrategy: (times) => Math.min(times * 500, 10000),
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

client.connect().catch(() => {}); // conexão assíncrona, erros tratados nos eventos

let _redisLoggedError = false;
client.on('ready',        () => { redisReady = true; _redisLoggedError = false; console.log(`[Cache] Redis conectado: ${redisUri}`); });
client.on('close',        () => { redisReady = false; });
client.on('error',        (err) => { if (!_redisLoggedError) { console.warn(`[Cache] Redis indisponível, usando cache em memória. (${err.message})`); _redisLoggedError = true; } });
client.on('reconnecting', () => {});

const DEFAULT_TTL = 86400; // 24h

// --- Helpers de memória ---
function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { memCache.delete(key); return null; }
  return entry.value;
}

function memSet(key, value, ttl) {
  memCache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}

// --- API pública ---
async function get(key) {
  if (redisReady) {
    try {
      const raw = await client.get(key);
      if (raw !== null) return JSON.parse(raw);
    } catch (e) {
      console.error(`[Cache] get("${key}") erro: ${e.message}`);
    }
  }
  return memGet(key);
}

async function set(key, value, opts = {}) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value) && value.length === 0) return;

  const ttl = opts.ttl ?? DEFAULT_TTL;

  if (redisReady) {
    try {
      await client.set(key, JSON.stringify(value), 'EX', ttl);
      return;
    } catch (e) {
      console.error(`[Cache] set("${key}") erro: ${e.message}`);
    }
  }
  memSet(key, value, ttl);
}

async function del(key) {
  memCache.delete(key);
  if (redisReady) {
    try { await client.del(key); } catch (e) {
      console.error(`[Cache] del("${key}") erro: ${e.message}`);
    }
  }
}

export default { get, set, del };

export async function clean() {}
export async function vacuum() {}
