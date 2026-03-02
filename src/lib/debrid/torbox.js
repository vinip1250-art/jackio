import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait} from '../util.js';

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

  // CORREÇÃO: Agora aceita Buffer real e faz upload do .torrent
  async getFilesFromBuffer(buffer, infoHash){
    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'application/x-bittorrent' });
    formData.append('file', blob, 'torrent.torrent');
    
    // Tenta adicionar via arquivo
    const torrentId = await this.#addToTorbox(formData, true);
    
    if (!torrentId) {
        // Fallback: se o arquivo falhar, tenta magnet
        console.log(`[Torbox] Upload de arquivo falhou, tentando magnet para ${infoHash}...`);
        const magnet = this.#buildMagnet(infoHash);
        return this.getFilesFromMagnet(magnet, infoHash);
    }

    return this.#waitForTorrentReady(torrentId);
  }

  async getFilesFromMagnet(magnet, infoHash){
    const body = new FormData();
    body.append('magnet', magnet);
    
    const torrentId = await this.#addToTorbox(body, false);
    
    if (!torrentId) {
        console.log(`[Torbox] ID não retornado. Buscando hash ${infoHash}...`);
        const foundId = await this.#searchTorrentIdByHash(infoHash, true);
        if(foundId) return this.#waitForTorrentReady(foundId);
        throw new Error('Falha ao adicionar torrent ao Torbox.');
    }

    return this.#waitForTorrentReady(torrentId);
  }

  // CORREÇÃO: Unificado para aceitar FormData (arquivo ou magnet)
  async #addToTorbox(formData, isFile = false) {
    try {
        // Endpoint é o mesmo, mas o conteúdo do FormData muda
        const res = await this.#request('POST', '/torrents/createtorrent', { body: formData });
        
        if (res?.success) {
            return res.data?.torrent_id || res.data?.id;
        } else if (res?.detail && (res.detail.includes('exists') || res.detail.includes('duplicate'))) {
            return null;
        }
        console.error(`[Torbox] Erro no create (File: ${isFile}): ${JSON.stringify(res)}`);
        return null;
    } catch(e) {
        console.error(`[Torbox] Exception no create: ${e.message}`);
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

  async #waitForTorrentReady(id){
    let retries = 30; 
    let torrentInfo = null;

    while(retries > 0) {
        const res = await this.#request('GET', '/torrents/mylist', { query: { bypass_cache: 'true' } });
        
        if (res?.data) {
            const found = res.data.find(t => t.id === id);
            
            if (found) {
                // Sucesso se tiver arquivos E download_present (ou state 'completed'/'cached')
                if ((found.download_present === true || found.download_state === 'cached') && found.files && found.files.length > 0) {
                    torrentInfo = found;
                    break;
                }
            }
        }
        await wait(1500);
        retries--;
    }

    if (!torrentInfo) throw new Error(`Torbox: Timeout. Torrent não ficou pronto.`);

    return torrentInfo.files.map(file => ({
        name: file.name,
        size: file.size,
        id: `${torrentInfo.id}:${file.id}`,
        url: '', 
        ready: true
    }));
  }

  async getDownload(file){
    let cleanId = file.id;
    if (cleanId.includes(':') && (cleanId.startsWith('tb:') || cleanId.startsWith('rd:'))) {
         const parts = cleanId.split(':');
         if(parts.length > 2) cleanId = parts.slice(-2).join(':');
    }
    
    const [torrentId, fileId] = cleanId.split(':');
    
    const query = { 
        token: this.#apiKey, 
        torrent_id: torrentId, 
        file_id: fileId, 
        zip: 'false' 
    };

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
    // Remove content-type se for FormData para o browser/node setar boundary
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
