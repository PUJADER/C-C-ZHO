export function resolveObject(registry, objectId, side = null) {
  const entry = registry?.objects?.[objectId];
  if (!entry) return null;

  const base = entry.base ?? {};
  const sideData = side ? (entry.factions?.[side] ?? {}) : {};

  const { factions: _factions, ...baseData } = base;

  return {
    id: entry.id,
    type: entry.type,
    name: baseData.name ?? entry.id,
    ...baseData,
    ...sideData,
    side: side ?? null,
    refs: entry.refs ?? {},
  };
}

export function listObjects(registry, side = null) {
  const objects = registry?.objects ?? {};
  return Object.keys(objects).map((id) => resolveObject(registry, id, side));
}
