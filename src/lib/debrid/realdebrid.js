import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait, isVideo} from '../util.js';
import config from '../config.js';
import pLimit from 'p-limit'; 

export default class RealDebrid {

  static id = 'realdebrid';
  static name = 'Real-Debrid';
  static shortName = 'RD';
  static configFields = [
    {
      type: 'text', 
      name: 'debridApiKey', 
      label: `Real-Debrid API Key`, 
      required: true, 
      href: {value: 'https://real-debrid.com/apitoken', label:'Get API Key Here'}
    }
  ];

  #apiKey;
  #ip;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.cacheCheckAvailable = true; 
    this.#apiKey = userConfig.debridApiKey;
    this.#ip = userConfig.ip || '';
  }

  async getTorrentsCached(torrents){
    const items = torrents.map(t => {
        let hash = t.infos?.infoHash || t.infoHash;
        if (!hash && (t.magneturl || t.infos?.magnetUrl)) {
             const match = (t.magneturl || t.infos?.magnetUrl).match(/xt=urn:btih:([a-zA-Z0-9]+)/);
             if(match) hash = match[1];
        }
        return { hash: hash?.toLowerCase(), magnet: t.magneturl || t.infos?.magnetUrl, original: t };
    }).filter(i => i.hash);

    if (items.length === 0) return [];

    // Tenta método oficial primeiro
    try {
        return await this.#checkInstantAvailability(items);
    } catch (e) {
        // Se der Erro 37 (Endpoint Disabled), usa o Plano B
        if (e.message.includes('disabled_endpoint') || e.message.includes('error_code":37')) {
            console.log("RD: Endpoint 'instantAvailability' desativado (Erro 37). Usando fallback 'addMagnet' via URLSearchParams.");
            return await this.#checkByAddMagnet(items);
        }
        console.error(`RD Cache Check Error: ${e.message}`);
        return [];
    }
  }

  // MÉTODO 1: RÁPIDO (Instant Availability)
  async #checkInstantAvailability(items) {
    const hashes = [...new Set(items.map(i => i.hash))]; 
    const cachedHashes = new Set();
    const chunkSize = 40; 

    for(let i=0; i < hashes.length; i += chunkSize){
        const chunk = hashes.slice(i, i+chunkSize);
        const url = `/torrents/instantAvailability/${chunk.join('/')}`;
        
        const res = await this.#request('GET', url);
        
        for(const hash of chunk){
            if(res[hash] && res[hash].rd && res[hash].rd.length > 0){
                cachedHashes.add(hash);
            }
        }
    }

    return items
        .filter(item => cachedHashes.has(item.hash))
        .map(item => item.original);
  }

  // MÉTODO 2: LENTO MAS SEGURO (Fallback)
  async #checkByAddMagnet(items) {
    const topItems = items.slice(0, 5); 
    const cachedHashes = new Set();
    const limit = pLimit(1); 

    console.log(`[RD-DEBUG] Iniciando verificação lenta de ${topItems.length} itens...`);

    await Promise.all(topItems.map(item => limit(async () => {
        // Constrói magnet se necessário
        let magnetLink = item.magnet;
        if (!magnetLink && item.hash) {
            magnetLink = `magnet:?xt=urn:btih:${item.hash}`;
        }
        
        if (!magnetLink) return;

        let torrentId = null;

        try {
            // CORREÇÃO: Usar URLSearchParams em vez de FormData para strings simples
            // Isso evita problemas de boundary/headers no Node.js
            const body = new URLSearchParams();
            body.append('magnet', magnetLink);
            
            const addRes = await this.#request('POST', `/torrents/addMagnet`, {body});
            
            if (addRes && addRes.id) {
                torrentId = addRes.id;
                console.log(`[RD-DEBUG] Magnet Adicionado: ${torrentId}`);
                
                let infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);

                if (infoRes.status === 'waiting_files_selection') {
                    // Aqui mantemos FormData pois alguns endpoints do RD preferem, mas 'selectFiles' aceita ambos.
                    // Vamos tentar URLSearchParams aqui também por consistência.
                    const selectBody = new URLSearchParams();
                    selectBody.append('files', 'all'); 
                    await this.#request('POST', `/torrents/selectFiles/${torrentId}`, {body: selectBody});
                    
                    await wait(1000); // Espera processar
                    infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);
                }

                // Polling 3x
                let isCached = false;
                for (let i = 1; i <= 3; i++) {
                    if (infoRes.status === 'downloaded' || infoRes.progress === 100) {
                        isCached = true;
                        break;
                    }
                    await wait(1000);
                    infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);
                }

                if (isCached) {
                    console.log(`[RD-DEBUG] CACHE ENCONTRADO: ${item.hash}`);
                    cachedHashes.add(item.hash);
                }

                await this.#request('DELETE', `/torrents/delete/${torrentId}`);
            }
        } catch (e) { 
            console.error(`[RD-DEBUG] Erro item ${item.hash}: ${e.message}`);
        } finally {
            if (torrentId) {
                try { await this.#request('DELETE', `/torrents/delete/${torrentId}`); } catch(e){}
            }
        }
    })));

    return items
        .filter(item => cachedHashes.has(item.hash))
        .map(item => item.original);
  }

  async getProgressTorrents(torrents){
    try {
      const res = await this.#request('GET', '/torrents');
      return res.reduce((progress, torrent) => {
        progress[torrent.hash] = {
          percent: torrent.progress || 0,
          speed: torrent.speed || 0
        }
        return progress;
      }, {});
    } catch(e) { return {}; }
  }

  async getFilesFromHash(infoHash){
    return this.getFilesFromMagnet(`magnet:?xt=urn:btih:${infoHash}`, infoHash);
  }

  async getFilesFromMagnet(magnet, infoHash){
    const torrentId = await this.#searchTorrentIdByHash(infoHash);
    if(torrentId) return this.#getFilesFromTorrent(torrentId);
    
    const body = new URLSearchParams();
    body.append('magnet', magnet);
    const res = await this.#request('POST', `/torrents/addMagnet`, {body});
    return this.#getFilesFromTorrent(res.id);
  }

  async getFilesFromBuffer(buffer, infoHash){
    const torrentId = await this.#searchTorrentIdByHash(infoHash);
    if(torrentId) return this.#getFilesFromTorrent(torrentId);
    
    // Buffer precisa ser raw body ou FormData específico, RD suporta PUT com body raw para addTorrent
    const body = buffer;
    const res = await this.#request('PUT', `/torrents/addTorrent`, {body});
    return this.#getFilesFromTorrent(res.id);
  }

  async getDownload(file){
    let cleanId = file.id;
    if (cleanId.includes(':') && (cleanId.startsWith('rd:') || cleanId.startsWith('tb:'))) {
        const parts = cleanId.split(':');
        if(parts.length > 2) cleanId = parts.slice(1).join(':'); 
    }

    const [torrentId, fileId] = cleanId.split(':');

    let torrent = await this.#request('GET', `/torrents/info/${torrentId}`);
    
    if(torrent.status == 'waiting_files_selection'){
      const body = new URLSearchParams();
      if (fileId) {
          body.append('files', fileId);
      } else {
          const fileIds = torrent.files.filter(file => isVideo(file.path)).map(file => file.id);
          body.append('files', fileIds.length > 0 ? fileIds.join(',') : 'all');
      }

      await this.#request('POST', `/torrents/selectFiles/${torrentId}`, {body});
      torrent = await this.#request('GET', `/torrents/info/${torrentId}`);
    }

    if(torrent.status == 'magnet_conversion') throw new Error(ERROR.NOT_READY);

    const linkIndex = torrent.files.filter(file => file.selected).findIndex(file => file.id == fileId);
    const link = torrent.links[linkIndex] || torrent.links[0] || false;
    
    if(!link) throw new Error(`LinkIndex or link not found`);

    const body = new URLSearchParams();
    body.append('link', link);
    const res = await this.#request('POST', '/unrestrict/link', {body});
    return res.download;
  }

  async getUserHash(){
    return createHash('md5').update(this.#apiKey).digest('hex');
  }

  async #getFilesFromTorrent(id){
    let torrent = await this.#request('GET', `/torrents/info/${id}`);
    return torrent.files.map((file) => {
      return {
        name: file.path.split('/').pop(),
        size: file.bytes,
        id: `${torrent.id}:${file.id}`,
        url: '',
        ready: null
      };
    });
  }

  async #searchTorrentIdByHash(hash){
    try {
        const torrents = await this.#request('GET', `/torrents`);
        for(let torrent of torrents){
            if(torrent.hash.toLowerCase() == hash.toLowerCase() && ['magnet_conversion', 'waiting_files_selection', 'queued', 'downloading', 'downloaded'].includes(torrent.status)){
                return torrent.id;
            }
        }
    } catch (e) { return null; }
  }

  async #request(method, path, opts){
    opts = opts || {};
    opts = Object.assign(opts, {
      method,
      headers: Object.assign(opts.headers || {}, {
        'accept': 'application/json',
        'authorization': `Bearer ${this.#apiKey}`
      }),
      query: opts.query || {}
    });

    // Se for URLSearchParams, o fetch seta o content-type automaticamente para form-urlencoded
    // Se for FormData, seta multipart/form-data
    // Se for Buffer (PUT), não mexemos
    
    if(method == 'POST' || method == 'PUT'){
       if (!opts.body) {
           opts.body = new URLSearchParams();
       }
       // Injeta IP se possível e se o body suportar append
       if(this.#ip && opts.body.append) {
           opts.body.append('ip', this.#ip);
       }
    }

    const url = `https://api.real-debrid.com/rest/1.0${path}?${new URLSearchParams(opts.query).toString()}`;
    const res = await fetch(url, opts);
    let data;
    try { data = await res.json(); }catch(err){ data = {}; }

    if(data.error_code){
      if (data.error_code === 37) throw new Error(`{"error":"disabled_endpoint","error_code":37}`);
      
      switch(data.error_code){
        case 8: throw new Error(ERROR.EXPIRED_API_KEY);
        case 9: throw new Error(ERROR.ACCESS_DENIED);
        case 20: throw new Error(ERROR.NOT_PREMIUM);
        default: throw new Error(`RD Error: ${JSON.stringify(data)}`);
      }
    }
    return data;
  }
}
