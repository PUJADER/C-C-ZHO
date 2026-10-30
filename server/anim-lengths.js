// Durée des animations d'accostage (DOCKING...) lue dans les .w3d : le ravitaillement enchaîne ses phases sur la fin RÉELLE de
// ces animations (le moteur les joue en ONCE / ONCE_BACKWARDS à une vitesse donnée par l'INI), au lieu de durées fixes.
import { parseW3D } from '../shared/w3d.js';

const key = r => `${r.file}|${r.name}`.toLowerCase();

export function createAnimLengths() {
  const secs = new Map(); // "fichier|nom" -> secondes (0 : introuvable)
  return {
    secondsOf: ref => secs.get(key(ref)),
    // refsOf(nom d'objet) -> références d'animation ; names : noms d'objets à examiner
    async load(vfs, names, refsOf) {
      let n = 0;
      for (const name of names) {
        for (const ref of refsOf(name)) {
          const k = key(ref); if (secs.has(k)) continue;
          secs.set(k, 0);
          for (const f of new Set([ref.file, ref.alt])) { // même ordre de recherche que le client : fichier de l'animation, puis celui du squelette
            try {
              const b = await vfs.readBytes(`art/w3d/${f.toLowerCase()}.w3d`);
              const anims = parseW3D(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).animations;
              const a = anims.find(x => (x.name ?? '').toLowerCase().endsWith(ref.name.toLowerCase())) ?? anims[0];
              if (a) { secs.set(k, (Math.max(2, a.numFrames) - 1) / (a.frameRate || 30)); n++; break; } // durée du clip, comme côté client
            } catch { /* fichier absent : on essaie le suivant */ }
          }
        }
      }
      return n;
    },
  };
}
