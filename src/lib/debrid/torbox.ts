import axios from 'axios';
import { DebridProvider } from './debridProvider'; // Verifique o caminho correto da interface

export class Torbox implements DebridProvider {
	name = 'Torbox';
	shortName = 'TB';
	private apiKey: string;
	private baseUrl = 'https://api.torbox.app/v1/api';

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	// Verifica se os hashes estão em cache
	async getCached(hashes: string[]): Promise<boolean[]> {
		try {
			// O Torbox aceita múltiplos hashes separados por vírgula
			const hashList = hashes.join(',');
			const response = await axios.get(`${this.baseUrl}/torrents/checkcached`, {
				params: { 
					hash: hashList,
					format: 'list' 
				},
				headers: { Authorization: `Bearer ${this.apiKey}` }
			});

			// A API retorna um objeto onde as chaves são os hashes ou uma lista
			// Ajuste conforme o retorno exato da API v1, mas geralmente é um map
			const data = response.data.data; 
            
            // Se retornar um objeto { "hash": true, "hash2": false }
			if (!Array.isArray(data)) {
				return hashes.map(h => data[h] === true);
			}
            
            return data; // Se já retornar array de booleanos
		} catch (error) {
			console.error('Torbox check cache error:', error);
			return hashes.map(() => false);
		}
	}

	// Adiciona o magnet e retorna o link direto
	async resolve(magnet: string): Promise<string> {
		try {
			// 1. Adicionar o Magnet
			const createForm = new FormData();
			createForm.append('magnet', magnet);
			
			const createRes = await axios.post(`${this.baseUrl}/torrents/create`, createForm, {
				headers: { Authorization: `Bearer ${this.apiKey}` }
			});

			if (!createRes.data.success) {
				throw new Error('Falha ao adicionar torrent no Torbox');
			}

			const torrentId = createRes.data.data.torrent_id;

			// 2. Obter informações do torrent (para pegar o ID do arquivo de vídeo)
            // O Torbox pode demorar um pouco para processar se não for instantâneo.
            // Aqui assumimos que é cached (já que o Jackettio filtra cached).
			const infoRes = await axios.get(`${this.baseUrl}/torrents/mylist`, {
				headers: { Authorization: `Bearer ${this.apiKey}` }
			});

            // Encontrar o torrent adicionado na lista
			const torrent = infoRes.data.data.find((t: any) => t.id === torrentId);
			if (!torrent) throw new Error('Torrent não encontrado na lista');

			// Lógica para pegar o maior arquivo (geralmente o filme/episódio)
			const videoFile = torrent.files
				.sort((a: any, b: any) => b.size - a.size)[0];

			if (!videoFile) throw new Error('Nenhum arquivo de vídeo encontrado');

			// 3. Gerar o Link de Download
			const linkRes = await axios.get(`${this.baseUrl}/torrents/requestdl`, {
				params: {
					token: this.apiKey,
					torrent_id: torrentId,
					file_id: videoFile.id
				}
			});

			if (linkRes.data.success && linkRes.data.data) {
				return linkRes.data.data; // URL direta
			}
            
            throw new Error('Link não retornado');

		} catch (error) {
			console.error('Torbox resolve error:', error);
			throw error;
		}
	}
}
