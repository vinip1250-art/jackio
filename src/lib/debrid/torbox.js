import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait, isVideo} from '../util.js';
import config from '../config.js';

export class Torbox {

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
  #ip;

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.cacheCheckAvailable = true; // Torbox suporta verificação de cache
    this.#apiKey = userConfig.debridApiKey;
    this.#ip = userConfig.ip || '';
  }

  async getTorrentsCached(torrents){
    const hashes = torrents.map(t => t.hash);
    const result = [];
    
    // O Torbox permite verificar múltiplos hashes separados por vírgula
    // Faremos em lotes de 50 para evitar limites de URL longa se houver muitos
    const chunkSize = 50;
    for (let i = 0; i < hashes.length; i += chunkSize) {
      const chunk = hashes.slice(i, i + chunkSize);
      const hashString = chunk.join(',');
      
      try {
        const data = await this.#request('GET', '/torrents/checkcached', {
          query: { hash: hashString, format: 'list' }
        });
        
        // A resposta data.data é um objeto: { "hash1": true, "hash2": false }
        if (data.data) {
          for (const [hash, isCached] of Object.entries(data.data)) {
             if (isCached) result.push(hash);
          }
        }
      } catch (err) {
        console.error('Erro ao verificar cache do Torbox:', err.message);
      }
    }
    
    return result;
  }

  async getProgressTorrents(torrents){
    // Torbox não fornece progresso detalhado instantâneo da mesma forma, 
    // mas podemos tentar listar os ativos se necessário. 
    // Para simplificar e evitar chamadas pesadas, retornamos vazio por enquanto
    // ou implementamos se for crucial para downloads em andamento.
    return {};
  }

  async getFilesFromHash(infoHash){
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    return this.getFilesFromMagnet(magnet, infoHash);
  }

  async getFilesFromMagnet(magnet, infoHash){
    // 1. Adicionar o Torrent ao Torbox
    const body = new FormData();
    body.append('magnet', magnet);
    // seed: 3 (Auto) é o padrão geralmente, ajustável se necessário
    
    const addRes = await this.#request('POST', '/torrents/create', { body });
    
    if (!addRes.success || !addRes.data || !addRes.data.torrent_id) {
       throw new Error('Falha ao adicionar torrent ao Torbox');
    }

    const torrentId = addRes.data.torrent_id;

    // 2. Buscar informações do torrent para listar arquivos
    // Torbox pode levar um momento para processar metadados se não estiver em cache.
    let torrentInfo = null;
    let retries = 5;

    while(retries > 0) {
        // Listar meus torrents para achar o ID
        const listRes = await this.#request('GET', '/torrents/mylist');
        const found = listRes.data.find(t => t.id === torrentId);
        
        if (found && found.files && found.files.length > 0) {
            torrentInfo = found;
            break;
        }
        
        await wait(1000);
        retries--;
    }

    if (!torrentInfo) {
        throw new Error('Não foi possível recuperar os arquivos do torrent (Timeout ou vazio)');
    }

    // Mapear arquivos para o formato do Jackettio
    // ID formato: "torrentId:fileId"
    return torrentInfo.files.map(file => {
      return {
        name: file.name,
        size: file.size,
        id: `${torrentId}:${file.id}`,
        url: '', // Será gerado em getDownload
        ready: true // Assumimos true se já listou, o getDownload tratará erros
      };
    });
  }

  async getFilesFromBuffer(buffer, infoHash){
     // Torbox API v1 foca em magnet, upload de arquivo .torrent seria multipart
     throw new Error("Upload de arquivo .torrent não implementado para Torbox neste driver.");
  }

  async getDownload(file){
    const [torrentId, fileId] = file.id.split(':');

    // Solicitar link de download
    // Endpoint: /torrents/requestdl?token=...&torrent_id=...&file_id=...
    const query = {
        token: this.#apiKey,
        torrent_id: torrentId,
        file_id: fileId,
        zip: 'false' // Não queremos zip
    };

    try {
        const res = await this.#request('GET', '/torrents/requestdl', { query });
        
        if (res.success && res.data) {
            return res.data; // URL do link direto
        } else {
             // Tratamento específico se estiver processando
             if (res.detail && res.detail.includes('processing')) {
                 throw new Error(ERROR.NOT_READY);
             }
             throw new Error(res.detail || 'Falha ao obter link Torbox');
        }
    } catch (err) {
        // Se der erro de "não encontrado" ou "processando", lançar NOT_READY
        throw err;
    }
  }

  async getUserHash(){
    return createHash('md5').update(this.#apiKey).digest('hex');
  }

  async #request(method, path, opts){
    opts = opts || {};
    const headers = Object.assign(opts.headers || {}, {
      'Authorization': `Bearer ${this.#apiKey}`,
      'Accept': 'application/json'
    });

    // Se for POST com FormData, o fetch seta o Content-Type automaticamente (boundary),
    // então não forçamos 'application/json' no Content-Type.
    
    const queryParams = new URLSearchParams(opts.query || {}).toString();
    const url = `https://api.torbox.app/v1/api${path}?${queryParams}`;

    const fetchOpts = {
      method,
      headers,
      body: opts.body
    };

    const res = await fetch(url, fetchOpts);
    let data;

    try {
      data = await res.json();
    } catch(err){
      data = {};
    }

    if (res.status >= 400) {
        console.error(`Torbox Error ${res.status}:`, data);
        if (res.status === 401 || res.status === 403) throw new Error(ERROR.EXPIRED_API_KEY);
        throw new Error(data.detail || `Erro na API Torbox: ${res.status}`);
    }

    return data;
  }
}
