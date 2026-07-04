/**
 * torrentEnrich.js
 * 
 * Injeta trackers adicionais em um buffer .torrent sem modificar o dict "info",
 * preservando o infoHash original.
 * 
 * Apenas os campos fora do "info" são alterados:
 *   - announce       → substitui pelo melhor tracker
 *   - announce-list  → adiciona todos os trackers extras
 */

// Lista de trackers de alta confiabilidade para injetar
export const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.dstud.io:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://www.torrent.eu.org:451/announce',
  'udp://tracker.dler.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker2.dler.org:80/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://wepzone.net:6969/announce',
  'udp://bt.ktrackers.com:6666/announce',
  'http://tracker.bt4g.com:2095/announce',
  'http://open.trackerlist.xyz:80/announce',
  'udp://tracker.filemail.com:6969/announce',
  'udp://tracker.srv00.com:6969/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'https://tracker.ghostchu-services.top:443/announce',
];

// ─── Bencode parser mínimo ───────────────────────────────────────────────────

/**
 * Decodifica um valor bencode a partir de `buf` na posição `offset`.
 * Retorna { value, end } onde `end` é o índice exclusivo após o valor.
 */
function bdecode(buf, offset = 0) {
  const ch = buf[offset];

  // Inteiro: i<digits>e
  if (ch === 0x69 /* 'i' */) {
    const end = buf.indexOf(0x65 /* 'e' */, offset + 1);
    if (end === -1) throw new Error('bencode: integer sem fechamento');
    const value = parseInt(buf.slice(offset + 1, end).toString('ascii'), 10);
    return { value, end: end + 1 };
  }

  // Lista: l...e
  if (ch === 0x6c /* 'l' */) {
    const list = [];
    let i = offset + 1;
    while (buf[i] !== 0x65 /* 'e' */) {
      const item = bdecode(buf, i);
      list.push(item.value);
      i = item.end;
    }
    return { value: list, end: i + 1 };
  }

  // Dicionário: d...e
  if (ch === 0x64 /* 'd' */) {
    const dict = {};
    let i = offset + 1;
    while (buf[i] !== 0x65 /* 'e' */) {
      const key = bdecode(buf, i);
      i = key.end;
      const val = bdecode(buf, i);
      i = val.end;
      dict[key.value.toString('ascii')] = val.value;
    }
    return { value: dict, end: i + 1 };
  }

  // String: <len>:<data>
  const colon = buf.indexOf(0x3a /* ':' */, offset);
  if (colon === -1) throw new Error(`bencode: string sem colon na posição ${offset}`);
  const len = parseInt(buf.slice(offset, colon).toString('ascii'), 10);
  const start = colon + 1;
  return { value: buf.slice(start, start + len), end: start + len };
}

// ─── Bencode encoder ─────────────────────────────────────────────────────────

/**
 * Codifica um valor para bencode, retornando um Buffer.
 * Aceita: Buffer, string, number, Array, plain object.
 * 
 * IMPORTANTE: objetos com chave '_raw' usam o Buffer raw diretamente,
 * permitindo preservar o dict "info" sem re-encodar (mantém infoHash).
 */
function bencode(value) {
  if (value && value._raw) {
    // Buffer raw preservado — usado para o dict "info"
    return value._raw;
  }

  if (Buffer.isBuffer(value)) {
    const lenBuf = Buffer.from(`${value.length}:`);
    return Buffer.concat([lenBuf, value]);
  }

  if (typeof value === 'string') {
    return bencode(Buffer.from(value, 'utf8'));
  }

  if (typeof value === 'number') {
    return Buffer.from(`i${value}e`);
  }

  if (Array.isArray(value)) {
    const parts = value.map(bencode);
    return Buffer.concat([Buffer.from('l'), ...parts, Buffer.from('e')]);
  }

  if (typeof value === 'object' && value !== null) {
    // Dicionários bencode devem ter chaves ordenadas lexicograficamente
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      parts.push(bencode(k));
      parts.push(bencode(value[k]));
    }
    return Buffer.concat([Buffer.from('d'), ...parts, Buffer.from('e')]);
  }

  throw new Error(`bencode: tipo não suportado: ${typeof value}`);
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Injeta trackers extras em um buffer .torrent.
 * 
 * - Preserva o dict "info" intacto (infoHash não muda)
 * - Substitui "announce" pelo tracker mais confiável
 * - Faz merge de "announce-list" existente + trackers extras (sem duplicatas)
 * 
 * @param {Buffer} buffer  Buffer original do arquivo .torrent
 * @param {string[]} [extraTrackers]  Lista de trackers a injetar (default: EXTRA_TRACKERS)
 * @returns {Buffer}  Novo buffer com trackers injetados
 */
