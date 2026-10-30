// Charge le modèle 3D d'un Object (via le serveur) et le met en cache.
import * as THREE from 'three';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { parseW3D } from '/shared/w3d.js';
import { buildModel } from '/w3d-three.js';

export const vfsUrl = p => `/api/vfs/${p.split('/').map(encodeURIComponent).join('/')}`;

const w3dCache = new Map();
function fetchW3D(name) {
  const key = name.toLowerCase();
  if (!w3dCache.has(key)) w3dCache.set(key, (async () => {
    const r = await fetch(vfsUrl(`art/w3d/${key}.w3d`));
    if (!r.ok) throw new Error(`W3D introuvable : ${name}`);
    return parseW3D(await r.arrayBuffer());
  })());
  return w3dCache.get(key).catch(e => { w3dCache.delete(key); throw e; });
}

// Animations d'une référence { file, alt, name } : le moteur charge "<nom>.w3d" (partie après le point) ;
// on essaie aussi la partie avant le point. Les animations embarquées dans le fichier du modèle sont
// ajoutées plus loin (buildModel), donc un fichier absent n'est pas une erreur si le modèle les contient.
async function loadAnimations(ref, model) {
  for (const f of new Set([ref.file, ref.alt])) {
    if (!f || f.toLowerCase() === model.toLowerCase()) continue; // le fichier du modèle est déjà lu
    try {
      const anims = (await fetchW3D(f)).animations;
      if (anims.length) return anims;
    } catch { /* fichier absent : on essaie le suivant */ }
  }
  return [];
}

const tga = new TGALoader();
const dds = new DDSLoader();
const texCache = new Map();
const texStatus = new Map(); // nom -> 'dds ok' | 'tga ok' | 'introuvable' | 'échec : ...' (diagnostic)
export const textureStatus = name => texStatus.get(name.replace(/\.[^.]+$/, '').toLowerCase()) ?? 'en attente';

// Textures : DDS puis TGA. L'orientation (V) et le bouclage sont réglés par le constructeur de modèle.
async function loadTexture(name) {
  const cleanName = name.replace(/\.[^.]+$/, '').toLowerCase();
  if (!texCache.has(cleanName)) {
    texCache.set(cleanName, (async () => {
      for (const [ext, loader] of [['dds', dds], ['tga', tga]]) {
        const url = vfsUrl(`art/textures/${cleanName}.${ext}`);
        try {
          const response = await fetch(url, { method: 'HEAD' });
          if (!response.ok) continue;
          const texture = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
          if (!texture) continue;
          texture.needsUpdate = true;
          texStatus.set(cleanName, `${ext} ok`);
          return texture;
        } catch (error) {
          texStatus.set(cleanName, `échec ${ext} : ${error?.message ?? error}`);
          console.warn(`[W3D] Impossible de charger ${url}`, error);
        }
      }
      if (!texStatus.has(cleanName)) texStatus.set(cleanName, 'introuvable');
      console.warn(`[W3D] Texture introuvable : ${cleanName}`);
      return null;
    })());
  }
  return texCache.get(cleanName);
}

const cache = new Map();

// Modèle W3D brut (sans Object INI) : ponts, par exemple. Rend un Group Y-haut, à cloner par instance (.clone(true)).
const rawCache = new Map();
export function loadRawModel(name) {
  const key = name.replace(/\.w3d$/i, '').toLowerCase();
  if (!rawCache.has(key)) rawCache.set(key, (async () => {
    const parsed = await fetchW3D(key);
    const hlod = parsed.hlods[0];
    let hier = parsed.hierarchies[0];
    if (hlod?.hierarchyName) {
      const want = hlod.hierarchyName.toLowerCase();
      hier = parsed.hierarchies.find(h => h.name.toLowerCase() === want) ?? (await fetchW3D(hlod.hierarchyName)).hierarchies[0];
    }
    const { group } = buildModel(parsed, hier, loadTexture, { prefix: 'raw_' });
    group.rotation.x = -Math.PI / 2; // W3D est Z-haut
    const root = new THREE.Group(); root.add(group);
    return root;
  })());
  return rawCache.get(key).catch(e => { rawCache.delete(key); throw e; });
}

