import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait, isVideo} from '../util.js';
import config from '../config.js';
import pLimit from 'p-limit'; 

const STREMTHRU_URL = 'https://stremthru.13377001.xyz';

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

    // Tenta StremThru (Opcional, falha silenciosa se der 404)
    try {
        const stItems = await this.#checkStremThru(items);
        if(stItems.length > 0) return stItems;
    } catch(e) {}

    // Tenta RD Oficial
    try {
        return await this.#checkInstantAvailability(items);
    } catch (e) {
        if (e.message.includes('disabled_endpoint') || e.message.includes('error_code":37')) {
            console.log("RD: Erro 37 (Instant Availability). Ativando fallback manual blindado...");
            return await this.#checkByAddMagnet(items);
        }
        console.error(`RD Cache Check Error: ${e.message}`);
        return [];
    }
  }

  async #checkStremThru(items) {
      const magnetList = items.map(i => i.magnet || `magnet:?xt=urn:btih:${i.hash}`);
      if(magnetList.length === 0) return [];
      const cachedHashes = new Set();
      // Lote pequeno para não quebrar URL
      const chunkSize = 5; 
      for (let i = 0; i < magnetList.length; i += chunkSize) {
          const chunk = magnetList.slice(i, i + chunkSize);
          const params = new URLSearchParams();
          params.append('magnets', chunk.join(','));
          try {
              const res = await fetch(`${STREMTHRU_URL}/v0/store?${params.toString()}`);
              if (res.ok) {
                  const data = await res.json();
                  if (data.items) data.items.forEach(x => { if(x.hash) cachedHashes.add(x.hash.toLowerCase()); });
              }
          } catch(err) {}
      }
      return items.filter(item => cachedHashes.has(item.hash)).map(item => item.original);
  }

  async #checkInstantAvailability(items) {
    const hashes = [...new Set(items.map(i => i.hash))]; 
    const cachedHashes = new Set();
    const chunkSize = 40; 
    for(let i=0; i < hashes.length; i += chunkSize){
        const chunk = hashes.slice(i, i+chunkSize);
        const url = `/torrents/instantAvailability/${chunk.join('/')}`;
        const res = await this.#request('GET', url);
        for(const hash of chunk){
            if(res[hash] && res[hash].rd && res[hash].rd.length > 0) cachedHashes.add(hash);
        }
    }
    return items.filter(item => cachedHashes.has(item.hash)).map(item => item.original);
  }

  // --- FALLBACK BLINDADO ---
  async #checkByAddMagnet(items) {
    const topItems = items.slice(0, 5); 
    const cachedHashes = new Set();
    const limit = pLimit(1); 

    await Promise.all(topItems.map(item => limit(async () => {
        let magnetLink = item.magnet;
        // Reconstrói magnet robusto se necessário
        if (!magnetLink || !magnetLink.includes('xt=urn:btih')) {
             if(item.hash) {
                 const trackers = [
                    'udp://tracker.opentrackr.org:1337/announce',
                    'udp://open.stealth.si:80/announce'
                 ];
                 magnetLink = `magnet:?xt=urn:btih:${item.hash}&dn=Package&tr=${trackers.join('&tr=')}`;
             } else {
                 return;
             }
        }

        let torrentId = null;
        try {
            // CORREÇÃO: Envio manual de string com header explícito
            // Isso evita erro "wrong_parameter" / "magnet is invalid"
            const bodyStr = `magnet=${encodeURIComponent(magnetLink)}`;
            
            const addRes = await this.#request('POST', `/torrents/addMagnet`, {
                body: bodyStr,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            
            if (addRes && addRes.id) {
                torrentId = addRes.id;
                console.log(`[RD-FALLBACK] Magnet OK: ${torrentId}`);
                
                let infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);

                if (infoRes.status === 'waiting_files_selection') {
                    // Seleciona tudo
                    const selectBody = 'files=all';
                    await this.#request('POST', `/torrents/selectFiles/${torrentId}`, {
                        body: selectBody,
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                    });
                    await wait(1000); 
                    infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);
                }

                // Polling
                for (let i = 1; i <= 3; i++) {
                    if (infoRes.status === 'downloaded' || infoRes.progress === 100) {
                        console.log(`[RD-FALLBACK] CACHE: ${item.hash}`);
                        cachedHashes.add(item.hash);
                        break;
                    }
                    await wait(1000);
                    infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);
                }
            }
        } catch (e) {
             console.error(`[RD-FALLBACK] Erro ${item.hash}: ${e.message}`);
        } finally {
            if (torrentId) try { await this.#request('DELETE', `/torrents/delete/${torrentId}`); } catch(e){}
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
    
    // Fallback manual para garantir
    const bodyStr = `magnet=${encodeURIComponent(magnet)}`;
    const res = await this.#request('POST', `/torrents/addMagnet`, {
        body: bodyStr,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return this.#getFilesFromTorrent(res.id);
  }

  async getFilesFromBuffer(buffer, infoHash){
    const torrentId = await this.#searchTorrentIdByHash(infoHash);
    if(torrentId) return this.#getFilesFromTorrent(torrentId);
    
    // PUT body raw
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
      // Correção também aqui
      let bodyStr = 'files=all';
      if(fileId) bodyStr = `files=${fileId}`;
      
      await this.#request('POST', `/torrents/selectFiles/${torrentId}`, {
          body: bodyStr,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      torrent = await this.#request('GET', `/torrents/info/${torrentId}`);
    }

    if(torrent.status == 'magnet_conversion') throw new Error(ERROR.NOT_READY);

    const linkIndex = torrent.files.filter(file => file.selected).findIndex(file => file.id == fileId);
    const link = torrent.links[linkIndex] || torrent.links[0] || false;
    
    if(!link) throw new Error(`LinkIndex or link not found`);

    const bodyStr = `link=${encodeURIComponent(link)}`;
    const res = await this.#request('POST', '/unrestrict/link', {
        body: bodyStr,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
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
    // Garante headers básicos
    const headers = Object.assign({}, opts.headers || {}, {
        'accept': 'application/json',
        'authorization': `Bearer ${this.#apiKey}`
    });

    // Se o corpo for string, o fetch não põe o content-type automático,
    // então o chamador JÁ DEVE TER POSTO (como fizemos acima).
    // Se não tiver body definido, iniciamos vazio.
    
    // Tratamento IP
    if((method == 'POST' || method == 'PUT') && this.#ip){
        // Injeção de IP é complexa com string body, vamos simplificar:
        // Se form-encoded string, concatenamos &ip=...
        if(typeof opts.body === 'string' && !opts.body.includes('&ip=')){
             opts.body += `&ip=${this.#ip}`;
        } else if (opts.body instanceof URLSearchParams) {
             opts.body.append('ip', this.#ip);
        } else if (!opts.body) {
             opts.body = new URLSearchParams();
             opts.body.append('ip', this.#ip);
        }
    }

    const queryStr = new URLSearchParams(opts.query || {}).toString();
    const url = `https://api.real-debrid.com/rest/1.0${path}?${queryStr}`;

    const res = await fetch(url, {
        method,
        headers,
        body: opts.body
    });

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
