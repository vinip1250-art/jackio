import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait} from '../util.js';

// Lock global por torrentId: evita múltiplos loops de polling paralelos para o mesmo torrent
const _pollLocks = new Map();

export default class Torbox { 

  static id = 'torbox';
  static name = 'Torbox';
  static shortName = 'TB';
  static configFields = [
    {
      type: 'text', 
      name: 'debridApiKey', 
      label: `Torbox API Key`, 
      required: true, 
      href: {value: 'https://torbox.app/settings', label:'Get API Key Here'}
    }
  ];

  #apiKey;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.cacheCheckAvailable = true;
    this.#apiKey = userConfig.debridApiKey;
  }

  async getTorrentsCached(torrents){
    const items = torrents.map(t => {
        let hash = t.infos?.infoHash || t.infoHash;
        let magnet = t.magneturl || t.infos?.magnetUrl || t.magnet;

        if (!hash && magnet) {
            const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
            if (match) hash = match[1];
        }
        return { hash, magnet, original: t };
    }).filter(i => i.hash);

    if (items.length === 0) return [];

    const hashes = items.map(i => i.hash);
    const cachedHashes = new Set();
    const chunkSize = 50;

    // 1. Verifica cache público do TorBox (torrents públicos)
    for (let i = 0; i < hashes.length; i += chunkSize) {
      const chunk = hashes.slice(i, i + chunkSize);
      const hashString = chunk.join(',');
      try {
        const data = await this.#request('GET', '/torrents/checkcached', {
          query: { hash: hashString, format: 'list' }
        });
        if (data && data.data) {
            if (Array.isArray(data.data)) {
                data.data.forEach(h => {
                    if (typeof h === 'string') cachedHashes.add(h.toLowerCase());
                    else if (h?.hash) cachedHashes.add(h.hash.toLowerCase());
                });
            } else if (typeof data.data === 'object') {
                for (const [hash, isCached] of Object.entries(data.data)) {
                    if (isCached) cachedHashes.add(hash.toLowerCase());
                }
            }
        }
      } catch (err) {
          console.error(`[Torbox] Cache check error: ${err.message}`);
      }
    }

    // 2. Verifica torrents privados já presentes na conta do usuário (mylist)
    // Torrents privados não aparecem no cache público mas podem já estar baixados
    const privateItems = items.filter(i => {
        const t = i.original;
        return t.type === 'private' || t.infos?.private === true;
    });

    if (privateItems.length > 0) {
        try {
            const res = await this.#request('GET', '/torrents/mylist', { query: { bypass_cache: 'true' } });
            if (res?.data && Array.isArray(res.data)) {
                const myHashes = new Set(res.data.map(t => (t.hash || '').toLowerCase()));
                privateItems.forEach(i => {
                    if (myHashes.has(i.hash.toLowerCase())) {
                        console.log(`[Torbox] Torrent privado já na conta: ${i.hash}`);
                        cachedHashes.add(i.hash.toLowerCase());
                    }
                });
            }
        } catch (err) {
            console.error(`[Torbox] mylist check error: ${err.message}`);
        }
    }

    return items
        .filter(item => cachedHashes.has(item.hash.toLowerCase()))
        .map(item => item.original);
  }

  async getProgressTorrents(torrents){
    return {};
  }

  async resolve(magnet){
    try {
        const files = await this.getFilesFromMagnet(magnet, '');
        if (files.length > 0) return await this.getDownload(files[0]);
        throw new Error('Sem arquivos');
    } catch(e) { throw e; }
  }

  async getFilesFromHash(infoHash){
    const magnet = this.#buildMagnet(infoHash);
    return this.getFilesFromMagnet(magnet, infoHash);
  }

  async getFilesFromBuffer(buffer, infoHash){
    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'application/x-bittorrent' });
    formData.append('file', blob, 'torrent.torrent');
    
    const torrentId = await this.#addFileToTorbox(formData);
    
    if (!torrentId) {
        console.log(`[Torbox] Upload de arquivo falhou, tentando magnet para ${infoHash}...`);
        const magnet = this.#buildMagnet(infoHash);
        return this.getFilesFromMagnet(magnet, infoHash);
    }

    return this.#waitForTorrentReady(torrentId, infoHash);
  }

  async getFilesFromMagnet(magnet, infoHash){
    if (!magnet || !magnet.startsWith('magnet:')) {
        console.log(`[Torbox] magnetUrl não é magnet real, usando hash: ${infoHash}`);
        if (infoHash) {
            magnet = this.#buildMagnet(infoHash);
        } else {
            throw new Error('Sem magnet válido nem infoHash disponível.');
        }
    }

    const torrentId = await this.#addMagnetToTorbox(magnet);
    
    if (!torrentId) {
        console.log(`[Torbox] ID não retornado. Buscando hash ${infoHash}...`);
        const foundId = await this.#searchTorrentIdByHash(infoHash, true);
        if(foundId) return this.#waitForTorrentReady(foundId, infoHash);
        throw new Error('Falha ao adicionar torrent ao Torbox.');
    }

    return this.#waitForTorrentReady(torrentId, infoHash);
  }

  async #addMagnetToTorbox(magnetLink) {
    const body = new URLSearchParams();
    body.append('magnet', magnetLink);
    body.append('allow_zip', 'false');

    try {
        const res = await this.#request('POST', '/torrents/createtorrent', { body });
        
        if (res?.success) {
            return res.data?.torrent_id || res.data?.id;
        } else if (res?.detail && (res.detail.includes('exists') || res.detail.includes('duplicate'))) {
            console.log(`[Torbox] Torrent já existe.`);
            return null;
        }
        console.error(`[Torbox] Erro no create: ${JSON.stringify(res)}`);
        return null;
    } catch(e) {
        console.error(`[Torbox] Exception no create: ${e.message}`);
        return null;
    }
  }

  async #addFileToTorbox(formData) {
    try {
        const res = await this.#request('POST', '/torrents/createtorrent', { body: formData });
        
        if (res?.success) {
            return res.data?.torrent_id || res.data?.id;
        } else if (res?.detail && (res.detail.includes('exists') || res.detail.includes('duplicate'))) {
            console.log(`[Torbox] Torrent já existe.`);
            return null;
        }
        console.error(`[Torbox] Erro no create (arquivo): ${JSON.stringify(res)}`);
        return null;
    } catch(e) {
        console.error(`[Torbox] Exception no create (arquivo): ${e.message}`);
        return null;
    }
  }

  async #searchTorrentIdByHash(hash, forceBypass = false){
    if (!hash) return null;
    try {
        const query = forceBypass ? { bypass_cache: 'true' } : {};
        const res = await this.#request('GET', '/torrents/mylist', { query });
        
        if (res?.data && Array.isArray(res.data)) {
            const found = res.data.find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase());
            return found ? found.id : null;
        }
    } catch (e) { return null; }
    return null;
  }

  async #waitForTorrentReady(id, infoHash){
    const lockKey = `${this.#apiKey}:${id}`;
    if (_pollLocks.has(lockKey)) {
        console.log(`[Torbox] Aguardando poll existente para torrent ${id}...`);
        return _pollLocks.get(lockKey);
    }

    const promise = this.#doPoll(id, infoHash).finally(() => {
        _pollLocks.delete(lockKey);
    });
    _pollLocks.set(lockKey, promise);
    return promise;
  }

  async #doPoll(id, infoHash) {
    let retries = 60;
    const ACTIVE_STATES = new Set(['checking', 'downloading', 'cached', 'completed', 'complete']);
    const ERROR_STATES = new Set(['error', 'stalled', 'missingFiles', 'dead']);

    while (retries > 0) {
        const res = await this.#request('GET', '/torrents/mylist', { query: { bypass_cache: 'true' } });
        
        if (res?.data) {
            const found = res.data.find(t => t.id === id);
            
            if (found) {
                const state = found.download_state || '';
                const filesCount = found.files?.length || 0;
                console.log(`[Torbox] Torrent ${id} state=${state} progress=${found.progress || 0} files=${filesCount} download_present=${found.download_present}`);

                if ((found.download_present === true || state === 'cached' || state === 'completed' || state === 'complete') && filesCount > 0) {
                    console.log(`[Torbox] Torrent ${id} pronto com ${filesCount} arquivo(s)!`);
                    return found.files.map(file => ({
                        name: file.name,
                        size: file.size,
                        id: `${id}:${file.id}`,
                        url: '',
                        ready: true
                    }));
                }

                if (ACTIVE_STATES.has(state) && filesCount === 0) {
                    const fileName = infoHash
                        ? `torrent_${infoHash.slice(0, 8)}.mkv`
                        : `torrent_${id}.mkv`;
                    console.log(`[Torbox] Torrent ${id} em ${state}, usando requestdl sem file_id`);
                    return [{
                        name: fileName,
                        size: found.size || 0,
                        id: `${id}:`,
                        url: '',
                        ready: false
                    }];
                }

                if (ERROR_STATES.has(state)) {
                    throw new Error(`Torbox: Torrent em estado de erro: ${state}`);
                }
            }
        }
        await wait(2000);
        retries--;
    }

    throw new Error(`Torbox: Timeout. Torrent não ficou pronto.`);
  }

  async getDownload(file){
    let cleanId = file.id;
    if (cleanId.includes(':') && (cleanId.startsWith('tb:') || cleanId.startsWith('rd:'))) {
         const parts = cleanId.split(':');
         if(parts.length > 2) cleanId = parts.slice(-2).join(':');
    }
    
    const parts = cleanId.split(':');
    const torrentId = parts[0];
    const fileId = parts[1] || '';
    
    const query = { 
        token: this.#apiKey, 
        torrent_id: torrentId,
        zip: 'false'
    };

    if (fileId) {
        query.file_id = fileId;
    }

    try {
        const res = await this.#request('GET', '/torrents/requestdl', { query });
        if (res.success && res.data) return res.data;
        throw new Error(res.detail || 'Falha ao obter link Torbox');
    } catch (err) { throw err; }
  }

  async getUserHash(){
    return createHash('md5').update(this.#apiKey).digest('hex');
  }

  #buildMagnet(hash) {
      const trackers = [
          'udp://tracker.opentrackr.org:1337/announce',
          'udp://open.stealth.si:80/announce',
          'udp://tracker.coppersurfer.tk:6969/announce',
          'udp://tracker.leechers-paradise.org:6969/announce',
          'udp://9.rarbg.to:2710/announce',
          'udp://tracker.cyberia.is:6969/announce',
          'udp://tracker.internetwarriors.net:1337/announce'
      ];
      return `magnet:?xt=urn:btih:${hash}&tr=${trackers.join('&tr=')}`;
  }

  async #request(method, path, opts){
    opts = opts || {};
    const headers = Object.assign(opts.headers || {}, {
      'Authorization': `Bearer ${this.#apiKey}`,
      'Accept': 'application/json' 
    });
    if (opts.body instanceof FormData) {
        delete headers['Content-Type'];
    }
    
    const queryParams = new URLSearchParams(opts.query || {}).toString();
    const url = `https://api.torbox.app/v1/api${path}?${queryParams}`;

    const res = await fetch(url, { method, headers, body: opts.body });
    let data;
    try { data = await res.json(); } catch(err){ data = {}; }

    if (path.includes('create') && res.status >= 400) return data;

    if (res.status >= 400) {
        if (res.status === 401 || res.status === 403) throw new Error(ERROR.EXPIRED_API_KEY);
        throw new Error(data.detail || `Erro Torbox ${res.status}`);
    }
    return data;
  }
}
