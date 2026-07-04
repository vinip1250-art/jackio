import config from './config.js';
import Cinemeta from './meta/cinemeta.js';
import Tmdb from './meta/tmdb.js';
import Kitsu from './meta/kitsu.js';

const client = config.tmdbAccessToken ? new Tmdb() : new Cinemeta();
const kitsu = new Kitsu();

function isKitsuId(id) {
  return String(id).startsWith('kitsu:');
}

export async function getMovieById(id, language) {
  if (isKitsuId(id)) return kitsu.getMovieById(id);
  return client.getMovieById(id, language);
}

export async function getEpisodeById(id, season, episode, language) {
  if (isKitsuId(id)) return kitsu.getEpisodeById(id, season, episode);
  return client.getEpisodeById(id, season, episode, language);
}

export async function getLanguages() {
  return client.getLanguages();
}
