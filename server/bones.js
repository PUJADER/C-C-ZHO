// Lit côté serveur les os "logiques" des bâtiments (sorties de production EXITSTART/EXITEND, places et pistes de parking...)
// dans leurs modèles W3D. Le moteur de simulation n'a pas Three.js : on n'utilise que le parseur W3D pur et la composition des pivots.
import { parseW3D, pivotWorld } from '../shared/w3d.js';
import { drawModulesOf, parkingOf, productionExitOf } from '../shared/objects.js';

const ab = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

async function readW3D(vfs, name) {
  const p = `art/w3d/${name.toLowerCase()}.w3d`;
  return vfs.has(p) ? parseW3D(ab(await vfs.readBytes(p))) : null;
}

// Table { objet(min.) : { NOM_OS: { pos, yaw } } } pour tous les Objects qui ont une sortie de production ou un parking.
// Les os de TOUS les modules Draw sont réunis (celui du 1er module l'emporte en cas de doublon) : la position est dans le repère
// du bâtiment (+X avant, +Y gauche), le même que UnitCreatePoint / NaturalRallyPoint de l'INI.
export async function loadBuildingBones(db, vfs) {
  const out = new Map(), byModel = new Map();
  const tableOf = async model => {
    const key = model.toLowerCase();
    if (!byModel.has(key)) {
      let table = null;
      try {
        const parsed = await readW3D(vfs, model);
        if (parsed) {
          const want = parsed.hlods[0]?.hierarchyName?.toLowerCase();
          let h = parsed.hierarchies.find(x => !want || x.name.toLowerCase() === want) ?? parsed.hierarchies[0];
          if (!h && want) h = (await readW3D(vfs, want))?.hierarchies?.[0];
          if (h) table = pivotWorld(h);
        }
      } catch (e) { console.warn(`[os] ${model} : ${e.message}`); }
      byModel.set(key, table);
    }
    return byModel.get(key);
  };
  const names = [...db.all('Object'), ...db.all('ObjectReskin')].map(b => b.args[0]);
  for (const name of names) {
    if (!parkingOf(db, name) && !productionExitOf(db, name)) continue;
    let merged = null;
    for (const m of drawModulesOf(db, name) ?? []) {
      const t = m.model ? await tableOf(m.model) : null;
      if (t) merged = { ...t, ...(merged ?? {}) };
    }
    if (merged) out.set(name.toLowerCase(), merged);
  }
  return out;
}
export const loadParkingBones = loadBuildingBones; // ancien nom