// Charge UN module Draw : modèle W3D + squelette + animations par état. `k` = numéro du module (préfixe des os).
async function loadModule(mod, k) {
  const parsed = await fetchW3D(mod.model);
  const hlod = parsed.hlods[0];
  let hier = parsed.hierarchies[0];
  if (hlod?.hierarchyName) {
    const want = hlod.hierarchyName.toLowerCase();
    hier = parsed.hierarchies.find(h => h.name.toLowerCase() === want);
    if (!hier) hier = (await fetchW3D(hlod.hierarchyName)).hierarchies[0];
  }
  // Animations par état (repos, marche, tir, portes) : dans le fichier du modèle ou dans des fichiers à part.
  const refs = mod.anims ?? (mod.anim ? { idle: mod.anim } : {});
  const stateAnims = {};
  let hideDoor = null; // plans de bataille : le module disparaît quand sa porte est en phase "attente" (Model = NONE)
  for (const [key, ref] of Object.entries(refs)) {
    if (ref.hide) { hideDoor = ref.door; continue; }
    stateAnims[key] = { animations: await loadAnimations(ref, mod.model), name: ref.name, mode: ref.mode, speed: ref.speed, door: ref.door };
  }
  const { group, info } = buildModel(parsed, hier, loadTexture, {
    hide: mod.hide, show: mod.show, muzzle: mod.muzzle, auto: mod.auto, stateAnims, prefix: `m${k}_`,
  });
  group.rotation.x = -Math.PI / 2; // W3D est Z-up, Three est Y-up
  group.name = `part${k}`;
  return { group, info, hier, model: mod.model, hideDoor, doorSub: mod.doorSub ?? [], onlyDoor: mod.onlyDoor ?? null, bones: { turret: mod.turretBone, pitch: mod.pitchBone, launch: mod.launchBone, recoil: mod.recoilBone } };
}

// Rend { template, size, info, object, model, models, skeleton, clips, parts } — utiliser cloneModel(m) pour chaque instance.
// Un Object peut avoir plusieurs modules Draw (bâtiment + porte + radar...) : un sous-groupe `part<k>` chacun,
// avec ses propres os (préfixe m<k>_) pour que les animations ne se mélangent pas.
export function loadObjectModel(objectName, conds = []) { // conds : conditions de modèle de l'objet (améliorations : POWER_PLANT_UPGRADED...)
  const key = objectName.toLowerCase() + '|' + conds.join(',');
  if (!cache.has(key)) cache.set(key, (async () => {
    const r = await fetch(`/api/object/${encodeURIComponent(objectName)}${conds.length ? '?c=' + encodeURIComponent(conds.join(',')) : ''}`);
    if (!r.ok) throw new Error(`Object inconnu : ${objectName}`);
    const o = await r.json();
    const mods = o.modules?.length ? o.modules : (o.model ? [o] : []);
    if (!mods.length) throw new Error(`${objectName} : aucun Model dans son Draw`);

    const loaded = [];
    for (let k = 0; k < mods.length; k++) {
      try { loaded.push({ ...(await loadModule(mods[k], k)), k, mod: mods[k] }); }
      catch (e) { if (k === 0) throw e; console.warn(`[W3D] module ${mods[k].tag || k} (${mods[k].model}) ignoré : ${e.message}`); }
    }
    const template = new THREE.Group();
    for (const p of loaded) template.add(p.group);
    const size = new THREE.Box3().setFromObject(template).getSize(new THREE.Vector3());

    // Rapport fusionné de tous les modules (visionneuse, diagnostic)
    const info = { placed: [], missing: [], hidden: [], textures: new Set(), meshes: [], bones: 0, clip: null, clips: {}, animNote: '', rotors: [] };
    const notes = [];
    for (const p of loaded) {
      const i = p.info, tag = loaded.length > 1 ? `[${p.mod.tag || p.k}:${p.model}] ` : '';
      info.placed.push(...i.placed); info.missing.push(...i.missing); info.hidden.push(...i.hidden.map(h => tag + h));
      i.textures.forEach(t => info.textures.add(t)); info.meshes.push(...i.meshes); info.bones += i.bones; info.rotors.push(...i.rotors);
      if (i.animNote) notes.push(tag + i.animNote);
    }
    info.animNote = notes.join(' || ');
    info.clips = loaded[0].info.clips; info.clip = loaded[0].info.clip;
    return {
      template, size, info, object: o, clip: info.clip, clips: info.clips, model: loaded[0].model, models: o.models,
      parts: loaded.map(p => ({ k: p.k, tag: p.mod.tag, model: p.model, clips: p.info.clips, hideDoor: p.hideDoor, doorSub: p.doorSub, onlyDoor: p.onlyDoor, bones: p.bones, note: p.info.animNote, hidden: p.info.hidden })),
      skeleton: loaded.map(p => (p.hier ? `${p.hier.name} (${p.hier.pivots.length} os)` : 'aucun')).join(' + '),
    };
  })());
  return cache.get(key);
}

