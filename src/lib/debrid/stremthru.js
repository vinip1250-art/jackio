import { createHash } from 'crypto';
import { ERROR } from './const.js';
import { wait } from '../util.js';
import { checkCacheViaStremThru } from './stremthruCache.js';

const READY = new Set(['cached', 'downloaded']);
const FAILED = new Set(['failed', 'invalid']);

export default class StremThru {
  static id = 'stremthru';
  static name = 'StremThru';
  static shortName = 'ST';
  static configFields = [
    {
      type: 'select',
      name: 'stremthruBaseUrl',
      label: 'Instância StremThru',
      required: true,
      options: [
        { label: 'stremthru.13377001.xyz (Padrão)', value: 'https://stremthru.13377001.xyz' },
        { label: 'stremthru.stremio.ru', value: 'https://stremthru.stremio.ru' },
        { label: 'stremthrufortheweebs.midnightignite.me', value: 'https://stremthrufortheweebs.midnightignite.me' },
        { label: 'Digitar manualmente...', value: '__custom__' },
      ],
    },
    {
      type: 'url',
      name: 'stremthruBaseUrlCustom',
      label: 'URL personalizada da instância StremThru',
      required: false,
      showIf: { field: 'stremthruBaseUrl', value: '__custom__' },
      placeholder: 'https://meu-stremthru.exemplo.com',
    },
    {
      type: 'select',
      name: 'stremthruStoreName',
      label: 'Serviço de Debrid (Store)',
      required: true,
      options: [
        { label: 'Torbox', value: 'torbox' },
        { label: 'Real-Debrid', value: 'realdebrid' },
        { label: 'AllDebrid', value: 'alldebrid' },
        { label: 'Premiumize', value: 'premiumize' },
        { label: 'DebridLink', value: 'debridlink' },
        { label: 'Offcloud', value: 'offcloud' },
        { label: 'Easydebrid', value: 'easydebrid' },
        { label: 'Pikpak', value: 'pikpak' },
      ],
    },
    {
      type: 'password',
      name: 'debridApiKey',
      label: 'API Key do serviço debrid',
      required: true,
    },
  ];

  #baseUrl;
  #storeName;
  #apiKey;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.cacheCheckAvailable = true;
    const rawUrl = String(userConfig.stremthruBaseUrl || '').trim();
    const resolvedUrl = rawUrl === '__custom__'
      ? String(userConfig.stremthruBaseUrlCustom || '').trim()
      : rawUrl;
    this.#baseUrl = resolvedUrl.replace(/\/+$/, '');
    this.#storeName = String(userConfig.stremthruStoreName || '').trim().toLowerCase();
    this.#apiKey = userConfig.debridApiKey;
  }

  async getTorrentsCached(torrents) {
    const byHash = new Map();
    for (const torrent of torrents) {
      const hash = String(torrent.infos?.infoHash || torrent.infoHash || '').toLowerCase();
      if (/^[a-f0-9]{40}$/.test(hash)) {
        byHash.set(hash, torrent);
      }
    }
    if (!byHash.size) return [];

    const hashes = [...byHash.keys()];
    
    // Usar stremthruCache com cache local + retry + backoff
    try {
      const cachedSet = await checkCacheViaStremThru(hashes, this.#storeName, this.#apiKey, this.#baseUrl);
      return [...cachedSet].map(hash => byHash.get(hash)).filter(Boolean);
    } catch (err) {
      console.error(`[StremThru] getTorrentsCached fallback: ${err.message}`);
      // Fallback: verificação direta (sem cache local)
      return this.#getTorrentsCachedDirect(byHash, hashes);
    }
  }

  // Método fallback para quando checkCacheViaStremThru falhar
  async #getTorrentsCachedDirect(byHash, hashes) {
    const cached = new Set();
    const BATCH = 50; // lotes menores para evitar timeouts
    for (let i = 0; i < hashes.length; i += BATCH) {
      const query = new URLSearchParams();
      for (const hash of hashes.slice(i, i + BATCH)) query.append('magnet', hash);
      try {
        const data = await this.#request('GET', `/v0/store/magnets/check?${query}`);
        for (const item of data?.items || []) {
          if (item?.hash && item.status === 'cached') cached.add(item.hash.toLowerCase());
        }
      } catch (err) {
        console.warn(`[StremThru] Chunk verification error: ${err.message}`);
      }
    }
    return [...cached].map(hash => byHash.get(hash)).filter(Boolean);
  }

  async getProgressTorrents() {
    return {};
  }

  async resolve(magnet) {
    const files = await this.getFilesFromMagnet(magnet);
    if (!files.length) throw new Error('StremThru: nenhum arquivo disponível.');
    return this.getDownload(files[0]);
  }

  async getFilesFromHash(infoHash) {
    return this.getFilesFromMagnet(`magnet:?xt=urn:btih:${infoHash}`, infoHash);
  }

  async getFilesFromBuffer(buffer) {
    const form = new FormData();
    form.append('torrent', new Blob([buffer], { type: 'application/x-bittorrent' }), 'torrent.torrent');
    const created = await this.#request('POST', '/v0/store/magnets', form);
    return this.#waitForReady(created);
  }

  async getFilesFromMagnet(magnet) {
    const created = await this.#request('POST', '/v0/store/magnets', { magnet });
    return this.#waitForReady(created);
  }

  async getDownload(file) {
    if (!file?.url) throw new Error('StremThru: link de arquivo ausente.');
    const data = await this.#request('POST', '/v0/store/link/generate', { link: file.url });
    if (!data?.link) throw new Error('StremThru: falha ao gerar link.');
    return data.link;
  }

  async getUserHash() {
    return createHash('md5')
      .update(`${this.#baseUrl}:${this.#storeName}:${this.#apiKey}`)
      .digest('hex');
  }

  async #waitForReady(initial) {
    let item = initial;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (READY.has(item?.status) && Array.isArray(item.files) && item.files.length) {
        return item.files.map(file => ({
          name: file.name || file.path,
          size: file.size,
          id: `${item.id}:${file.index}`,
          url: file.link,
          ready: true,
        }));
      }
      if (FAILED.has(item?.status)) {
        throw new Error(`StremThru: torrent ${item.status}.`);
      }
      if (!item?.id) throw new Error('StremThru: ID do torrent ausente.');
      await wait(1500);
      item = await this.#request('GET', `/v0/store/magnets/${encodeURIComponent(item.id)}`);
    }
    throw new Error(`StremThru: timeout (status ${item?.status || 'desconhecido'}).`);
  }

  async #request(method, endpoint, body) {
    const headers = {
      Accept: 'application/json',
      'X-StremThru-Store-Name': this.#storeName,
      'X-StremThru-Store-Authorization': `Bearer ${this.#apiKey}`,
    };
    const options = {
      method,
      headers,
      signal: AbortSignal.timeout(30_000),
    };
    if (body instanceof FormData) {
      options.body = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${this.#baseUrl}${endpoint}`, options);
    const raw = await res.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error(ERROR.EXPIRED_API_KEY);
      throw new Error(payload?.error?.message || raw || `StremThru HTTP ${res.status}`);
    }
    return payload?.data;
  }
}
