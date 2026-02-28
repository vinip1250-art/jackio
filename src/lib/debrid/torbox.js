import {createHash} from 'crypto';
import {ERROR} from './const.js';
import {wait} from '../util.js';

// Lock global por torrentId: evita múltiplos loops de polling paralelos para o mesmo torrent
// (Stremio dispara 3-4 requisições simultâneas para a mesma URL)
const _pollLocks = new Map(); // torrentId -> Promise

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
    // Se não for magnet real (ex: URL HTTP do Prowlarr), constrói a partir do hash
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

  // Usa URLSearchParams (form-urlencoded) com allow_zip=false —
  // imita exatamente o envio manual pelo browser, necessário para trackers privados
  // (CapybaraBR, AmigosshareClub etc.) que rejeitam multipart/form-data
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

  // Upload de arquivo .torrent via multipart/form-data (fluxo do getFilesFromBuffer)
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

  /**
   * CORREÇÃO PRINCIPAL:
   *
   * Problema 1 — files=[] durante checking/downloading:
   *   O TorBox só popula o array `files` DEPOIS que download_present=true (download 100% concluído).
   *   Durante checking e downloading, files=[] SEMPRE.
   *   A solução: quando o torrent está em estado ativo (checking/downloading), chamamos
   *   requestdl com apenas o torrent_id (sem file_id). O TorBox aceita isso e retorna
   *   o link de streaming progressivo mesmo com download incompleto.
   *
   * Problema 2 — múltiplos loops paralelos (Stremio dispara 3-4 requests simultâneos):
   *   Usamos um lock global por torrentId. Se já existe um poll rodando para esse ID,
   *   as demais requisições aguardam e reutilizam o mesmo resultado.
   */
  async #waitForTorrentReady(id, infoHash){
    // LOCK: se já existe um poll para este torrentId, aguarda e retorna o mesmo resultado
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
    // Fase 1: aguarda o torrent aparecer e sair do metaDL (máx 60s)
    // Fase 2: assim que estiver em checking/downloading/cached, retorna imediatamente
    //         com um "file virtual" baseado no torrent_id para que requestdl funcione.

    let retries = 60; // 60 × 2000ms = 2 minutos máximo
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

                // Sucesso completo: TorBox já tem o arquivo, usa file_id real
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

                // Estado ativo sem files ainda: retorna "file virtual" para usar requestdl sem file_id
                // O TorBox suporta requestdl com só torrent_id para torrents de arquivo único
                if (ACTIVE_STATES.has(state) && filesCount === 0) {
                    const fileName = infoHash
                        ? `torrent_${infoHash.slice(0, 8)}.mkv`
                        : `torrent_${id}.mkv`;
                    console.log(`[Torbox] Torrent ${id} em ${state}, usando requestdl sem file_id (streaming progressivo)`);
                    return [{
                        name: fileName,
                        size: found.size || 0,
                        id: `${id}:`, // file_id vazio = requestdl usa só torrent_id
                        url: '',
                        ready: false
                    }];
                }

                // Estado de erro — não adianta esperar
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
    const fileId = parts[1] || ''; // pode ser vazio para torrents de arquivo único
    
    const query = { 
        token: this.#apiKey, 
        torrent_id: torrentId,
        zip: 'false'
    };

    // Só inclui file_id se tiver um valor real
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
        delete headers['Content-Type']; // deixa o browser setar boundary do multipart
    }
    // URLSearchParams define seu próprio Content-Type automaticamente (application/x-www-form-urlencoded)
    
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
