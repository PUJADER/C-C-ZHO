// Cameos et images d'interface : un nom d'image (ButtonImage, SelectPortrait...) désigne un bloc MappedImage qui donne
// une texture d'interface (SAUserInterface512_001.tga...) et un rectangle dedans. Le serveur résout le nom (/api/image/<nom>),
// la texture est lue par /api/terrain-tex/<fichier> (cherche dans art/terrain puis art/textures, en .tga ou .dds), puis on découpe.
import { decodeTga, decodeDds } from '/terrain-tex.js';

const infos = new Map();  // nom d'image -> Promise<{ file, tw, th, l, t, r, b, rot } | null>
const sheets = new Map(); // fichier de texture -> Promise<ImageData | null>
const urls = new Map();   // nom d'image -> Promise<string | null> (data URL du cameo découpé)

const info = name => {
  if (!infos.has(name)) infos.set(name, fetch(`/api/image/${encodeURIComponent(name)}`).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return infos.get(name);
};

function sheet(file) {
  if (!sheets.has(file)) sheets.set(file, (async () => {
    const r = await fetch(`/api/terrain-tex/${encodeURIComponent(file)}`);
    if (!r.ok) return null;
    const ext = r.headers.get('X-Tex-Ext'), buf = await r.arrayBuffer();
    try { return ext === 'dds' ? decodeDds(buf) : decodeTga(buf); } catch (e) { console.warn(`[cameo] ${file} illisible :`, e.message); return null; }
  })());
  return sheets.get(file);
}

// Data URL (PNG) de l'image `name`, ou null si elle est introuvable (texture absente, nom inconnu).
export function cameoUrl(name) {
  if (!name) return Promise.resolve(null);
  if (!urls.has(name)) urls.set(name, (async () => {
    const i = await info(name);
    if (!i) return null;
    const img = await sheet(i.file);
    if (!img) return null;
    // Le rectangle est exprimé dans la texture déclarée (TextureWidth x TextureHeight) : on le ramène à la taille réelle du fichier.
    const sx = i.tw ? img.width / i.tw : 1, sy = i.th ? img.height / i.th : 1;
    const x = Math.round(i.l * sx), y = Math.round(i.t * sy), w = Math.max(1, Math.round((i.r - i.l) * sx)), h = Math.max(1, Math.round((i.b - i.t) * sy));
    const src = document.createElement('canvas'); src.width = img.width; src.height = img.height; src.getContext('2d').putImageData(img, 0, 0);
    const out = document.createElement('canvas'), rot = i.rot;
    out.width = rot ? h : w; out.height = rot ? w : h;
    const cx = out.getContext('2d');
    if (rot) { cx.translate(0, w); cx.rotate(-Math.PI / 2); } // ROTATED_90_CLOCKWISE : l'image est couchée dans la texture, on la redresse
    cx.drawImage(src, x, y, w, h, 0, 0, w, h);
    return out.toDataURL('image/png');
  })().catch(e => { console.warn(`[cameo] ${name} :`, e.message); return null; }));
  return urls.get(name);
}

// Pose le cameo en fond de l'élément `el` (quand il est prêt). `cls` est ajouté à l'élément si l'image existe.
export function setCameo(el, name, cls = 'has-cameo') {
  if (!name) return;
  cameoUrl(name).then(u => {
    if (!u) { el.dataset.noCameo = name; return; } // image introuvable : le bouton garde son texte
    el.style.backgroundImage = `url(${u})`; el.classList.add(cls);
  });
}
