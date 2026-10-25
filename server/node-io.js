// Accès disque côté Node : lecture d'archives .big et de dossiers loose.
import { open, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { BigArchive } from '../shared/big.js';

export class NodeFileReader {
  constructor(fh, size) { this.fh = fh; this.size = size; }
  static async open(path) {
    const fh = await open(path, 'r');
    const { size } = await fh.stat();
    return new NodeFileReader(fh, size);
  }
  async read(offset, length) {
    const buf = new Uint8Array(length);
    const { bytesRead } = await this.fh.read(buf, 0, length, offset);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  }
}

// Monte tous les *.big d'un dossier (ordre alphabétique).
export async function mountBigsIn(vfs, dir, priority) {
  const names = (await readdir(dir)).filter(n => n.toLowerCase().endsWith('.big')).sort();
  for (const n of names) {
    const reader = await NodeFileReader.open(join(dir, n));
    vfs.mountArchive(await BigArchive.open(reader, n), priority);
  }
  return names;
}

// Monte récursivement un dossier de fichiers "loose" (ex. Data\INI\... ou un mod).
export async function mountDirectory(vfs, root, priority, prefix = '') {
  let count = 0;
  async function walk(dir) {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else {
        const rel = (prefix ? prefix + '/' : '') + relative(root, full);
        vfs.add(rel, priority, async () => new Uint8Array(await readFile(full)), root);
        count++;
      }
    }
  }
  await walk(root);
  return count;
}
