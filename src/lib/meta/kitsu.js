import cache from '../cache.js';

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

    const name =
      attrs.titles?.en ||
      attrs.titles?.en_jp ||
      attrs.canonicalTitle ||
      'Unknown Anime';

    const year = attrs.startDate
      ? parseInt(attrs.startDate.split('-')[0])
      : 0;

    return {
      name,
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
