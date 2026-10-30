import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const outputFile = path.join(projectRoot, 'server', 'data', 'registry.json');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanValue(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str === '' ? '' : str;
}

function parseIniBlock(block) {
  const out = {};
  for (const item of block.items ?? []) {
    if (item.kind === 'field') {
      out[item.key] = cleanValue(item.value);
    } else if (item.kind === 'block') {
      out[item.type] = parseIniBlock(item);
    }
  }
  return out;
}

function guessFactionFromName(name = '', parent = '') {
  const haystack = `${name} ${parent}`.toUpperCase();
  if (haystack.includes('AMERICA')) return 'USA';
  if (haystack.includes('CHINA')) return 'CHINA';
  if (haystack.includes('GLA')) return 'GLA';
  return 'NEUTRAL';
}

function buildRegistryFromDb(db) {
  const entries = new Map();

  const objectBlocks = typeof db?.all === 'function' ? db.all('Object') : [];
  for (const block of objectBlocks) {
    const name = block.args?.[0];
    if (!name) continue;

    const raw = parseIniBlock(block);

    entries.set(name, {
      id: name,
      type: 'unit',
      base: {
        name,
        ...raw,
      },
      factions: {},
      refs: {
        effects: [],
        sounds: [],
        weapons: [],
      },
    });
  }

  const reskinBlocks = typeof db?.all === 'function' ? db.all('ObjectReskin') : [];
  for (const block of reskinBlocks) {
    const name = block.args?.[0];
    if (!name) continue;

    const parent = block.args?.[1] ?? '';
    const side = guessFactionFromName(name, parent);
    const raw = parseIniBlock(block);

    const existing = entries.get(name) ?? {
      id: name,
      type: 'unit',
      base: { name },
      factions: {},
      refs: { effects: [], sounds: [], weapons: [] },
    };

    existing.factions[side] = {
      ...raw,
      model: raw.Model ?? name,
      soundMove: raw.SoundMoveStart ?? raw.SoundMove ?? name,
    };

    entries.set(name, existing);
  }

  const objects = Object.fromEntries([...entries.values()].map((entry) => [entry.id, entry]));
  return {
    generatedAt: new Date().toISOString(),
    factions: ['USA', 'CHINA', 'GLA', 'NEUTRAL'],
    objects,
  };
}

export async function buildRegistry(db = { all: () => [] }) {
  const registry = buildRegistryFromDb(db);
  ensureDir(path.dirname(outputFile));
  fs.writeFileSync(outputFile, JSON.stringify(registry, null, 2));
  return registry;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildRegistry().then((registry) => {
    console.log(`Registry generated: ${Object.keys(registry.objects).length} objects`);
  }).catch((error) => {
    console.error('Failed to build registry:', error);
    process.exitCode = 1;
  });
}
