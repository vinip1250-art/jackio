import Torbox from './torbox.js';
import Offcloud from './offcloud.js';

export default class HybridOC {

  static id = 'hybridoc';
  static name = 'Hybrid (TB + OC)';
  static shortName = '[TB+OC]';

  static configFields = [
    { type: 'text', name: 'tbApiKey', label: 'Torbox API Key',   required: true, href: { value: 'https://torbox.app/settings',    label: 'Get Torbox Key'   } },
    { type: 'text', name: 'ocApiKey', label: 'Offcloud API Key', required: true, href: { value: 'https://offcloud.com/#/account',  label: 'Get Offcloud Key' } },
  ];

  constructor(userConfig) {
    Object.assign(this, this.constructor);
    this.tb = new Torbox(   { ...userConfig, debridApiKey: userConfig.tbApiKey });
    this.oc = new Offcloud( { ...userConfig, debridApiKey: userConfig.ocApiKey });
  }

  async getTorrentsCached(torrents) {
    const [tbCached, ocCached] = await Promise.all([
      this.tb.getTorrentsCached(torrents).catch(() => []),
      this.oc.getTorrentsCached(torrents).catch(() => []),
    ]);

    const tbHashes = new Set(tbCached.map(t => t.infos?.infoHash).filter(Boolean));
    const ocHashes = new Set(ocCached.map(t => t.infos?.infoHash).filter(Boolean));

    const results = [];
    for (const torrent of torrents) {
      const hash = torrent.infos?.infoHash;
      const inTb = tbHashes.has(hash);
      const inOc = ocHashes.has(hash);
      const origId = torrent.id;

      if (inTb && inOc) {
        results.push({ ...torrent, shortName: 'TB', id: `tb:${origId}` });
        results.push({ ...torrent, infos: { ...torrent.infos }, shortName: 'OC', id: `oc:${origId}` });
      } else if (inTb) {
        results.push({ ...torrent, shortName: 'TB', id: `tb:${origId}` });
      } else if (inOc) {
        results.push({ ...torrent, shortName: 'OC', id: `oc:${origId}` });
      }
    }
    return results;
  }

  async getProgressTorrents() { return {}; }

  async getFilesFromMagnet(magnet, infoHash) {
    try {
      const files = await this.tb.getFilesFromMagnet(magnet, infoHash);
      return files.map(f => ({ ...f, id: `tb:${f.id}` }));
    } catch {
      const files = await this.oc.getFilesFromMagnet(magnet, infoHash);
      return files.map(f => ({ ...f, id: `oc:${f.id}` }));
    }
  }

  async getFilesFromBuffer(buffer, infoHash) {
    try {
      const files = await this.tb.getFilesFromBuffer(buffer, infoHash);
      return files.map(f => ({ ...f, id: `tb:${f.id}` }));
    } catch {
      const files = await this.oc.getFilesFromBuffer(buffer, infoHash);
      return files.map(f => ({ ...f, id: `oc:${f.id}` }));
    }
  }

  async getFilesFromHash(infoHash) {
    try {
      const files = await this.tb.getFilesFromHash(infoHash);
      return files.map(f => ({ ...f, id: `tb:${f.id}` }));
    } catch {
      const files = await this.oc.getFilesFromHash(infoHash);
      return files.map(f => ({ ...f, id: `oc:${f.id}` }));
    }
  }

  async getDownload(file) {
    const [prefix, ...rest] = file.id.split(':');
    const cleanId = rest.join(':');
    const fileForService = { ...file, id: cleanId };

    if (prefix === 'tb') return this.tb.getDownload(fileForService);
    if (prefix === 'oc') return this.oc.getDownload(fileForService);
    return this.tb.getDownload(file);
  }

  async getUserHash() {
    const h = await this.tb.getUserHash();
    return h + '_hybridoc';
  }
}
