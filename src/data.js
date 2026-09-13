export const ELEMENTS = [
  { id: 0, name: '노말', key: 'normal', effect: '순수 물리' },
  { id: 1, name: '불', key: 'fire', effect: '화상' },
  { id: 2, name: '번개', key: 'lightning', effect: '감전/연쇄' },
  { id: 3, name: '얼음', key: 'ice', effect: '둔화/빙결 축적' },
  { id: 4, name: '바람', key: 'wind', effect: '밀치기/범위' },
  { id: 5, name: '어둠', key: 'dark', effect: '출혈/흡수' },
  { id: 6, name: '빛', key: 'light', effect: '표식/폭발' },
];

export const MODS = [
  { id: 0, name: '분산', key: 'split' },
  { id: 1, name: '확장', key: 'expand' },
  { id: 2, name: '관통', key: 'pierce' },
  { id: 3, name: '낙하', key: 'drop' },
  { id: 4, name: '연쇄', key: 'chain' },
  { id: 5, name: '회귀', key: 'return' },
  { id: 6, name: '공전', key: 'orbit' },
];

export const RARITIES = [
  null,
  { tier: 1, grade: 0, name: '노말', affixes: 0 },
  { tier: 2, grade: 1, name: '마법', affixes: 1 },
  { tier: 3, grade: 2, name: '희귀', affixes: 2 },
  { tier: 4, grade: 3, name: '에픽', affixes: 3 },
  { tier: 5, grade: 4, name: '전설', affixes: 4 },
  { tier: 6, grade: 5, name: '신화', affixes: 5 },
];

export const SLOTS = {
  main: '주무기',
  off: '보조무기',
  head: '투구',
  chest: '갑옷',
  gloves: '장갑',
  boots: '장화',
  ring: '왼쪽 반지',
  ring2: '오른쪽 반지',
  amulet: '목걸이',
};

export const AFFIX_LABELS = {
  damage: '피해',
  armor: '방어',
  life: '생명력',
  crit: '치명타 확률',
  critd: '치명타 피해',
  speed: '공격 속도',
  move: '이동 속도',
  area: '범위',
  pierce: '관통',
  projectile: '투사체',
  skilldamage: '스킬 피해',
  resist: '저항',
  allskills: '모든 스킬',
  skillrank0: '스킬 1 랭크',
  skillrank1: '스킬 2 랭크',
  skillrank2: '스킬 3 랭크',
  skillrank3: '스킬 4 랭크',
  skillrank4: '스킬 5 랭크',
};

// 아래 5개 스킬 이름/동작은 원본 세이브에서 복원된 값이 아니라 복원판 설계안이다.
export const BERSERKER_SKILLS = [
  {
    id: 0,
    name: '파쇄',
    description: '전방을 크게 베는 근접 도끼 기술.',
    forms: [
      { id: 0, name: '처형', description: '좁고 강한 2연격. 단일 대상에 강함.' },
      { id: 1, name: '지진', description: '부채꼴 충격파를 남기는 광역형.' },
    ],
  },
  {
    id: 1,
    name: '투척',
    description: '회전 도끼를 투사체로 던진다.',
    forms: [
      { id: 0, name: '사냥꾼', description: '빠른 직선 단일 투척.' },
      { id: 1, name: '분쇄륜', description: '느리지만 큰 다단히트 도끼.' },
    ],
  },
  {
    id: 2,
    name: '붕괴 도약',
    description: '지정 지점으로 도약한 뒤 내려찍는다.',
    forms: [
      { id: 0, name: '분화구', description: '착지 중심 대형 원형 피해.' },
      { id: 1, name: '파열선', description: '착지 후 전방으로 균열 진행.' },
    ],
  },
  {
    id: 3,
    name: '혈쇄',
    description: '피의 사슬로 적을 붙잡거나 절단한다.',
    forms: [
      { id: 0, name: '인력', description: '적을 사용자 쪽으로 끌어당김.' },
      { id: 1, name: '절단', description: '사슬 경로에 지속 피해.' },
    ],
  },
  {
    id: 4,
    name: '광폭',
    description: '짧은 시간 공격성을 폭발적으로 끌어올린다.',
    forms: [
      { id: 0, name: '광란', description: '공격/이동 속도 중심 강화.' },
      { id: 1, name: '혈폭', description: '즉시 주변 폭발 후 공격 강화.' },
    ],
  },
];

// support: 자연 적용, strong: 강한 시너지, transform: 전용 변환, limited: 일부만 적용, blocked: 적용 금지
export const MOD_COMPATIBILITY = [
  ['support', 'strong', 'limited', 'transform', 'support', 'blocked', 'transform'],
  ['strong', 'support', 'strong', 'support', 'strong', 'strong', 'support'],
  ['blocked', 'strong', 'transform', 'strong', 'support', 'blocked', 'transform'],
  ['support', 'support', 'transform', 'blocked', 'strong', 'strong', 'strong'],
  ['blocked', 'support', 'blocked', 'transform', 'support', 'blocked', 'strong'],
];

export function getElement(id) {
  return ELEMENTS.find((v) => v.id === Number(id)) ?? ELEMENTS[0];
}

export function getMod(id) {
  return MODS.find((v) => v.id === Number(id)) ?? MODS[0];
}

export function getRarity(tier) {
  return RARITIES[Number(tier)] ?? RARITIES[1];
}

export function getSkill(id) {
  return BERSERKER_SKILLS[Number(id)] ?? BERSERKER_SKILLS[0];
}

export function getCompatibility(skillId, modId) {
  return MOD_COMPATIBILITY[Number(skillId)]?.[Number(modId)] ?? 'support';
}