// Porte de bâtiment : fermée au repos (image 0 de l'animation d'ouverture), puis ouverture -> attente -> fermeture.
function makeDoor(actions, n, group, hides) {
  const act = actions.door_open;
  if (!act) return null;
  const dur = act.getClip().duration;
  let phase = 'closed', ct = 0, dir = 0, rate = Math.abs(act.timeScale) || 1; // rate : secondes d'animation par seconde réelle
  act.paused = true;
  act.time = 0;
  const apply = function() { act.time = ct; };
  apply();
  const d = { n };
  Object.defineProperty(d, 'phase', { get: function() { return phase; } });
  d.setPhase = function(ph, dseconds){
    phase = ph;
    if (group && hides) group.visible = ph !== 'wait';
    // Le moteur cale l'animation sur DoorOpeningTime / DoorCloseTime : sans ça la porte finissait trop tôt (ou sautait à la fin).
    // On ne compte que la part d'animation qu'il reste à jouer.
    if (ph === 'opening') { dir = 1; if (dseconds > 0) rate = dur / dseconds; }
    else if (ph === 'closing') { dir = -1; if (dseconds > 0) rate = dur / dseconds; }
    else if (ph === 'wait') { dir = 0; ct = dur; apply(); return; }
    else { dir = 0; ct = 0; apply(); return; }
    apply();
  };
  d.update = function(dt){
    if (dir === 0) return;
    ct += dir * dt * rate;
    if (ct >= dur) { ct = dur; dir = 0; }
    if (ct <= 0) { ct = 0; dir = 0; }
    act.time = ct;
  };
  return d;
}

// Applique le mode d'animation de l'INI à une action three.js
function setupAction(act, mode, speed, start) {
  const dur = act.getClip().duration, sp = Math.abs(speed) || 1;
  const last = start === 'last';
  act.paused = false;
  if (mode === 'MANUAL') {
    act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.timeScale = 1;
    act.play(); act.paused = true; act.time = last ? dur : 0;
  } else if (mode === 'ONCE_BACKWARDS') {
    act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.timeScale = -sp;
    act.play(); act.paused = false;
    act.time = last ? dur : 0;
  } else if (mode === 'ONCE') {
    act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.timeScale = sp;
    act.play(); act.paused = false;
    act.time = last ? dur : 0;
  } else {
    act.setLoop(mode === 'PING_PONG' ? THREE.LoopPingPong : THREE.LoopRepeat, Infinity);
    act.clampWhenFinished = false; act.timeScale = sp;
    act.play(); act.paused = false;
    act.time = last ? dur : 0;
  }
  return act;
}

