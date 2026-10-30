import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listObjects, resolveObject } from './resolve-object.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const registryFile = path.join(projectRoot, 'server', 'data', 'registry.json');

async function ensureRegistry() {
  if (!fs.existsSync(registryFile)) {
    const { buildRegistry } = await import('../parser/build-registry.mjs');
    await buildRegistry();
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

async function loadRegistry() {
  await ensureRegistry();
  return JSON.parse(fs.readFileSync(registryFile, 'utf8'));
}

const server = async () => {
  const registry = await loadRegistry();

  const http = await import('node:http');
  const app = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, generatedAt: registry.generatedAt ?? null });
    }

    if (url.pathname === '/api/factions') {
      return sendJson(res, 200, registry.factions ?? []);
    }

    if (url.pathname === '/api/objects' || url.pathname === '/api/catalog') {
      const side = url.searchParams.get('side');
      return sendJson(res, 200, listObjects(registry, side));
    }

    if (url.pathname.startsWith('/api/object/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/object/', ''));
      const side = url.searchParams.get('side');
      const obj = resolveObject(registry, id, side);

      if (!obj) {
        return sendJson(res, 404, { error: 'object not found' });
      }

      return sendJson(res, 200, obj);
    }

    return sendJson(res, 404, { error: 'not found' });
  });

  app.listen(3001, '0.0.0.0', () => {
    console.log('Neutral object API running on http://localhost:3001');
  });
};

server().catch((error) => {
  console.error('Failed to start API server:', error);
  process.exitCode = 1;
});
