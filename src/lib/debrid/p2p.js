export default class P2P {
  static id = 'p2p';
  static name = 'P2P (Sem Debrid)';
  static shortName = 'P2P';
  static configFields = [];

  constructor(userConfig) {
    this.userConfig = userConfig;
  }

  /**
   * Necessário pro cache do sistema
   */
  async getUserHash() {
    return 'p2p'; // valor fixo (sem usuário)
  }

  /**
   * No P2P tudo é "disponível"
   */
  async getTorrentsCached(torrents) {
    return torrents.map(t => ({
      ...t,
      cached: true
    }));
  }

  /**
   * Quando o sistema tenta pegar arquivos do torrent
   * Aqui usamos magnet direto
   */
  async getFilesFromMagnet(magnetUrl) {
    return [{
      id: magnetUrl,
      name: magnetUrl,
      size: 0
    }];
  }

  async getFilesFromHash(infoHash) {
    return [{
      id: `magnet:?xt=urn:btih:${infoHash}`,
      name: infoHash,
      size: 0
    }];
  }

  async getFilesFromBuffer(buffer, infoHash) {
    return this.getFilesFromHash(infoHash);
  }

  /**
   * Retorna stream direto (magnet)
   */
async getDownload(file) {
  let url = file?.id;

  // 🔥 Caso venha objeto (bug atual)
  if (typeof url === 'object') {
    // tenta extrair magnet
    if (url?.magnet) url = url.magnet;
    else if (url?.url) url = url.url;
    else url = JSON.stringify(url); // fallback debug
  }

  if (!url) {
    throw new Error('P2P: invalid file id');
  }

  url = String(url);

  // garante formato magnet válido
  if (!url.startsWith('magnet:')) {
    // tenta converter hash em magnet
    if (/^[a-f0-9]{40}$/i.test(url)) {
      url = `magnet:?xt=urn:btih:${url}`;
    }
  }

  return url;
}
}
