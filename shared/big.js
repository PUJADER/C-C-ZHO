// Lecteur d'archives .big (format BIGF de Generals / Zero Hour).
// Module partagé Node + navigateur : il ne dépend que d'un "reader" avec
//   { size, read(offset, length) -> Promise<Uint8Array> }
// (NodeFileReader côté serveur, BlobReader côté navigateur / Tauri).

export class BlobReader {
  constructor(blob) { this.blob = blob; this.size = blob.size; }
  async read(offset, length) {
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

export function normPath(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

export class BigArchive {
  constructor(reader, entries, name) {
    this.reader = reader;
    this.entries = entries; // [{ path, rawPath, offset, size }]
    this.name = name;
  }

  // Header : "BIGF" | taille archive (LE) | nb fichiers (BE) | offset 1er fichier (BE)
  // Puis pour chaque fichier : offset (BE) | taille (BE) | chemin terminé par \0
  static async open(reader, name = '') {
    const head = await reader.read(0, 16);
    const magic = String.fromCharCode(head[0], head[1], head[2], head[3]);
    if (magic !== 'BIGF' && magic !== 'BIG4') {
      throw new Error(`${name}: signature invalide "${magic}" (pas une archive .big)`);
    }
    const hv = new DataView(head.buffer, head.byteOffset, 16);
    const count = hv.getUint32(8, false);
    let firstOffset = hv.getUint32(12, false);
    if (firstOffset < 16 || firstOffset > reader.size) {
      firstOffset = Math.min(reader.size, 8 * 1024 * 1024); // garde-fou
    }
    const idx = await reader.read(16, firstOffset - 16);
    const dv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      const offset = dv.getUint32(p, false);
      const size = dv.getUint32(p + 4, false);
      p += 8;
      let end = p;
      while (end < idx.length && idx[end] !== 0) end++;
      let raw = '';
      for (let k = p; k < end; k++) raw += String.fromCharCode(idx[k]);
      p = end + 1;
      entries.push({ path: normPath(raw), rawPath: raw, offset, size });
    }
    return new BigArchive(reader, entries, name);
  }

  read(entry) { return this.reader.read(entry.offset, entry.size); }
}
