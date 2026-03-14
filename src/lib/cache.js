import Redis from 'ioredis';
import config from './config.js';

const redisUri = process.env.REDIS_URI || config.redisUri || 'redis://localhost:6379';

const client = new Redis(redisUri, {
  retryStrategy: (times) => Math.min(times * 200, 5000),
  enableOfflineQueue: false,
  lazyConnect: false,
  maxRetriesPerRequest: 1,
});

client.on('connect',      () => console.log(`[Cache] Redis conectado: ${redisUri}`));
client.on('error',        (err) => console.error(`[Cache] Redis erro: ${err.message}`));
client.on('reconnecting', () => console.log('[Cache] Redis reconectando...'));

const DEFAULT_TTL = 86400; // 24h

async function get(key) {
  try {
    const raw = await client.get(key);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[Cache] get("${key}") erro: ${e.message}`);
    return null;
  }
}

async function set(key, value, opts = {}) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value) && value.length === 0) return;

  const ttl = opts.ttl ?? DEFAULT_TTL;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttl);
  } catch (e) {
    console.error(`[Cache] set("${key}") erro: ${e.message}`);
  }
}

async function del(key) {
  try {
    await client.del(key);
  } catch (e) {
    console.error(`[Cache] del("${key}") erro: ${e.message}`);
  }
}

export default { get, set, del };

export async function clean() {}
export async function vacuum() {}
