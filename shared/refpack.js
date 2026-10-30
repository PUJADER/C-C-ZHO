// Décompression RefPack (QFS) telle qu'utilisée par les fichiers Generals/Zero Hour ("EAR\0" + taille + flux).
// Module partagé Node + navigateur.

export const isEar = b => b.length > 8 && b[0] === 0x45 && b[1] === 0x41 && b[2] === 0x52; // "EAR"

// Décode un flux RefPack brut à partir de `pos`, vers un tampon de `outSize` octets.
export function refpackDecode(src, pos, outSize) {
  const out = new Uint8Array(outSize);
  let o = 0;
  while (pos < src.length && o < outSize) {
    const c0 = src[pos++];
    let lit, ref = 0, off = 0;
    if (c0 < 0x80) { const c1 = src[pos++]; lit = c0 & 3; ref = ((c0 & 0x1C) >> 2) + 3; off = ((c0 & 0x60) << 3) + c1 + 1; }
    else if (c0 < 0xC0) { const c1 = src[pos++], c2 = src[pos++]; lit = (c1 >> 6) & 3; ref = (c0 & 0x3F) + 4; off = ((c1 & 0x3F) << 8) + c2 + 1; }
    else if (c0 < 0xE0) { const c1 = src[pos++], c2 = src[pos++], c3 = src[pos++]; lit = c0 & 3; ref = ((c0 & 0x0C) << 6) + c3 + 5; off = ((c0 & 0x10) << 12) + (c1 << 8) + c2 + 1; }
    else if (c0 < 0xFC) lit = ((c0 & 0x1F) << 2) + 4;
    else lit = c0 & 3;
    for (let i = 0; i < lit && o < outSize; i++) out[o++] = src[pos++];
    if (ref) {
      if (off > o) throw new Error('RefPack : référence arrière invalide');
      for (let i = 0; i < ref && o < outSize; i++, o++) out[o] = out[o - off];
    }
    if (c0 >= 0xFC) break;
  }
  return out.subarray(0, o);
}

// Fichier complet : "EAR\0" | taille décompressée (LE) | flux (avec ou sans en-tête 0x10FB/0x11FB).
export function decompressEar(b) {
  const size = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true);
  let pos = 8;
  if ((b[pos + 1] === 0xFB) && (b[pos] & 0x3E) === 0x10) { // en-tête RefPack : drapeaux, 0xFB, [taille compressée], taille décompressée
    const big = (b[pos] & 0x80) !== 0, n = big ? 4 : 3;
    pos += 2;
    if (b[pos - 2] & 0x01) pos += n;
    pos += n;
  }
  return refpackDecode(b, pos, size);
}
