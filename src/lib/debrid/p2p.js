export default class P2P {
  static id = 'p2p';
  static name = 'P2P (Sem Debrid)';
  static shortName = 'P2P';
  static configFields = [];

  constructor(userConfig) {
    this.userConfig = userConfig;
  }

  /**
   * Simula cache: no P2P tudo é "disponível"
   */
  async getTorrentsCached(torrents) {
    return torrents.map(torrent => ({
      ...torrent,
      cached: true
    }));
  }

  /**
   * Pass-through
   */
  async getStreams(streams) {
    return streams;
  }

  async resolve(stream) {
    return stream;
  }

  async getDownload(stream) {
    return stream;
  }
}