export function injectTrackers(buffer, extraTrackers = EXTRA_TRACKERS) {
  try {
    const parsed = bdecode(buffer, 0);
    const torrent = parsed.value;

    if (typeof torrent !== 'object' || Array.isArray(torrent)) {
      console.warn('[torrentEnrich] Buffer não é um dicionário bencode válido');
      return buffer;
    }

    // Coleta trackers existentes do announce-list
    const existingTrackers = new Set();

    if (torrent['announce']) {
      const ann = torrent['announce'];
      const annStr = Buffer.isBuffer(ann) ? ann.toString('utf8') : String(ann);
      if (annStr.startsWith('http') || annStr.startsWith('udp')) {
        existingTrackers.add(annStr);
      }
    }

    if (Array.isArray(torrent['announce-list'])) {
      for (const tier of torrent['announce-list']) {
        const tierArr = Array.isArray(tier) ? tier : [tier];
        for (const tr of tierArr) {
          const trStr = Buffer.isBuffer(tr) ? tr.toString('utf8') : String(tr);
          existingTrackers.add(trStr);
        }
      }
    }

    // Merge: existentes + extras (sem duplicatas, case-insensitive)
    const existingLower = new Set([...existingTrackers].map(t => t.toLowerCase()));
    const newTrackers = extraTrackers.filter(t => !existingLower.has(t.toLowerCase()));
    const allTrackers = [...existingTrackers, ...newTrackers];

    console.log(`[torrentEnrich] Trackers: ${existingTrackers.size} existentes + ${newTrackers.length} novos = ${allTrackers.length} total`);

    // Preserva o dict "info" como raw buffer para não alterar o infoHash
    // Localiza o offset exato do valor "info" no buffer original
    const infoRaw = extractInfoRaw(buffer);

    // Monta o novo dicionário do torrent
    const newTorrent = {
      // Trackers atualizados
      'announce': allTrackers[0] || EXTRA_TRACKERS[0],
      'announce-list': allTrackers.map(t => [t]),
    };

    // Copia todos os outros campos exceto 'info', 'announce', 'announce-list'
    for (const key of Object.keys(torrent)) {
      if (key === 'info' || key === 'announce' || key === 'announce-list') continue;
      newTorrent[key] = torrent[key];
    }

    // Injeta o "info" raw preservado
    if (infoRaw) {
      newTorrent['info'] = { _raw: infoRaw };
    } else if (torrent['info']) {
      // Fallback: re-encode o info (menos seguro mas melhor que falhar)
      console.warn('[torrentEnrich] Não foi possível extrair info raw, re-encodando (infoHash pode mudar)');
      newTorrent['info'] = torrent['info'];
    }

    const newBuffer = bencode(newTorrent);
    console.log(`[torrentEnrich] Buffer: ${buffer.length} → ${newBuffer.length} bytes`);
    return newBuffer;

  } catch (e) {
    console.error(`[torrentEnrich] Erro ao injetar trackers: ${e.message}`);
    return buffer; // Retorna original em caso de falha
  }
}

/**
 * Extrai o buffer raw do valor da chave "info" no torrent bencoded.
 * Usado para preservar o infoHash original após re-encode.
 */
function extractInfoRaw(buf) {
  try {
    // Localiza "4:info" no buffer
    const needle = Buffer.from('4:info');
    const idx = bufferIndexOf(buf, needle);
    if (idx === -1) return null;

    const valueStart = idx + needle.length;
    const valueEnd = findBencodeEnd(buf, valueStart);
    if (valueEnd === -1) return null;

    return buf.slice(valueStart, valueEnd);
  } catch {
    return null;
  }
}

/**
 * Busca um sub-buffer dentro de um buffer maior.
 */
function bufferIndexOf(haystack, needle) {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

/**
 * Encontra o índice de fim de um valor bencoded começando em `start`.
 */
function findBencodeEnd(buf, start) {
  try {
    const ch = buf[start];

    if (ch === 0x64 /* 'd' */) {
      let i = start + 1;
      while (i < buf.length && buf[i] !== 0x65) {
        const k = findBencodeEnd(buf, i); if (k === -1) return -1; 
        const v = findBencodeEnd(buf, k);  if (v === -1) return -1;
        i = v;
      }
      return i + 1;
    }

    if (ch === 0x6c /* 'l' */) {
      let i = start + 1;
      while (i < buf.length && buf[i] !== 0x65) {
        const e = findBencodeEnd(buf, i); if (e === -1) return -1;
        i = e;
      }
      return i + 1;
    }

    if (ch === 0x69 /* 'i' */) {
      const end = buf.indexOf(0x65, start + 1);
      return end === -1 ? -1 : end + 1;
    }

    if (ch >= 0x30 && ch <= 0x39 /* '0'-'9' */) {
      const colon = buf.indexOf(0x3a, start);
      if (colon === -1) return -1;
      const len = parseInt(buf.slice(start, colon).toString('ascii'), 10);
      return colon + 1 + len;
    }

    return -1;
  } catch {
    return -1;
  }
}