// Instance indépendante (os et squelettes clonés : sans ça, deux unités partageraient la même animation).
// `actions`/`state` = ceux du 1er module (repos / marche / tir des unités) ; les autres modules jouent leur animation
// de repos tout seuls (radar qui tourne...) ; les portes de tous les modules sont pilotées ensemble par `door`.
export function cloneModel(m) {
  const inst = skeletonClone(m.template);
  let mixer = null;
  const actions = {}, doors = [];
  let state = null;
  let upAnim = null; // { action, dur } pour animation pilotée par progression (centrale électrique)
  const subs = []; // sous-objets montrés / cachés selon la phase d'une porte (plan de bataille en service)
  for (const part of m.parts) {
    const grp = inst.getObjectByName(`part${part.k}`);
    // ÉCART ASSUMÉ avec l'INI : un module sans animation qui ne change d'aspect qu'à DOOR_n_WAITING_TO_CLOSE (canon déployé A8) n'est dessiné que
    // pendant cette phase. L'INI le dessinerait aussi au repos ; ses pièces sont à l'intérieur du bâtiment (z 1..18 sous un toit à 42), que le
    // moteur d'origine cache sans doute par la structure. À retirer le jour où le rendu du corps du bâtiment est fidèle.
    const statique = !Object.keys(part.clips ?? {}).length;
    for (const s of part.doorSub ?? []) { subs.push({ ...s, group: grp, whole: statique }); if (statique && grp) grp.visible = false; }
    // Module déployé (paraboles ouvertes...) : n'existe visuellement que quand la porte `onlyDoor` attend, à la place du module animé qui disparaît
    if (part.onlyDoor != null && grp) { subs.push({ door: part.onlyDoor, show: [], hide: [], group: grp, whole: true }); grp.visible = false; }
  }
  for (const part of m.parts) {
    const keys = Object.keys(part.clips ?? {});
    if (!keys.length) continue;
    mixer ??= new THREE.AnimationMixer(inst);
    const acts = {};
    for (const k of keys) {
      const { clip, mode, speed, start } = part.clips[k];
      acts[k] = setupAction(mixer.clipAction(clip), mode, speed, start);
    }
    const body = keys.filter(k => !k.startsWith('door_') && k !== 'upgrading'); // repos / marche / tir (exclusifs entre eux)
    const start = acts.idle ?? acts[body[0]];
    // Animation d'amélioration "à la main" (ex. PowerPlant : tiges montent sur toute la durée de l'upgrade)
    if (acts.upgrading) {
      const a = acts.upgrading;
      a.paused = true; a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.timeScale = 0;
      a.time = 0;
      upAnim ??= { action: a, dur: a.getClip().duration };
    }
    // Une animation de repos qui touche les MÊMES os qu'une porte ou qu'une animation d'amélioration s'additionne à elle
    // (three.js moyenne les actions actives d'une même piste) : porte à moitié ouverte, tiges qui redescendent... Le moteur
    // ne joue qu'UNE animation par module : on neutralise le repos pour les os pilotés par la porte / l'amélioration.
    const trackNames = k => new Set((part.clips[k]?.clip?.tracks ?? []).map(t => t.name));
    const mute = (driver) => {
      const names = trackNames(driver);
      for (const k of body) { const a = acts[k]; if (a && part.clips[k].clip.tracks.some(t => names.has(t.name))) a.setEffectiveWeight(0); }
    };
    // Porte : seule door_open pilote la pose (fermée = image 0, ouverte = dernière image, fermeture = lecture à l'envers).
    // door_wait et door_close étaient lancées toutes seules avec le même poids : moyenne des trois = porte à moitié.
    if (acts.door_open) { for (const k of ['door_wait', 'door_close']) { const a = acts[k]; if (a) { a.stop(); a.enabled = false; } } mute('door_open'); }
    if (acts.upgrading) mute('upgrading');
    // Modules annexes du Strategy Center (canon, paraboles...) : au repos ils sont REPLIÉS = image 0 de leur animation
    // d'ouverture. Avant, stop() faisait retomber les os sur la pose de base du modèle (= déployée : canon et paraboles en l'air).
    // On garde donc l'action active mais figée à l'image 0 (la porte la pilote ensuite, voir makeDoor).
    const tag = (part.mod?.tag || '').toUpperCase();
    const model = (part.model || '').toUpperCase();
    if (/STRATEGY/.test(model) && tag !== 'MODULETAG_01' && tag !== 'MODULETAG_MAIN' && part.k !== 0) {
      for (const k of keys) {
        if (k === 'upgrading') continue;
        const a = acts[k];
        if (!a) continue;
        if (!k.startsWith('door_') && keys.some(x => x.startsWith('door_'))) { a.setEffectiveWeight(0); continue; } // la porte pilote seule la pose
        if (k === 'door_wait' || k === 'door_close') continue; // déjà neutralisées : seule door_open pilote (sinon moyenne = porte à moitié)
        a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.timeScale = 0;
        a.play(); a.paused = true; a.time = 0;
      }
    }
    const hasDoor = !!acts.door_open;
    // setupAction a déjà lancé (ou figé) chaque animation de repos ; on désynchronise seulement les boucles.
    if (start && !hasDoor && start.loop === THREE.LoopRepeat && !start.paused) mixer.update(Math.random() * start.getClip().duration);
      if (hasDoor) {
        const d = makeDoor(acts, part.clips.door_open.door ?? doors.length + 1, inst.getObjectByName(`part${part.k}`), part.hideDoor != null);
        if (d) doors.push(d);
      }
      if (part.k === 0) { Object.assign(actions, acts); state = acts.idle ? 'idle' : body[0] ?? null; }
  }
  mixer?.update(0);
  const applySubs = (n, ph) => {
    for (const s of subs) {
      if (s.door !== n) continue;
      const on = ph === 'wait'; // plan en service
      if (s.whole && s.group) s.group.visible = on;
      s.group?.traverse(o => {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        const short = (o.name ?? '').split('#')[0].split('.').pop().toUpperCase();
        const inShow = s.show.includes(short), inHide = s.hide.includes(short);
        if (!inShow && !inHide) return;
        o.userData.v0 ??= o.visible; // visibilité d'origine (état par défaut)
        o.visible = on ? inShow : o.userData.v0;
      });
    }
  };
  const door = doors.length || subs.length ? {
    get phase() { return doors[0]?.phase ?? 'closed'; },
    setPhase(ph, n = 1, dur = 0) {
      for (const d of doors.filter(d => d.n === n)) d.setPhase(ph, dur);
      if (!doors.some(d => d.n === n) && !subs.some(s => s.door === n) && doors.length) doors[0].setPhase(ph, dur);
      applySubs(n, ph);
    },
    setAll(ph) { doors.forEach(d => d.setPhase(ph)); },
    update(dt) { doors.forEach(d => d.update(dt)); },
  } : null;
  const rotors = [];
  inst.traverse(o => { if (o.isBone && m.info.rotors.includes(o.name)) rotors.push(o); });
  if (typeof window !== 'undefined' && window.ZHO_DEBUG !== false && m.parts.length > 1 && m.parts.some(p => /STRATEGY/i.test(p.model))) { // diagnostic Strategy Center
    const rep = m.parts.map(p => ({ k: p.k, tag: p.tag, model: p.model, onlyDoor: p.onlyDoor, note: p.note, hidden: p.hidden, doorSub: p.doorSub, clips: Object.entries(p.clips ?? {}).map(([k, c]) => `${k}:${c.clip.duration.toFixed(2)}s/${c.clip.tracks.length}pistes/${c.mode}/${c.start ?? '-'}`) }));
    console.log('[ZHO] ' + m.object?.name, JSON.stringify(rep));
  }
  return { inst, mixer, rotors, actions, door, state, upAnim };
}

// Cases à cocher de diagnostic pour l'orientation des textures (rechargent la page quand on les change).
export function bindTexToggles(vBox, uBox) {
  const get = k => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
  vBox.checked = get('texInvertV'); uBox.checked = get('texMirrorU');
  const set = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* stockage indisponible */ } location.reload(); };
  vBox.onchange = () => set('texInvertV', vBox.checked);
  uBox.onchange = () => set('texMirrorU', uBox.checked);
}
