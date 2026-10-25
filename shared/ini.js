// Parser INI de Generals / Zero Hour — conserve toute la structure :
// ordre des lignes, clés répétées, blocs imbriqués, origine (fichier + ligne).
//
// Modèle :
//   IniBlock  { kind:'block', type, args[], items[], file, line, endLine }
//   IniField  { kind:'field', key, value, line }
//
// Règle d'ouverture de bloc (le "=" est OPTIONNEL dans les INI de Generals :
// le moteur le traite comme un simple séparateur, donc "Map Maps\X.map" et
// "Map = Maps\X.map" sont équivalents) :
//   - niveau racine : toute ligne sans "=" ouvre un bloc ("Object Foo", "Campaign USA")
//   - clé dans NESTED_KEYS (Behavior, Draw, Body...)            => bloc
//   - mot seul, sans valeur ("WeaponSet", "CreateObject")        => bloc
//     (sauf les mots de BARE_LEAFS, ex. "Blank")
//   - niveau racine, ligne "Clé = valeur" suivie plus loin d'un End orphelin :
//     l'en-tête du bloc était écrit avec "=" => bloc reconstruit après coup
//   - clé dans NESTED_ARGS sans "=" (ex. "Mission Mission01")    => bloc
//   - sinon                                                      => champ simple
// Un bloc se ferme avec "End". Un mot-clé inconnu casse l'équilibre des End :
// le validateur le signale (avec contexte) et on complète les listes ci-dessous.

export const NESTED_KEYS = new Set([
  'behavior', 'draw', 'body', 'clientupdate', 'clientbehavior',
  'conditionstate', 'defaultconditionstate', 'modelconditionstate',
  'transitionstate', 'idleanimationstate',
]);

export const NESTED_ARGS = new Set([
  'mission', 'replacemodule', 'structure', 'sideinfo', 'skirmishbuildlist',
]);

// Mots seuls qui sont des champs (pas des blocs) : ex. "Blank" dans credits.ini
export const BARE_LEAFS = new Set([
  'blank',
]);

export class IniDatabase {
  constructor() {
    this.blocks = [];            // blocs de premier niveau, dans l'ordre
    this.byType = new Map();     // type(min.) -> Map(nom(min.) -> bloc)
    this.defines = new Map();    // #define
    this.errors = [];            // { file, line, msg, ctx }
    this.warnings = [];          // blocs reconstruits / promus par indentation
    this.indentIssues = [];      // End dont l'indentation ≠ celle de l'en-tête du bloc fermé (aide au diagnostic)
    this.rootFields = [];        // lignes "Clé = valeur" isolées au niveau racine (ex. BenchProfile)
    this.files = [];             // fichiers chargés (include compris)
  }

  register(block) {
    this.blocks.push(block);
    const type = block.type.toLowerCase();
    const name = (block.args[0] ?? '').toLowerCase();
    if (!this.byType.has(type)) this.byType.set(type, new Map());
    this.byType.get(type).set(name, block); // dernier défini gagne (override de mod)
  }

  get(type, name) { return this.byType.get(type.toLowerCase())?.get(name.toLowerCase()); }
  all(type) { return [...(this.byType.get(type.toLowerCase())?.values() ?? [])]; }
}

// --- Helpers de lecture d'un bloc -------------------------------------------
export function fieldOf(block, key) {
  const k = key.toLowerCase();
  return block.items.find(i => i.kind === 'field' && i.key.toLowerCase() === k)?.value;
}
export function fieldsOf(block, key) {
  const k = key.toLowerCase();
  return block.items.filter(i => i.kind === 'field' && i.key.toLowerCase() === k).map(i => i.value);
}
export function subBlocks(block, type) {
  const t = type.toLowerCase();
  return block.items.filter(i => i.kind === 'block' && i.type.toLowerCase() === t);
}

// --- Chargement ---------------------------------------------------------------
function stripComment(s) {
  let cut = s.length;
  const a = s.indexOf(';'); if (a >= 0) cut = Math.min(cut, a);
  const b = s.indexOf('//'); if (b >= 0) cut = Math.min(cut, b);
  return s.slice(0, cut);
}

function dirOf(path) { const i = path.lastIndexOf('/'); return i >= 0 ? path.slice(0, i + 1) : ''; }

