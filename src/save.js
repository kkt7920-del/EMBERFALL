const SAVE_FORMAT = 'emberfall-save';
const SAVE_VERSION = 1;

export function createEmptyState() {
  return {
    classId: 'berserker',
    lv: 1,
    xp: 0,
    gold: 0,
    bagCapacity: 24,
    bag: [],
    stash: [],
    eq: {},
    ranks: [0, 0, 0, 0, 0],
    awake: [false, false, false, false, false],
    passives: { projectile: 0, bloodlust: 0 },
    stats: {
      damage: 0,
      armor: 0,
      agility: 0,
      critd: 0,
      crit: 0,
      spell: 0,
      casting: 0,
      speed: 0,
      move: 0,
      projectile: 0,
    },
    statVersion: 3,
    kills: 0,
    skillGrowthVersion: 2,
    traits: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
    rewards: [],
    knightVersion: 1,
    activeLoadout: 0,
    loadouts: [{}, {}],
    paragon: 0,
    paragonXP: 0,
    materials: { aether: 0 },
    cosmetic: null,
    awakenLook: -1,
    clears: [],
    collection: {},
  };
}

function fixedArray(value, length, fallback) {
  const source = Array.isArray(value) ? [...value] : [];
  while (source.length < length) source.push(typeof fallback === 'function' ? fallback() : fallback);
  return source.slice(0, length);
}

export function normalizeState(input = {}) {
  const defaults = createEmptyState();
  const state = { ...defaults, ...input };

  state.bag = Array.isArray(input.bag) ? input.bag : [];
  state.stash = Array.isArray(input.stash) ? input.stash : [];
  state.eq = input.eq && typeof input.eq === 'object' ? input.eq : {};
  state.ranks = fixedArray(input.ranks, 5, 0).map((v) => Number(v) || 0);
  state.awake = fixedArray(input.awake, 5, false).map(Boolean);
  state.traits = fixedArray(input.traits, 5, () => [0, 0]).map((row) => fixedArray(row, 2, 0).map((v) => Number(v) || 0));
  state.loadouts = fixedArray(input.loadouts, 2, () => ({}));
  state.rewards = Array.isArray(input.rewards) ? input.rewards : [];
  state.clears = Array.isArray(input.clears) ? input.clears : [];
  state.stats = { ...defaults.stats, ...(input.stats || {}) };
  state.passives = { ...defaults.passives, ...(input.passives || {}) };
  state.materials = { ...defaults.materials, ...(input.materials || {}) };
  state.collection = input.collection && typeof input.collection === 'object' ? input.collection : {};

  return state;
}

export function parseSave(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON 형식이 올바르지 않습니다.');
  }

  if (!data || typeof data !== 'object') throw new Error('세이브 데이터가 비어 있습니다.');
  if (data.format !== SAVE_FORMAT) throw new Error(`지원하지 않는 세이브 형식입니다: ${data.format ?? '없음'}`);
  if (!data.state || typeof data.state !== 'object') throw new Error('state 필드를 찾을 수 없습니다.');

  // 알 수 없는 최상위/상태 필드는 제거하지 않고 그대로 보존한다.
  return {
    ...data,
    format: SAVE_FORMAT,
    version: Number(data.version) || SAVE_VERSION,
    state: normalizeState(data.state),
  };
}

export function buildSave(state, sourceEnvelope = {}) {
  return {
    ...sourceEnvelope,
    format: SAVE_FORMAT,
    version: Number(sourceEnvelope.version) || SAVE_VERSION,
    savedAt: Date.now(),
    state: normalizeState(state),
  };
}

export function downloadSave(state, sourceEnvelope = {}) {
  const save = buildSave(state, sourceEnvelope);
  const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `emberfall-backup-${save.savedAt}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function saveLocal(state, sourceEnvelope = {}) {
  localStorage.setItem('emberfall-restored-save', JSON.stringify(buildSave(state, sourceEnvelope)));
}

export function loadLocal() {
  const raw = localStorage.getItem('emberfall-restored-save');
  if (!raw) return null;
  try {
    return parseSave(raw);
  } catch {
    return null;
  }
}
