export default class P2P {
  static id = 'p2p';
  static name = 'P2P (Sem Debrid)';
  static shortName = 'P2P';
  static configFields = []; // sem configuração

  constructor(userConfig) {
    this.userConfig = userConfig;
  }

  /**
   * Pass-through: retorna os links exatamente como vieram
   */
  async getStreams(streams) {
    return streams;
  }

  /**
   * Alguns providers usam "resolve"
   */
  async resolve(stream) {
    return stream;
  }

  /**
   * Compatibilidade com outros fluxos
   */
  async getDownload(stream) {
    return stream;
  }
}
