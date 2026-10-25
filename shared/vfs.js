// Système de fichiers virtuel : empile des sources (archives .big, dossiers
// "loose", dossier de mod) avec une priorité. À priorité égale, la dernière
// montée gagne. Chemins normalisés : minuscules, séparateur "/".
import { normPath } from './big.js';

const latin1 = new TextDecoder('windows-1252');

export class Vfs {
  constructor() { this.index = new Map(); }

  add(path, priority, read, origin) {
    const key = normPath(path);
    const cur = this.index.get(key);
    if (cur && cur.priority > priority) return;
    this.index.set(key, { priority, read, origin });
  }

  mountArchive(archive, priority) {
    for (const e of archive.entries) {
      this.add(e.path, priority, () => archive.read(e), archive.name);
    }
  }

  has(path) { return this.index.has(normPath(path)); }
  originOf(path) { return this.index.get(normPath(path))?.origin ?? null; }

  async readBytes(path) {
    const f = this.index.get(normPath(path));
    if (!f) throw new Error(`Fichier introuvable : ${path}`);
    return f.read();
  }

  async readText(path) { return latin1.decode(await this.readBytes(path)); }

  list(prefix, ext = '') {
    const pre = normPath(prefix);
    const out = [];
    for (const k of this.index.keys()) {
      if (k.startsWith(pre) && k.endsWith(ext)) out.push(k);
    }
    return out.sort();
  }
}
