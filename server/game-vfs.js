// Monte les fichiers du jeu : base (.big) < jeu (.big) < fichiers loose (Data, Art) < mod.
import { join } from 'node:path';
import { Vfs } from '../shared/vfs.js';
import { mountBigsIn, mountDirectory } from './node-io.js';

export async function mountGame({ game, base, mod }) {
  const vfs = new Vfs();
  if (base) await mountBigsIn(vfs, base, 0);
  await mountBigsIn(vfs, game, 10);
  for (const sub of ['Data', 'Art']) {
    try { await mountDirectory(vfs, join(game, sub), 20, sub.toLowerCase()); } catch { /* dossier absent */ }
  }
  if (mod) await mountDirectory(vfs, mod, 30); // un mod reprend l'arborescence du jeu (Data\INI\..., Art\...)
  return vfs;
}
