// Catalogue des cartes : lit les .map montés dans le VFS (MapsZH.big, Maps.big, dossiers loose...) et en extrait nom,
// taille et points de départ. L'analyse tourne en arrière-plan au démarrage ; `ready` se résout quand elle est finie.
import { parseMap } from '../shared/map.js';

const title = s => s.replace(/[_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export function createMapCatalog(vfs) {
  const maps = new Map(); // id (dossier, minuscules) -> { id, name, players, w, h, starts, preview }
  const failed = [];
  const files = vfs.list('maps/', '.map').map(k => k.split('/')).filter(p => p.length === 3 && p[2] === p[1] + '.map').map(p => p[1]);

  async function scan() {
    for (const id of files) {
      try {
        const info = parseMap(await vfs.readBytes(`maps/${id}/${id}.map`));
        if (!info.ok) { failed.push({ id, errors: info.errors }); continue; }
        if (info.starts.length < 2) continue; // pas une carte multijoueur / escarmouche
        maps.set(id, { id, name: title(id), players: info.starts.length, w: info.w, h: info.h, starts: info.starts, preview: vfs.has(`maps/${id}/${id}.tga`) ? `/api/vfs/maps/${encodeURIComponent(id)}/${encodeURIComponent(id)}.tga` : null });
      } catch (e) { failed.push({ id, errors: [e.message] }); }
    }
    console.log(`Cartes : ${maps.size} jouable(s) sur ${files.length} .map${failed.length ? `, ${failed.length} illisible(s) (voir /api/maps)` : ''}`);
  }
  const objCache = new Map(); // id -> résultat complet du parse (objets, routes, ponts, waypoints) ; 3 cartes en mémoire au plus
  const state = { done: false };
  const ready = scan().finally(() => { state.done = true; });
  const list = () => [...maps.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ starts, ...m }) => m);
  async function parsed(id) {
    const k = String(id ?? '').toLowerCase();
    if (objCache.has(k)) return objCache.get(k);
    if (!vfs.has(`maps/${k}/${k}.map`)) return null;
    const res = parseMap(await vfs.readBytes(`maps/${k}/${k}.map`), { objects: true });
    objCache.set(k, res); if (objCache.size > 3) objCache.delete(objCache.keys().next().value);
    return res;
  }
  return { ready, get done() { return state.done; }, list, get: id => maps.get(String(id ?? '').toLowerCase()) ?? null, failed, total: files.length,
           async loadObjects(id) { return (await parsed(id))?.objects ?? []; }, // objets posés sur la carte (arbres, bâtiments civils...) : { name, x, y, z, angle, flags }
           objectsOf: id => objCache.get(String(id ?? '').toLowerCase())?.objects ?? null,
           // routes / ponts / waypoints de la carte (coordonnées brutes, origine au coin jouable) ; les routes et ponts sont des paires de points
           async features(id) { const r = await parsed(id); return r ? { roads: r.roads, bridges: r.bridges, waypoints: r.waypointList, links: r.waypointLinks, objects: r.objects } : null; },
           async terrain(id) { // grille de hauteurs d'une carte (1 octet par case), pour dessiner le relief côté client
             const k = String(id).toLowerCase(); if (!vfs.has(`maps/${k}/${k}.map`)) return null;
             const m = parseMap(await vfs.readBytes(`maps/${k}/${k}.map`), { heights: true });
             const need = m.width * m.height;
             if (!m.heights) return { error: 'HeightMapData illisible', errors: m.errors, chunks: m.chunks };
             if (m.heights.length < need) return { error: `hauteurs incomplètes : ${m.heights.length} octets pour ${m.width}×${m.height} = ${need}`, heightMap: m.heightMap, errors: m.errors, chunks: m.chunks };
             return { width: m.width, height: m.height, border: m.border, heights: m.heights.subarray(0, need) };
           },
           async tiles(id) { // tuiles de texture de la carte (BlendTileData) : { width, height, border, classes, shift, tiles: Int16Array } ou { error }
             const k = String(id).toLowerCase(); if (!vfs.has(`maps/${k}/${k}.map`)) return null;
             const m = parseMap(await vfs.readBytes(`maps/${k}/${k}.map`), { tiles: true });
             if (!m.blend || m.blend.error) return { ...(m.blend ?? {}), error: m.blend?.error ?? 'pas de BlendTileData', chunks: m.chunks };
             return { width: m.width, height: m.height, border: m.border, classes: m.blend.classes, shift: m.blend.shift, tiles: m.blend.tiles };
           },
           async inspect(id) { const k = String(id).toLowerCase(); if (!vfs.has(`maps/${k}/${k}.map`)) return null; const { heights, ...info } = parseMap(await vfs.readBytes(`maps/${k}/${k}.map`)); return info; } };
}
