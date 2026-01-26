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

  // --- 1. CACHE CHECK (Adaptado do Sootio) ---
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
    const chunkSize = 50; // Sootio faz em lotes, boa prática manter
    
    for (let i = 0; i < hashes.length; i += chunkSize) {
      const chunk = hashes.slice(i, i + chunkSize);
      const hashString = chunk.join(',');
      
      try {
        // Sootio usa GET com query string para checkcached
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

  // --- 2. ADIÇÃO E MONITORAMENTO (Lógica Sootio) ---

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
    // Torbox API v1 prefere magnet, mas se tivermos que enviar arquivo, usamos FormData
    // Porém, no fluxo do Sootio, ele foca em magnet. Vamos manter magnet como prioridade.
    const magnet = this.#buildMagnet(infoHash);
    return this.getFilesFromMagnet(magnet, infoHash);
  }

  async getFilesFromMagnet(magnet, infoHash){
    // 1. Tenta adicionar usando a lógica do Sootio (URLSearchParams)
    const torrentId = await this.#addToTorbox(magnet);
    
    if (!torrentId) {
        // Se falhar o ID, tenta recuperar buscando o hash na lista (fallback)
        console.log(`[Torbox] Tentando recuperar ID para hash ${infoHash}...`);
        const foundId = await this.#searchTorrentIdByHash(infoHash, true);
        if(foundId) return this.#waitForTorrentReady(foundId);
        
        throw new Error('Falha ao adicionar torrent ao Torbox.');
    }

    // 2. Aguarda ficar pronto (download_present: true)
    return this.#waitForTorrentReady(torrentId);
  }

  // Lógica de Create do Sootio: POST /createtorrent com URLSearchParams
  async #addToTorbox(magnetLink) {
    const body = new URLSearchParams();
    body.append('magnet', magnetLink);
    body.append('allow_zip', 'false');

    try {
        // headers vazios aqui pois URLSearchParams define content-type automaticamente no fetch
        const res = await this.#request('POST', '/torrents/createtorrent', { body });
        
        if (res?.success) {
            return res.data?.torrent_id || res.data?.id;
        } else if (res?.detail && (res.detail.includes('exists') || res.detail.includes('duplicate'))) {
            // Se já existe, não retorna ID no create, retornamos null para o chamador buscar na lista
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

  // Lógica de Polling do Sootio: espera 'download_present'
  async #waitForTorrentReady(id){
    let retries = 30; // 30 tentativas (aprox 30-40s)
    let torrentInfo = null;

    while(retries > 0) {
        const res = await this.#request('GET', '/torrents/mylist', { query: { bypass_cache: 'true' } });
        
        if (res?.data) {
            const found = res.data.find(t => t.id === id);
            
            if (found) {
                // A chave do sucesso no Sootio: download_present === true
                if (found.download_present === true && found.files && found.files.length > 0) {
                    torrentInfo = found;
                    break;
                }
                
                if (retries % 5 === 0) console.log(`[Torbox] Aguardando 'download_present'... ID: ${id} State: ${found.download_state}`);
            }
        }
        await wait(1500);
        retries--;
    }

    if (!torrentInfo) throw new Error(`Torbox: Timeout. Torrent não ficou pronto (download_present=false).`);

    return torrentInfo.files.map(file => ({
        name: file.name,
        size: file.size,
        id: `${torrentInfo.id}:${file.id}`,
        url: '', 
        ready: true
    }));
  }

  // --- 3. DOWNLOAD (Lógica Sootio: requestdl) ---
  async getDownload(file){
    let cleanId = file.id;
    if (cleanId.includes(':') && (cleanId.startsWith('tb:') || cleanId.startsWith('rd:'))) {
         const parts = cleanId.split(':');
         if(parts.length > 2) cleanId = parts.slice(-2).join(':');
    }
    
    const [torrentId, fileId] = cleanId.split(':');
    
    // Sootio envia user_ip também, vamos adicionar se possível (mas 'clientIp' geralmente vem de fora)
    // Aqui usamos o padrão da classe
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
          'udp://tracker.leechers-paradise.org:6969/announce'
      ];
      return `magnet:?xt=urn:btih:${hash}&tr=${trackers.join('&tr=')}`;
  }

  async #request(method, path, opts){
    opts = opts || {};
    const headers = Object.assign(opts.headers || {}, {
      'Authorization': `Bearer ${this.#apiKey}`,
      'Accept': 'application/json' 
    });
    
    const queryParams = new URLSearchParams(opts.query || {}).toString();
    const url = `https://api.torbox.app/v1/api${path}?${queryParams}`;

    const res = await fetch(url, { method, headers, body: opts.body });
    let data;
    try { data = await res.json(); } catch(err){ data = {}; }

    // Ignora erros no create para tratar manualmente (duplicatas)
    if (path.includes('create') && res.status >= 400) return data;

    if (res.status >= 400) {
        if (res.status === 401 || res.status === 403) throw new Error(ERROR.EXPIRED_API_KEY);
        throw new Error(data.detail || `Erro Torbox ${res.status}`);
    }
    return data;
  }
}