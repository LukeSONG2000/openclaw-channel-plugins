const id = /^[a-z0-9_-]{1,256}$/iu;
const normalize = value => value.normalize('NFC').trim();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const switches = new Set(['freeReply', 'imageGeneration', 'memory']);

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

// Only trusted platform addresses belong here, never a display name or chat command.
export function conversationPolicy(config, { pilotGroup, groupMemory = () => false } = {}) {
  if (config !== undefined && !record(config)) throw new Error('invalid conversation policy');
  const haveNames = config && (Object.hasOwn(config, 'verifiedNames') || Object.hasOwn(config, 'namedModes'));
  const mode = groupPolicy(haveNames ? config : undefined, pilotGroup);
  const overrides = new Map();
  const configured = config?.conversations;
  if (configured !== undefined) {
    if (!record(configured)) throw new Error('invalid conversation policy');
    for (const [address, values] of Object.entries(configured)) {
      const [scope, peer, extra] = address.split(':');
      if (!['group', 'direct'].includes(scope) || !peer || !id.test(peer) || extra !== undefined ||
          !record(values) || Object.entries(values).some(([key, value]) =>
            !switches.has(key) || typeof value !== 'boolean' || (scope === 'direct' && key === 'freeReply'))) {
        throw new Error('invalid conversation switches');
      }
      overrides.set(address, Object.freeze({ ...values }));
    }
  }
  return Object.freeze({
    groupIds: Object.freeze([...new Set([...Object.keys(config?.verifiedNames ?? {}),
      ...[...overrides.keys()].filter(key => key.startsWith('group:')).map(key => key.slice(6))])]),
    forGroup(peer) {
      return { freeReply: mode(peer) === 'free', memory: groupMemory(peer), imageGeneration: false,
        ...overrides.get('group:' + peer) };
    },
    forDirect(peer) {
      return { memory: true, imageGeneration: false, ...overrides.get('direct:' + peer) };
    },
  });
}
