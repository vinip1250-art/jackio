import { createHash } from 'crypto';
import { ERROR } from './const.js';
import { wait } from '../util.js';

const BASE = 'https://offcloud.com/api';
const MAX_RETRIES = 20;
const POLL_INTERVAL = 3000; // ms

export default class Offcloud {

  static id = 'offcloud';
  static name = 'Offcloud';
  static shortName = 'OC';
  static configFields = [
    {
      type: 'text',
      name: 'debridApiKey',
      label: 'Offcloud API Key',
      required: true,
      href: { value: 'https://offcloud.com/#/account', label: 'Get API Key Here' }
    }
  ];

  #apiKey;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.#apiKey = userConfig.debridApiKey;
  }

  // ── Cache check ────────────────────────────────────────────────────────────
  async getTorrentsCached(torrents) {
    const items = torrents.map(t => {
      let hash = (t.infos?.infoHash || t.infoHash || '').toLowerCase();
      const magnet = t.magneturl || t.infos?.magnetUrl || '';
      if (!hash && magnet) {
        const m = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        if (m) hash = m[1].toLowerCase();
      }
      const isPrivate = t.infos?.private || t.private || false;
      return { hash, original: t, isPrivate };
    }).filter(i => i.hash && !i.isPrivate);

    if (items.length === 0) return [];

    const hashes = items.map(i => i.hash);

    try {
      const body = new URLSearchParams();
      hashes.forEach(h => body.append('hashes[]', h));

      const res = await fetch(`${BASE}/torrent/checkcached?key=${this.#apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const cachedHashes = new Set();
      if (Array.isArray(data)) {
        data.forEach(h => {
          if (typeof h === 'string') cachedHashes.add(h.toLowerCase());
          else if (h?.hash) cachedHashes.add(h.hash.toLowerCase());
        });
      } else if (data && typeof data === 'object') {
        for (const [hash, available] of Object.entries(data)) {
          if (available) cachedHashes.add(hash.toLowerCase());
        }
      }

      return items
        .filter(i => cachedHashes.has(i.hash))
        .map(i => i.original);

    } catch (e) {
      console.error(`[OC] getTorrentsCached erro: ${e.message}`);
      return [];
    }
  }

  async getProgressTorrents() { return {}; }

  // ── Add torrent ────────────────────────────────────────────────────────────
  async #addMagnet(magnet) {
    const body = new URLSearchParams({ url: magnet });
    const res = await fetch(`${BASE}/cloud?key=${this.#apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!res.ok) throw new Error(`[OC] addMagnet HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error) throw new Error(`[OC] addMagnet: ${data.error}`);
    return data?.requestId || null;
  }

  // ── Poll until downloaded ──────────────────────────────────────────────────
  async #waitForReady(requestId) {
    for (let i = 0; i < MAX_RETRIES; i++) {
      await wait(POLL_INTERVAL);

      const body = new URLSearchParams({ requestId });
      const res = await fetch(`${BASE}/cloud/status?key=${this.#apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      if (!res.ok) continue;

      const data = await res.json();
      const status = typeof data?.status === 'string'
        ? data.status
        : (data?.status?.status || '');

      if (status === 'downloaded') return requestId;
      if (status === 'error') throw new Error(ERROR.NOT_READY);
    }
    throw new Error(ERROR.NOT_READY);
  }

  // ── List files for a requestId ─────────────────────────────────────────────
  async #exploreRequest(requestId) {
    const res = await fetch(`${BASE}/cloud/explore/${requestId}?key=${this.#apiKey}`);
    if (!res.ok) throw new Error(`[OC] explore HTTP ${res.status}`);
    const links = await res.json();
    if (!Array.isArray(links)) return [];

    return links.map((url, i) => ({
      id:   `${requestId}:${i}`,
      name: decodeURIComponent(url.split('/').pop() || `file_${i}`),
      size: 0,
      _url: url
    }));
  }

  // ── Public getFiles* ───────────────────────────────────────────────────────
  async getFilesFromMagnet(magnet, _infoHash) {
    const requestId = await this.#addMagnet(magnet);
    if (!requestId) throw new Error('[OC] sem requestId após addMagnet');
    await this.#waitForReady(requestId);
    return this.#exploreRequest(requestId);
  }

  async getFilesFromHash(infoHash) {
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    return this.getFilesFromMagnet(magnet, infoHash);
  }

  async getFilesFromBuffer(buffer, infoHash) {
    // Offcloud não aceita upload direto de .torrent — usa magnet como fallback
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    return this.getFilesFromMagnet(magnet, infoHash);
  }

  // ── Download link ──────────────────────────────────────────────────────────
  async getDownload(file) {
    if (!file._url) throw new Error('[OC] sem URL no arquivo');
    return file._url;
  }

  async getUserHash() {
    return createHash('md5').update(this.#apiKey).digest('hex');
  }

  async resolve(magnet) {
    const files = await this.getFilesFromMagnet(magnet, '');
    if (!files.length) throw new Error('[OC] sem arquivos');
    return this.getDownload(files[0]);
  }
}
