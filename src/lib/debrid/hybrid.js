import RealDebrid from './realdebrid.js';
import Torbox from './torbox.js';

export default class Hybrid {

  static id = 'hybrid';
  static name = 'Hybrid (RD + Torbox)';
  static shortName = '[RD+TB]'; 
  
  static configFields = [
    { type: 'text', name: 'rdApiKey', label: 'Real-Debrid API Key', required: true, href: {value: 'https://real-debrid.com/apitoken', label:'Get RD Key'} },
    { type: 'text', name: 'tbApiKey', label: 'Torbox API Key', required: true, href: {value: 'https://torbox.app/settings', label:'Get Torbox Key'} }
  ];

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.rd = new RealDebrid({ ...userConfig, debridApiKey: userConfig.rdApiKey });
    this.tb = new Torbox({ ...userConfig, debridApiKey: userConfig.tbApiKey });
  }

  async getTorrentsCached(torrents) {
    const rdCached = await this.rd.getTorrentsCached(torrents).catch(() => []);
    const tbCached = await this.tb.getTorrentsCached(torrents).catch(() => []);

    const rdHashes = new Set(rdCached.map(t => t.infos.infoHash));
    const tbHashes = new Set(tbCached.map(t => t.infos.infoHash));

    const finalResults = [];

    for (const torrent of torrents) {
        const hash = torrent.infos.infoHash;
        const inRd = rdHashes.has(hash);
        const inTb = tbHashes.has(hash);
        const originalId = torrent.id;

        if (inRd && inTb) {
            torrent.shortName = 'RD';
            torrent.id = `rd:${originalId}`;
            finalResults.push(torrent);

            const clone = Object.assign({}, torrent);
            clone.infos = Object.assign({}, torrent.infos); 
            clone.shortName = 'TB';
            clone.id = `tb:${originalId}`;
            finalResults.push(clone);

        } else if (inRd) {
            torrent.shortName = 'RD';
            torrent.id = `rd:${originalId}`;
            finalResults.push(torrent);

        } else if (inTb) {
            torrent.shortName = 'TB';
            torrent.id = `tb:${originalId}`;
            finalResults.push(torrent);
        }
    }
    return finalResults;
  }

  async getProgressTorrents(torrents) { return {}; }

  async resolve(magnet) {
    try { return await this.rd.resolve(magnet); } 
    catch (error) { return await this.tb.resolve(magnet); }
  }

  // Estes métodos de fallback usam RD primeiro (padrão antigo),
  // mas o jackettio.js agora vai ignorar isso se tiver prefixo!
  async getFilesFromMagnet(magnet, infoHash) {
    try {
        const files = await this.rd.getFilesFromMagnet(magnet, infoHash);
        return files.map(f => ({...f, id: `rd:${f.id}`}));
    } catch (e) {
        const files = await this.tb.getFilesFromMagnet(magnet, infoHash);
        return files.map(f => ({...f, id: `tb:${f.id}`}));
    }
  }

  async getFilesFromBuffer(buffer, infoHash) {
    try {
      const files = await this.rd.getFilesFromBuffer(buffer, infoHash);
      return files.map(f => ({...f, id: `rd:${f.id}`}));
    } catch (e) {
      const files = await this.tb.getFilesFromBuffer(buffer, infoHash);
      return files.map(f => ({...f, id: `tb:${f.id}`}));
    }
  }

  async getFilesFromHash(infoHash) {
     try {
        const files = await this.rd.getFilesFromHash(infoHash);
        return files.map(f => ({...f, id: `rd:${f.id}`}));
     } catch(e) {
        const files = await this.tb.getFilesFromHash(infoHash);
        return files.map(f => ({...f, id: `tb:${f.id}`}));
     }
  }
  
  async getDownload(file) {
    const [servicePrefix, ...rest] = file.id.split(':');
    const originalFileId = rest.join(':');
    const fileForService = { ...file, id: originalFileId };

    if (servicePrefix === 'rd') {
        return await this.rd.getDownload(fileForService);
    } else if (servicePrefix === 'tb') {
        return await this.tb.getDownload(fileForService);
    } else {
        return await this.rd.getDownload(file);
    }
  }

  async getUserHash() {
    const rdHash = await this.rd.getUserHash();
    return rdHash + '_hybrid';
  }
}
