import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadObjectModel, cloneModel, bindTexToggles, textureStatus } from '/model-loader.js';
import { applyHouseColor, zhcMode, isHouseMesh } from '/w3d-three.js';

const $ = id => document.getElementById(id);
const info = t => { $('info').textContent = t; };
bindTexToggles($('texV'), $('texU'));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14181d);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 5000);
camera.position.set(30, 20, 30);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(40, 80, 30); scene.add(sun);
scene.add(new THREE.GridHelper(100, 20, 0x335, 0x223));
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
let mixer = null, rotors = [], door = null;
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (door) door.update(dt);
  if (mixer) mixer.update(dt);
  for (const r of rotors) r.rotation.z += dt * 28;
  controls.update(); renderer.render(scene, camera);
});

let current = null, currentReport = '', entries = [];
const hex = n => '0x' + (n >>> 0).toString(16).padStart(8, '0');
const meshOf = label => { let found = null; current?.traverse(o => { if (o.isMesh && o.name === label) found = o; }); return found; };

function showMeshList(m) {
  const box = $('meshes');
  box.innerHTML = '';
  entries = m.info.meshes.map(r => {
    const mesh = meshOf(r.label);
    const lab = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = mesh ? mesh.visible : false;
    cb.onchange = () => { if (mesh) mesh.visible = cb.checked; lab.classList.toggle('off', !cb.checked); };
    lab.classList.toggle('off', !cb.checked);
    lab.append(cb, ` ${r.label.split('.').pop()} — ${hex(r.attributes)} — ${r.blend}${r.reason ? ` — masqué : ${r.reason}` : ''}`);
    lab.title = `${r.label}\ntextures : ${r.textures.join(', ') || 'aucune'}\n${r.verts} sommets, ${r.tris} triangles`;
    box.appendChild(lab);
    return { label: r.label, lab, cb, mesh };
  });
}

// Rapport texte à coller dans la conversation pour diagnostiquer un modèle.
function makeReport(name, m) {
  const o = m.object, L = [];
  L.push(`Object : ${name} — modèle ${m.model} — squelette ${m.skeleton}`);
  L.push(`modules Draw (${(o.modules ?? []).length}) : ${(o.modules ?? []).map(x => `${x.tag}=${x.model}${x.activeState ? `[${x.activeState}]` : ''}`).join(' ; ') || 'aucun'}`);
  L.push(`état actif : ${o.activeState ?? 'par défaut'}`);
  L.push(`INI hide=[${o.hide.join(' ')}] show=[${o.show.join(' ')}] muzzle=[${o.muzzle.join(' ')}] auto=[${o.auto.join(' ')}]`);
  L.push(`animation INI : ${o.anim ? `${o.anim.file}.${o.anim.name} (${o.anim.mode})` : 'aucune'} -> ${m.info.animNote || 'non jouée'} | rotors : ${m.info.rotors.length}`);
  L.push(`porte : ${door ? 'oui (image 0 de DOOR_1_OPENING = fermée)' : 'pas d\'animation de porte dans l\'INI'} | animations : ${Object.keys(m.clips ?? {}).join(', ') || 'aucune'}`);
  for (const e of entries) {
    const r = m.info.meshes.find(x => x.label === e.label);
    const tx = r.textures.map(t => { const n = t.split(' (')[0]; const z = zhcMode(n); return `${t} = ${textureStatus(n)}${z ? ` [couleur d'équipe ZHC${z}]` : ''}`; });
    L.push(`${e.cb.checked ? 'visible' : 'masqué '} | ${r.label} | attr ${hex(r.attributes)} | ${r.verts}v ${r.tris}t | ${r.blend}${isHouseMesh(r.label) ? ' | HOUSECOLOR' : ''} | tex [${tx.join(', ')}]${r.reason ? ` | ${r.reason}` : ''}`);
  }
  L.push('--- états de l\'INI (conditions | modèle | show | hide | animation) ---');
  for (const st of o.states ?? []) L.push(`${st.conds.join('+') || '?'} | ${st.model ?? '-'} | show[${st.show.join(' ')}] | hide[${st.hide.join(' ')}] | ${st.anim ?? '-'}`);
  return L.join('\n');
}

async function loadObject(name) {
  info(`Recherche de ${name}…`);
  try {
    const m = await loadObjectModel(name);
    if (current) scene.remove(current);
    const inst = cloneModel(m);
    applyHouseColor(inst.inst, 0x4aa3ff); // couleur d'équipe de test (bleu)
    current = inst.inst; mixer = inst.mixer; rotors = inst.rotors; door = inst.door;
    scene.add(current);

    const box = new THREE.Box3().setFromObject(current);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const d = Math.max(size.x, size.y, size.z, 1) * 1.8;
    controls.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(d, d * 0.6, d)); controls.update();

    const bi = m.info;
    showMeshList(m);
    currentReport = makeReport(name, m);
    info([`${name} → ${m.model}.w3d`,
      `squelette : ${m.skeleton}`,
      `meshes : ${bi.placed.length}${bi.missing.length ? ` — introuvables : ${bi.missing.join(', ')}` : ''}`,
      `masqués : ${bi.hidden.join(', ') || 'aucun'}`,
      `textures : ${[...bi.textures].join(', ') || 'aucune'}`,
      `animation : ${m.object.anim ? `${m.object.anim.file}.${m.object.anim.name}` : 'aucune dans l\'INI'}${bi.animNote ? ` — ${bi.animNote}` : ''}`,
      'Clique sur une pièce du modèle pour la repérer dans la liste ; décoche pour masquer.'].join('\n'));
    window.__lastModel = m;
  } catch (e) { info(`Erreur : ${e.message}`); console.error(e); }
}

// Clic sur le modèle : repère la pièce dans la liste (sans confondre avec une rotation de caméra).
let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || !current) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
  const meshes = []; current.traverse(o => { if (o.isMesh && o.visible) meshes.push(o); });
  const hit = ray.intersectObjects(meshes, false)[0];
  for (const en of entries) en.lab.classList.remove('sel');
  if (!hit) return;
  const en = entries.find(x => x.label === hit.object.name);
  if (en) { en.lab.classList.add('sel'); en.lab.scrollIntoView({ block: 'nearest' }); }
});

$('copy').onclick = async () => {
  if (!currentReport) return;
  currentReport = makeReport($('obj').value.trim(), window.__lastModel);
  try { await navigator.clipboard.writeText(currentReport); info('Rapport copié : colle-le dans la conversation.'); }
  catch { info(currentReport); }
};
$('door').onclick = () => { if (door) { door.setAll('opening'); setTimeout(() => door.setAll('wait'), 1500); setTimeout(() => door.setAll('closing'), 3500); setTimeout(() => door.setAll('closed'), 6000); } else info('Cet Object n\'a pas d\'animation de porte (DOOR_1_OPENING) dans son INI.'); };
$('go').onclick = () => loadObject($('obj').value.trim());
$('obj').addEventListener('keydown', e => { if (e.key === 'Enter') $('go').click(); });

const list = await (await fetch('/api/objects')).json();
$('objs').innerHTML = list.map(n => `<option value="${n}">`).join('');
info(`${list.length} Objects avec un modèle. Tape un nom puis Entrée.`);
