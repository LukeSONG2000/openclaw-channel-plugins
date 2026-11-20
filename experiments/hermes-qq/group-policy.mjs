const id = /^[a-z0-9_-]{1,256}$/iu;
const normalize = value => value.normalize('NFC').trim();

export function groupPolicy(config, pilotGroup) {
  const modes = new Map([[pilotGroup, 'free']]);
  if (config !== undefined) {
    const { namedModes, verifiedNames } = config ?? {};
    if (!namedModes || !verifiedNames || [namedModes, verifiedNames].some(x => typeof x !== 'object' || Array.isArray(x))) {
      throw new Error('invalid group policy');
    }
    const named = new Map();
    for (const [name, mode] of Object.entries(namedModes)) {
      if (!normalize(name) || !['free', 'default'].includes(mode) || named.has(normalize(name))) {
        throw new Error('invalid named mode');
      }
      named.set(normalize(name), mode);
    }
    const seen = new Set();
    for (const [group, name] of Object.entries(verifiedNames)) {
      if (!id.test(group) || typeof name !== 'string' || !normalize(name) || seen.has(normalize(name))) {
        throw new Error('invalid verified group name');
      }
      seen.add(normalize(name));
      modes.set(group, named.get(normalize(name)) ?? 'default');
    }
  }
  return group => modes.get(group) ?? 'default';
}
