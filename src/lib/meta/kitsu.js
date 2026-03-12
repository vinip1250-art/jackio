import cache from '../cache.js';

// Sufixos que o Kitsu adiciona ao título mas que não aparecem nos torrents
const KITSU_NAME_SUFFIXES = [
  /\s*[-–]\s*[^-–]+$/,                         // " - Arise from the Shadow-" e similares
  /\s*:?\s*Season\s+\d+(\s+Part\s+\d+)?$/i,    // "Season 2", "Season 2 Part 1"
  /\s*Part\s+\d+$/i,                            // "Part 2"
  /\s*Cour\s+\d+$/i,                            // "Cour 2"
  /\s*\(\d{4}\)$/,                              // "(2024)"
];

function simplifyAnimeName(name) {
  let simplified = name.trim();
  for (const pattern of KITSU_NAME_SUFFIXES) {
    simplified = simplified.replace(pattern, '').trim();
  }
  // Remove pontuação no final que pode sobrar
  simplified = simplified.replace(/[:\-–,]+$/, '').trim();
  return simplified || name;
}

export default class Kitsu {

  static id = 'kitsu';
  static name = 'Kitsu';

  async getMovieById(id) {
    return this.#getAnime(id);
  }

  async getEpisodeById(id, season, episode) {
    return this.#getAnime(id, season, episode);
  }

  async #getAnime(id, season = 0, episode = 0) {
    const kitsuId = id.startsWith('kitsu:') ? id.replace('kitsu:', '') : id;

    const data = await this.#request(
      `https://kitsu.io/api/edge/anime/${kitsuId}`,
      `kitsu:anime:${kitsuId}`
    );

    const attrs = data?.data?.attributes;
    if (!attrs) throw new Error(`Kitsu: anime ${kitsuId} não encontrado`);

    const fullName =
      attrs.titles?.en ||
      attrs.titles?.en_jp ||
      attrs.canonicalTitle ||
      'Unknown Anime';

    const searchName = simplifyAnimeName(fullName);

    if (searchName !== fullName) {
      console.log(`[KITSU] nome original: "${fullName}" → busca: "${searchName}"`);
    }

    const year = attrs.startDate
      ? parseInt(attrs.startDate.split('-')[0])
      : 0;

    return {
      name: searchName,
      fullName,
      year,
      imdb_id: null,
      type: 'series',
      stremioId: episode ? `kitsu:${kitsuId}:${season}:${episode}` : `kitsu:${kitsuId}`,
      id: `kitsu:${kitsuId}`,
      season,
      episode,
      episodes: []
    };
  }

  async #request(url, cacheKey) {
    if (cacheKey) {
      const cached = await cache.get(cacheKey);
      if (cached) return cached;
    }

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json'
      }
    });

    if (!res.ok) throw new Error(`Kitsu API error: ${res.status}`);

    const data = await res.json();

    if (cacheKey) {
      await cache.set(cacheKey, data, { ttl: 3600 * 6 });
    }

    return data;
  }

}
