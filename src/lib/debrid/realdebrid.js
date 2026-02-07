import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait, isVideo} from '../util.js';
import config from '../config.js';

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

  // --- CACHE CHECK NATIVO ---
  async getTorrentsCached(torrents){
    const items = torrents.map(t => {
        let hash = t.infos?.infoHash || t.infoHash;
        let magnet = t.magneturl || t.infos?.magnetUrl || t.magnet;

        if (!hash && magnet) {
            const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/);
            if (match) hash = match[1];
        }
        if (hash && !magnet) magnet = `magnet:?xt=urn:btih:${hash}`;

        return { hash, magnet, original: t };
    }).filter(i => i.hash && i.magnet);

    if (items.length === 0) return [];

    const topItems = items.slice(0, 5); 
    const cachedHashes = [];

    for (const item of topItems) {
        try {
            const body = new FormData();
            body.append('magnet', item.magnet);
            
            const addRes = await this.#request('POST', `/torrents/addMagnet`, {body});
            
            if (addRes && addRes.id) {
                const torrentId = addRes.id;
                let infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);

                if (infoRes.status === 'waiting_files_selection') {
                    const selectBody = new FormData();
                    selectBody.append('files', 'all'); 
                    await this.#request('POST', `/torrents/selectFiles/${torrentId}`, {body: selectBody});
                    infoRes = await this.#request('GET', `/torrents/info/${torrentId}`);
                }

                if (infoRes && infoRes.status === 'downloaded') {
                    cachedHashes.push(item.hash);
                }

                await this.#request('DELETE', `/torrents/delete/${torrentId}`);
            }
        } catch (e) { }
    }

    return items
        .filter(item => cachedHashes.includes(item.hash))
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
    
    const body = new FormData();
    body.append('magnet', magnet);
    const res = await this.#request('POST', `/torrents/addMagnet`, {body});
    return this.#getFilesFromTorrent(res.id);
  }

  async getFilesFromBuffer(buffer, infoHash){
    const torrentId = await this.#searchTorrentIdByHash(infoHash);
    if(torrentId) return this.#getFilesFromTorrent(torrentId);
    
    const body = buffer;
    const res = await this.#request('PUT', `/torrents/addTorrent`, {body});
    return this.#getFilesFromTorrent(res.id);
  }

  // --- DOWNLOAD FIX (Proteção contra files vazio) ---
  async getDownload(file){
    let cleanId = file.id;
    if (cleanId.includes(':') && (cleanId.startsWith('rd:') || cleanId.startsWith('tb:'))) {
        const parts = cleanId.split(':');
        if(parts.length > 2) cleanId = parts.slice(1).join(':'); 
    }

    const [torrentId, fileId] = cleanId.split(':');

    let torrent = await this.#request('GET', `/torrents/info/${torrentId}`);
    
    if(torrent.status == 'waiting_files_selection'){
      // Tenta filtrar vídeos
      const fileIds = torrent.files.filter(file => isVideo(file.path)).map(file => file.id);
      
      const body = new FormData();
      // CORREÇÃO: Se não achou videos (lista vazia), seleciona 'all' para evitar erro
      if (fileIds.length > 0) {
          body.append('files', fileIds.join(','));
      } else {
          console.log(`RD: Nenhum vídeo detectado automaticamente para ${torrentId}, selecionando 'all'`);
          body.append('files', 'all');
      }

      await this.#request('POST', `/torrents/selectFiles/${torrentId}`, {body});
      torrent = await this.#request('GET', `/torrents/info/${torrentId}`);
    }

    if(torrent.status == 'magnet_conversion') throw new Error(ERROR.NOT_READY);

    const linkIndex = torrent.files.filter(file => file.selected).findIndex(file => file.id == fileId);
    // Se não achou pelo ID exato, tenta pegar o primeiro selecionado como fallback
    if (linkIndex === -1) {
         // console.warn('RD: File ID mismatch, tentando recuperar link...');
    }
    
    // Tenta pegar o link pelo índice ou o primeiro disponível
    const link = torrent.links[linkIndex] || torrent.links[0] || false;
    
    if(!link) throw new Error(`LinkIndex or link not found`);

    const body = new FormData();
    body.append('link', link);
    const res = await this.#request('POST', '/unrestrict/link', {body});
    return res.download;
  }
  // ------------------------------------------------

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

    if(method == 'POST' || method == 'PUT'){
      opts.body = opts.body || new FormData();
      if(this.#ip && opts.body instanceof FormData) opts.body.append('ip', this.#ip);
    }

    const url = `https://api.real-debrid.com/rest/1.0${path}?${new URLSearchParams(opts.query).toString()}`;
    const res = await fetch(url, opts);
    let data;
    try { data = await res.json(); }catch(err){ data = {}; }

    if(data.error_code){
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
