import {
  AFFIX_LABELS,
  BERSERKER_SKILLS,
  ELEMENTS,
  MODS,
  SLOTS,
  getCompatibility,
  getElement,
  getMod,
  getRarity,
  getSkill,
} from './data.js';
import {
  buildSave,
  createEmptyState,
  downloadSave,
  loadLocal,
  normalizeState,
  parseSave,
  saveLocal,
} from './save.js';

let envelope = { format: 'emberfall-save', version: 1, savedAt: Date.now() };
let state = createEmptyState();

const restored = loadLocal();
if (restored) {
  envelope = restored;
  state = restored.state;
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pct(roll) {
  const n = Number(roll);
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(n * 100)}% 롤`;
}

function itemTitle(item) {
  const rarity = getRarity(item.tier);
  return item.name || `${rarity.name} ${SLOTS[item.slot] || item.slot}`;
}

function itemMeta(item) {
  const parts = [SLOTS[item.slot] || item.slot, `Lv.${item.baseLevel ?? '?'}`, `+${item.enhance ?? 0}`];
  if (item.slot === 'main') parts.push(`속성: ${getElement(item.el).name}`);
  if (item.slot === 'off') parts.push(`변형: ${getMod(item.mod).name}`);
  return parts.join(' · ');
}

function affixesHtml(item) {
  const affixes = item.statRolls?.affixes || [];
  if (!affixes.length) return '<span class="muted">추가 옵션 없음</span>';
  return affixes.map((a) => `<span class="affix">${esc(AFFIX_LABELS[a.key] || a.key)} <b>${pct(a.roll)}</b></span>`).join('');
}

function persist() {
  state = normalizeState(state);
  saveLocal(state, envelope);
}

function renderHeader() {
  $('#char-title').textContent = `${state.classId === 'berserker' ? '버서커' : state.classId} · Lv.${state.lv}`;
  $('#char-subtitle').textContent = `XP ${state.xp} · 골드 ${state.gold.toLocaleString()} · 처치 ${state.kills.toLocaleString()}`;
}

function renderOverview() {
  const ranks = state.ranks.map((v, i) => `${getSkill(i).name} ${v}`).join(' / ');
  const awake = state.awake.map((v, i) => v ? getSkill(i).name : null).filter(Boolean);
  $('#overview').innerHTML = `
    <div class="stat-grid">
      <article><span>레벨</span><b>${state.lv}</b></article>
      <article><span>골드</span><b>${state.gold.toLocaleString()}</b></article>
      <article><span>가방</span><b>${state.bag.length}/${state.bagCapacity}</b></article>
      <article><span>처치</span><b>${state.kills.toLocaleString()}</b></article>
      <article><span>패러곤</span><b>${state.paragon ?? 0}</b></article>
      <article><span>에테르</span><b>${state.materials?.aether ?? 0}</b></article>
    </div>
    <div class="panel compact">
      <h3>스킬 랭크</h3>
      <p>${esc(ranks)}</p>
      <h3>각성</h3>
      <p>${awake.length ? awake.map(esc).join(', ') : '각성 없음'}</p>
    </div>
  `;
}

const EQUIP_ORDER = ['main', 'off', 'head', 'chest', 'gloves', 'boots', 'ring', 'ring2', 'amulet'];

function renderEquipment() {
  $('#equipment').innerHTML = EQUIP_ORDER.map((slot) => {
    const item = state.eq?.[slot];
    return `
      <article class="equip-slot ${item ? 'filled' : ''}">
        <header><span>${SLOTS[slot]}</span>${item ? `<button data-unequip="${slot}" class="ghost small">해제</button>` : ''}</header>
        ${item ? `
          <h3>${esc(itemTitle(item))}</h3>
          <p>${esc(itemMeta(item))}</p>
          <div class="affixes">${affixesHtml(item)}</div>
        ` : '<p class="muted">비어 있음</p>'}
      </article>
    `;
  }).join('');

  $$('[data-unequip]').forEach((button) => {
    button.addEventListener('click', () => unequip(button.dataset.unequip));
  });
}

function renderInventory() {
  const filter = $('#slot-filter')?.value || 'all';
  const items = state.bag.filter((item) => filter === 'all' || item.slot === filter);
  $('#inventory-count').textContent = `${state.bag.length}/${state.bagCapacity}`;
  $('#inventory').innerHTML = items.length ? items.map((item) => {
    const rarity = getRarity(item.tier);
    const element = item.slot === 'main' ? `<span class="tag element-${getElement(item.el).key}">${getElement(item.el).name}</span>` : '';
    const mod = item.slot === 'off' ? `<span class="tag">${getMod(item.mod).name}</span>` : '';
    return `
      <article class="item-card" data-tier="${item.tier ?? 1}">
        <div class="item-top">
          <div>
            <span class="rarity">${rarity.name}</span>
            <h3>${esc(itemTitle(item))}</h3>
          </div>
          <button class="primary small" data-equip="${esc(item.id)}">장착</button>
        </div>
        <p>${esc(itemMeta(item))}</p>
        <div class="tags">${element}${mod}<span class="tag">skill ${item.skill ?? 0}</span><span class="tag">unique ${item.uniqueMod ?? 0}</span></div>
        <div class="affixes">${affixesHtml(item)}</div>
      </article>
    `;
  }).join('') : '<div class="empty">조건에 맞는 아이템이 없습니다.</div>';

  $$('[data-equip]').forEach((button) => {
    button.addEventListener('click', () => equip(Number(button.dataset.equip)));
  });
}

function equip(id) {
  const index = state.bag.findIndex((item) => Number(item.id) === Number(id));
  if (index < 0) return;
  const item = state.bag[index];
  let target = item.slot;
  if (item.slot === 'ring') target = !state.eq.ring ? 'ring' : (!state.eq.ring2 ? 'ring2' : 'ring');
  const old = state.eq[target];
  state.eq[target] = item;
  state.bag.splice(index, 1);
  if (old) state.bag.push(old);
  syncLoadout();
  persist();
  renderAll();
}

function unequip(slot) {
  const item = state.eq?.[slot];
  if (!item) return;
  if (state.bag.length >= state.bagCapacity) {
    alert('가방이 가득 찼습니다.');
    return;
  }
  state.bag.push(item);
  delete state.eq[slot];
  syncLoadout();
  persist();
  renderAll();
}

function syncLoadout() {
  const idx = Number(state.activeLoadout) || 0;
  state.loadouts[idx] = structuredClone(state.eq);
}

function renderSkillLab() {
  const mainItems = [state.eq.main, ...state.bag.filter((i) => i.slot === 'main')].filter(Boolean);
  const offItems = [state.eq.off, ...state.bag.filter((i) => i.slot === 'off')].filter(Boolean);

  $('#lab-main').innerHTML = mainItems.length
    ? mainItems.map((i, idx) => `<option value="${esc(i.id)}" ${idx === 0 ? 'selected' : ''}>${esc(itemTitle(i))} · ${getElement(i.el).name}</option>`).join('')
    : '<option value="">주무기 없음</option>';
  $('#lab-off').innerHTML = offItems.length
    ? offItems.map((i, idx) => `<option value="${esc(i.id)}" ${idx === 0 ? 'selected' : ''}>${esc(itemTitle(i))} · ${getMod(i.mod).name}</option>`).join('')
    : '<option value="">보조무기 없음</option>';

  $('#lab-skill').innerHTML = BERSERKER_SKILLS.map((s) => `<option value="${s.id}">${s.id + 1}. ${s.name}</option>`).join('');
  renderForms();
  renderCompatibility();
}

function findItem(id) {
  if (!id) return null;
  return Object.values(state.eq || {}).find((i) => String(i?.id) === String(id))
    || state.bag.find((i) => String(i?.id) === String(id))
    || null;
}

function renderForms() {
  const skill = getSkill($('#lab-skill').value);
  $('#lab-forms').innerHTML = skill.forms.map((form, index) => `
    <label class="form-choice">
      <input type="radio" name="skill-form" value="${index}" ${index === 0 ? 'checked' : ''}>
      <span><b>${form.name}</b><small>${form.description}</small></span>
    </label>
  `).join('');
}

function compatibilityLabel(value) {
  return {
    support: '지원',
    strong: '강지원',
    transform: '전용 변환',
    limited: '제한 적용',
    blocked: '적용 금지',
  }[value] || value;
}

function renderCompatibility() {
  const skillId = Number($('#lab-skill').value || 0);
  const off = findItem($('#lab-off').value);
  const mod = off ? getMod(off.mod) : MODS[0];
  const compatibility = getCompatibility(skillId, mod.id);
  const badge = $('#compatibility');
  badge.textContent = `${mod.name}: ${compatibilityLabel(compatibility)}`;
  badge.dataset.kind = compatibility;
}

function playSkill() {
  const skillId = Number($('#lab-skill').value || 0);
  const formId = Number($('input[name="skill-form"]:checked')?.value || 0);
  const skill = getSkill(skillId);
  const form = skill.forms[formId];
  const main = findItem($('#lab-main').value);
  const off = findItem($('#lab-off').value);
  const element = getElement(main?.el ?? 0);
  const mod = getMod(off?.mod ?? 0);
  const compatibility = getCompatibility(skillId, mod.id);

  if (compatibility === 'blocked') {
    addLog(`⛔ ${skill.name}은(는) ${mod.name} 변형과 호환되지 않습니다.`);
    $('#arena').classList.add('blocked-flash');
    setTimeout(() => $('#arena').classList.remove('blocked-flash'), 380);
    return;
  }

  const rank = Number(state.ranks?.[skillId] || 0);
  const awakened = Boolean(state.awake?.[skillId]);
  const base = 100 + rank * 12 + (awakened ? 35 : 0);
  const compatibilityBonus = compatibility === 'strong' ? 1.22 : compatibility === 'transform' ? 1.12 : compatibility === 'limited' ? 0.9 : 1;
  const damage = Math.round(base * compatibilityBonus);

  const effect = document.createElement('div');
  effect.className = `skill-effect skill-${skillId} element-${element.key} mod-${mod.key}`;
  effect.textContent = skillId === 1 ? '🪓' : skillId === 3 ? '⛓' : '✦';
  $('#arena').appendChild(effect);
  setTimeout(() => effect.remove(), 1100);

  $$('.dummy').forEach((dummy, index) => {
    const shown = Math.max(1, damage - index * 7);
    const number = document.createElement('span');
    number.className = 'damage-number';
    number.textContent = shown;
    dummy.appendChild(number);
    setTimeout(() => number.remove(), 900);
  });

  addLog(`⚔ ${skill.name} · ${form.name} / ${element.name} / ${mod.name} (${compatibilityLabel(compatibility)}) → 기준 피해 ${damage}`);
}

function addLog(text) {
  const row = document.createElement('li');
  row.textContent = text;
  $('#combat-log').prepend(row);
  while ($('#combat-log').children.length > 8) $('#combat-log').lastElementChild.remove();
}

function renderDesignSummary() {
  $('#design-summary').innerHTML = `
    <article class="panel"><h3>복원된 확정값</h3><p>속성 7종, 보조 변형 7종, 등급 6단계, 5개 스킬 슬롯, 스킬별 2칸 traits, 2개 장비 로드아웃 구조.</p></article>
    <article class="panel"><h3>새 설계값</h3><p>버서커 5스킬의 이름/동작, A/B 폼, 속성 상태효과, 스킬×보조변형 호환표는 원본 코드가 없어 복원판 규칙으로 새로 정의했습니다.</p></article>
    <article class="panel"><h3>호환성 원칙</h3><p>원본 JSON의 알 수 없는 필드는 삭제하지 않고 유지합니다. 나중에 원본 소스를 찾으면 새 구현과 병합할 수 있도록 데이터 계층을 분리했습니다.</p></article>
  `;
}

function renderAll() {
  renderHeader();
  renderOverview();
  renderEquipment();
  renderInventory();
  renderSkillLab();
  renderDesignSummary();
}

function switchTab(name) {
  $$('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
}

$$('[data-tab]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('#slot-filter').addEventListener('change', renderInventory);
$('#lab-skill').addEventListener('change', () => { renderForms(); renderCompatibility(); });
$('#lab-off').addEventListener('change', renderCompatibility);
$('#test-skill').addEventListener('click', playSkill);

$('#import-save').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = parseSave(await file.text());
    envelope = parsed;
    state = parsed.state;
    persist();
    renderAll();
    addLog(`✅ ${file.name} 가져오기 완료`);
  } catch (error) {
    alert(error.message);
  } finally {
    event.target.value = '';
  }
});

$('#export-save').addEventListener('click', () => downloadSave(state, envelope));
$('#reset-save').addEventListener('click', () => {
  if (!confirm('복원판 로컬 상태를 초기화할까요? 원본 JSON 파일은 삭제되지 않습니다.')) return;
  envelope = buildSave(createEmptyState());
  state = envelope.state;
  persist();
  renderAll();
});

renderAll();
