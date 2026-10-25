// Exécuteur des états de dessin (W3DModelDraw) : pour un module Draw et un ensemble de drapeaux de condition (DOOR_1_OPENING, DAMAGED,
// ACTIVELY_BEING_CONSTRUCTED...), dit QUEL état s'applique et donc quel modèle, quelle animation, quels sous-objets, quels os.
// Algorithme du moteur : SparseMatchFinder::findBestInfoSlow (GameEngine/Include/Common/SparseMatchFinder.h). Aucune règle par bâtiment :
// la porte, les dégâts, la construction, les plans de bataille... sortent tous des mêmes drapeaux posés par la logique de jeu.
import { classTable, parseFields } from './ini-bridge.js';

const upper = s => String(s ?? '').toUpperCase();
const flagsOf = it => new Set([...(it.args ?? []), it.value].flatMap(x => String(x ?? '').split(/[\s=,]+/)).map(upper).filter(f => f && f !== 'NONE'));
const NO_STATE_WORDS = /^(CONDITIONSTATE|DEFAULTCONDITIONSTATE|ALIASCONDITIONSTATE|TRANSITIONSTATE)$/;

// Lit les états d'un bloc Draw = W3DModelDraw : { states: [{ yes: [Set...], block, isDefault }], transitions: [{ from, to, block }] }
export function drawStates(draw) {
  const states = [], transitions = [];
  for (const it of draw.items ?? []) {
    if (it.kind !== 'block') continue;
    const t = it.type.toLowerCase();
    if (t === 'defaultconditionstate') states.push({ yes: [new Set()], block: it, isDefault: true });
    else if (t === 'conditionstate') states.push({ yes: [flagsOf(it)], block: it, isDefault: false });
    else if (t === 'aliasconditionstate' && states.length) states[states.length - 1].yes.push(flagsOf(it)); // même contenu, autre jeu de drapeaux
    else if (t === 'transitionstate') { const [from, to] = [...(it.args ?? []), ...String(it.value ?? '').split(/\s+/)].filter(Boolean); transitions.push({ from: upper(from), to: upper(to), block: it }); }
  }
  return { states, transitions };
}

// SparseMatchFinder::findBestInfoSlow : le plus de drapeaux "oui" en commun ; à égalité, le moins de drapeaux "oui" superflus ; à égalité encore, le premier.
export function findBest(states, bits) {
  let result = null, bestMatch = 0, bestExtra = 999;
  for (const st of states) {
    for (let i = st.yes.length - 1; i >= 0; i--) {
      const yes = st.yes[i];
      let match = 0; for (const f of yes) if (bits.has(f)) match++;
      const extra = yes.size - match;
      if (match > bestMatch || (match >= bestMatch && extra < bestExtra)) { result = st; bestMatch = match; bestExtra = extra; }
    }
  }
  return result;
}

const TABLE = () => classTable('W3DModelDrawModuleData.parseConditionState');
const words = v => String(v ?? '').trim().split(/\s+/).filter(Boolean);

// Contenu d'un état : champs typés par le schéma du moteur. Un état part d'une COPIE de l'état par défaut (moteur : parseConditionState),
// puis ses propres lignes remplacent celles du défaut.
export function resolveState(drawInfo, st) {
  const def = drawInfo.states.find(s => s.isDefault);
  const base = def && st !== def ? parseFields(TABLE(), def.block).data : {};
  const own = parseFields(TABLE(), st.block).data;
  const f = { ...base, ...own };
  const model = words(f.Model?.raw ?? f.Model ?? '')[0] ?? null;
  const anims = [].concat(f.Animation ?? []).map(a => words(a?.raw ?? a)[0]).filter(Boolean);
  return {
    model: !model || /^none$/i.test(model) ? null : model,   // Model = NONE : module invisible dans cet état
    animations: anims, mode: upper(f.AnimationMode ?? f.AnimationMode?.raw ?? ''),
    hide: words([].concat(f.HideSubObject ?? []).map(x => x?.raw ?? x).join(' ')).map(upper), show: words([].concat(f.ShowSubObject ?? []).map(x => x?.raw ?? x).join(' ')).map(upper),
    bones: { turret: f.Turret?.raw ?? f.Turret ?? null, pitch: f.TurretPitch?.raw ?? f.TurretPitch ?? null,
             launch: [].concat(f.WeaponLaunchBone ?? [])[0]?.raw ?? null, recoil: [].concat(f.WeaponRecoilBone ?? [])[0]?.raw ?? null, muzzleFlash: [].concat(f.WeaponMuzzleFlash ?? [])[0]?.raw ?? null },
    flags: [...st.yes[0]], isDefault: st.isDefault, data: f,
  };
}

// Raccourci : l'état d'un module Draw pour un ensemble de drapeaux.
export function stateFor(drawInfo, flags) {
  const bits = new Set([...flags].map(upper));
  const st = findBest(drawInfo.states, bits);
  return st ? resolveState(drawInfo, st) : null;
}
