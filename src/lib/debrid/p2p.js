import { buildTorrentInfo } from "./torrentInfos.js";

export async function buildP2PStreams(torrents, config) {
  return torrents.map(torrent => {
    const info = buildTorrentInfo(torrent);

    return {
      name: `[P2P] ${info.title}`,
      title: `${info.title}\n🌱 ${info.seeders} | 💾 ${info.size}`,
      infoHash: info.infoHash,
      fileIdx: 0,
      sources: [`tracker:${info.magnet}`]
    };
  });
}
