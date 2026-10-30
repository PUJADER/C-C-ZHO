// Convertit les vidéos Bink (.bik) de Zero Hour en .mp4 lisibles par le navigateur, dans client/media/.
// Usage : node tools/convert-movies.mjs "C:\Program Files (x86)\EA Games\Command & Conquer Generals Zero Hour" [largeur max]
// Nécessite ffmpeg dans le PATH (https://ffmpeg.org). Les fichiers déjà convertis sont ignorés.
// Le son est supprimé : ce sont des fonds muets, la musique est jouée à part.
import { readdir, mkdir, stat } from 'node:fs/promises';
import { join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const [game, maxW = '1280'] = process.argv.slice(2);
if (!game) { console.error('Usage : node tools/convert-movies.mjs "<dossier du jeu>" [largeur max]'); process.exit(1); }
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'media');
await mkdir(out, { recursive: true });

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}
const run = args => new Promise(res => { const c = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; c.stderr.on('data', d => { err += d; }); c.on('error', () => res({ code: -1, err: 'ffmpeg introuvable (installe-le et ajoute-le au PATH)' })); c.on('close', code => res({ code, err })); });

let done = 0, skipped = 0, failed = 0;
for await (const f of walk(join(game, 'Data'))) {
  if (extname(f).toLowerCase() !== '.bik') continue;
  const dest = join(out, basename(f, extname(f)) + '.mp4');
  if (await stat(dest).then(() => true, () => false)) { skipped++; continue; }
  process.stdout.write(`${basename(f)} … `);
  const r = await run(['-y', '-i', f, '-an', '-vf', `scale='min(${maxW},iw)':-2`, '-c:v', 'libx264', '-crf', '26', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest]);
  if (r.code === 0) { done++; console.log('ok'); } else { failed++; console.log('ÉCHEC'); console.error(r.err.split('\n').slice(-4).join('\n')); if (r.code === -1) process.exit(1); }
}
console.log(`\nTerminé : ${done} converti(s), ${skipped} déjà présent(s), ${failed} échec(s) -> ${out}`);
