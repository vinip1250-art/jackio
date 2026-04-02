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
    return {
      url: file.id // magnet link
    };
  }

  async getStreams(streams) {
    return streams;
  }

  async resolve(stream) {
    return stream;
  }
}