// Aplatit un fichier : gère #include (récursif) et #define.
async function expand(vfs, path, db, out, depth = 0) {
  if (depth > 16) { db.errors.push({ file: path, line: 0, msg: '#include trop profond' }); return; }
  const norm = path.replace(/\\/g, '/').toLowerCase();
  let text;
  try { text = await vfs.readText(norm); }
  catch { db.errors.push({ file: path, line: 0, msg: 'fichier introuvable' }); return; }
  db.files.push(norm);

  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    let raw = lines[n];
    const t = raw.trim();
    if (t.startsWith('#')) {
      const m = /^#\s*(include|define)\s+(.*)$/i.exec(t);
      if (!m) continue;
      if (m[1].toLowerCase() === 'include') {
        const inc = m[2].replace(/^["']|["']$/g, '').trim().replace(/\\/g, '/').toLowerCase();
        const rel = dirOf(norm) + inc;
        await expand(vfs, vfs.has(rel) ? rel : inc, db, out, depth + 1);
      } else {
        const [name, ...rest] = stripComment(m[2]).trim().split(/\s+/);
        db.defines.set(name, rest.join(' '));
      }
      continue;
    }
    if (db.defines.size) {
      raw = raw.replace(/[A-Za-z_][A-Za-z0-9_]*/g, w => (db.defines.has(w) ? db.defines.get(w) : w));
    }
    out.push({ text: raw, file: norm, line: n + 1 });
  }
}

function indentOf(t) {
  let n = 0;
  for (const c of t) { if (c === ' ') n++; else if (c === '\t') n += 4; else break; }
  return n;
}

// promote = true : un "champ" suivi de lignes plus indentées est promu en bloc
// (filet de sécurité pour les mots-clés de bloc qu'on ne connaît pas encore).
function parseLines(lines, sink, promote = false) {
  const L = [];
  for (const { text, file, line } of lines) {
    const s = stripComment(text).trim();
    if (s) L.push({ s, file, line, indent: indentOf(text) });
  }

  const root = { items: [] };
  const stack = [root];
  const recent = [];
  let pending = [];

  const err = (file, line, msg) =>
    sink.errors.push({ file, line, msg, ctx: recent.map(r => `${r.line}: ${r.text}`) });
  const flushPending = () => {
    for (const p of pending) sink.rootFields.push({ file: p.file, line: p.line, key: p.key, value: p.value });
    pending = [];
  };

  for (let i = 0; i < L.length; i++) {
    const { s, file, line, indent } = L[i];
    const nextIndent = i + 1 < L.length ? L[i + 1].indent : -1;
    recent.push({ line, text: s }); if (recent.length > 6) recent.shift();

    if (/^end$/i.test(s)) {
      if (stack.length === 1) {
        if (pending.length) { // En-tête écrit avec "=" : on reconstruit le bloc
          const h = pending[0];
          sink.register({
            kind: 'block', type: h.key, args: h.value ? h.value.split(/\s+/) : [],
            items: pending.slice(1).map(p => ({ kind: 'field', key: p.key, value: p.value, line: p.line, eq: true })),
            file: h.file, line: h.line, endLine: line, repaired: true,
          });
          sink.warnings.push({ file: h.file, line: h.line, msg: `bloc reconstruit (en-tête avec "=") : ${h.s}` });
          pending = [];
        } else err(file, line, 'End sans bloc ouvert');
        continue;
      }
      const b = stack.pop();
      b.endLine = line;
      if (b.indent !== indent) {
        sink.indentIssues.push({ file, line, msg: `End (ligne ${line}, indent ${indent}) ferme "${b.type} ${b.args.join(' ')}" (ligne ${b.line}, indent ${b.indent})` });
      }
      delete b.indent;
      if (stack.length === 1) sink.register(b);
      continue;
    }

    const m = /^([^\s=]+)\s*(=)?\s*(.*)$/.exec(s);
    if (!m) continue;
    const key = m[1], hasEq = !!m[2], value = m[3].trim(), lk = key.toLowerCase();
    const depth = stack.length - 1;

    let opens;
    if (depth === 0) {
      if (hasEq) { pending.push({ file, line, key, value, s }); continue; }
      flushPending();
      opens = true;
    }
    else if (NESTED_KEYS.has(lk)) opens = true;
    else if (!hasEq && value === '') opens = !BARE_LEAFS.has(lk);
    else if (!hasEq && NESTED_ARGS.has(lk)) opens = true;
    else opens = false;

    if (!opens && promote && depth > 0 && nextIndent > indent) {
      opens = true;
      sink.warnings.push({ file, line, msg: `promu en bloc (indentation) : ${s}` });
    }

    const parent = stack[depth];
    if (opens) {
      const block = { kind: 'block', type: key, args: value ? value.split(/\s+/) : [], items: [], file, line, endLine: null, indent };
      parent.items.push(block);
      stack.push(block);
    } else {
      parent.items.push({ kind: 'field', key, value, line, eq: hasEq });
    }
  }

  flushPending();
  for (let i = stack.length - 1; i >= 1; i--) {
    const b = stack[i];
    err(b.file, b.line, `bloc "${b.type} ${b.args.join(' ')}" jamais fermé`);
  }
}

export async function loadIni(vfs, path, db = new IniDatabase()) {
  const lines = [];
  await expand(vfs, path, db, lines);

  // Passe 1 : règles strictes. Si erreurs : passe 2 avec promotion par indentation,
  // gardée seulement si elle fait mieux.
  const p1 = new IniDatabase();
  parseLines(lines, p1, false);
  let best = p1;
  if (p1.errors.length) {
    const p2 = new IniDatabase();
    parseLines(lines, p2, true);
    if (p2.errors.length < p1.errors.length) best = p2;
  }
  for (const b of best.blocks) db.register(b);
  db.errors.push(...best.errors);
  db.warnings.push(...best.warnings);
  db.rootFields.push(...best.rootFields);
  db.indentIssues.push(...best.indentIssues);
  return db;
}
