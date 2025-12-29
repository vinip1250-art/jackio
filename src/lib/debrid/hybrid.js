import RealDebrid from './realdebrid.js'; // RealDebrid usa export default
import { Torbox } from './torbox.js';     // Torbox usa export nomeado

export class Hybrid {

  static id = 'hybrid';
  static name = 'Hybrid (RD + Torbox)';
  static shortName = 'HY';
  
  // Combina os campos de configuração dos dois serviços
  static configFields = [
    {
      type: 'text', 
      name: 'rdApiKey', 
      label: 'Real-Debrid API Key', 
      required: true, 
      href: {value: 'https://real-debrid.com/apitoken', label:'Get RD Key'}
    },
    {
      type: 'text', 
      name: 'tbApiKey', 
      label: 'Torbox API Key', 
      required: true, 
      href: {value: 'https://torbox.app/settings', label:'Get Torbox Key'}
    }
  ];

  constructor(userConfig) {
    // Instancia o Real-Debrid usando a chave correta
    this.rd = new RealDebrid({
      ...userConfig,
      debridApiKey: userConfig.rdApiKey
    });

    // Instancia o Torbox usando a chave correta
    this.tb = new Torbox({
      ...userConfig,
      debridApiKey: userConfig.tbApiKey
    });
  }

  // Verifica cache em AMBOS os serviços e une os resultados
  async getTorrentsCached(torrents) {
    const [rdCached, tbCached] = await Promise.all([
      this.rd.getTorrentsCached(torrents).catch(() => []),
      this.tb.getTorrentsCached(torrents).catch(() => [])
    ]);

    // Une os hashes encontrados nos dois serviços sem duplicatas
    const uniqueCached = new Set([...rdCached, ...tbCached]);
    return Array.from(uniqueCached);
  }

  // Tenta resolver no RD primeiro, se falhar, tenta no Torbox
  async resolve(magnet) {
    try {
      // Tenta Real-Debrid (Prioridade 1)
      console.log('Hybrid: Tentando resolver via Real-Debrid...');
      return await this.rd.resolve(magnet);
    } catch (error) {
      // Se falhar (não cacheado ou erro), tenta Torbox (Prioridade 2)
      console.log('Hybrid: Falha no RD, tentando Torbox...', error.message);
      return await this.tb.resolve(magnet);
    }
  }

  // Métodos auxiliares necessários que delegam para o RD (ou TB)
  async getFilesFromMagnet(magnet, infoHash) {
    try {
        return await this.rd.getFilesFromMagnet(magnet, infoHash);
    } catch (e) {
        return await this.tb.getFilesFromMagnet(magnet, infoHash);
    }
  }

  async getFilesFromHash(infoHash) {
     try {
        return await this.rd.getFilesFromHash(infoHash);
     } catch(e) {
        return await this.tb.getFilesFromHash(infoHash);
     }
  }

  async getUserHash() {
    // Retorna um hash combinado para identificar o usuário
    const rdHash = await this.rd.getUserHash();
    return rdHash + '_hybrid';
  }
}
