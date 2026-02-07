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
    try {
        const items = torrents.map(t => {
            let hash = t.infos?.infoHash || t.infoHash;
            if (!hash && (t.magneturl || t.infos?.magnetUrl)) {
                 const match = (t.magneturl || t.infos?.magnetUrl).match(/xt=urn:btih:([a-zA-Z0-9]+)/);
                 if(match) hash = match[1];
            }
            return { hash: hash?.toLowerCase(), magnet: t.magneturl || t.infos?.magnetUrl, original: t };
        }).filter(i => i.hash);

        if (items.length === 0) return [];

        // Log para confirmar que a função iniciou
        // console.log(`[RD] Iniciando verificação manual para ${items.length} itens...`);

        // Vai direto para o método manual (AddMagnet) que funcionou nos logs anteriores
        return await this.#checkByAddMagnet(items);

    } catch (e) {
        // SEGURANÇA MÁXIMA: Se der erro, loga e retorna vazio para não quebrar o addon
        console.error(`[RD] ERRO CRÍTICO em getTorrentsCached: ${e.message}`);
        return [];
    }
  }

  // --- MÉTODO MANUAL (O QUE FUNCIONOU) ---
  async #checkByAddMagnet(items) {
    // Top 5 para agilidade
    const topItems = items.slice(0, 5); 
    const cachedHashes = new Set();
    const limit = pLimit(2); 

    await Promise.all(topItems.map(item => limit(async () => {
        try {
            let magnetLink = item.magnet;
            // Reconstrói magnet se necessário
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

            // Construção Manual do Body (String) para evitar erros de parser do RD
            const bodyStr = `magnet=${encodeURIComponent(magnetLink)}`;
            
            const addRes = await this.#request('POST', `/torrents/addMagnet`, {
                body: bodyStr,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            
            if (addRes && addRes.id) {
                const torrentId = addRes.id;
                
                let infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);

                if (infoRes.status === 'waiting_files_selection') {
                    await this.#request('POST', `/torrents/selectFiles/${torrentId}`, {
                        body: 'files=all',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                    });
                    await wait(700); 
                    infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);
                }

                // Verifica cache
                if (infoRes.status === 'downloaded' || infoRes.progress === 100) {
                    // console.log(`[RD] Cache OK: ${item.hash}`);
                    cachedHashes.add(item.hash);
                } else {
                    // Polling extra rápido se não estiver pronto de imediato
                     await wait(800);
                     infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);
                     if (infoRes.status === 'downloaded' || infoRes.progress === 100) {
                        cachedHashes.add(item.hash);
                     }
                }

                // Limpeza
                await this.#request('DELETE', `/torrents/delete/${torrentId}`);
            }
        } catch (e) {
             // Ignora erro individual
             // console.error(`[RD] Erro item: ${e.message}`);
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
    
    // Fallback manual para garantir sucesso na adição
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
    // Garante headers
    const headers = Object.assign({}, opts.headers || {}, {
        'accept': 'application/json',
        'authorization': `Bearer ${this.#apiKey}`
    });

    // Injeção de IP segura
    if((method == 'POST' || method == 'PUT') && this.#ip){
        if(typeof opts.body === 'string' && !opts.body.includes('&ip=')){
             opts.body += `&ip=${this.#ip}`;
        } else if (opts.body instanceof URLSearchParams) {
             opts.body.append('ip', this.#ip);
        } else if (!opts.body) {
             // Se body vazio, cria params
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
      // Ignora erro 37 aqui pois já tratamos desativando a chamada
      if (data.error_code === 37) {
          // Apenas lança erro simples para ser pego
          throw new Error('RD Error 37');
      }
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
