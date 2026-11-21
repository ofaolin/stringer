// STRINGER client — vanilla JS, no deps.
import { capitalizeOps, highlightRegexes, lex, parseQuery, suggest, QUERY_HELP, WINDOW_CLAUSES, setTimeClause, windowOf, setFieldClause, fieldClauses, biasOf, biasClause, typeOf, hasClause } from '/query.js';
import { createEditor } from '/editor.js';
import { createStats } from '/stats.js';
import { attachDatePicker } from '/datepicker.js';
import { installTooltips } from '/tooltip.js';
import { createReader } from '/reader.js';
import { createSideStats } from '/sidestats.js';
import { createAuth } from '/auth.js';
import { createComments } from '/comments.js';
import { createSettingsCommands } from '/settings-cmd.js';
import { topicOf, topicOfMany, TOPIC_DESC } from '/topics.js';
import { createResearch } from '/research.js';
import { installPasswordMask } from '/pwmask.js';
import { createActivity, KINDS as ACT_ICON } from '/activity.js';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');

const BUCKET = { '-2': 'L', '-1': 'LL', 0: 'C', 1: 'LR', 2: 'R' };
const BIAS_NAME = { '-2': 'LEFT', '-1': 'LEAN LEFT', 0: 'CENTER', 1: 'LEAN RIGHT', 2: 'RIGHT' };
const BIAS_ALIASES = { l: -2, left: -2, ll: -1, leanleft: -1, c: 0, center: 0, centre: 0, lr: 1, leanright: 1, r: 2, right: 2 };
const THEMES = ['green', 'amber', 'cyan', 'red', 'mono'];

// ───────────────────────── state ─────────────────────────
const store = {
  get(k, d) { try { const v = localStorage.getItem('stringer.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stringer.' + k, JSON.stringify(v)); } catch {} },
};
// the site was called NEWSER: carry its saved settings over to the new key prefix, once
try {
  if (!localStorage.getItem('stringer.migrated')) {
    for (const k of Object.keys(localStorage)) if (k.startsWith('newser.') && localStorage.getItem('stringer.' + k.slice(7)) == null) localStorage.setItem('stringer.' + k.slice(7), localStorage.getItem(k));
    localStorage.setItem('stringer.migrated', '1');
  }
} catch {}
// one-time move to new defaults (mono theme, slow ticker): every setting is persisted together, so a stored
// value can't tell a deliberate choice from an old default — reset these two once
if (store.get('defaultsV', 1) < 2) {
  try { localStorage.removeItem('stringer.theme'); localStorage.removeItem('stringer.tickerSpeed'); } catch {}
  store.set('defaultsV', 2);
}
const state = {
  mode: ['stories', 'stream'].includes(store.get('mode')) ? store.get('mode') : 'stories',
  sort: store.get('sort', 'top'),
  theme: store.get('theme', 'mono'),
  img: store.get('img', true),
  crt: store.get('crt', true),
  ticker: store.get('ticker', true),
  pane: store.get('pane', 'stats'),          // sidebar tab: stats | sources
  tickerSpeed: store.get('tickerSpeed', 'slow'),
  bmin: store.get('bmin', 3),
  q: '',
  source: null,
  sources: [],
  items: [],
  total: 0,
  sel: -1,
  lastRefresh: 0,
  editing: null,
  saved: [],
  counts: {},
  tabId: null,
  srcSort: store.get('srcSort', 'bias'),
  page: 0,          // results page (PAGE items each); reset whenever the query/view changes
  pageKey: '',
  extent: null,
  view: null,       // what the server actually returned: archive results are always a stream of articles
  inArchive: false,
};
const viewMode = () => state.view || state.mode;
const ARCHIVE_NO_STORIES = 'stories are only grouped for the live feeds — archive results are listed as articles';
const PAGE = 100;
const persist = () => {
  store.set('mode', state.mode);
  store.set('sort', state.sort); store.set('theme', state.theme);
  store.set('img', state.img); store.set('crt', state.crt); store.set('ticker', state.ticker); store.set('tickerSpeed', state.tickerSpeed); store.set('bmin', state.bmin);
};

// ───────────────────────── api ─────────────────────────
async function api(path, opts = {}) {
  const r = await fetch('/api/' + path, {
    method: opts.method || 'GET',
    // X-Requested-With: the server only accepts writes that carry it (cross-site forms can't set it)
    headers: { 'X-Requested-With': 'stringer', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.data = data; throw e; }
  return data;
}

// ───────────────────────── utils ─────────────────────────
// "5m ago" — but just "now" for the last minute (ago() says "now", and "now ago" reads wrong)
const agoText = (ts) => { const s = ago(ts); return s === 'now' ? 'now' : `${s} ago`; };
const isoDay = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 45 * 86400) return `${Math.floor(s / 86400)}d`;
  return isoDay(ts);                                   // archive items: show the actual date
}
// "3h ago" or "on 2016-05-12" (for sentences)
const agoPhrase = (ts) => (Date.now() - ts < 45 * 86400e3 ? `<b>${ago(ts)}</b> ago` : `on <b>${isoDay(ts)}</b>`);
const approxMark = (a) => (a.approx ? '<span class="approx" title="archived item — headline reconstructed from the article URL">≈</span>' : '');
const hhmmss = (d) => d.toTimeString().slice(0, 8);
const srcById = (id) => state.sources.find((s) => s.id === id);

// ── reader view: every article link opens in the floating reader (modifier/middle-click keeps a new tab) ──
let reader;   // created once chip() exists
const asArticle = (x) => x && { link: x.link, title: x.title, summary: x.summary, sourceId: x.sourceId || x.leadSource, date: x.date || x.newest };
function readLink(e, a, known = []) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
  const href = a.getAttribute('href');
  if (!/^https?:\/\//i.test(href || '')) return false;
  e.preventDefault();
  reader.open(asArticle(known.find((k) => k.link === href)) || { link: href, title: a.textContent.trim() });
  return true;
}
const chip = (bias) => `<span class="chip ${BUCKET[bias]}" title="${BIAS_NAME[bias]}">${BUCKET[bias]}</span>`;

// ───────────────────────── accounts & comments ─────────────────────────
const auth = createAuth({
  api, esc, chip, log: (m, c) => log(m, c),
  onChange: (what) => {
    if (what === 'login') return location.reload();                 // a different person: start fresh
    if (what === 'rank') { loadSources(); loadNews(); loadTicker(); sideStats.refresh(true); }
  },
});
const comments = createComments({ api, esc, log: (m, c) => log(m, c), auth, ago: (t) => agoText(t), onPosted: () => reloadNewsSoon(400) });
const cmBadge = (id) => (state.comments?.[id] ? `<span class="cm-badge" title="${state.comments[id]} comment${state.comments[id] === 1 ? '' : 's'} — open to read">✎ ${state.comments[id]}</span>` : '');
// Popovers and the reader put the discussion in a collapsible left sidebar — closed until you open it (then
// remembered per browser); c or the rail toggles it
const cmCollapsed = () => !store.get('cmOpen', false);
// the side panel shows one pane: the discussion, or (in the reader) the article's details
const sidePane = () => store.get('sidePane', 'discussion');
const paneAttr = (details) => (details && sidePane() === 'details' ? 'details' : 'discussion');
function cmAside(threads, opts = {}) {
  const info = opts.details;
  return `<aside class="pop-cm${info ? ' has-info' : ''}">
    <div class="pop-tabs">
      <button type="button" class="pop-cm-rail ${info ? 'needs-perm-comments-read' : ''}" data-act="cm-toggle" title="your notes and the discussion — show / hide (c)"><span class="pop-cm-rail-l">✎ NOTES · DISCUSSION</span> <span class="cm-total"></span> <span class="pop-cm-arrow"></span></button>
      ${info ? '<button type="button" class="pop-cm-rail pop-info-rail" data-act="info-toggle" title="show / hide this article\'s details: outlet, morgue, read state, the stories it belongs to (i)"><span class="pop-cm-rail-l">ⓘ DETAILS</span> <span class="pop-cm-arrow"></span></button>' : ''}
    </div>
    <div class="pop-cm-body">${opts.notes ? `<div class="pop-cm-sec pop-note-sec"><h4>✎ NOTES <span class="dim note-where"></span></h4><div id="${opts.notes}" class="note-slot"></div></div>` : ''}${threads.filter(Boolean).map(([title, id]) => `<div class="pop-cm-sec needs-perm-comments-read"><h4>${title} <span class="dim cm-count"></span></h4><div id="${id}" class="cm-slot"></div></div>`).join('')}</div>
    ${info ? `<div class="pop-info-body"><div id="${info}" class="info-slot"></div></div>` : ''}
  </aside>`;
}
// open a pane, switch to it, or (already showing it) close the panel
function openPane(p) {
  const open = !cmCollapsed();
  if (open && sidePane() === p) store.set('cmOpen', false);
  else { store.set('cmOpen', true); store.set('sidePane', p); }
  for (const el of document.querySelectorAll('.pop-split')) {
    el.classList.toggle('collapsed', cmCollapsed());
    el.dataset.pane = el.querySelector('.has-info') && sidePane() === 'details' ? 'details' : 'discussion';
  }
  placeCmTabs(); requestAnimationFrame(placeCmTabs);   // the drawer / file tabs follow the popover
}
const toggleComments = () => openPane('discussion');
const toggleDetails = () => openPane('details');
// Closed, the discussion is a file tab sticking out of the dialog's left edge, a quarter of the way up. Dialogs
// scroll internally (they'd clip anything outside them), so the tab is position:fixed and placed here — after the
// dialog's open animation (a transformed ancestor would offset it), and again on resize.
// The open sidebar is a drawer attached to the popover's left edge, between its header and footer — the popover
// itself keeps its size and place. (Narrow screens: it stays in the page flow above the content.)
const CM_W = 320, CM_MIN = 280;
function placeCmAside(d) {
  const aside = d.querySelector('.pop-split:not(.collapsed) > .pop-cm');
  // not enough room beside the popover for the drawer: the popover gives up width on its left only (its right
  // edge and header controls stay put) — never covered, never re-centred
  const squeeze = (px) => { if ((Number(d.dataset.cmSqueeze) || 0) !== px) { d.dataset.cmSqueeze = px; d.style.setProperty('--cm-squeeze', `${px}px`); d.classList.toggle('cm-squeezed', px > 0); } };
  if (!aside || innerWidth < 900) { squeeze(0); if (aside) { aside.removeAttribute('style'); aside.dataset.placed = '1'; } return; }
  const cur = Number(d.dataset.cmSqueeze) || 0;
  const baseLeft = d.getBoundingClientRect().left - cur;                // where the popover sits without squeezing
  squeeze(Math.max(0, Math.ceil(CM_MIN - (baseLeft - 6))));
  const r = d.getBoundingClientRect();
  const head = d.querySelector('.sd-head, .rd-head'), foot = d.querySelector('.sd-foot, .rd-foot');
  const top = head ? head.getBoundingClientRect().bottom : r.top + 48;
  const bottom = foot ? foot.getBoundingClientRect().top : r.bottom - 48;
  // as wide as there's room for beside the popover (it overlaps the popover's edge only when the window is narrow)
  const w = Math.max(260, Math.min(CM_W, r.left - 6));
  // ends exactly at the popover's border (which stays visible as the seam), as if slid out from under it
  // a little shorter than the body, centred on the popover — its ends sit clear of the header and footer lines
  const h = Math.max(160, bottom - top - 56);
  const y = Math.min(Math.max(r.top + r.height / 2 - h / 2, top + 8), bottom - 8 - h);
  Object.assign(aside.style, { left: `${Math.round(Math.max(4, r.left - w))}px`, top: `${Math.round(y)}px`, height: `${Math.round(h)}px`, width: `${w}px` });
  aside.dataset.placed = '1';
}
function placeCmTabs() {
  for (const d of document.querySelectorAll('dialog[open]')) {
    // (measure after the popover's opening animation, not mid-scale)
    if (d.getAnimations().some((a) => a.playState === 'running')) { d.addEventListener('animationend', placeCmTabs, { once: true }); continue; }
    placeCmAside(d);
    const rails = [...d.querySelectorAll('.pop-split.collapsed .pop-cm-rail')].filter((x) => getComputedStyle(x).display !== 'none');
    const rail = rails[0];
    if (!rail) continue;
    if (innerWidth < 900) { for (const x of rails) { x.style.left = x.style.top = ''; x.dataset.placed = '1'; } continue; }
    if (d.getAnimations().some((a) => a.playState === 'running')) { d.addEventListener('animationend', placeCmTabs, { once: true }); continue; }
    const r = d.getBoundingClientRect();
    rail.style.left = `${Math.round(r.left - rail.offsetWidth + 1)}px`;
    // centred about a quarter of the way up from the popover's bottom, clear of the footer
    const top = r.top + r.height * 0.75 - rail.offsetHeight / 2;
    // two tabs (discussion + details) stack, the second directly under the first
    const total = rails.reduce((t, x) => t + x.offsetHeight, 0) + (rails.length - 1) * 6;
    let y = Math.round(Math.max(r.top + 60, Math.min(r.top + r.height * 0.75 - total / 2, r.bottom - 64 - total)));
    for (const x of rails) {
      x.style.left = `${Math.round(r.left - x.offsetWidth + 1)}px`;
      x.style.top = `${y}px`;
      x.dataset.placed = '1';
      y += x.offsetHeight + 6;
    }
  }
}
addEventListener('resize', () => requestAnimationFrame(placeCmTabs));

// keep a thread's DOM across popover re-renders (votes re-render them) so a half-typed comment isn't lost
// your note on a story / article (top of the sidebar): kept across re-renders like the threads
function mountNote(slotId, key, target) {
  const slot = document.getElementById(slotId);
  if (!slot || typeof research === 'undefined') return;
  const prev = mountNote.kept?.[slotId];
  if (prev && prev.dataset.key === key) { slot.replaceWith(prev); return; }
  slot.dataset.key = key;
  (mountNote.kept ??= {})[slotId] = slot;
  research.mountNote(slot, target);
}
function mountThread(slotId, key, what) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  const prev = mountThread.kept?.[slotId];
  if (prev && prev.dataset.key === key) { slot.replaceWith(prev); return; }
  slot.dataset.key = key;
  (mountThread.kept ??= {})[slotId] = slot;
  comments.mount(slot, what);
}

function log(msg, cls = '') {
  const el = $('#log');
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">[${hhmmss(new Date())}]</span> <span class="${cls}">${msg}</span>`;
  el.appendChild(div);
  while (el.children.length > 200) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
  peekConsole();
  floatLog(div);
}

// While a popover (modal dialog) is up it covers the terminal, so new messages also float in the bottom-left corner.
// It's a manual popover, re-shown on each message so it stacks above the dialog in the top layer; it ignores the
// mouse and each line fades out after a few seconds.
const floatBox = Object.assign(document.createElement('div'), { id: 'float-log', popover: 'manual' });
floatBox.setAttribute('aria-live', 'polite');
document.body.append(floatBox);
function floatLog(line) {
  if (!document.querySelector('dialog[open]') || !floatBox.showPopover) return;
  const div = line.cloneNode(true);
  floatBox.append(div);
  while (floatBox.children.length > 4) floatBox.firstChild.remove();
  try { if (floatBox.matches(':popover-open')) floatBox.hidePopover(); floatBox.showPopover(); } catch {}
  setTimeout(() => div.classList.add('out'), 4500);
  setTimeout(() => { div.remove(); if (!floatBox.children.length) try { floatBox.hidePopover(); } catch {} }, 5000);
}

// console collapses when unfocused; new messages "peek" briefly while collapsed
const consoleEl = $('.console');
let peekTimer;
function peekConsole() {
  if (consoleEl.classList.contains('open')) return;
  consoleEl.classList.add('peek');
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => consoleEl.classList.remove('peek'), 3500);
  requestAnimationFrame(() => { $('#log').scrollTop = $('#log').scrollHeight; });
}
function setConsoleOpen(open) {
  consoleEl.classList.toggle('open', open);
  if (open) { consoleEl.classList.remove('peek'); clearTimeout(peekTimer); }
  requestAnimationFrame(() => { $('#log').scrollTop = $('#log').scrollHeight; });
}
consoleEl.addEventListener('focusin', () => setConsoleOpen(true));
consoleEl.addEventListener('focusout', (e) => { if (!consoleEl.contains(e.relatedTarget)) setConsoleOpen(false); });
consoleEl.addEventListener('mousedown', (e) => { if (!e.target.closest('input, .log')) { e.preventDefault(); $('#cmd').focus(); } });

let newsTimer;
const reloadNewsSoon = (ms = 350) => { clearTimeout(newsTimer); newsTimer = setTimeout(loadNews, ms); };

// ───────────────────────── sources pane ─────────────────────────
async function loadSources() {
  state.sources = await api('sources');
  renderSources();
  try { research.renderSide(); } catch {}        // binder sidebar: outlet names / tooltips need the sources (no-op before it exists)
}

function renderSources() {
  const filter = $('#src-filter').value.trim().toLowerCase();
  const list = $('#src-list');
  const enabled = state.sources.filter((s) => s.enabled);
  $('#src-count').textContent = `[${enabled.length}/${state.sources.length}]`;

  const dist = [-2, -1, 0, 1, 2].map((b) => enabled.filter((s) => s.bias === b).length);
  const tot = dist.reduce((a, b) => a + b, 0) || 1;
  $('#spectrum').innerHTML = dist.map((n, i) => `<span style="width:${(n / tot) * 100}%;background:var(--${BUCKET[i - 2]})" title="${BIAS_NAME[i - 2]}: ${n}"></span>`).join('');

  $$('#src-sort button').forEach((b) => b.classList.toggle('on', b.dataset.ssort === state.srcSort));
  const flat = state.srcSort !== 'bias';
  const statusRank = (s) => (!s.enabled ? 1 : s.status === 'error' ? 0 : s.status === 'ok' ? 3 : 2);
  const cmp = {
    bias: (x, y) => (y.enabled - x.enabled) || (y.votes - x.votes) || x.name.localeCompare(y.name),
    votes: (x, y) => (y.votes - x.votes) || (y.enabled - x.enabled) || x.name.localeCompare(y.name),
    name: (x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }),
    items: (x, y) => ((y.enabled ? y.count || 0 : -1) - (x.enabled ? x.count || 0 : -1)) || x.name.localeCompare(y.name),
    status: (x, y) => (statusRank(x) - statusRank(y)) || x.name.localeCompare(y.name),
  }[state.srcSort] || ((x, y) => x.name.localeCompare(y.name));
  const matches = (s) => !filter || s.name.toLowerCase().includes(filter) || s.id.includes(filter);
  const groups = flat
    ? [[null, state.sources.filter(matches).sort(cmp)]]
    : [-2, -1, 0, 1, 2].map((b) => [b, state.sources.filter((s) => s.bias === b && matches(s)).sort(cmp)]);
  let html = '';
  const solo = soloOf(state.q);
  for (const [b, group] of groups) {
    if (!group.length) continue;
    if (b !== null) html += `<div class="src-group">${chip(b)} ${BIAS_NAME[b]} <span class="dim">(${group.length})</span></div>`;
    for (const s of group) {
      const sc = s.votes > 0 ? 'pos' : s.votes < 0 ? 'neg' : '';
      const title = (s.status === 'error' ? `ERROR: ${s.error}` : s.status === 'ok' ? `${s.count} items · fetched in ${s.ms}ms` : s.status);
      html += `<div class="src ${s.enabled ? '' : 'off'} ${solo === s.id ? 'active' : ''}" data-id="${esc(s.id)}">
        <button class="vote up" data-vote="1" title="Upvote ${esc(s.name)}">▲</button>
        <span class="score ${sc}" title="${esc(scoreTip(s))}">${s.votes > 0 ? '+' : ''}${s.votes}</span>
        <button class="vote down" data-vote="-1" title="Downvote ${esc(s.name)}">▼</button>
        <button class="name" data-act="solo" title="Show only ${esc(s.name)}">${flat ? chip(s.bias) + ' ' : ''}${esc(s.name)}</button>
        <span class="meta">
          ${state.srcSort === 'items' && s.enabled ? `<span class="tag" title="items in the live feeds">${s.count || 0}</span>` : ''}
          <span class="dot ${s.status}" title="${esc(title)}"></span>
          <button class="tog needs-perm-sources-manage" data-act="toggle" title="${s.enabled ? 'Disable' : 'Enable'}">${s.enabled ? '[on]' : '[off]'}</button>
          <button class="gear needs-perm-sources-manage" data-act="edit" title="Edit">⚙</button>
        </span>
      </div>`;
    }
  }
  list.innerHTML = html || '<div class="empty">no sources match</div>';
}

// the number beside an outlet is its votes in the ranking you're using (community net, or your personal votes)
function scoreTip(s) {
  const mode = auth.me?.rank?.mode || 'community';
  const sign = (n) => `${n > 0 ? '+' : ''}${n || 0}`;
  return mode === 'community'
    ? `COMMUNITY ranking: net ${sign(s.community)} from everyone's votes · weight ×${s.weight}${s.today ? `\nyour vote today: ${sign(s.today)} (vote the other way to take it back)` : ''}${auth.me?.user ? `\nyour personal votes: ${sign(s.personal)}` : ''}`
    : `PERSONAL ranking: your votes ${sign(s.personal)} · weight ×${s.weight}\ncommunity: ${sign(s.community)}`;
}

async function vote(id, delta) {
  const s = srcById(id);
  if (!s) return;
  try {
    const mode = auth.me?.rank?.mode || 'community';
    const updated = await api(`sources/${encodeURIComponent(id)}/vote`, { method: 'POST', body: { delta, mode } });
    Object.assign(s, updated);
    if (updated.budget) auth.setBudget(updated.budget);
    renderSources();
    if (state.openStory) renderStoryModal();
    if (artOpen) renderArticleModal();
    const sign = (n) => `${n > 0 ? '+' : ''}${n}`;
    activity.record('vote', `${updated.budget?.undone ? 'took back a vote on' : delta > 0 ? 'upvoted' : 'downvoted'} ${s.name} (${mode})`, { source: s.id });
    if (mode === 'personal') log(`${delta > 0 ? '▲' : '▼'} personal vote: ${esc(s.name)} → ${sign(s.personal)} (weight ×${s.weight})`, delta > 0 ? 'ok' : 'warn');
    else if (updated.budget?.undone) log(`↺ took back today's community vote on ${esc(s.name)} → community ${sign(s.community)} · ▲${updated.budget.upLeft} ▼${updated.budget.downLeft} left today`);
    else log(`${delta > 0 ? '▲' : '▼'} community vote: ${esc(s.name)} → community ${sign(s.community)} (weight ×${s.weight}) · ▲${updated.budget.upLeft} ▼${updated.budget.downLeft} left today`, delta > 0 ? 'ok' : 'warn');
    reloadNewsSoon(600);
  } catch (e) { if (!auth.denied(e)) log(`vote failed: ${esc(e.message)}`, 'err'); }
}

async function toggleSource(id) {
  if (!auth.can('sources.manage')) return;
  const s = srcById(id);
  const updated = await api(`sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled: !s.enabled } });
  Object.assign(s, updated);
  renderSources();
  log(`${esc(s.name)} ${s.enabled ? 'enabled' : 'disabled'}`);
  reloadNewsSoon(s.enabled ? 2500 : 100);
}

// Clicking an outlet in the sidebar is a query shortcut like the toolbar filters: it sets (or, clicked
// again, removes) a top-level source:<id> clause. The highlighted outlet is read back from the query.
function soloOf(q) {
  const cs = fieldClauses(q || '', new Set(['source']));
  if (cs.length !== 1) return null;
  const id = cs[0].text.slice(cs[0].text.indexOf(':') + 1).toLowerCase();
  return state.sources.some((s) => s.id === id) ? id : null;
}
function soloSource(id) {
  editClause('source', id && soloOf(qInput.value) !== id ? `source:${id}` : null);
  renderSources();
}

$('#src-list').addEventListener('click', (e) => {
  const row = e.target.closest('.src');
  if (!row) return;
  const id = row.dataset.id;
  const v = e.target.closest('[data-vote]');
  if (v) return vote(id, Number(v.dataset.vote));
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'toggle') toggleSource(id);
  else if (act === 'edit') openSourceDialog(srcById(id));
  else if (act === 'solo') soloSource(id);
});
$('#src-filter').addEventListener('input', renderSources);
$('#src-sort').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ssort]');
  if (!b) return;
  state.srcSort = b.dataset.ssort;
  store.set('srcSort', state.srcSort);
  renderSources();
});

// ───────────────────────── feed ─────────────────────────
function newsQuery() {
  const p = new URLSearchParams({
    mode: state.mode, sort: state.sort, limit: PAGE, bmin: state.bmin,
  });
  if (state.q) p.set('q', state.q);
  const key = p.toString();
  if (key !== state.pageKey) { state.pageKey = key; state.page = 0; }   // new query/view → back to page 1
  if (state.page) p.set('offset', state.page * PAGE);
  return p.toString();
}
const pageCount = () => Math.max(1, Math.ceil(state.total / PAGE));
// sel: index to select on the new page ('last' = its last item); keeps the feed at the top otherwise
async function gotoPage(p, sel = null) {
  p = Math.max(0, Math.min(pageCount() - 1, p));
  if (p === state.page) return;
  state.page = p;
  state.sel = -1;
  await loadNews();
  $('.feed').scrollTo({ top: 0, behavior: 'instant' });
  if (sel != null) { state.sel = sel === 'last' ? state.items.length - 1 : sel; highlight(); }
}

let newsReq = 0;
async function loadNews() {
  const my = ++newsReq;
  // slow (archive) queries: dim the stale results and say so, instead of looking finished
  const t0 = Date.now();
  let saidSlow = false;
  const slow = setTimeout(() => { if (my === newsReq) { saidSlow = true; log(`<span class="dim">⟳ searching${qInput.value.trim() ? ` for</span> ${esc(qInput.value.trim().slice(0, 80))}<span class="dim">` : ''}…</span>`); document.body.classList.add('loading'); qStatus.classList.remove('bad', 'wip'); qStatus.innerHTML = '<span class="spin">⟳</span> searching…'; } }, 250);
  try {
    const data = await api('news?' + newsQuery());
    if (my !== newsReq) return;
    clearTimeout(slow);
    document.body.classList.remove('loading');
    if (saidSlow) log(`<span class="dim">✓ ${data.total.toLocaleString()} ${data.mode === 'stories' ? 'stor' + (data.total === 1 ? 'y' : 'ies') : 'article' + (data.total === 1 ? '' : 's')} found${data.extent?.source === 'archive' ? ' in the archive' : ''} · ${((Date.now() - t0) / 1000).toFixed(1)} s</span>`);
    state.items = data.items;
    state.total = data.total;
    state.fulltext = data.fulltext || {};
    state.comments = data.comments || {};
    state.reads = data.reads || {};
    state.readLinks = new Set(data.readLinks || []);
    state.storyReads = data.storyReads || {};
    state.snippets = data.snippets || {};
    state.extent = data.extent || null;
    // page vanished (fewer results than before): jump to the real last page, once
    if (data.offset && !data.items.length && data.total && !loadNews.retried) { loadNews.retried = true; state.page = pageCount() - 1; return loadNews(); }
    loadNews.retried = false;
    state.view = data.mode;
    state.inArchive = data.extent?.source === 'archive';
    syncModeAvailability();
    state.lastRefresh = data.lastRefresh;
    state.archive = data.archive || null;
    renderFeed();
    renderTabs();
    loadCountsSoon();
    sideStats.refresh();
  } catch (e) {
    clearTimeout(slow);
    if (my !== newsReq) return;
    document.body.classList.remove('loading');
    if (e.data?.error) {                              // the server rejected the query (e.g. story field on the archive)
      const err = { message: e.data.error, pos: e.data.pos ?? -1, len: e.data.len || 0 };
      renderQueryHL(err); setQueryStatus(err);
      state.items = []; state.total = 0; state.extent = null; state.archive = null;
      renderFeed();
      return log(`query: ${esc(e.data.error)}`, 'err');
    }
    setQueryStatus(null);
    if (auth.denied(e)) return;
    log(`news load failed: ${esc(e.message)}`, 'err');
  }
}

function biasBar(dist, total) {
  return `<span class="biasbar" title="L ${dist.L} · LL ${dist.LL} · C ${dist.C} · LR ${dist.LR} · R ${dist.R}">${
    ['L', 'LL', 'C', 'LR', 'R'].map((k) => (dist[k] ? `<span class="${k}" style="width:${(dist[k] / total) * 100}%"></span>` : '')).join('')
  }</span>`;
}

function voteBtns(sid) {
  return `<span class="votes"><button class="vote up" data-vote="1" data-sid="${esc(sid)}" title="Upvote source">▲</button><button class="vote down" data-vote="-1" data-sid="${esc(sid)}" title="Downvote source">▼</button></span>`;
}

// STRINGER-archived: the article's full text is saved in STRINGER (it has a morgue no., is searchable with body:,
// and the reader opens STRINGER's copy even if the page later dies or goes behind a paywall). One marker everywhere: ▣
const fmtWords = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
// Morgue no.: the catalog number of STRINGER's saved copy — 8 hex characters, unique (newsrooms call their clippings
// archive "the morgue"). The tag copies it.
const morgueShort = (u) => String(u || '').slice(0, 8);
function morgueTag(morgue) {
  if (!morgue) return '';
  return `<button type="button" class="link morgue" data-act="copy-morgue" data-morgue="${esc(morgue)}"
    title="${esc(`STRINGER's catalog number for the copy of this article it filed — newsrooms call their archive of clippings “the morgue”.`)}"
    data-tip-head="▣ STRINGER MORGUE" data-tip-head-right="no. ${esc(morgueShort(morgue))}" data-tip-foot="click to copy · find it with morgue:${esc(morgueShort(morgue))}">morgue no. ${esc(morgueShort(morgue))}</button>`;
}
function archTip(f) {
  if (f.fragment) return `filed in the morgue ${f.saved ? isoDay(f.saved) : ''} as a fragment — headline and summary only; the full text hasn't been filed (yet)`;
  return `filed in the morgue ${f.saved ? isoDay(f.saved) : ''} · ${(f.words || 0).toLocaleString()} words${f.partial ? ' — a fragment only (paywall?)' : ''}`;
}
// the MORGUE tag: shows the morgue no.; clicking it copies the number (words / save date are in the tooltip)
function morgueBadge(f, { compact = false, big = false } = {}) {
  const no = morgueShort(f.morgue);
  return `<button type="button" class="ft${f.partial || f.fragment ? ' partial' : ''}${big ? ' big' : ''}" data-act="copy-morgue" data-morgue="${esc(no)}" title="${esc(archTip(f))}" data-tip-head="▣ STRINGER MORGUE" data-tip-head-right="no. ${esc(no)}" data-tip-note="${f.fragment ? 'a fragment: the reader fetches the article when you open it' : 'searchable with body: · the reader opens this copy'}" data-tip-foot="click to copy · find it with morgue:${esc(no)}">▣${compact ? '' : ' MORGUE'} ${esc(no)}${f.fragment && !compact ? ' · fragment' : ''}</button>`;
}
// Where it shows: popovers and the reader always; STREAM rows only for articles older than the live window (the
// morgue copy matters once an article has aged out of the feeds); never on STORIES-mode rows (the story is the focus).
const LIVE_WINDOW_MS = 14 * 864e5;
function ftBadge(a, compact = false) {
  const f = state.fulltext?.[a.id];
  return f?.morgue ? morgueBadge(f, { compact }) : '';
}
// copy a morgue no. from anywhere (results, popovers, the reader)
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-act=copy-morgue]');
  if (!b) return;
  e.preventDefault();
  navigator.clipboard?.writeText(b.dataset.morgue).then(() => log(`copied morgue no. ${esc(b.dataset.morgue)} — query it with morgue:${esc(b.dataset.morgue)}`, 'ok'), () => log('could not copy (clipboard unavailable)', 'err'));
});
// matched headline / summary terms of the current query, marked like body snippets
let hlRes = { title: [], summary: [] }, hlFor = null;
function hlRegs() {
  if (hlFor !== state.q) { hlFor = state.q; try { hlRes = state.q ? highlightRegexes(parseQuery(state.q)) : { title: [], summary: [], body: [] }; } catch { hlRes = { title: [], summary: [], body: [] }; } }
  return hlRes;
}
const hlHits = (text, where) => !!text && hlRegs()[where].some((r) => { r.lastIndex = 0; return r.test(text); });
// STORIES mode: the story matched through one of its other articles — say which, with the words marked
// (body matches too: in STORIES mode this line is the only place a body match shows; STREAM rows show their own)
function hitIn(st) {
  const R = hlRegs();
  const bodyHits = st.articles.filter((a) => state.snippets?.[a.id]);
  if (!R.title.length && !R.summary.length && !bodyHits.length) return '';
  const lead = st.articles.find((a) => a.link === st.link);
  if (hlHits(st.title, 'title') || hlHits(st.summary || lead?.summary, 'summary')) return '';
  const hits = st.articles.filter((a) => a !== lead && (hlHits(a.title, 'title') || hlHits(a.summary, 'summary')));
  if (!hits.length && bodyHits.length) {
    // only the full text matched: the body excerpt, marked (the lead's own body first)
    const a = bodyHits.find((x) => x === lead) || bodyHits[0], sn = state.snippets[a.id], s = srcById(a.sourceId);
    return `<div class="hit-in" title="your search words aren't in the lead article's headline or summary — they matched the full text of ${bodyHits.length} article${bodyHits.length === 1 ? '' : 's'} in this story">⌕ <span class="dim">matched in</span> ${s ? srcLink(a) : ''} <span class="dim">· body ›</span> <span class="hit-what">${esc(sn.pre)}<mark>${esc(sn.hit)}</mark>${esc(sn.post)}</span>${bodyHits.length > 1 ? ` <span class="dim">+${bodyHits.length - 1} more</span>` : ''}</div>`;
  }
  if (!hits.length) return '';
  const a = hits[0], s = srcById(a.sourceId);
  let what;
  if (hlHits(a.title, 'title')) what = `“${hl(a.title, 'title')}”`;
  else {
    // a short stretch of the summary around the first match
    const t = a.summary, r = R.summary.find((x) => { x.lastIndex = 0; return x.test(t); });
    r.lastIndex = 0;
    const m = r.exec(t), at = m ? m.index : 0;
    const from = Math.max(0, at - 60), to = Math.min(t.length, at + (m?.[0].length || 0) + 90);
    what = `${from ? '…' : ''}${hl(t.slice(from, to), 'summary')}${to < t.length ? '…' : ''} <span class="dim">(summary)</span>`;
  }
  return `<div class="hit-in" title="your search words aren't in the lead article — they matched ${hits.length} other article${hits.length === 1 ? '' : 's'} in this story">⌕ <span class="dim">matched in</span> ${s ? srcLink(a) : ''} <span class="dim">·</span> <span class="hit-what">${what}</span>${hits.length > 1 ? ` <span class="dim">+${hits.length - 1} more</span>` : ''}</div>`;
}
// the open tab is a saved query with highlighting turned off (and its query hasn't been edited): no yellow marks —
// which articles matched (the "matched in" line, the body-match markers) is still worked out, just not painted
const hlMuted = () => { const sq = state.tabId && state.saved.find((x) => x.id === state.tabId); return !!sq && sq.highlight === false && sq.query.trim() === String(state.q || '').trim(); };
function hl(text, where) {
  if (hlMuted()) return esc(String(text ?? ''));
  if (hlFor !== state.q) { hlFor = state.q; try { hlRes = state.q ? highlightRegexes(parseQuery(state.q)) : { title: [], summary: [] }; } catch { hlRes = { title: [], summary: [] }; } }
  const res = hlRes[where];
  const t = String(text ?? '');
  if (!res?.length || !t) return esc(t);
  const spans = [];
  for (const r of res) { r.lastIndex = 0; for (const m of t.matchAll(r)) if (m[0]) spans.push([m.index, m.index + m[0].length]); }
  if (!spans.length) return esc(t);
  spans.sort((x, y) => x[0] - y[0]);
  let out = '', pos = 0;
  for (const [a, b] of spans) { if (b <= pos) continue; const s0 = Math.max(a, pos); out += esc(t.slice(pos, s0)) + `<mark>${esc(t.slice(s0, b))}</mark>`; pos = b; }
  return out + esc(t.slice(pos));
}
function snippetHTML(a, who = '') {
  const sn = state.snippets?.[a.id];
  return sn ? `<div class="summary snippet"><span class="dim">${who}body ›</span> ${esc(sn.pre)}<mark>${esc(sn.hit)}</mark>${esc(sn.post)}</div>` : '';
}

// how one-sided a blindspot is: "entirely" only when the ignoring side has no coverage at all
function blindPhrase(st) {
  const by = st.blindspot === 'left' ? 'right' : 'left';
  const d = st.dist;
  const ignored = st.blindspot === 'left' ? d.L + d.LL : d.R + d.LR;
  if (ignored > 0) return `covered almost entirely by ${by}-leaning outlets`;
  return d.C ? `covered by ${by}-leaning and center outlets — none from the ${st.blindspot}` : `covered entirely by ${by}-leaning outlets`;
}

// ── read / unread (yours; signed in) ── a story counts as read once you've read any of its articles
// tracked by link (one article has different ids in different views)
const isReadA = (a) => !!(a && auth.me?.user && state.readLinks?.has(a.link));
// Two kinds of read state. An ARTICLE is read once you've opened it (reader, or a new tab); a STORY once you've
// opened its popover — and if coverage arrived since, it says so (↻) instead of ✓.
const storyReadCount = (st) => (st.articles || []).filter(isReadA).length;
const storyReadAt = (st) => (st?.sid && auth.me?.user ? state.storyReads?.[st.sid] ?? null : null);
const storyNewCount = (st) => { const at = storyReadAt(st); return at == null ? 0 : (st.articles || []).filter((a) => a.date > at).length; };
const storyIsNew = (st) => storyNewCount(st) > 0;
// the most recent article that arrived since you read the story
const storyNewest = (st) => { const at = storyReadAt(st); return (st.articles || []).filter((a) => a.date > at).sort((a, b) => b.date - a.date)[0] || null; };
const storyRead = (x) => (x.articles ? storyReadAt(x) != null && !storyIsNew(x) : isReadA(x));
const mergeReads = (links) => { state.readLinks ??= new Set(); for (const l of links || []) state.readLinks.add(l); };
// a small ✓ for read articles in lists (popover columns, timeline, coverage rows, related coverage)
// on attribution lines: a clickable "✓ read" (marks it unread) — or "○ unread" (marks it read)
const readBadge = (a) => (!auth.me?.user ? '' : isReadA(a)
  ? ' <button type="button" class="read-badge' + jr(a.link) + '" data-act="toggle-read" data-link="' + esc(a.link) + '" title="you\'ve read this — click or press m to mark it unread">✓ read</button>'
  : ' <button type="button" class="read-badge unread" data-act="toggle-read" data-link="' + esc(a.link) + '" title="not read yet — click or press m to mark it read">○ unread</button>');
const readTick = (a) => (isReadA(a) ? '<span class="read-tick" title="you\'ve read this">✓</span>' : '');
function readMark(x) {
  if (!auth.me?.user) return '';
  if (!x.articles) return isReadA(x) ? `<button type="button" class="read-mark" data-act="unread" title="you've read this article — click or press m to mark it unread">✓</button>` : '';
  const at = storyReadAt(x);
  if (at == null) return '';
  const n = storyReadCount(x), of = x.articles.length, fresh = storyNewCount(x);
  const arts = `you've read ${n} of its ${of} article${of === 1 ? '' : 's'}`;
  const newest = fresh ? storyNewest(x) : null;
  return fresh
    ? `<button type="button" class="read-mark is-new" data-act="open-new"${articleTip(newest, {
        alert: `↻ new coverage: ${fresh} article${fresh === 1 ? '' : 's'} since you read this story (${agoText(at)}) · ${arts}`,
        foot: `click to read the newest${fresh > 1 ? ` (of ${fresh} new)` : ''} · m marks the story read` })}>↻ ${fresh} new</button>`
    : `<button type="button" class="read-mark" data-act="unread" title="you've read this story (${agoText(at)}) · ${arts} — click or press m to mark it unread">✓</button>`;
}
// a story's own read badge (story popover): ✓ story read / ↻ n new since / ○ story unread
function storyBadge(st) {
  if (!auth.me?.user || !st?.sid) return '';
  const at = storyReadAt(st), fresh = storyNewCount(st);
  return at == null ? ' <button type="button" class="read-badge unread" data-act="toggle-story-read" title="you haven\'t read this story — m marks it read">○ story unread</button>'
    : fresh ? ` <button type="button" class="read-badge is-new" data-act="toggle-story-read" title="${fresh} new article${fresh === 1 ? '' : 's'} since you read it ${agoText(at)} — m marks it unread">↻ ${fresh} new since you read it</button>`
      : ` <button type="button" class="read-badge${jr(st.sid)}" data-act="toggle-story-read" title="you read this story ${agoText(at)} — m marks it unread">✓ story read</button>`;
}
// opening a story's popover marks it read — after a second, with the badge visibly flipping
function markStoryReadSoon(st) {
  if (!auth.me?.user || !st?.sid) return;
  clearTimeout(markStoryReadSoon.t);
  markStoryReadSoon.t = setTimeout(() => {
    if (!storyDlg.open || state.openStory?.st?.sid !== st.sid) return;      // moved on already
    const was = storyRead(st);
    if (!was) flashRead(st.sid);
    setStoryRead(st, true, { quiet: true });
  }, READ_DELAY);
}
// stories: mark read / unread
async function setStoryRead(st, read, { quiet = false } = {}) {
  if (!auth.me?.user || !st?.sid) return quiet ? null : auth.openLogin('sign in to keep track of what you have read');
  try {
    const r = await api('story-reads', { method: 'POST', body: { sid: st.sid, read } });
    state.storyReads ??= {};
    if (read) state.storyReads[st.sid] = r.at; else delete state.storyReads[st.sid];
    rerenderReads();
    if (!quiet) activity.record('mark', `marked story ${st.sid} ${read ? 'read' : 'unread'}: ${st.title || ''}`, { sid: st.sid });
    if (!quiet) log(`${read ? '✓ story marked read' : '○ story marked unread'}: ${esc((st.title || '').slice(0, 70))} <span class="dim">(story ${esc(st.sid)})</span>`);
  } catch (e) { if (!quiet && !auth.denied(e)) log(`couldn't update: ${esc(e.message)}`, 'err'); }
}
// topics: a small tag on rows and in the story popover; clicking it filters to (or, if filtered, clears) that topic
const storyTopic = (st) => (st.articles ? (st.topic ??= topicOfMany(st.articles)) : topicOf(st));
function topicTag(t) {
  if (!t || t === 'other') return '';
  // the query's topic clauses, parsed once per query text (not once per row)
  if (topicTag.for !== qInput.value) { topicTag.for = qInput.value; topicTag.clauses = fieldClauses(qInput.value, new Set(['topic'])).map((c) => qInput.value.slice(c.s, c.e).toLowerCase()); }
  const on = topicTag.clauses.some((c) => c.includes(t));
  return `<button type="button" class="topic-tag${on ? ' on' : ''}" data-topic="${t}" title="topic: ${t} — ${esc(TOPIC_DESC[t])}${on ? ' · click to clear the topic filter' : ' · click to show only this topic'}">#${t}</button>`;
}
// the story an article is part of (STREAM / archive rows)
const storyChip = (a) => (a.story?.sid && a.story.sources >= 2
  ? `<span class="story-chip" title="part of story ${esc(a.story.sid)}: ${a.story.articles} articles from ${a.story.sources} outlets — click the headline to open it · query story:${esc(a.story.sid)}">▤ story ${esc(a.story.sid)} · ${a.story.sources} outlets</span>` : '');
// mark one article (or every article of a story) read / unread
async function setRead(x, read) {
  if (!auth.me?.user) return auth.openLogin('sign in to keep track of what you have read');
  if (x.articles) return setStoryRead(x, read);                    // a story has its own read state
  const arts = [x];
  if (!arts.length) return;
  try {
    await api('reads', { method: 'POST', body: { links: arts.map((a) => a.link), read } });
    state.readLinks ??= new Set();
    for (const a of arts) { if (read) state.readLinks.add(a.link); else state.readLinks.delete(a.link); }
    rerenderReads();
    log(`${read ? '✓ marked read' : '○ marked unread'}: ${esc((x.title || '').slice(0, 70))}`);
    activity.record('mark', `marked ${read ? 'read' : 'unread'}: ${x.title || ''}`, { link: x.link, title: x.title, sourceId: x.sourceId, date: x.date });
  } catch (e) { if (!auth.denied(e)) log(`couldn't update: ${esc(e.message)}`, 'err'); }
}
const toggleRead = (x) => (x.articles ? setStoryRead(x, !storyRead(x)) : setRead(x, !isReadA(x)));
// read state changed: everything that shows it
// things that just turned read get a short animation on their badge
const READ_DELAY = 1000;
const justRead = new Set();
function flashRead(key) { justRead.add(key); setTimeout(() => justRead.delete(key), 1600); }
const jr = (key) => (justRead.has(key) ? ' just-read' : '');
function rerenderReads() {
  renderFeed();
  if (state.openStory && storyDlg.open) renderStoryModal();
  if (artOpen && artDlg.open) renderArticleModal();
  for (const el of document.querySelectorAll('.tk-item[data-tk]')) {
    const it = tickerItems[Number(el.dataset.tk)];
    if (!it) continue;
    el.classList.toggle('is-read', storyRead(it));
    for (const [k, v] of Object.entries(tickerTip(it))) { if (v) el.setAttribute(k, v); else el.removeAttribute(k); }
  }
  for (const slot of document.querySelectorAll('.info-slot')) if (slot._data) renderDetails(slot);
}
// opening an article in a new tab counts as reading it: ctrl/⌘/shift-click or middle-click on an article link, or
// the reader's "original" links. (A plain click on a headline opens the story intel / reader instead — the reader
// marks the article read itself.)
function markOpened(e) {
  const a = e.target.closest?.('a[href][target=_blank]');
  if (!a || !auth.me?.user || !/^https?:/.test(a.getAttribute('href')) || a.closest('#log, .tip')) return;
  const newTab = e.type === 'auxclick' ? e.button === 1 : e.ctrlKey || e.metaKey || e.shiftKey || !!a.closest('#dlg-reader');
  if (!newTab) return;
  const link = a.closest('#dlg-reader') && reader.current?.() ? reader.current().link : a.getAttribute('href');
  const hits = state.items.flatMap((it) => it.articles || [it]).filter((x) => x.link === link);
  if (!hits.length && !a.closest('dialog')) return;
  api('reads', { method: 'POST', body: { link, read: true } }).then(() => { mergeReads([link]); rerenderReads(); }).catch(() => {});
}
document.addEventListener('click', markOpened, true);
document.addEventListener('auxclick', markOpened, true);

function renderStory(st, i) {
  const lead = srcById(st.leadSource);
  const left = st.dist.L + st.dist.LL, right = st.dist.R + st.dist.LR;
  const blind = st.blindspot
    ? `<span class="blind ${st.blindspot === 'left' ? 'right' : 'left'}" title="${blindPhrase(st).replace(/^c/, 'C')} — a blindspot for the ${st.blindspot}">BLINDSPOT // ${st.blindspot.toUpperCase()}</span>`
    : '';
  // the coverage list (every article) is built the first time the row is expanded — 100 rows × all their articles
  // would otherwise be ~45k hidden elements re-created on every render
  return `<article class="story${storyRead(st) ? ' is-read' : storyIsNew(st) ? ' is-new' : ''}" data-i="${i}">
    <div class="idx">${String(state.page * PAGE + i + 1).padStart(2, '0')}</div>
    <div class="main">
      <a class="title" href="${esc(safeUrl(st.link))}" target="_blank" rel="noopener noreferrer">${approxMark(st.articles.find((x) => x.link === st.link) || {})}${hl(st.title, 'title')}</a>
      <div class="line2">
        ${biasBar(st.dist, st.sourceCount)}
        <span class="tri"><span class="l">L${left}</span> · <span class="c">C${st.dist.C}</span> · <span class="r">R${right}</span></span>
        <button class="expand" data-act="expand">[${st.sourceCount} source${st.sourceCount > 1 ? 's' : ''} ▾]</button>
        <span class="dim">${lead ? chip(lead.bias) + ' ' + esc(lead.name) : ''} · ${ago(st.newest)}</span>
        ${lead ? voteBtns(lead.id) : ''}
        ${readMark(st)}
        ${cmBadge(st.id)}
        ${blind}
        ${topicTag(storyTopic(st))}
      </div>
      ${st.summary ? `<div class="summary">${hl(st.summary, 'summary')}</div>` : ''}
      ${hitIn(st)}
      <div class="coverage"></div>
    </div>
    ${st.image ? `<img class="thumb" src="${esc(safeUrl(st.image))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : '<span></span>'}
  </article>`;
}

// a story row's coverage list (see renderStory)
function covHTML(st) {
  return st.articles.map((a) => {
    const s = srcById(a.sourceId);
    if (!s) return '';
    return `<div class="cov${isReadA(a) ? ' is-read' : ''}">${chip(s.bias)}<span class="src-name">${esc(s.name)}</span><a href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer">${approxMark(a)}${hl(a.title, 'title')}</a><span class="ago">${readTick(a)} ${ago(a.date)}</span>${voteBtns(s.id)}</div>`;
  }).join('');
}
function toggleRow(el) {
  const cov = el.querySelector('.coverage');
  if (cov && !cov.dataset.built) { const st = state.items[Number(el.dataset.i)]; if (st?.articles) { cov.innerHTML = covHTML(st); cov.dataset.built = '1'; } }
  el.classList.toggle('open');
}

function renderArticle(a, i) {
  const s = srcById(a.sourceId);
  if (!s) return '';
  return `<article class="story${isReadA(a) ? ' is-read' : ''}" data-i="${i}">
    <div class="idx">${String(state.page * PAGE + i + 1).padStart(2, '0')}</div>
    <div class="main">
      <a class="title" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer">${approxMark(a)}${hl(a.title, 'title')}</a>
      <div class="line2">
        ${chip(s.bias)} <span>${esc(s.name)}</span>
        <span class="dim">${ago(a.date)}</span>
        ${Date.now() - a.date > LIVE_WINDOW_MS ? ftBadge(a) : ''}
        ${readMark(a)}
        ${storyChip(a)}
        ${topicTag(topicOf(a))}
        ${cmBadge(a.id)}
        ${voteBtns(s.id)}
        <span class="dim" title="source weight">×${s.weight}</span>
      </div>
      ${snippetHTML(a) || (a.summary ? `<div class="summary">${hl(a.summary, 'summary')}</div>` : '')}
    </div>
    ${a.image ? `<img class="thumb" src="${esc(safeUrl(a.image))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : '<span></span>'}
  </article>`;
}

function renderFeed() {
  const list = $('#feed-list');
  const isStream = viewMode() === 'stream';
  list.innerHTML = state.items.map(isStream ? renderArticle : renderStory).join('');
  const empty = $('#feed-empty');
  empty.hidden = state.items.length > 0;
  if (!state.items.length) {
    empty.textContent = state.lastRefresh
      ? `> 0 results.\n> try widening the time window, enabling more bias buckets, or clearing the search.`
      : `> establishing uplink to ${state.sources.filter((s) => s.enabled).length} feeds…\n> first sync can take ~10-20s`;
  }
  renderPager();
  const af = $('#active-filter');
  const parts = [];
  const tab = activeTab();
  if (state.q) parts.unshift(`<span class="q-echo">${esc(state.q)}</span>${tab ? ` <span class="dim">· tab</span> <b>${esc(tab.name)}</b>` : ''}`);
  if (!parts.length) parts.push('<span class="dim">(none — everything)</span>');
  const approx = state.archive?.approx ? '~' : '';
  const pg = pageCount() > 1 ? ` <span class="pg-mini"><button type="button" class="pg-arrow" data-page="${state.page - 1}"${state.page ? '' : ' disabled'} title="previous page (&lt;)">‹</button><span class="dim">page</span> ${state.page + 1}<span class="dim">/${approx}${pageCount().toLocaleString()}</span><button type="button" class="pg-arrow" data-page="${state.page + 1}"${state.page < pageCount() - 1 ? '' : ' disabled'} title="next page (&gt;)">›</button></span>` : '';
  af.hidden = false;
  af.innerHTML = `<div class="af-row"><span><span class="prompt">query <span class="q-sl">//</span></span> ${parts.join(' · ')} <span class="dim">(${approx}${state.total.toLocaleString()} ${isStream ? 'articles' : 'stories'})</span>${pg}</span>${state.q ? '<button class="link" id="clear-filter" title="clear the query">[clear]</button>' : ''}</div>
    <div class="af-row af-extent">${extentHTML(state.extent, isStream)}</div>`;
  $('#st-stories').textContent = isStream ? `${state.total} arts` : state.total;
  if (!qStatus.classList.contains('bad') && !qStatus.classList.contains('wip')) setQueryStatus(null);
  state.sel = Math.min(state.sel, state.items.length - 1);
  highlight(false);
}

// spell out what was actually searched: live feeds vs archive, and the effective date range
const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
const fmtWhen = (ts) => (Date.now() - ts < 3 * 86400e3 ? fmtTime(ts) : fmtDay(ts));
function extentHTML(x, isStream) {
  if (!x) return '';
  const out = [];
  if (x.source === 'live') {
    const days = Math.round(x.windowHours / 24);
    out.push(`<span class="ext-src" title="the in-memory live feeds hold the last ${days} days; anything older is in the archive">◷ live feeds</span>`);
    if (x.defaulted) {
      out.push(`<b>last ${days} days</b> <span class="dim">(${fmtDay(x.from)} → now)</span>`);
      out.push(`<span class="dim">no date:/age: clause, so the default window applies —</span> <button class="link" data-ext="all" title="add date:* to the query">[search all time]</button> <button class="link" data-ext="24h" title="add age:<24h">[last 24h]</button>`);
    } else {
      out.push(`<b>${fmtWhen(x.from)} → ${x.to ? fmtWhen(x.to) : 'now'}</b>`);
    }
  } else {
    const A = state.archive;
    out.push(`<span class="arch-badge" title="searched the local historical archive${A ? ` (${A.ms} ms)` : ''}">▤ archive</span>`);
    out.push(x.allTime && x.to == null ? '<b>all time</b>' : `<b>${x.from != null ? fmtDay(x.from) : 'beginning'} → ${x.to != null ? fmtDay(x.to - 1) : 'now'}</b>`);
    if (x.morgueLookup) out.push('<span class="dim" title="a morgue no. lookup searches all time unless the query has its own date:/age: clause">morgue lookups default to all time</span>');
    if (A) out.push(`<span class="dim" title="${A.approx ? `estimated from the first ${A.scanned.toLocaleString()} of ${A.candidates.toLocaleString()} candidates scanned — exact for the pages you view` : 'exact count'}">${A.approx ? '~' : ''}${state.total.toLocaleString()} matching articles of ${A.indexed.toLocaleString()} indexed</span>`);
    out.push(`<span class="dim" title="${ARCHIVE_NO_STORIES}">articles only — stories mode is for the live feeds</span>`);
  }
  if (x.source === 'archive' && state.items.length) {      // archive totals can be estimates: describe this page
    const ds = state.items.map((a) => a.date);
    const lo = fmtDay(Math.min(...ds)), hi = fmtDay(Math.max(...ds));
    out.push(`<span class="dim">this page spans</span> ${lo}${lo !== hi ? ` – ${hi}` : ''}${state.archive?.partial ? ' <span class="warn" title="the scan hit its time limit before reaching this page — narrow the date: range, add terms, or sort OLDEST to reach the far end">⚠ scan limit reached — narrow the query</span>' : ''}`);
  } else if (x.source === 'archive' && state.archive?.partial) {
    out.push('<span class="warn" title="the scan hit its time limit before reaching this page — narrow the date: range, add terms, or sort OLDEST to reach the far end">⚠ scan limit reached — narrow the query</span>');
  } else if (x.results) {
    const what = isStream ? 'articles' : 'stories';
    const capped = state.archive?.partial;
    out.push(`<span class="dim">${what} found span</span> ${fmtDay(x.results.first)}${fmtDay(x.results.first) !== fmtDay(x.results.last) ? ` – ${fmtDay(x.results.last)}` : ''}${capped ? ` <span class="warn" title="the scan hit its time limit before reaching this page — narrow the date: range, add terms, or sort OLDEST to reach the far end">⚠ scan limit reached — narrow the query</span>` : ''}`);
  }
  return `<span class="dim">extent:</span> ${out.join(' <span class="dim">·</span> ')}`;
}

function renderPager() {
  const el = $('#pager');
  const pages = pageCount();
  el.hidden = state.total <= PAGE;
  if (el.hidden) return;
  const cur = state.page;
  const ap = state.archive?.approx ? '~' : '';
  const nums = [...new Set([0, cur - 2, cur - 1, cur, cur + 1, cur + 2, pages - 1])].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b);
  let html = '', prev = -1;
  for (const p of nums) {
    if (p - prev > 1) html += '<span class="dim">…</span>';
    html += `<button type="button" class="pg${p === cur ? ' on' : ''}" data-page="${p}">${p === pages - 1 && p !== cur ? ap : ''}${(p + 1).toLocaleString()}</button>`;
    prev = p;
  }
  const from = cur * PAGE + 1, to = Math.min(state.total, (cur + 1) * PAGE);
  el.innerHTML = `<span class="dim">showing ${from.toLocaleString()}–${to.toLocaleString()} of ${ap}${state.total.toLocaleString()}</span>
    <span class="pg-nums"><button type="button" class="pg" data-page="${cur - 1}"${cur ? '' : ' disabled'} title="previous page (&lt;)">‹ prev</button>${html}<button type="button" class="pg" data-page="${cur + 1}"${cur < pages - 1 ? '' : ' disabled'} title="next page (&gt;)">next ›</button></span>`;
}
installTooltips();

// back-to-top: the feed is the scroll container on desktop, the window on narrow screens
const feedEl = $('.feed');
const toTop = $('#to-top');
const scrolledFar = () => Math.max(feedEl.scrollTop, window.scrollY) > 600;
const syncToTop = () => { toTop.hidden = !scrolledFar(); };
feedEl.addEventListener('scroll', syncToTop, { passive: true });
window.addEventListener('scroll', syncToTop, { passive: true });
toTop.addEventListener('click', () => { feedEl.scrollTo({ top: 0 }); window.scrollTo({ top: 0, behavior: 'smooth' }); });

$('#pager').addEventListener('click', (e) => {
  const b = e.target.closest('[data-page]');
  if (b && !b.disabled) gotoPage(Number(b.dataset.page));
});

function clearQuery() {
  setQuery('');
  renderSources(); loadNews();
}
// Esc on the results page (with nothing selected) asks before wiping the query; Enter confirms
const confirmDlg = $('#dlg-confirm');
function confirmClearQuery() {
  if (!state.q) return;
  $('#cf-query').textContent = state.q;
  confirmDlg.returnValue = '';
  confirmDlg.showModal();
  confirmDlg.querySelector('button.primary').focus();
}
confirmDlg.addEventListener('close', () => { if (confirmDlg.returnValue === 'ok') clearQuery(); });
confirmDlg.addEventListener('click', (e) => { if (e.target === confirmDlg) confirmDlg.close(); });
confirmDlg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.target.closest('button[value=cancel]')) { e.preventDefault(); confirmDlg.close('ok'); }
});

$('#active-filter').addEventListener('click', (e) => {
  const pgb = e.target.closest('[data-page]');
  if (pgb) return pgb.disabled || gotoPage(Number(pgb.dataset.page));
  const ext = e.target.closest('[data-ext]');
  if (ext) return setWindow(ext.dataset.ext);
  if (e.target.id !== 'clear-filter') return;
  clearQuery();
});

// timeline in the story popover: expand to the complete timeline / collapse back
$('#story-body').addEventListener('click', (e) => {
  const b = e.target.closest('.tl-more');
  if (!b) return;
  const extra = b.previousElementSibling;
  extra.hidden = !extra.hidden;
  b.setAttribute('aria-expanded', String(!extra.hidden));
  b.textContent = extra.hidden ? `▾ show complete timeline (${b.dataset.more} more)` : '▴ show fewer';
  if (extra.hidden) b.scrollIntoView({ block: 'nearest' });
});

$('#feed-list').addEventListener('click', (e) => {
  if (e.target.closest('[data-act=copy-morgue]')) return;          // the MORGUE tag copies its number (document handler)
  // "matched in <outlet>": the outlet name opens that article in the reader (ctrl/middle-click: a new tab)
  const ml = e.target.closest('.hit-in .sd-srclink');
  if (ml) { const it = state.items[Number(ml.closest('.story')?.dataset.i)]; e.stopPropagation(); if (readLink(e, ml, it?.articles || [])) return; return; }
  const tg = e.target.closest('.topic-tag');
  if (tg) { e.preventDefault(); e.stopPropagation(); return editClause('topic', tg.classList.contains('on') ? null : `topic:${tg.dataset.topic}`); }
  const rm = e.target.closest('.read-mark');
  if (rm) {
    const it = state.items[Number(rm.closest('.story').dataset.i)];
    if (!it) return;
    if (rm.dataset.act === 'open-new') { const a = storyNewest(it); if (a) reader.open(asArticle(a)); return; }   // straight to the new article
    toggleRead(it);
    return;
  }
  const v = e.target.closest('[data-vote]');
  if (v) return vote(v.dataset.sid, Number(v.dataset.vote));
  const st = e.target.closest('.story');
  if (!st) return;
  state.sel = Number(st.dataset.i);
  highlight(false);
  if (e.target.closest('[data-act=expand]')) return toggleRow(st);
  const cov = e.target.closest('.coverage a');
  if (cov) return readLink(e, cov, state.items.flatMap((it) => it.articles || [it]));   // per-outlet links → reader
  const link = e.target.closest('a');
  if (link && (e.ctrlKey || e.metaKey || e.shiftKey)) return;    // modifier-click = open article directly
  if (window.getSelection()?.toString()) return;                 // don't hijack text selection
  e.preventDefault();
  openRow(state.sel);
});
// A STREAM / archive row whose article matched your search in its full text opens straight into the reader (the
// matches highlighted); anything else opens its story (archive: its details). Right-click → Open story is always there.
function openRow(i) {
  const it = state.items[i];
  if (it && !it.articles && state.snippets?.[it.id]) { state.sel = i; highlight(false); return reader.open(asArticle(it)); }
  openStoryAt(i);
}

// ───────────────────────── story intel popover ─────────────────────────
const storyDlg = $('#dlg-story');
const sideOf = (b) => (b < 0 ? 'left' : b > 0 ? 'right' : 'center');
// with the year when it isn't this year (archive articles)
const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', ...(new Date(ts).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hour12: false });
const relAge = (ts) => {
  const d = (Date.now() - ts) / 864e5;
  return d < 45 ? agoText(ts) : d < 730 ? `${Math.round(d / 30.44)} months ago` : `${d < 3650 ? (d / 365.25).toFixed(1) : Math.floor(d / 365.25)} years ago`;
};

function articleAsStory(a) {
  const s = srcById(a.sourceId);
  const dist = { L: 0, LL: 0, C: 0, LR: 0, R: 0 };
  if (s) dist[BUCKET[s.bias]] = 1;
  return { id: a.id, title: a.title, summary: a.summary, image: a.image, link: a.link, leadSource: a.sourceId,
    newest: a.date, oldest: a.date, sourceCount: 1, dist, blindspot: null, articles: [a] };
}

// status lines for what's being opened (they float over popovers too)
function logOpenStory(st, how = '') {
  const n = st.articles?.length || 1, srcs = new Set((st.articles || [st]).map((a) => a.sourceId)).size;
  activity.record('story', `opened ${st.sid ? `story ${st.sid}` : 'a story'}${how ? ` (${how})` : ''}: ${st.title || ''}`, st.sid ? { sid: st.sid, link: st.link } : { link: st.link });
  log(`▤ opening ${st.sid ? `story <b>${esc(st.sid)}</b>` : 'article'}${how ? ` <span class="dim">${how}</span>` : ''}: ${esc((st.title || '').slice(0, 70))} <span class="dim">· ${n} article${n === 1 ? '' : 's'} · ${srcs} outlet${srcs === 1 ? '' : 's'}</span>`);
}
async function openStoryAt(i) {
  if (state.inArchive) return openArticleAt(i);            // archive results aren't grouped: per-article popover
  const it = state.items[i];
  if (!it) return;
  state.sel = i;
  highlight();
  let st = it;
  let focusId = null;
  if (viewMode() === 'stream') {
    focusId = it.id;
    log(`<span class="dim">⟳ finding the story for</span> ${esc((it.title || '').slice(0, 70))}…`);
    try { st = await api(`story?id=${encodeURIComponent(it.id)}&bmin=${state.bmin}`); Object.assign(state.fulltext, st.fulltext || {}); mergeReads(st.readLinks); }
    catch { st = articleAsStory(it); }
  }
  state.openStory = { st, focusId, idx: i };
  logOpenStory(st);
  markStoryReadSoon(st);
  renderStoryModal();
  if (!storyDlg.open) storyDlg.showModal();
  $('#story-body').focus({ preventScroll: true });   // never land focus on a button (prev/next/close)
  storyDlg.scrollTop = 0;
}

// a ticker headline opens the same popover as a STREAM-mode headline: the story, focused on that article;
// j/k then step through the ticker's headlines
async function openTickerStory(i) {
  let st = tickerItems[i];
  if (!st) return;
  try { const full = await api(`story?id=${encodeURIComponent(st.id)}&bmin=${state.bmin}`); Object.assign(state.fulltext, full.fulltext || {}); mergeReads(full.readLinks); st = { ...st, ...full }; } catch {}
  state.openStory = { st, focusId: st.id, idx: i, from: 'ticker' };
  logOpenStory(st, 'from the ticker');
  markStoryReadSoon(st);
  renderStoryModal();
  if (!storyDlg.open) storyDlg.showModal();
  $('#story-body').focus({ preventScroll: true });
  storyDlg.scrollTop = 0;
}

// The article tooltip (outlet · bias · media / headline / published, morgue, read / summary), as attributes for any
// element: outlet names, headlines in the lower sections, the ↻ new tag. opts.alert adds a highlighted line on top.
function articleTip(a, { alert = '', foot = 'click to read · ctrl/middle-click for a new tab' } = {}) {
  const s = a && srcById(a.sourceId);
  if (!s) return '';
  const f = state.fulltext?.[a.id];
  const head = `${s.name} · ⟦b-${BUCKET[s.bias]}|${BIAS_NAME[s.bias].toLowerCase()}⟧ · ${s.type === 'legacy' ? 'legacy' : 'new'} media`;
  // under the headline (dim italic): when it was published (and whether you've read it), whether it's in the morgue
  const read = auth.me?.user ? (isReadA(a) ? " · ⟦ok|✓ you've read this⟧" : ' · ○ not read yet') : '';
  const sub = [`published ${fmtTime(a.date)} · ${agoText(a.date)}${read}`,
    f ? `▣ in the STRINGER morgue · ${(f.words || 0).toLocaleString()} words · morgue no. ${morgueShort(f.morgue)}` : ''].filter(Boolean).join('\n');
  const body = a.summary ? (a.summary.length > 220 ? a.summary.slice(0, 220).trimEnd() + '…' : a.summary) : '';
  return ` title="${esc(body || ' ')}"${alert ? ` data-tip-alert="${esc(alert)}"` : ''} data-tip-head="${esc(head)}" data-tip-title="${esc(`“${a.title}”`)}" data-tip-sub="${esc(sub)}" data-tip-foot="${esc(foot)}"`;
}
// an outlet's name as a link to its article (click opens the reader), with the article tooltip
function srcLink(a, { withChip = true, cls = '' } = {}) {
  const s = a && srcById(a.sourceId);
  if (!s) return '';
  return `${withChip ? chip(s.bias) + ' ' : ''}<a class="sd-srclink${cls ? ' ' + cls : ''}" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer"${articleTip(a)}>${esc(s.name)}</a>`;
}

function renderStoryModal() {
  const { st, focusId, idx } = state.openStory;
  // when you last read this story, as of opening it (opening marks it read a second later): articles since get ↻ new
  if (!('prevRead' in state.openStory)) state.openStory.prevRead = storyReadAt(st);
  const prevRead = state.openStory.prevRead;
  const newTag = (a) => (prevRead != null && a.date > prevRead ? `<span class="new-tag" title="new since you last read this story (${esc(agoText(prevRead))})">↻ new</span>` : '');
  // articles whose full text matched your query: marked ⌕ (the excerpt in its tooltip), their rows tinted
  const bodyHit = (a) => state.snippets?.[a.id];
  const hitTag = (a) => { const sn = bodyHit(a); return sn ? `<span class="body-hit" title="${esc(`…${sn.pre}${sn.hit}${sn.post}…`)}" data-tip-head="⌕ MATCHED IN THE ARTICLE TEXT" data-tip-foot="opening it in the reader highlights the matches">⌕</span>` : ''; };
  const arts = st.articles.filter((a) => srcById(a.sourceId));
  const uniq = new Map();
  for (const a of arts) if (!uniq.has(a.sourceId)) uniq.set(a.sourceId, srcById(a.sourceId));
  const n = uniq.size || 1;
  const sides = { left: [], center: [], right: [] };
  for (const s of uniq.values()) sides[sideOf(s.bias)].push(s);
  const pct = (x) => Math.round((x / n) * 100);
  const avg = [...uniq.values()].reduce((t, s) => t + s.bias, 0) / n;
  const lean = Math.abs(avg) < 0.35 ? 'BALANCED' : `${Math.abs(avg) >= 1 ? '' : 'SLIGHT '}${avg < 0 ? 'LEFT' : 'RIGHT'} LEAN`;
  const legacy = [...uniq.values()].filter((s) => s.type === 'legacy').length;
  // in STREAM mode you opened a specific article: lead with it, not with the story's top outlet
  const picked = focusId ? arts.find((a) => a.id === focusId) : null;
  const head = picked ? { title: picked.title, link: picked.link, summary: picked.summary, date: picked.date, image: picked.image || st.image, sourceId: picked.sourceId } : { title: st.title, link: st.link, summary: st.summary, date: st.newest, image: st.image, sourceId: st.leadSource };
  state.openStory.head = head;
  const pickedSrc = picked && srcById(picked.sourceId);
  const lead = srcById(st.leadSource);
  const first = [...arts].sort((a, b) => a.date - b.date)[0];
  const firstSrc = first && srcById(first.sourceId);
  const missing = Object.entries(sides).filter(([, v]) => !v.length).map(([k]) => k);
  // "lead" explained: the lead is the covering outlet with the highest source weight (your votes);
  // among equally weighted outlets, the most recent article that has a summary
  const whyLead = (() => {
    if (!lead) return '';
    const ws = [...uniq.values()].map((x) => x.weight);
    const top = Math.max(...ws), tied = ws.filter((w) => w === top).length;
    const fmtW = (w) => `×${+w.toFixed(2)}`;
    // the weights come from the ranking in use: everyone's community votes, or your own personal ones
    const community = (auth.me?.rank?.mode || 'community') === 'community';
    const votesOf = community ? "the community's votes" : 'your personal votes';
    const noVotes = community ? 'no community votes on them yet' : "you haven't voted on them";
    const body = uniq.size < 2 ? `${lead.name} is the only outlet covering this story so far.`
      : tied === 1 ? `${lead.name} has the highest source weight (${fmtW(top)}, from ${votesOf}) of the ${uniq.size} outlets covering this story, so its article leads.`
      : `${tied === uniq.size ? `All ${tied}` : `${tied} of the ${uniq.size}`} outlets share the top source weight (${fmtW(top)}${top === 1 ? `, i.e. ${noVotes}` : ` from ${votesOf}`}), so the lead is the most recent of their articles that has a summary — here ${lead.name}'s.`;
    return `<span class="sd-why" title="${esc(body)}" data-tip-head="why this lead?" data-tip-head-right="${(auth.me?.rank?.mode || 'community') === 'community' ? 'COMMUNITY' : 'PERSONAL'} ranking" data-tip-foot="${(auth.me?.rank?.mode || 'community') === 'community' ? '▲/▼ spend your daily community votes to change which outlet leads' : '▲/▼ vote outlets to change which one leads your stories'}">lead</span>`;
  })();
  const leadArt = arts.find((a) => a.link === st.link) || arts.find((a) => a.sourceId === st.leadSource);

  const segs = ['L', 'LL', 'C', 'LR', 'R'].map((k) => {
    const c = st.dist[k];
    if (!c) return '';
    const w = (c / st.sourceCount) * 100;
    return `<span class="${k}" style="width:${w}%" title="${k}: ${c}">${w >= 9 ? `${k} ${c}` : ''}</span>`;
  }).join('');

  const blind = st.blindspot
    ? `<div class="sd-blind ${st.blindspot === 'left' ? 'right' : 'left'}">⚠ BLINDSPOT // ${st.blindspot.toUpperCase()} — ${blindPhrase(st)}.</div>`
    : missing.length && n > 1 && n < state.bmin
      ? `<div class="sd-blind neutral">no ${missing.join(' or ')} coverage yet — blindspots need ${state.bmin}+ sources (cmd: blindspot min N)</div>` : '';

  // one summary per side (from the highest-weighted outlet that has one)
  // the summary under the headline is the headline article's (the lead, or the article you opened)
  const topArt = picked || leadArt;
  const topSum = (topArt?.summary || (!picked ? st.summary : '') || '').trim();
  // by side, from the highest-ranked outlet that has one — skipping the outlet whose summary is already at the top
  // (the next highest-ranked outlet on that side instead; that outlet's other articles only if no one else has one)
  const sums = ['left', 'center', 'right'].map((side) => {
    const a = arts.find((x) => x.summary && sideOf(srcById(x.sourceId).bias) === side && x.sourceId !== topArt?.sourceId && x.summary.trim() !== topSum)
      || arts.find((x) => x.summary && sideOf(srcById(x.sourceId).bias) === side && x.link !== topArt?.link && x.summary.trim() !== topSum);   // only that outlet has one
    return a ? `<div class="sd-sum" data-link="${esc(a.link)}"><span class="side ${side}">${side.toUpperCase()}</span><div>${hl(a.summary, 'summary')} <span class="dim">— ${srcLink(a, { withChip: false, cls: 'quiet' })}</span></div></div>` : '';
  }).filter(Boolean);

  const artRow = (a) => {
    const s = srcById(a.sourceId);
    return `<div class="sd-art ${a.id === focusId ? 'focus' : ''}${isReadA(a) ? ' is-read' : ''}${bodyHit(a) ? ' has-hit' : ''}" data-link="${esc(a.link)}">
      <div class="sd-art-meta">${hitTag(a)}${chip(s.bias)} <span class="sd-src">${esc(s.name)}</span> <span class="dim">· ${ago(a.date)}</span> ${newTag(a)} ${readTick(a)} ${ftBadge(a, true)} ${voteBtns(s.id)} <span class="dim w">×${s.weight}</span></div>
      <a href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer"${articleTip(a)}>${approxMark(a)}${hl(a.title, 'title')} <span class="ext">↗</span></a>
    </div>`;
  };
  // each column: higher-ranked outlets first (as before); within the same rank, articles new since you last read
  // the story come first (stable sort, so the existing newest-first order holds otherwise)
  const isNewA = (a) => prevRead != null && a.date > prevRead;
  const colLists = ['left', 'center', 'right'].map((side) => [side, arts.filter((a) => sideOf(srcById(a.sourceId).bias) === side)
    .sort((x, y) => (srcById(y.sourceId).weight || 0) - (srcById(x.sourceId).weight || 0) || !!bodyHit(y) - !!bodyHit(x) || isNewA(y) - isNewA(x))]);
  const colsOpen = !!state.openStory.colsOpen;
  const cols = colLists.map(([side, list]) => `<div class="sd-col ${side}">
      <div class="sd-col-head">${side.toUpperCase()} <span class="dim">${sides[side].length} src · ${pct(sides[side].length)}%</span></div>
      ${colRows(list, artRow, colsOpen) || `<div class="dim sd-none">&gt; no coverage${st.blindspot === side ? `<br>&gt; ${side} blindspot` : ''}</div>`}
    </div>`).join('');

  const timeline = [...arts].sort((a, b) => a.date - b.date);
  const tlRow = (a, k) => {
    const s = srcById(a.sourceId);
    return `<div class="tl-row${isReadA(a) ? ' is-read' : ''}${bodyHit(a) ? ' has-hit' : ''}" data-link="${esc(a.link)}"><span class="tl-t">${fmtTime(a.date)}</span><span class="tl-dot ${k === 0 ? 'first' : ''}"></span>${chip(s.bias)}<span class="tl-src">${esc(s.name)}</span><a href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer"${articleTip(a)}>${hl(a.title, 'title')}</a><span class="tl-tags">${hitTag(a)}${newTag(a)}${readTick(a)}</span></div>`;
  };
  const TL_SHOW = 15;
  const tl = timeline.slice(0, TL_SHOW).map(tlRow).join('') + (timeline.length > TL_SHOW
    ? `<div class="tl-extra" hidden>${timeline.slice(TL_SHOW).map((a, k) => tlRow(a, k + TL_SHOW)).join('')}</div>
       <button type="button" class="link tl-more" data-more="${timeline.length - TL_SHOW}" aria-expanded="false">▾ show complete timeline (${timeline.length - TL_SHOW} more)</button>`
    : '');

  $('#story-body').innerHTML = `
    <div class="sd-head">
      <span>// STORY ${st.sid ? `<b class="sid" title="the story's number — it keeps it as coverage arrives · query story:${esc(st.sid)}">${esc(st.sid)}</b> ` : ''}<span class="dim">${state.openStory.from === 'ticker'
        ? `ticker headline ${idx + 1} of ${tickerItems.length}`
        : state.openStory.from === 'sid' ? `${arts.length} article${arts.length === 1 ? '' : 's'}`
        : `#${String(state.page * PAGE + idx + 1).padStart(2, '0')} of ${state.total.toLocaleString()}`}</span>
        <span class="sd-head-meta">· updated ${agoPhrase(st.newest)} · <b>${uniq.size}</b> source${uniq.size === 1 ? '' : 's'} · <b>${arts.length}</b> article${arts.length === 1 ? '' : 's'}${storyTopic(st) !== 'other' ? ` · <span class="sd-topic" title="the story's topic (its articles' most common) — ${esc(TOPIC_DESC[storyTopic(st)])}">#${storyTopic(st)}</span>` : ''}${storyBadge(st)}</span></span>
      <span class="sd-nav"><button class="link" data-act="prev" title="previous (k)">[◂ k]</button> <button class="link" data-act="next" title="next (j)">[j ▸]</button> <button class="link" data-act="close">[esc]</button></span>
    </div>
    <div class="pop-split ${cmCollapsed() ? 'collapsed' : ''}" data-pane="discussion">
    ${cmAside([picked && ['ON THIS ARTICLE', 'sd-cm-article'], ['THE WHOLE STORY', 'sd-cm-story']], { notes: 'sd-note' })}
    <div class="pop-main">
    <div class="sd-top">
      <div class="sd-top-main">
        <h2 class="sd-title">${hl(head.title, 'title')}</h2>
        ${!pickedSrc && leadArt ? `<div class="sd-picked">${srcLink(leadArt)} · ${agoPhrase(leadArt.date)}${readBadge(leadArt)}${uniq.size > 1 ? ` <span class="dim">— ${whyLead} article of ${uniq.size} sources</span>` : ''}</div>` : ''}
        ${pickedSrc ? `<div class="sd-picked">${srcLink(picked)} · ${agoPhrase(picked.date)}${readBadge(picked)}${uniq.size > 1 && picked === leadArt ? ` <span class="dim">— ${whyLead} article of ${uniq.size} sources</span>` : uniq.size > 1 ? ` <span class="dim">— part of a story covered by ${uniq.size} sources (${whyLead}: ${leadArt ? srcLink(leadArt, { withChip: false }) : esc(lead?.name || '')}: “${esc(st.title.slice(0, 70))}${st.title.length > 70 ? '…' : ''}”)</span>` : ''}</div>` : ''}
        ${topSum ? `<div class="sd-lead-sum">${hl(topSum, 'summary')}</div>` : ''}
        ${blind}
      </div>
      ${head.image ? `<img class="sd-img" src="${esc(safeUrl(head.image))}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''}
    </div>

    <section>
      <h3>▌REPORTING BIAS</h3>
      <div class="sd-bar">${segs}</div>
      <div class="sd-split">
        <div class="left"><b>${pct(sides.left.length)}%</b> LEFT <span class="dim">(${sides.left.length})</span></div>
        <div class="center"><b>${pct(sides.center.length)}%</b> CENTER <span class="dim">(${sides.center.length})</span></div>
        <div class="right"><b>${pct(sides.right.length)}%</b> RIGHT <span class="dim">(${sides.right.length})</span></div>
      </div>
      <div class="sd-gauge-wrap">
        <div class="sd-gauge"><span class="marker" style="left:${((avg + 2) / 4) * 100}%" title="avg bias ${avg.toFixed(2)}"></span></div>
        <div class="sd-gauge-lbl"><span>LEFT</span><span>CENTER</span><span>RIGHT</span></div>
      </div>
      <div class="sd-stats">
        <span>coverage lean: <b class="lean ${avg < -0.35 ? 'left' : avg > 0.35 ? 'right' : ''}">${lean}</b> <span class="dim">(avg ${avg > 0 ? '+' : ''}${avg.toFixed(2)} on −2…+2)</span></span>
        <span>legacy <b>${legacy}</b> · new media <b>${uniq.size - legacy}</b></span>
        ${firstSrc ? `<span>first reported ${agoPhrase(first.date)} by ${srcLink(first)}</span>` : ''}
      </div>
    </section>

    ${sums.length ? `<section><h3>▌SUMMARY${sums.length > 1 ? ' BY SIDE' : ''}</h3>${sums.join('')}</section>` : ''}

    <section>
      <h3>▌HOW EACH SIDE FRAMED IT</h3>
      <div class="sd-cols">${cols}</div>
      ${colsToggle(colLists.map(([, l]) => l), colsOpen, 'articles', isNewA, (a) => !!bodyHit(a))}
    </section>

    ${arts.length > 1 ? `<section><h3>▌TIMELINE</h3><div class="tl">${tl}</div></section>` : ''}


    </div></div>

    <div class="sd-foot">
      <span class="dim">⏎/o read ${picked ? 'article' : 'lead'} · u/d vote its source · m read/unread · j/k next/prev · c discussion · esc close</span>
      <span><button data-act="close">CLOSE</button> <a class="btn primary" href="${esc(safeUrl(head.link))}" target="_blank" rel="noopener noreferrer" title="read it here (enter) — ctrl/middle-click for a new tab">OPEN ${picked ? '' : 'LEAD '}ARTICLE ↗</a></span>
    </div>`;
  // discussion threads (loaded after the popover renders)
  const storyKey = arts.map((a) => a.link).sort().join('|');
  mountNote('sd-note', st.sid ? `story:${st.sid}` : `article:${(picked || leadArt || arts[0]).link}`, st.sid ? { kind: 'story', st } : { kind: 'article', a: picked || leadArt || arts[0] });
  mountThread('sd-cm-story', `story:${storyKey}`, { scope: 'story', links: arts.map((a) => a.link), postLink: (leadArt || arts[0]).link });
  if (picked) mountThread('sd-cm-article', `article:${picked.link}`, { scope: 'article', link: picked.link });
  placeCmTabs(); requestAnimationFrame(placeCmTabs);
}

// ───────────────────────── archive article popover ─────────────────────────
// Archive results aren't grouped into stories, so a result opens this instead: the article, how it got into the
// archive, its stored full text, and related coverage — other outlets' headlines from ±2 days sharing its words.
const artDlg = $('#dlg-article');
const ORIGIN = {
  live: ['live feed', 'seen in the outlet\'s RSS feed while STRINGER was running — real headline and publish time'],
  wayback: ['Wayback Machine feed snapshot', 'from a Wayback Machine snapshot of the outlet\'s RSS feed — real headline; the link may have moved since'],
  sitemap: ['outlet sitemap', 'listed in the outlet\'s sitemap — the headline is rebuilt from the URL (≈) and the date can be approximate'],
  hn: ['Hacker News', 'linked from Hacker News — the submission title and time'],
};
// the morgue's modes: [label, what gets filed]
const MORGUE_MODES = {
  auto: ['AUTO', 'every article that appears in the live feeds is filed, plus anything opened in the reader or saved to a binder'],
  adhoc: ['AD-HOC', 'articles are filed when someone opens them in the reader or saves them to a binder'],
  manual: ['MANUAL', "only what's saved to a binder, or filed by hand (right-click → File in the morgue)"],
  fragment: ['FRAGMENT', 'like manual, but filed as fragments: headline and summary only — no pages are fetched'],
};
// what the morgue is (the DETAILS heading's tooltip)
const MORGUE_HELP = "Newsrooms call their archive of clippings “the morgue”. STRINGER keeps one: an article's text is fetched once, cleaned up for the reader and filed here under a morgue no. — so it stays readable and searchable (body:, author:, words:) after the page changes, goes behind a paywall or disappears. Articles are filed automatically as they appear in the feeds (the auto-filer), or when someone opens an unfiled one in the reader or saves it to a binder — who did is shown as “filed by”.";
const BODY_STATUS = { ok: 'in the morgue', partial: 'only a fragment filed (paywall or script-rendered page)', blocked: 'the site refused the request or the page is gone', failed: 'fetching the text failed',
  fragment: 'filed as a fragment — headline and summary only; reading it fetches the full text' };
let artOpen = null;          // { idx, a, data, err }

// After the reader loads an article it may have become STRINGER-archived (morgue no.) and, if its headline was rebuilt
// from the URL (≈), carry its real headline — reflect both in the results and any open popover.
function noteRead(link, r) {
  // the server marked it read when you opened it; the page waits a second, then flips it visibly (so an article
  // you just opened never looks as if you'd read it before)
  if (auth.me?.user && !state.readLinks?.has(link)) {
    setTimeout(() => {
      if (state.readLinks?.has(link)) return;
      mergeReads([link]);
      flashRead(link);
      rerenderReads();
      reader.refreshRead(link);
    }, READ_DELAY);
  }
  // the reader's DETAILS pane loaded while the article was still being fetched: refresh it (now read, maybe filed)
  const slot = document.getElementById('rd-info');
  if (slot?._data?.a?.link === link) { delete mountDetails.kept['rd-info']; delete slot.dataset.key; mountDetails('rd-info', slot._data.a); }
  if (!r?.morgue && !r?.retitled) return;
  let touched = false;
  for (const it of state.items) for (const a of it.articles || [it]) {
    if (a.link !== link) continue;
    if (r.morgue) state.fulltext[a.id] ??= { words: r.words || 0, morgue: r.morgue, saved: r.archived || Date.now(), partial: !r.ok };
    if (r.retitled) { a.title = r.retitled; a.approx = false; if (it.articles && it.link === link) it.title = r.retitled; }
    touched = true;
  }
  if (artOpen?.a.link === link) {
    if (r.morgue) state.fulltext[artOpen.a.id] ??= { words: r.words || 0, morgue: r.morgue, saved: r.archived || Date.now(), partial: !r.ok };
    if (r.retitled) { artOpen.a.title = r.retitled; artOpen.a.approx = false; if (artOpen.data?.article) Object.assign(artOpen.data.article, { title: r.retitled, approx: false, quality: 2 }); }
    if (artOpen.data?.body === null && r.morgue) artOpen.data.body = { status: r.ok ? 'ok' : 'partial', words: r.words, byline: r.byline, fetched: r.archived || Date.now(), morgue: r.morgue };
    renderArticleModal();
  }
  if (state.openStory) renderStoryModal();
  if (touched) renderFeed();
  if (r.retitled) log(`headline updated from the article page: “${esc(r.retitled)}”`, 'ok');
}

// Side-by-side columns (how each side framed it / related coverage) show their first COLS_SHOW articles each; the
// rest drop down with one button under the columns. Expanded stays expanded while the popover re-renders.
const COLS_SHOW = 10;
function colRows(list, row, open) {
  const head = list.slice(0, COLS_SHOW).map(row).join('');
  const rest = list.slice(COLS_SHOW);
  return head + (rest.length && open ? `<div class="sd-col-more">${rest.map(row).join('')}</div>` : '');
}
// isNew (optional): articles new since you last read the story — a ↻ tag by the button when some are hidden
function colsToggle(lists, open, what, isNew = null, isHit = null) {
  const more = lists.reduce((t, l) => t + Math.max(0, l.length - COLS_SHOW), 0);
  if (!more) return '';
  const total = lists.reduce((t, l) => t + l.length, 0);
  const hiddenNew = isNew && !open ? lists.reduce((t, l) => t + l.slice(COLS_SHOW).filter(isNew).length, 0) : 0;
  const hiddenHit = isHit && !open ? lists.reduce((t, l) => t + l.slice(COLS_SHOW).filter(isHit).length, 0) : 0;
  return `<div class="sd-cols-more"><button type="button" class="link sd-cols-toggle" data-act="cols-toggle" aria-expanded="${!!open}">${open ? `▴ show the first ${COLS_SHOW} per side` : `▾ show all ${total} ${what} (${more} more)`}</button>${hiddenNew ? ` <span class="new-tag" title="${hiddenNew} of the hidden articles ${hiddenNew === 1 ? 'is' : 'are'} new since you last read this story">↻ ${hiddenNew} new</span>` : ''}${hiddenHit ? ` <span class="body-hit" title="${hiddenHit} of the hidden articles matched your search in their text">⌕ ${hiddenHit}</span>` : ''}</div>`;
}

// ── the reader's DETAILS pane: everything about one article, and the stories it belongs to ──
const ORIGIN_NAME = { live: 'live feed', wayback: 'Wayback Machine feed snapshot', sitemap: 'outlet sitemap', hn: 'Hacker News' };
async function mountDetails(slotId, a) {
  const slot = document.getElementById(slotId);
  if (!slot || !a?.link) return;
  const key = `details:${a.link}`;
  const prev = mountDetails.kept?.[slotId];
  if (prev && prev.dataset.key === key) { slot.replaceWith(prev); return; }
  slot.dataset.key = key;
  (mountDetails.kept ??= {})[slotId] = slot;
  slot.innerHTML = '<div class="dim"><span class="spin">⟳</span> loading…</div>';
  let d;
  try { d = await api(`details?url=${encodeURIComponent(a.link)}`); } catch (e) { slot.innerHTML = `<div class="err small">✗ ${esc(e.message)}</div>`; return; }
  slot._data = { d, a };
  renderDetails(slot);
}
function renderDetails(slot) {
  const { d, a } = slot._data || {};
  if (!d) return;
  const s = srcById(a.sourceId || d.archived?.sourceId);
  const b = d.body, pub = a.date || d.archived?.published;
  const art = { ...a, link: d.link };
  const row = (k, v) => `<div class="dt-row"><span class="dt-k">${k}</span><span class="dt-v">${v}</span></div>`;
  const stories = d.stories || [];
  slot.innerHTML = `
    <div class="dt-sec"><h4>THE ARTICLE</h4>
      ${s ? row('outlet', `${chip(s.bias)} ${esc(s.name)} <span class="dim">· ${s.type === 'legacy' ? 'legacy' : 'new'} media</span>`) : ''}
      ${b?.byline ? row('byline', esc(b.byline)) : ''}
      ${pub ? row('published', `${esc(fmtTime(pub))} <span class="dim">· ${relAge(pub)}</span>`) : ''}
      ${auth.me?.user ? row('status', readBadge(art).trim() || '—') : ''}
      ${row('link', `<span class="dim dt-link" title="${esc(d.link)}">${esc(d.link.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}${d.link.length > 70 ? '…' : ''}</span>`)}
      ${d.archived ? row('indexed via', `${esc(ORIGIN_NAME[d.archived.origin] || d.archived.origin)}${d.archived.quality < 2 ? ' <span class="dim">· headline rebuilt from the URL</span>' : ''}`) : ''}
    </div>
    <div class="dt-sec"><h4><span class="dt-help" title="${esc(MORGUE_HELP)}" data-tip-head="THE MORGUE">THE MORGUE</span></h4>
      ${b?.morgue ? `${row('morgue no.', morgueBadge({ morgue: b.morgue, words: b.words, saved: b.fetched, partial: b.status === 'partial', fragment: b.status !== 'ok' && b.status !== 'partial' }))}
        ${row('words', `${(b.words || 0).toLocaleString()}${b.status === 'partial' ? ' <span class="warn">· fragment</span>' : ''}`)}
        ${b.fetched ? row('filed', esc(isoDay(b.fetched))) : ''}${row('filed by', b.filedBy ? esc(b.filedBy) : '<span class="dim">not recorded (filed before STRINGER tracked it)</span>')}`
        : `<div class="dim small">${b ? 'couldn\'t be filed — the site refused or the page is gone' : 'not in the morgue yet'}</div>`}
    </div>
    <div class="dt-sec"><h4>STORIES <span class="dim">· ${stories.length}</span></h4>
      <div class="dim small dt-note">An article belongs to one story at a time. As coverage regroups it can move; the stories it was part of before are kept here.</div>
      ${stories.length ? stories.map((st) => {
        const fresh = st.read != null && st.newest > st.read;
        return `<button type="button" class="dt-story${st.current ? ' current' : ''}" data-sid="${esc(st.sid)}" title="open story ${esc(st.sid)}">
          <span class="dt-story-h"><b>story ${esc(st.sid)}</b> ${st.current ? '<span class="dt-now">now</span>' : '<span class="dim">earlier</span>'}
            ${st.read == null ? (auth.me?.user ? '<span class="dim">○ unread</span>' : '') : fresh ? '<span class="dt-new">↻ new since</span>' : '<span class="dt-read">✓ read</span>'}</span>
          <span class="dt-story-t">${esc(st.title)}</span>
          <span class="dim small">${st.articles} article${st.articles === 1 ? '' : 's'} · ${st.sources} outlet${st.sources === 1 ? '' : 's'}${st.newest ? ` · updated ${agoText(st.newest)}` : ''}</span>
        </button>`;
      }).join('') : '<div class="dim small">not grouped into a story — stories are grouped for the live window (the last 14 days)</div>'}
    </div>
    ${d.comments ? `<div class="dt-sec"><h4>DISCUSSION</h4><div class="small">${d.comments.article} comment${d.comments.article === 1 ? '' : 's'} on this article · ${d.comments.story} on its story <button type="button" class="link" data-act="cm-toggle">[open ✎]</button></div></div>` : ''}`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('.info-slot .dt-story');
  if (b) {
    const slot = b.closest('.info-slot');
    const link = slot?._data?.d?.link;
    if (slot.closest('#dlg-reader')?.open) slot.closest('#dlg-reader').close();      // get the reader out of the way
    openStoryBySid(b.dataset.sid, link);
  }
  const t = e.target.closest('.info-slot [data-act=toggle-read]');
  if (t) { const slot = t.closest('.info-slot'); const { a } = slot._data; setRead(a, !isReadA(a)).then(() => renderDetails(slot)); }
});

async function openArticleAt(i) {
  const a = state.items[i];
  if (!a) return;
  state.sel = i;
  highlight();
  const my = (artOpen = { idx: i, a, data: null, err: null });
  activity.record('archive', `opened archived article: ${a.title || ''} — ${srcById(a.sourceId)?.name || ''}`, { link: a.link, title: a.title, sourceId: a.sourceId, date: a.date });
  log(`▣ opening archived article: ${esc((a.title || '').slice(0, 70))} <span class="dim">— ${esc(srcById(a.sourceId)?.name || '')}${state.fulltext?.[a.id]?.morgue ? ` · morgue no. ${esc(morgueShort(state.fulltext[a.id].morgue))}` : ''} · looking for related coverage…</span>`);
  renderArticleModal();
  if (!artDlg.open) artDlg.showModal();
  $('#article-body').focus({ preventScroll: true });
  artDlg.scrollTop = 0;
  try {
    my.data = await api(`article?id=${encodeURIComponent(a.id)}`); mergeReads(my.data.readLinks);
    log(`<span class="dim">✓ related coverage: ${my.data.matches ?? 0} headline${my.data.matches === 1 ? '' : 's'} from ${my.data.scanned?.toLocaleString() || 0} searched · ${my.data.ms ?? '?'} ms</span>`);
  } catch (e) { my.err = e.message; log(`related coverage failed: ${esc(e.message)}`, 'err'); }
  if (artOpen === my && artDlg.open) renderArticleModal();
}

function renderArticleModal() {
  const { a, idx, data, err } = artOpen;
  const s = srcById(a.sourceId);
  const d = data?.article || a;
  const [originName, originWhy] = ORIGIN[d.origin] || [d.origin || 'unknown', ''];
  const body = data?.body;
  const ft = state.fulltext?.[a.id];
  const words = body?.words || ft?.words || 0;
  const morgue = body?.morgue || ft?.morgue || '';
  const sn = state.snippets?.[a.id];
  const rel = data?.related || [];
  const relOutlets = new Set(rel.map((r) => r.sourceId)).size;
  // shown words for the matched stems (the tokenizer stems: "senat" → "Senate")
  const words0 = a.title.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const shown = (t) => words0.find((w) => w.toLowerCase().startsWith(t)) || t;
  const D = 864e5;
  // [query these]: the pair of words the related headlines most often share, over the same ±2 days
  const pairs = new Map();
  for (const r of rel) for (let x = 0; x < r.shared.length; x++) for (let y = x + 1; y < r.shared.length; y++) {
    const k = [r.shared[x], r.shared[y]].sort().join(' ');
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  const best = [...pairs].sort((p, q) => q[1] - p[1])[0];
  const searchQ = best && best[1] >= 2 ? `${best[0].split(' ').map((t) => `title:${t}*`).join(' ')} date:[${isoDay(a.date - 2 * D)} TO ${isoDay(a.date + 2 * D)}]` : '';
  const relRow = (r) => `<div class="sd-art${isReadA(r) ? ' is-read' : ''}" data-link="${esc(r.link)}">
      <div class="sd-art-meta">${srcLink(r)} <span class="dim">· ${fmtTime(r.date)}</span> ${readTick(r)}</div>
      <a href="${esc(safeUrl(r.link))}" target="_blank" rel="noopener noreferrer"${articleTip(r)}>${approxMark(r)}${esc(r.title)} <span class="ext">↗</span></a>
      <div class="dim small" title="headline words it shares with this article">shares: ${r.shared.map((t) => esc(shown(t).toLowerCase())).join(' · ')}</div>
    </div>`;
  const relLists = ['left', 'center', 'right'].map((side) => rel.filter((r) => srcById(r.sourceId) && sideOf(srcById(r.sourceId).bias) === side));
  const relOpen = !!artOpen.colsOpen;
  const cols = ['left', 'center', 'right'].map((side, k) => `<div class="sd-col ${side}"><div class="sd-col-head">${side.toUpperCase()} <span class="dim">${relLists[k].length}</span></div>
      ${colRows(relLists[k], relRow, relOpen) || '<div class="dim sd-none">&gt; nothing matched</div>'}</div>`).join('');

  $('#article-body').innerHTML = `
    <div class="sd-head">
      <span>// ARCHIVE ARTICLE <span class="dim">#${String(state.page * PAGE + idx + 1).padStart(2, '0')} of ${state.archive?.approx ? '~' : ''}${state.total.toLocaleString()}</span></span>
      <span class="sd-nav"><button class="link" data-act="prev" title="previous (k)">[◂ k]</button> <button class="link" data-act="next" title="next (j)">[j ▸]</button> <button class="link" data-act="close" title="close (esc)">[esc]</button></span>
    </div>
    <div class="pop-split ${cmCollapsed() ? 'collapsed' : ''}" data-pane="discussion">
    ${cmAside([['ON THIS ARTICLE', 'ad-cm']], { notes: 'ad-note' })}
    <div class="pop-main">
    <div class="sd-top">
      <div class="sd-top-main">
        <h2 class="sd-title">${approxMark(a)}${hl(a.title, 'title')}</h2>
        <div class="sd-picked">${srcLink(a)} · ${esc(fmtTime(a.date))} <span class="dim">(${relAge(a.date)})</span>${readBadge(a)}</div>
        <div class="sd-meta dim">indexed via <b class="ar-origin" title="${esc(originWhy)}">${esc(originName)}</b>${d.approx ? ' · headline rebuilt from the URL' : d.origin === 'sitemap' ? ' · headline from the article page' : ''}${ft || body?.morgue ? ` · ${ftBadge(a) || '<span class="ft">▣ MORGUE</span>'}` : ''}</div>
      </div>
      ${a.image ? `<img class="sd-img" src="${esc(safeUrl(a.image))}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''}
    </div>

    ${a.summary ? `<section><h3>▌SUMMARY</h3><div class="sd-sum-plain">${hl(a.summary, 'summary')}</div></section>` : ''}

    <section>
      <h3>▌THE MORGUE</h3>
      ${sn ? `<div class="summary snippet ad-snip"><span class="dim">matched ›</span> ${esc(sn.pre)}<mark>${esc(sn.hit)}</mark>${esc(sn.post)}</div>` : ''}
      <div class="ad-body">${words && (!body || body.status === 'ok' || body.status === 'partial')
        ? `${morgue ? morgueBadge({ morgue, words, saved: body?.fetched || ft?.saved, partial: body?.status === 'partial' || ft?.partial }, { big: true }) : '<span class="ft big">▣ MORGUE</span>'} <b>${words.toLocaleString()}</b> words${body?.byline ? ` · by ${esc(body.byline)}` : ''}${body?.fetched ? ` · saved ${esc(isoDay(body.fetched))}` : ''}${body?.status === 'partial' ? ' · <span class="warn">fragment only</span>' : ''} — <button type="button" class="link" data-act="read">[read it ⏎]</button>
          `
        : body ? `${body.morgue ? `${morgueBadge({ morgue: body.morgue, words: 0, saved: body.fetched, fragment: true }, { big: true })} ` : ''}<span class="dim">${esc(BODY_STATUS[body.status] || body.status)}</span> — <button type="button" class="link" data-act="read">[try the reader ⏎]</button>`
        : `<span class="dim">not in the morgue yet — reading it fetches the text (or the Wayback Machine copy if the page is gone or the site won't serve it) and files it in the morgue with a morgue no.${d.approx ? ', and replaces the rebuilt ≈ headline with the real one' : ''}.</span> <button type="button" class="link" data-act="read">[read it ⏎]</button>`}</div>
    </section>

    <section>
      <h3>▌OUTLET</h3>
      <div class="sd-stats">
        ${s ? `<span>${chip(s.bias)} <b>${esc(s.name)}</b> · ${esc(BIAS_NAME[s.bias].toLowerCase())} · ${s.type === 'legacy' ? 'legacy' : 'new'} media</span>
        <span>votes <b>${s.votes > 0 ? '+' : ''}${s.votes}</b> <span class="dim">×${s.weight}</span> ${voteBtns(s.id)}</span>` : ''}
        <span class="dim ad-link" title="${esc(a.link)}">${esc(a.link.replace(/^https?:\/\/(www\.)?/, '').slice(0, 90))}${a.link.length > 100 ? '…' : ''}</span>
      </div>
    </section>

    <section>
      <h3>▌RELATED COVERAGE <span class="dim">· ±2 days in the archive</span>
        ${searchQ ? `<span class="st-sp"></span><button type="button" class="link" data-act="search" data-q="${esc(searchQ)}" title="query // ${esc(searchQ)}">[query these ▸]</button>` : ''}</h3>
      ${err ? `<div class="err">✗ ${esc(err)}</div>`
        : !data ? '<div class="dim"><span class="spin">⟳</span> looking for related headlines…</div>'
        : rel.length ? `<div class="dim small ad-rel-note">${rel.length < data.matches ? `top ${rel.length} of ` : ''}${data.matches} headline${data.matches === 1 ? '' : 's'} from ${relOutlets} outlet${relOutlets === 1 ? '' : 's'} sharing its key words${data.tokens.length ? ` (${data.tokens.map((t) => esc(shown(t).toLowerCase())).join(', ')})` : ''} · searched ${data.scanned.toLocaleString()} articles in ${data.ms} ms</div>
          <div class="sd-cols">${cols}</div>
          ${colsToggle(relLists, relOpen, 'headlines')}`
        : `<div class="dim">no other archived headline from ±2 days shares enough of its words${data.scanned ? ` (searched ${data.scanned.toLocaleString()})` : ''}.</div>`}
    </section>

    </div></div>

    <div class="sd-foot">
      <span class="dim">⏎/o read article · u/d vote the outlet · m read/unread · j/k next/prev · c discussion · esc close</span>
      <span><button data-act="close">CLOSE</button> <a class="btn primary" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer" title="read it here (enter) — ctrl/middle-click for a new tab">OPEN ARTICLE ↗</a></span>
    </div>`;
  mountNote('ad-note', `article:${a.link}`, { kind: 'article', a });
  mountThread('ad-cm', `article:${a.link}`, { scope: 'article', link: a.link });
  placeCmTabs(); requestAnimationFrame(placeCmTabs);
}

function stepArticle(dir) {
  const i = artOpen.idx + dir;
  if (i >= 0 && i < state.items.length) openArticleAt(i);
}
artDlg.addEventListener('click', (e) => {
  if (e.target === artDlg) return artDlg.close();
  const link = e.target.closest('a[href]');
  if (link && artOpen && readLink(e, link, [artOpen.a, ...(artOpen.data?.related || [])])) return;
  const v = e.target.closest('[data-vote]');
  if (v) return vote(v.dataset.sid, Number(v.dataset.vote));
  const b = e.target.closest('[data-act]');
  const act = b?.dataset.act;
  if (act === 'cm-toggle') return toggleComments();
  if (act === 'cols-toggle') { artOpen.colsOpen = !artOpen.colsOpen; return renderArticleModal(); }
  if (act === 'toggle-read') return toggleRead(artOpen.a);
  if (act === 'close') artDlg.close();
  else if (act === 'next') stepArticle(1);
  else if (act === 'prev') stepArticle(-1);
  else if (act === 'read') reader.open(asArticle(artOpen.a));
  else if (act === 'search') { artDlg.close(); state.tabId = null; if (!setQuery(b.dataset.q)) log(`query → ${esc(b.dataset.q)}`); }
});
artDlg.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !artOpen) return;
  if (e.key === 'c') toggleComments();
  else if (e.key === 'j' || e.key === 'ArrowRight') stepArticle(1);
  else if (e.key === 'k' || e.key === 'ArrowLeft') stepArticle(-1);
  else if (e.key === 'o' || (e.key === 'Enter' && !e.target.closest('a, button, input, textarea'))) reader.open(asArticle(artOpen.a));
  else if (e.key === 'u' || e.key === 'd') vote(artOpen.a.sourceId, e.key === 'u' ? 1 : -1);
  else if (e.key === 'm') toggleRead(artOpen.a);
  else return;
  e.preventDefault();
});
artDlg.addEventListener('close', () => { artOpen = null; });

// open a story by its number (from an article's DETAILS), focused on that article
async function openStoryBySid(sid, link) {
  let st;
  try { st = await api(`story?sid=${encodeURIComponent(sid)}&bmin=${state.bmin}`); }
  catch (e) { return log(e.data?.error === 'story not found' ? `story ${esc(sid)} isn't in the live window any more (stories are grouped for the last 14 days)` : `couldn't open story ${esc(sid)}: ${esc(e.message)}`, 'warn'); }
  Object.assign(state.fulltext, st.fulltext || {}); mergeReads(st.readLinks);
  const focus = st.articles.find((a) => a.link === link);
  state.openStory = { st, focusId: focus?.id || null, idx: 0, from: 'sid' };
  logOpenStory(st, 'from the article details');
  markStoryReadSoon(st);
  renderStoryModal();
  if (!storyDlg.open) storyDlg.showModal();
  $('#story-body').focus({ preventScroll: true });
  storyDlg.scrollTop = 0;
}

function stepStory(d) {
  if (state.openStory.from === 'sid') return;
  const i = state.openStory.idx + d;
  if (state.openStory.from === 'ticker') { if (i >= 0 && i < tickerItems.length) openTickerStory(i); return; }
  if (i >= 0 && i < state.items.length) openStoryAt(i);
}

storyDlg.addEventListener('click', (e) => {
  if (e.target === storyDlg) return storyDlg.close();            // backdrop click
  const link = e.target.closest('a[href]');
  if (link && state.openStory) {
    const known = [...state.openStory.st.articles, state.openStory.head];
    if (readLink(e, link, known)) return;
  }
  const v = e.target.closest('[data-vote]');
  if (v) return vote(v.dataset.sid, Number(v.dataset.vote));
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'cm-toggle') return toggleComments();
  if (act === 'cols-toggle') { state.openStory.colsOpen = !state.openStory.colsOpen; return renderStoryModal(); }
  if (act === 'toggle-read') { const l = e.target.closest('[data-act]').dataset.link; const x = state.openStory.st.articles.find((z) => z.link === l); if (x) toggleRead(x); return; }
  if (act === 'toggle-story-read') return toggleRead(state.openStory.st);
  if (act === 'close') storyDlg.close();
  else if (act === 'next') stepStory(1);
  else if (act === 'prev') stepStory(-1);
});
storyDlg.addEventListener('close', () => { state.openStory = null; });
storyDlg.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const st = state.openStory?.st;
  if (!st) return;
  if (e.key === 'c') toggleComments();
  else if (e.key === 'j' || e.key === 'ArrowRight') stepStory(1);
  else if (e.key === 'k' || e.key === 'ArrowLeft') stepStory(-1);
  else if (e.key === 'o') reader.open(asArticle(state.openStory.head));
  // Enter = the OPEN (LEAD) ARTICLE button — unless focus is on another link/button, which Enter activates
  else if (e.key === 'Enter' && !e.target.closest('a, button, input, textarea')) reader.open(asArticle(state.openStory.head));
  else if (e.key === 'u' || e.key === 'd') vote(state.openStory.head.sourceId, e.key === 'u' ? 1 : -1);
  else if (e.key === 'm') toggleRead(st);                          // the story (article badges are clickable)
  else return;
  e.preventDefault();
});

function highlight(scroll = true) {
  $$('.story.sel').forEach((el) => el.classList.remove('sel'));
  const el = $(`.story[data-i="${state.sel}"]`);
  if (!el) return;
  el.classList.add('sel');
  if (scroll) el.scrollIntoView({ block: 'nearest' });
}

// ───────────────────────── toolbar ─────────────────────────
function syncToolbar() {
  $$('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  syncFilterButtons();
  syncWindowButtons();
  if (state.mode === 'stream' && state.sort === 'coverage') state.sort = 'top';
  syncModeAvailability();
  document.body.classList.toggle('no-img', !state.img);
  document.body.classList.toggle('no-crt', !state.crt);
  $('#ticker').hidden = !state.ticker;
  document.documentElement.dataset.theme = state.theme;
  persist();
}
// archive results are articles only: STORIES/BLINDSPOT and the TOP/COVERAGE sorts don't apply there.
// state.mode/sort keep the user's choice, so going back to the live feeds restores it.
function syncModeAvailability() {
  const arch = state.inArchive;
  const sort = arch && state.sort !== 'oldest' ? 'latest' : state.sort;
  $$('#mode button[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === viewMode()));
  $$('#sort button').forEach((b) => b.classList.toggle('on', b.dataset.sort === sort));
  document.body.classList.toggle('archive-view', arch);
  document.body.classList.toggle('mode-stream', viewMode() === 'stream');
}
const update = () => { syncToolbar(); state.sel = -1; loadNews(); };  // loadNews also refreshes tab counts

$('.toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (state.inArchive && (b.dataset.mode === 'stories' || b.dataset.blind || ['top', 'coverage'].includes(b.dataset.sort))) {
    return log(b.dataset.sort ? 'archive results are listed by date — sort LATEST or OLDEST' : ARCHIVE_NO_STORIES, 'err');
  }
  if (b.dataset.mode) state.mode = b.dataset.mode;
  else if (b.dataset.bias !== undefined) return toggleBias(Number(b.dataset.bias), e.shiftKey || e.altKey);
  else if (b.dataset.type) return setMedia(b.dataset.type);
  else if (b.dataset.blind) return toggleBlindspot();
  else if (b.dataset.win) return setWindow(b.dataset.win);
  else if (b.dataset.sort) state.sort = b.dataset.sort;
  else return;
  update();
});

// ───────────────────────── query box ─────────────────────────
const qInput = $('#q');
const qHL = $('#q-hl');
const qStatus = $('#q-status');

function queryError(v) {
  try { parseQuery(v); return null; }
  catch (e) {
    // errors at the very end of the input are usually just "still typing" — don't shout about them
    const end = v.trimEnd().length;
    e.incomplete = e.pos + Math.max(1, e.len || 1) >= end && !/unknown field|expects|bad regex|not supported|unexpected \)/.test(e.message);
    return e;
  }
}

function tokClass(t, prev) {
  if (t.t === 'FIELD') return 'h-field';
  if (t.t === 'AND' || t.t === 'OR' || t.t === 'NOT' || t.t === '+') return 'h-op';
  if (t.t === '(' || t.t === ')') return 'h-paren';
  if (t.t === 'PHRASE') return 'h-str';
  if (t.t === 'REGEX') return 'h-re';
  if (t.t === 'RANGE') return 'h-range';
  if (/^[<>]/.test(t.v)) return 'h-cmp';
  if (/[*?]|~\d?$/.test(t.v)) return 'h-wild';
  if (prev && prev.t === 'FIELD' && prev.e === t.s) return 'h-val';
  return 'h-term';
}

function highlightHTML(v, err) {
  const toks = lex(v);
  let html = '', pos = 0, prev = null;
  const errFrom = err ? err.pos : -1, errTo = err ? err.pos + Math.max(1, err.len || 1) : -1;
  for (const t of toks) {
    html += esc(v.slice(pos, t.s));
    const bad = err && t.s < errTo && t.e > errFrom;
    html += `<span class="${tokClass(t, prev)}${bad ? ' h-err' : ''}">${esc(v.slice(t.s, t.e))}</span>`;
    pos = t.e; prev = t;
  }
  return html + esc(v.slice(pos));
}

function renderQueryHL(err) {
  const v = qInput.value;
  const toks = lex(v);
  let html = '', pos = 0, prev = null;
  const errFrom = err ? err.pos : -1, errTo = err ? err.pos + Math.max(1, err.len || 1) : -1;
  for (const t of toks) {
    html += esc(v.slice(pos, t.s));
    const bad = err && t.s < errTo && t.e > errFrom;
    html += `<span class="${tokClass(t, prev)}${bad ? (err.incomplete ? ' h-wip' : ' h-err') : ''}">${esc(v.slice(t.s, t.e))}</span>`;
    pos = t.e; prev = t;
  }
  html += esc(v.slice(pos));
  if (err && !err.incomplete && errFrom >= v.length) html += '<span class="h-err h-eol"> </span>';
  qHL.innerHTML = html + ' ';
  qHL.scrollLeft = qInput.scrollLeft;
  syncFilterButtons();
}

function setQueryStatus(err) {
  qStatus.classList.toggle('bad', !!err && !err.incomplete);
  qStatus.classList.toggle('wip', !!err && !!err.incomplete);
  // the full message is on the first line of the dropdown; beside the input just a short marker
  if (err) { qStatus.textContent = err.incomplete ? '… incomplete' : '✗ invalid'; qStatus.title = err.message; }
  else if (state.q) { qStatus.textContent = `✓ ${state.archive?.approx ? '~' : ''}${state.total.toLocaleString()} hit${state.total === 1 ? '' : 's'}`; qStatus.title = ''; }
  else { qStatus.textContent = ''; qStatus.title = ''; }
}

// The query bar, the advanced editor and the query builder always show the same query: an edit in any of them
// updates the other two (it still runs only on Enter / APPLY / RUN). Each registers a setter here.
// The builder and the editor also share tabs: CURRENT (that mirrored query) and drafts — queries being built for
// later, edited in either place without touching the query bar until they're run. Drafts live in this browser.
const queryMirrors = {};
let mirroring = false;
const qDrafts = { list: store.get('qDrafts', []), active: store.get('qDraftActive', 'current') };
if (qDrafts.active !== 'current' && !qDrafts.list.some((d) => d.id === qDrafts.active)) qDrafts.active = 'current';
const activeDraft = () => qDrafts.list.find((d) => d.id === qDrafts.active) || null;
const activeQueryText = () => activeDraft()?.text ?? qInput.value;
const saveDrafts = () => { store.set('qDrafts', qDrafts.list); store.set('qDraftActive', qDrafts.active); };
function mirrorQuery(from, v) {
  if (mirroring) return;
  mirroring = true;
  try {
    const one = String(v ?? '').replace(/\s*\n\s*/g, ' ');
    const d = activeDraft();
    if (d) {
      // a draft tab is open: the query bar keeps its own query; builder ⇄ editor stay in step on the draft
      if (from === 'main') return;
      d.text = v; d.at = Date.now(); saveDrafts();
      for (const [k, set] of Object.entries(queryMirrors)) if (k !== from) set(v);
      renderQTabs();
      return;
    }
    if (from !== 'main' && qInput.value !== one) { qInput.value = one; applyQuery(false); }
    for (const [k, set] of Object.entries(queryMirrors)) if (k !== from) set(from === 'main' ? one : v);
  } finally { mirroring = false; }
}
function renderQTabs() {
  const label = (d, i) => { const t = (d.text || '').replace(/\s+/g, ' ').trim(); return t ? (t.length > 18 ? t.slice(0, 17) + '…' : t) : `draft ${i + 1}`; };
  const html = `<button type="button" class="qtab${qDrafts.active === 'current' ? ' on' : ''}" data-qtab="current" title="the current query — the same as the query bar">● CURRENT</button>`
    + qDrafts.list.map((d, i) => `<span class="qtab-w"><button type="button" class="qtab${qDrafts.active === d.id ? ' on' : ''}" data-qtab="${esc(d.id)}" title="${esc(d.text ? `draft: ${d.text}` : 'an empty draft')} — run it to make it the current query">${esc(label(d, i))}</button><button type="button" class="qtab-x" data-qtab-close="${esc(d.id)}" title="close this draft">×</button></span>`).join('')
    + (qDrafts.list.length < 9 ? '<button type="button" class="qtab qtab-add" data-qtab-add title="a new draft query, for later">＋</button>' : '');
  for (const el of document.querySelectorAll('[data-qtabs]')) el.innerHTML = html;
}
function setQTab(id) {
  qDrafts.active = id === 'current' || qDrafts.list.some((d) => d.id === id) ? id : 'current';
  saveDrafts();
  renderQTabs();
  const text = activeQueryText();
  mirroring = true;
  try { for (const set of Object.values(queryMirrors)) set(text); } finally { mirroring = false; }
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-qtab]');
  if (t) return setQTab(t.dataset.qtab);
  if (e.target.closest('[data-qtab-add]')) {
    const d = { id: Math.random().toString(36).slice(2, 8), text: '', at: Date.now() };
    qDrafts.list.push(d);
    setQTab(d.id);
    return document.querySelector('dialog[open] .qb-q, dialog[open] #ae-input, .qb.open .qb-q')?.focus();
  }
  const x = e.target.closest('[data-qtab-close]');
  if (x) {
    const d = qDrafts.list.find((z) => z.id === x.dataset.qtabClose);
    if (d?.text?.trim() && !confirm(`close the draft “${d.text.slice(0, 60)}”?`)) return;
    qDrafts.list = qDrafts.list.filter((z) => z.id !== x.dataset.qtabClose);
    setQTab(qDrafts.active === x.dataset.qtabClose ? 'current' : qDrafts.active);
  }
});

// Typing only validates/highlights; the search runs on Enter (or when a button/tab/command sets the query).
function applyQuery(run = false) {
  const v = qInput.value;
  mirrorQuery('main', v);
  const err = queryError(v);
  renderQueryHL(err);
  setQueryStatus(err);
  if (err) return err;
  if (run) { if (state.q !== v.trim()) { state.q = v.trim(); state.sel = -1; loadNews(); renderSources(); if (state.q) activity.record('query', `ran a query: ${state.q}`, { q: state.q }); } }
  else if (v.trim() !== state.q) { qStatus.textContent = '⏎ search'; qStatus.title = 'press Enter to run this query'; }
  return null;
}
function setQuery(v) { qInput.value = v; return applyQuery(true); }

// time-window buttons are shortcuts that set/replace the query's top-level time clause;
// clicking the active one removes it. The highlighted button is read back from the query text.
function setWindow(w) {
  const cur = windowOf(qInput.value);
  qInput.value = setTimeClause(qInput.value, w && cur !== w ? WINDOW_CLAUSES[w] : null);
  applyQuery(true);
}
// all quick-filter buttons are shortcuts that edit the query; their state is read back from it
function editClause(field, clause) {
  state.tabId = null;
  qInput.value = setFieldClause(qInput.value, new Set([field]), clause);
  applyQuery(true);
}
function toggleBias(v, solo) {
  const cur = biasOf(qInput.value);
  let next;
  if (solo) next = cur.size === 1 && cur.has(v) ? new Set([-2, -1, 0, 1, 2]) : new Set([v]);
  else { next = new Set(cur); if (next.has(v)) { if (next.size > 1) next.delete(v); } else next.add(v); }
  editClause('bias', biasClause(next));
}
const setMedia = (t) => editClause('type', t === 'all' ? null : `type:${t}`);
const toggleBlindspot = () => editClause('blindspot', hasClause(qInput.value, 'blindspot') ? null : 'blindspot:any');
function syncFilterButtons() {
  const v = qInput.value;
  const biases = biasOf(v);
  $$('#bias button').forEach((b) => b.classList.toggle('on', biases.has(Number(b.dataset.bias))));
  const t = typeOf(v);
  $$('#type button').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
  $$('#mode [data-blind]').forEach((b) => b.classList.toggle('on', hasClause(v, 'blindspot')));
  syncWindowButtons();
}
function syncWindowButtons() {
  const w = windowOf(qInput.value);
  $$('#hours button').forEach((b) => b.classList.toggle('on', b.dataset.win === w));
  const lbl = $('#win-label');
  lbl.textContent = w === 'custom' ? 'window: custom' : w ? 'window:' : 'window: 14d default';
  lbl.title = w === 'custom' ? 'the query has its own time clause'
    : w ? '' : 'no time clause in the query: the live feeds (last 14 days) are searched. Pick a window or "all" to change it.';
}

// all three query boxes (bar, advanced editor, builder): a lowercase or/and that's an operator becomes OR/AND as you
// type past it — before their own input handlers run (capture), with the caret kept where it was
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.matches?.('#q, #ae-input, .qb-q')) return;
  const fixed = capitalizeOps(el.value);
  if (fixed === el.value) return;
  const a = el.selectionStart, b = el.selectionEnd;
  el.value = fixed;
  el.setSelectionRange(a, b);
}, true);
qInput.addEventListener('input', () => applyQuery());
qInput.addEventListener('scroll', () => { qHL.scrollLeft = qInput.scrollLeft; });
qInput.addEventListener('keyup', () => { qHL.scrollLeft = qInput.scrollLeft; });
// Enter runs the query and hands the keyboard back to the results (j/k or ↑/↓ to move)
qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!applyQuery(true)) qInput.blur(); } });
$('#qbox').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget || e.target.classList.contains('prompt')) { e.preventDefault(); qInput.focus(); } });
$('#q-help').addEventListener('click', () => { $('#cmd').focus(); runCommand('help query'); });

// ───────────────────────── autocomplete (query box + terminal) ─────────────────────────
// notice(): an optional line shown first in the dropdown (the query bar's parse errors), even with no suggestions
function attachAutocomplete(input, provider, { above = false, position = null, notice = null } = {}) {
  const box = document.createElement('div');
  box.className = 'ac' + (above ? ' above' : '');
  box.hidden = true;
  input.closest('.ac-host').appendChild(box);
  let res = null, idx = -1, note = null;
  const hide = () => { box.hidden = true; res = null; idx = -1; };
  const render = () => {
    box.innerHTML = (note ? `<div class="ac-note ${note.cls || ''}">${note.html}</div>` : '') + res.items.map((it, k) => `<div class="ac-item k-${it.kind || 'value'}${k === idx ? ' on' : ''}" data-k="${k}">
        <span class="ac-chip">${it.bias != null ? chip(it.bias) : ''}</span><span class="ac-label">${esc(it.label)}</span><span class="ac-hint">${esc(it.hint || '')}</span></div>`).join('')
      + (res.items.length ? `<div class="ac-foot">↑↓ select · tab accept · esc close</div>` : '');
    box.hidden = false;
    if (position) position(box);
    box.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const update = (force = false) => {
    if (document.activeElement !== input) return hide();
    let r = provider(input.value, input.selectionStart ?? input.value.length, force);
    note = notice?.() || null;
    if (r?.items.length === 1 && input.value.slice(r.from, r.to) === r.items[0].insert.trim()) r = { ...r, items: [] };
    if (!r?.items.length && !note) return hide();
    res = r?.items ? r : { items: [], from: 0, to: 0 }; idx = -1; render();
  };
  const accept = (k) => {
    const it = res.items[k];
    const v = input.value;
    const after = v.slice(res.to);
    let ins = it.insert;
    if (!it.keepOpen && !/^[\s)]/.test(after)) ins += ' ';
    input.value = v.slice(0, res.from) + ins + after;
    const caret = res.from + ins.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  input.addEventListener('input', () => update());
  input.addEventListener('focus', () => update());
  input.addEventListener('click', () => update());
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { hide(); return; }   // ⌃⏎ always submits, even over a suggestion
    if (box.hidden || !res.items.length) {
      if (!box.hidden && (e.key === 'Escape' || e.key === 'Enter')) hide();        // the error line alone
      if (e.key === 'Tab' && !e.shiftKey) {
        update(true);
        if (!box.hidden) { stop(e); if (res.items.length === 1) accept(0); }
      }
      return;
    }
    const n = res.items.length;
    if (e.key === 'ArrowDown') { idx = (idx + 1) % n; render(); stop(e); }
    else if (e.key === 'ArrowUp') { idx = idx <= 0 ? n - 1 : idx - 1; render(); stop(e); }
    else if (e.key === 'Tab') { accept(idx < 0 ? 0 : idx); stop(e); }
    else if (e.key === 'Enter' && idx >= 0) { accept(idx); stop(e); }
    else if (e.key === 'Escape') { hide(); stop(e); }
    else if (e.key === 'Enter') hide();
  }, true);
  box.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const el = e.target.closest('.ac-item');
    if (el) accept(Number(el.dataset.k));
  });
  return { update, hide };
}

const acCtx = () => ({ sources: state.sources });
// a top-level OR with an AND (or implicit AND) on one side: show how it groups, from the parsed query
function groupingHint(v) {
  let ast;
  try { ast = parseQuery(v); } catch { return null; }
  if (ast?.type !== 'or' || !ast.items.some((i) => i.type === 'and')) return null;
  const span = (n) => (n.type === 'term' ? [n.s, n.e] : (n.items || [n.item]).map(span).reduce((a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1])]));
  // term positions cover the value only: widen back over its field:, -/! and opening parens, then balance parens
  const text = (n) => {
    let [s0, e0] = span(n);
    while (s0 > 0 && /[\p{L}\p{N}_:!(-]/u.test(v[s0 - 1])) s0--;
    if (n.type === 'not' && /NOT\s+$/i.test(v.slice(0, s0))) s0 = v.slice(0, s0).search(/NOT\s+$/i);
    let t = v.slice(s0, e0);
    const depth = () => [...t].reduce((d, c) => d + (c === '(') - (c === ')'), 0);
    while (depth() > 0 && v[e0] === ')') t += v[e0++];
    while (depth() > 0 && t.startsWith('(')) t = t.slice(1);
    t = t.trim();
    return n.type === 'and' && !/^\(.*\)$/.test(t) ? `(${t})` : t;
  };
  try { return ast.items.map(text).join(' OR '); } catch { return null; }
}
const qAc = attachAutocomplete(qInput, (v, caret) => {
  const r = suggest(v, caret, acCtx());
  if (!v.trim() && state.saved.length) {
    const saved = state.saved.map((sq) => ({ label: `★ ${sq.name}`, insert: sq.query, hint: sq.query, kind: 'saved', keepOpen: true }));
    r.items = [...saved, ...r.items];
  }
  return r;
}, {
  // parse errors go on the dropdown's first line (wrapped), not beside the input where a long one bumps the layout
  notice: () => {
    const err = queryError(qInput.value);
    if (err) return { cls: err.incomplete ? 'wip' : 'bad', html: `${err.incomplete ? '…' : '✗'} ${esc(err.message)}` };
    const g = groupingHint(qInput.value);
    return g ? { cls: 'hint', html: `ⓘ AND binds tighter than OR — this reads as <b>${esc(g)}</b> · add parentheses to group it differently` } : null;
  },
});
qInput.addEventListener('input', () => setTimeout(() => qAc.update(), 0));      // refresh the error line after validation

// ───────────────────────── saved queries / tabs ─────────────────────────
const tabsEl = $('#tabs');

function activeTab() {
  const byId = state.saved.find((x) => x.id === state.tabId);
  if (byId && byId.query.trim() === state.q) return byId;
  return state.q ? state.saved.find((x) => x.pinned && x.query.trim() === state.q) || null : null;
}

async function loadSaved() {
  try { state.saved = await api('queries'); } catch (e) { log(`saved queries: ${esc(e.message)}`, 'err'); }
  renderTabs();
  loadCountsSoon(0);
}

function renderTabs() {
  const act = activeTab();
  const pinned = state.saved.filter((x) => x.pinned);
  const unpinned = state.saved.filter((x) => !x.pinned);
  const cnt = (id) => (state.counts[id] == null ? '' : `<span class="cnt">${state.counts[id]}</span>`);
  tabsEl.innerHTML =
    `<button class="tab ${!state.q ? 'on' : ''}" data-tab="" title="no query  ( [ / ] cycle tabs )">ALL</button>` +
    pinned.map((x, k) => `<button class="tab ${act?.id === x.id ? 'on' : ''}" data-tab="${esc(x.id)}" draggable="true"
        title="${esc(x.query)}${x.view ? `  ·  view: ${x.view.mode}/${x.view.sort}` : ''}${k < 9 ? `  ·  alt+${k + 1}` : ''}  ·  right-click to edit">${x.view ? '<span class="tab-v">◧</span>' : ''}${esc(x.name)}${cnt(x.id)}<span class="tab-edit" data-act="edit" title="edit">⋯</span></button>`).join('') +
    `<button class="tab tab-add needs-perm-queries-save" data-act="save" title="save the current query (s)">+ save query</button>` +
    (unpinned.length ? `<div class="tab-more"><button class="tab" data-act="more">saved (${unpinned.length}) ▾</button>
      <div class="tab-menu" hidden>${unpinned.map((x) => `<div class="tm-item" data-tab="${esc(x.id)}" title="${esc(x.query)}">
        <span class="tm-name">${esc(x.name)}${cnt(x.id)}</span><span class="tm-q">${esc(x.query)}</span>
        <button class="link" data-act="pin" title="pin as tab">[pin]</button><button class="link" data-act="edit">[edit]</button></div>`).join('')}</div></div>` : '');
}

function applySaved(sq) {
  state.tabId = sq?.id || null;
  if (sq?.view) { state.mode = sq.view.mode === 'stream' ? 'stream' : 'stories'; state.sort = sq.view.sort; syncToolbar(); }
  qInput.value = sq ? sq.query : '';
  const err = applyQuery(true);
  if (!err) { state.sel = -1; loadNews(); }
  renderTabs();
}

function cycleTab(d) {
  const order = [null, ...state.saved.filter((x) => x.pinned)];
  const cur = Math.max(0, order.indexOf(activeTab() || null));
  applySaved(order[(cur + d + order.length) % order.length]);
}

let countsTimer;
function loadCountsSoon(ms = 500) {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(async () => {
    if (!state.saved.length) return;
    try {
      state.counts = await api('counts', { method: 'POST', body: { params: {
        mode: state.mode, bmin: state.bmin,
      } } });
      renderTabs();
    } catch {}
  }, ms);
}

async function setPinned(sq, pinned) {
  Object.assign(sq, await api(`queries/${sq.id}`, { method: 'PATCH', body: { pinned } }));
  log(`${pinned ? 'pinned' : 'unpinned'} “${esc(sq.name)}”`);
  renderTabs();
}

tabsEl.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const tabEl = e.target.closest('[data-tab]');
  const sq = tabEl && state.saved.find((x) => x.id === tabEl.dataset.tab);
  if (act === 'save') return openQueryDialog();
  if (act === 'more') { const m = $('.tab-menu', tabsEl); m.hidden = !m.hidden; return; }
  if (act === 'edit' && sq) return openQueryDialog(sq);
  if (act === 'pin' && sq) return setPinned(sq, true);
  if (tabEl) applySaved(sq || null);
});
tabsEl.addEventListener('contextmenu', (e) => {
  const sq = state.saved.find((x) => x.id === e.target.closest('[data-tab]')?.dataset.tab);
  if (sq) { e.preventDefault(); openQueryDialog(sq); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.tab-more')) { const m = $('.tab-menu', tabsEl); if (m) m.hidden = true; } });

// drag to reorder pinned tabs
let dragId = null;
tabsEl.addEventListener('dragstart', (e) => {
  dragId = e.target.closest('[data-tab]')?.dataset.tab || null;
  if (dragId) { e.dataTransfer.effectAllowed = 'move'; e.target.classList.add('dragging'); }
});
tabsEl.addEventListener('dragend', () => { dragId = null; $$('.tab', tabsEl).forEach((t) => t.classList.remove('dragging', 'drop-before', 'drop-after')); });
tabsEl.addEventListener('dragover', (e) => {
  const t = e.target.closest('[data-tab][draggable]');
  if (!dragId || !t) return;
  e.preventDefault();
  const r = t.getBoundingClientRect();
  $$('.tab', tabsEl).forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  t.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
});
tabsEl.addEventListener('drop', async (e) => {
  const t = e.target.closest('[data-tab][draggable]');
  if (!dragId || !t || t.dataset.tab === dragId) return;
  e.preventDefault();
  const ids = state.saved.map((x) => x.id).filter((x) => x !== dragId);
  const before = t.classList.contains('drop-before');
  ids.splice(ids.indexOf(t.dataset.tab) + (before ? 0 : 1), 0, dragId);
  state.saved = await api('queries/order', { method: 'POST', body: { ids } });
  renderTabs();
});

// save / edit dialog
const qDlg = $('#dlg-query');
const qForm = $('#form-query');
let qEditing = null;
const viewDesc = () => `(${state.mode} · ${state.sort})`;

function checkDialogQuery() {
  const v = $('#dq-query').value;
  const el = $('#dq-check');
  if (!v.trim()) { el.textContent = ''; return false; }
  try { parseQuery(v); el.className = 'dq-check ok'; el.textContent = '✓ valid query'; return true; }
  catch (e) { el.className = 'dq-check bad'; el.textContent = `✗ ${e.message}`; return false; }
}

function openQueryDialog(sq = null) {
  if (!auth.can('queries.save')) return auth.me?.user ? log('your role cannot save queries', 'warn') : auth.openLogin('sign in to save queries as your own tabs');
  qEditing = sq;
  qForm.reset();
  qForm.classList.toggle('editing', !!sq);
  $('#dq-title').textContent = sq ? `// EDIT SAVED QUERY` : '// SAVE QUERY';
  $('#dq-query').value = sq ? sq.query : qInput.value.trim();
  $('#dq-name').value = sq ? sq.name : '';
  $('#dq-pinned').checked = sq ? sq.pinned : true;
  $('#dq-view').checked = !!sq?.view;
  $('#dq-highlight').checked = sq ? sq.highlight !== false : true;
  $('#dq-view-desc').textContent = sq?.view ? `(${sq.view.mode} · ${sq.view.sort} → now ${viewDesc().slice(1)}` : viewDesc();
  $('#dq-error').hidden = true;
  checkDialogQuery();
  qDlg.showModal();
  ($('#dq-query').value ? $('#dq-name') : $('#dq-query')).focus();
}
$('#dq-query').addEventListener('input', checkDialogQuery);

qForm.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  if (!checkDialogQuery()) { $('#dq-error').hidden = false; $('#dq-error').textContent = '! fix the query first'; return; }
  const body = {
    name: $('#dq-name').value, query: $('#dq-query').value, pinned: $('#dq-pinned').checked,
    view: $('#dq-view').checked ? { mode: state.mode, sort: state.sort } : null,
    highlight: $('#dq-highlight').checked,
  };
  try {
    const sq = qEditing
      ? await api(`queries/${qEditing.id}`, { method: 'PATCH', body })
      : await api('queries', { method: 'POST', body });
    if (qEditing) Object.assign(qEditing, sq); else state.saved.push(sq);
    log(`${qEditing ? 'updated' : '★ saved'} “${esc(sq.name)}” → ${esc(sq.query)}${sq.pinned ? ' [tab]' : ''}`, 'ok');
    qDlg.close();
    applySaved(sq);
  } catch (err) { $('#dq-error').hidden = false; $('#dq-error').textContent = '! ' + err.message; }
});
$('#dq-delete').addEventListener('click', async () => {
  const sq = qEditing;
  if (!sq || !confirm(`Delete saved query “${sq.name}”?`)) return;
  await api(`queries/${sq.id}`, { method: 'DELETE' });
  state.saved = state.saved.filter((x) => x !== sq);
  if (state.tabId === sq.id) state.tabId = null;
  log(`deleted saved query “${esc(sq.name)}”`, 'warn');
  qDlg.close();
  renderTabs();
});
$('#q-save').addEventListener('click', () => openQueryDialog());

function findSaved(arg) {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  const pinned = state.saved.filter((x) => x.pinned);
  if (/^\d+$/.test(a)) return pinned[Number(a) - 1] || null;
  return state.saved.find((x) => x.id === a || x.name.toLowerCase() === a)
    || state.saved.find((x) => x.name.toLowerCase().startsWith(a))
    || state.saved.find((x) => x.name.toLowerCase().includes(a));
}

// ───────────────────────── headline ticker ─────────────────────────
// The day's top live stories scrolling between // marks (independent of the current query). Hover pauses;
// click opens the story popover (like a STREAM headline), ctrl/⌘/middle-click a new tab.
let tickerItems = [], tickerSig = '';
// the story details tooltip for a ticker headline (with the yellow alert when coverage arrived since you read it)
function tickerTip(st) {
  const s = srcById(st.leadSource), n = st.articles?.length || 1;
  const at = storyReadAt(st), fresh = storyNewCount(st);
  const lead = st.articles?.find((a) => a.link === st.link);
  const sum = st.summary ? (st.summary.length > 220 ? st.summary.slice(0, 220).trimEnd() + '…' : st.summary) : ' ';
  return {
    title: sum,
    'data-tip-alert': fresh ? `↻ new coverage: ${fresh} article${fresh === 1 ? '' : 's'} since you read this story (${agoText(at)})` : '',
    'data-tip-head': `${st.sid ? `STORY ${st.sid} · ` : ''}${st.sourceCount} outlet${st.sourceCount === 1 ? '' : 's'} · ${n} article${n === 1 ? '' : 's'}`,
    'data-tip-title': `“${st.title}”`,
    'data-tip-sub': [`lead: ${s?.name || ''}${lead ? ` · published ${agoText(lead.date)}` : ''} · updated ${agoText(st.newest)}`,
      auth.me?.user ? (at == null ? '○ not read yet' : fresh ? `↻ read ${agoText(at)} — new coverage since` : `⟦ok|✓ you've read this story⟧ (${agoText(at)})`) : ''].filter(Boolean).join('\n'),
    'data-tip-foot': 'click to open the story · ctrl/middle-click: the lead article in a new tab',
  };
}
const attrs = (o) => Object.entries(o).map(([k, v]) => (v ? ` ${k}="${esc(v)}"` : '')).join('');

async function loadTicker() {
  if (!state.ticker) return;
  try {
    const r = await api('news?' + new URLSearchParams({ mode: 'stories', sort: 'top', limit: '30', q: 'age:<24h', lite: '1' }));
    mergeReads(r.readLinks);
    Object.assign((state.storyReads ??= {}), r.storyReads || {});
    const items = r.items.filter((st) => srcById(st.leadSource));
    const sig = items.map((st) => st.id).join(',');
    if (!items.length || sig === tickerSig) return;
    tickerSig = sig; tickerItems = items;
    const one = items.map((st, i) => {
      const s = srcById(st.leadSource);
      return `<a class="tk-item${storyRead(st) ? ' is-read' : ''}" data-tk="${i}" href="${esc(safeUrl(st.link))}" target="_blank" rel="noopener noreferrer"${attrs(tickerTip(st))}>${chip(s.bias).replace(/ title="[^"]*"/, '')}<span class="tk-src">${esc(s.name)}:</span>${esc(st.title)}</a><span class="tk-sep">::</span>`;
    }).join('');
    const track = $('#tk-track');
    // the second copy makes the loop seamless (hidden when the ticker is stopped)
    track.innerHTML = `<span class="tk-copy">${one}</span><span class="tk-copy tk-dup" aria-hidden="true">${one.replace(/<a /g, '<a tabindex="-1" ')}</span>`;
    requestAnimationFrame(setTickerSpeed);
  } catch {}
}
// stopped ticker: the mouse wheel scrolls it sideways
$('.tk-view').addEventListener('wheel', (e) => {
  const v = e.currentTarget;
  if (v.scrollWidth <= v.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault();
  v.scrollLeft += e.deltaY;
}, { passive: false });
const TICKER_SPEEDS = { stop: 0, slow: 40, medium: 70, fast: 120 };     // px per second; stop = still, scroll by hand
function setTickerSpeed() {
  const track = $('#tk-track');
  $('#ticker').classList.toggle('tk-stopped', state.tickerSpeed === 'stop');
  if (state.tickerSpeed === 'stop') return;
  $('.tk-view').scrollLeft = 0;                 // drop any hand-scroll offset once it moves again
  const px = TICKER_SPEEDS[state.tickerSpeed] || TICKER_SPEEDS.medium;
  if (track.scrollWidth) track.style.setProperty('--tk-dur', `${Math.max(15, track.scrollWidth / 2 / px)}s`);
}
$('#tk-track').addEventListener('click', (e) => {
  const a = e.target.closest('[data-tk]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  openTickerStory(Number(a.dataset.tk));
});

// ───────────────────────── status / refresh ─────────────────────────
async function loadStatus() {
  try {
    const st = await api('status');
    $('#st-feeds').textContent = `${st.ok}/${st.enabled}`;
    $('#st-articles').textContent = st.articles;
    $('#st-uplink').className = st.ok ? 'ok' : 'err';
    $('#st-sync').textContent = st.refreshing ? 'syncing…' : st.lastRefresh ? hhmmss(new Date(st.lastRefresh)) : '--:--:--';
    // background sync: say when it starts, and (below) what it brought in
    if (st.refreshing && !state.wasRefreshing && !state.manualSync) log(`<span class="dim">⟳ feed sync started — checking ${st.enabled} feeds…</span>`);
    state.wasRefreshing = st.refreshing;
    clearTimeout(loadStatus.fast);
    if (st.refreshing) loadStatus.fast = setTimeout(loadStatus, 4000);      // watch it closely while it runs
    if (st.lastRefresh && st.lastRefresh !== state.lastRefresh) {
      const first = !state.lastRefresh;
      const before = state.lastArticles;
      if (!first && !state.manualSync) {
        const g = st.grouping;
        log(`✓ feeds synced: ${st.ok}/${st.enabled} online${before != null && st.articles > before ? ` · <b>+${(st.articles - before).toLocaleString()}</b> new article${st.articles - before === 1 ? '' : 's'}` : ' · nothing new'}${g ? ` <span class="dim">· stories regrouped: ${g.stories.toLocaleString()} from ${g.articles.toLocaleString()} articles in ${g.ms < 1000 ? `${g.ms} ms` : `${(g.ms / 1000).toFixed(1)} s`}</span>` : ''}`, 'ok');
      }
      state.lastArticles = st.articles;
      state.lastRefresh = st.lastRefresh;
      await loadSources();
      await loadNews();
      loadTicker();
      if (first) log(`uplink established: ${st.ok}/${st.enabled} feeds online, ${st.articles} articles indexed`, 'ok');
      else if (!state.manualSync) log('<span class="dim">↻ results updated with the new coverage</span>');
    }
    return st;
  } catch { $('#st-uplink').className = 'err'; }
}

async function refresh() {
  if (!auth.can('sources.manage')) return log('a feed sync runs every few minutes on its own; triggering one needs the sources.manage permission', 'warn');
  log('⟳ syncing all feeds…');
  $('#st-sync').textContent = 'syncing…';
  state.manualSync = true;
  try {
    await api('refresh', { method: 'POST' });
    log('<span class="dim">⟳ feeds fetched · grouping stories…</span>');
    await loadStatus();
    await loadSources();
    await loadNews();
    const bad = state.sources.filter((s) => s.status === 'error');
    const g = (await api('status').catch(() => null))?.grouping;
    if (g) log(`<span class="dim">✓ stories regrouped: ${g.stories.toLocaleString()} from ${g.articles.toLocaleString()} articles in ${g.ms < 1000 ? `${g.ms} ms` : `${(g.ms / 1000).toFixed(1)} s`}</span>`);
    log(`sync complete. ${bad.length ? `<span class="warn">${bad.length} feed(s) erroring: ${bad.map((s) => esc(s.name)).join(', ')}</span>` : 'all feeds nominal.'}`, 'ok');
  } catch (e) { log(`sync failed: ${esc(e.message)}`, 'err'); }
  finally { state.manualSync = false; }
}
$('#btn-refresh').addEventListener('click', refresh);

setInterval(() => { $('#st-clock').textContent = hhmmss(new Date()); }, 1000);
setInterval(loadStatus, 20000);

// ───────────────────────── add / edit source dialog ─────────────────────────
const dlg = $('#dlg-source');
const form = $('#form-source');

function openSourceDialog(src = null, prefillUrl = '') {
  if (!auth.can('sources.manage')) return log(auth.me?.user ? 'your role cannot manage outlets' : 'sign in as an admin to manage outlets', 'warn');
  state.editing = src;
  state.discoveredSite = null;
  form.reset();
  form.classList.toggle('editing', !!src);
  $('#dlg-title').textContent = src ? `// EDIT SOURCE: ${src.name}` : '// ADD SOURCE';
  $('#btn-save').textContent = src ? 'SAVE ⏎' : 'ADD SOURCE ⏎';
  $('#f-error').hidden = true;
  $('#discover-out').hidden = true;
  $('#f-url').closest('.field').hidden = !!src;
  $('#f-feed').readOnly = false;                         // (an outlet can move to another feed — e.g. off Google News)
  if (src) {
    $('#f-feed').value = src.feed;
    $('#f-name').value = src.name;
    form.querySelector(`input[name=bias][value="${src.bias}"]`).checked = true;
    form.querySelector(`input[name=type][value="${src.type}"]`).checked = true;
    form.querySelector(`input[name=morgueMode][value="${MORGUE_MODES[src.morgueMode] ? src.morgueMode : ''}"]`).checked = true;
  } else if (prefillUrl) {
    $('#f-url').value = prefillUrl;
  }
  // DEFAULT shows what the server's mode is right now
  $('#f-morgue-default').textContent = 'DEFAULT';
  api('archive').then((a) => { const m = a.fulltext?.harvester?.mode; if (MORGUE_MODES[m]) $('#f-morgue-default').textContent = `DEFAULT (${MORGUE_MODES[m][0]})`; }).catch(() => {});
  dlg.showModal();
  (src ? $('#f-name') : $('#f-url')).focus();
  if (prefillUrl && !src) discover();
}

function formError(msg) { const el = $('#f-error'); el.textContent = '! ' + msg; el.hidden = !msg; }

async function discover() {
  const url = $('#f-url').value.trim();
  if (!url) return;
  const out = $('#discover-out');
  const btn = $('#btn-discover');
  out.hidden = false;
  out.textContent = `> probing ${url} …`;
  btn.disabled = true;
  formError('');
  try {
    const r = await api('discover', { method: 'POST', body: { url } });
    $('#f-feed').value = r.feed;
    state.discoveredSite = r.site;
    if (!$('#f-name').value) $('#f-name').value = (r.title || '').split(/\s[|\-–—:]\s/)[0].slice(0, 80);
    out.textContent = `> FOUND ${r.feed}\n> ${r.count} items. sample:\n${r.sample.map((t) => '  · ' + t).join('\n')}\n> set a bias rating, then add.`;
    $('#f-name').focus();
  } catch (e) {
    out.textContent = `> ${e.message}`;
    formError('discovery failed — paste the RSS/Atom feed URL directly into "feed url".');
  } finally { btn.disabled = false; }
}
$('#btn-discover').addEventListener('click', discover);
$('#f-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); discover(); } });

form.addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const fd = new FormData(form);
  const body = { name: fd.get('name'), feed: fd.get('feed'), bias: Number(fd.get('bias')), type: fd.get('type'), site: state.discoveredSite || undefined, morgueMode: fd.get('morgueMode') || 'default' };
  const btn = $('#btn-save');
  btn.disabled = true;
  formError('');
  try {
    if (state.editing) {
      const s = await api(`sources/${encodeURIComponent(state.editing.id)}`, { method: 'PATCH', body });
      log(`updated ${esc(s.name)} → ${BIAS_NAME[s.bias]}`, 'ok');
    } else {
      const s = await api('sources', { method: 'POST', body });
      log(`+ added ${esc(s.name)} [${BIAS_NAME[s.bias]}] — ${s.count} items`, 'ok');
    }
    dlg.close();
    await loadSources();
    if (arDlg.open) loadArchiveStatus();                  // (opened from the archive popover's ⚙: show the change there)
    await loadNews();
  } catch (err) { formError(err.message); }
  finally { btn.disabled = false; }
});

$('#btn-delete').addEventListener('click', async () => {
  const s = state.editing;
  if (!s || !confirm(`Delete ${s.name}?`)) return;
  await api(`sources/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
  log(`- removed ${esc(s.name)}`, 'warn');
  if (soloOf(qInput.value) === s.id) editClause('source', null);
  dlg.close();
  await loadSources(); await loadNews();
});
$('#btn-reset-votes').addEventListener('click', async () => {
  const s = state.editing;
  await api(`sources/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: { votes: 0 } });
  log(`votes reset for ${esc(s.name)}`);
  dlg.close();
  await loadSources(); await loadNews();
});
$('#btn-add').addEventListener('click', () => openSourceDialog());

// ───────────────────────── command line ─────────────────────────
function findSource(q) {
  q = q.toLowerCase();
  return state.sources.find((s) => s.id === q || s.name.toLowerCase() === q)
    || state.sources.find((s) => s.name.toLowerCase().includes(q) || s.id.includes(q));
}

const HELP = `commands:
  add [url]            add a source (auto-discovers the RSS feed)
  up|down <source>     upvote / downvote a source
  solo <source>        show only one source   ·  solo  (no arg) clears
  on|off <source>      enable / disable a source
  edit <source>        edit name / bias / type
  query <lucene>       filter with query syntax (alias q, grep) — 'help query' for syntax
  bias <l ll c lr r|all>  set the query's bias: clause, e.g. "bias l r"
  mode <stories|stream>   ·  blindspot [on|off] toggles blindspot:any in the query
  sort <top|latest|coverage>    window <12h|24h|48h|7d|all|off>  (edits the query)
  media <all|legacy|new>  sets/removes the type: clause
  srcsort <bias|votes|name|items|status>  sort the sources sidebar
  side <stats|sources>    sidebar tab: quick stats for the query, or the outlet list
  side hide|show          collapse the sidebar to the edge (h)
  log [n|all] [what]      your activity: opened, searched, saved, marked, voted (alias history)
  toolbar filter buttons (bias, media, blindspot, window) just edit the query text
  theme <${THEMES.join('|')}>    img on|off    crt on|off    ticker on|off|stop|slow|medium|fast
  blindspot min <n>    sources a story needs before it can be a blindspot
  top                  show most up/downvoted sources
  save [name]          save the current query as a tab (no name = dialog)
  saved                list saved queries      open <name|n|all>  switch tab
  pin|unpin <name>     show / hide as a tab    unsave <name>      delete
  sync                 refetch every feed now
  clear                clear this console
tab autocompletes commands, sources and query fields.
keys:  j/k move · enter/click story intel · o open link · x expand · u/d vote · m read/unread · / search · : command
       s save query · e advanced editor · g query stats · [ ] cycle tabs · alt+1-9 jump to tab · a add source · r sync · esc`;

// settings commands (account, server, SSO, users, roles…) — see public/settings-cmd.js
let acRoles = null, acUsers = null, acPerms = null;
const acLoad = () => {
  if (acRoles === null && auth.can('users.manage')) {
    acRoles = [];
    api('admin/roles').then((r) => { acRoles = r.roles.map((x) => x.id); acPerms = Object.keys(r.permissions); }).catch(() => {});
    api('admin/users').then((r) => { acUsers = r.users.map((u) => u.username); }).catch(() => {});
  }
};
const setCmds = createSettingsCommands({
  api, esc, auth, store, state, log: (m, c) => log(m, c), toggleComments,
  reader: { prefs: () => reader.prefs(), setPref: (k, v) => reader.setPref(k, v) },
  roleIds: () => (acLoad(), acRoles || ['admin', 'moderator', 'member', 'viewer', 'guest']),
  userNames: () => (acLoad(), acUsers || []), permNames: () => (acLoad(), acPerms || []),
});

// terminal colour: the echoed command, help text, and the prompt
function echoHTML(line) {
  const m = line.trim().match(/^(\S+)(\s+.*)?$/);
  return m ? `<span class="c-cmd">${esc(m[1])}</span>${m[2] ? `<span class="c-arg">${esc(m[2])}</span>` : ''}` : '';
}
// help text: section titles, the command on each line, <placeholders> / [optional] parts, the description
function colorHelp(text) {
  return esc(text).split('\n').map((l) => {
    if (/^[a-z][\w ()&,'/-]*:(\s|$)/i.test(l) && !/^\s/.test(l)) return l.replace(/^([^:]+:)/, '<span class="c-h">$1</span>');
    return l.replace(/^(\s+)([a-z][\w|?-]*(?:\s(?:min|font|size))?)/i, '$1<span class="c-cmd">$2</span>')
      .replace(/(&lt;[^&]+?&gt;|\[[^\]]+\])/g, '<span class="c-ph">$1</span>')
      .replace(/(\s{2,})([a-z][^<]*)$/i, '$1<span class="c-desc">$2</span>');
  }).join('\n');
}
function setPrompt() {
  const u = auth.me?.user?.username || 'guest';
  const el = $('.console .cmd .prompt');
  if (el) el.innerHTML = `<span class="p-user">${esc(u)}</span><span class="p-at">@</span><span class="p-host">stringer</span><span class="p-path">:~</span><span class="p-sign">$</span>`;
}

async function runCommand(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  log(`<span class="prompt">$</span> ${echoHTML(setCmds.redact(line))}`);
  switch ((cmd || '').toLowerCase()) {
    case '': return;
    case 'help': case '?': return log(colorHelp(/^q(uery)?$/i.test(arg) ? QUERY_HELP : /^set/i.test(arg) ? setCmds.help : `${HELP}\n\n${setCmds.help}`));
    case 'clear': case 'cls': $('#log').innerHTML = ''; return;
    case 'sync': case 'refresh': return refresh();
    case 'add': return openSourceDialog(null, arg);
    case 'binder': return arg === 'side' || arg === 'sidebar' ? research.toggleSide() : research.open();
    case 'log': case 'history': return showActivity(rest);
    case 'builder': case 'qb': return research.builder.toggle();
    case 'up': case 'down': case '+': case '-': {
      const s = findSource(arg);
      if (!s) return log(`no source matching "${esc(arg)}"`, 'err');
      return vote(s.id, cmd === 'up' || cmd === '+' ? 1 : -1);
    }
    case 'solo': case 'only': {
      if (!arg) { soloSource(null); return log(`query → ${esc(qInput.value || '(empty)')}`); }
      const s = findSource(arg);
      if (!s) return log(`no source matching "${esc(arg)}"`, 'err');
      if (soloOf(qInput.value) !== s.id) soloSource(s.id);
      return log(`query → ${esc(qInput.value || '(empty)')}`);
    }
    case 'on': case 'off': case 'enable': case 'disable': {
      const s = findSource(arg);
      if (!s) return log(`no source matching "${esc(arg)}"`, 'err');
      if (s.enabled !== (cmd === 'on' || cmd === 'enable')) return toggleSource(s.id);
      return log(`${esc(s.name)} already ${s.enabled ? 'on' : 'off'}`);
    }
    case 'edit': {
      const s = findSource(arg);
      return s ? openSourceDialog(s) : log(`no source matching "${esc(arg)}"`, 'err');
    }
    case 'query': case 'q': case 'grep': case 'search': case 'find': {
      const qs = line.trim().slice(cmd.length).trim();
      const err = setQuery(qs);
      if (err) return log(`✗ ${esc(err.message)}\n  ${esc(qs)}\n  ${' '.repeat(err.pos)}${'^'.repeat(Math.max(1, err.len || 1))}`, 'err');
      return log(qs ? `query → ${esc(qs)}` : 'query cleared');
    }
    case 'bias': {
      let set = new Set([-2, -1, 0, 1, 2]);
      if (arg && arg !== 'all') {
        const vals = rest.map((x) => BIAS_ALIASES[x.toLowerCase().replace(/[-_]/g, '')]).filter((v) => v !== undefined);
        if (!vals.length) return log('usage: bias l ll c lr r | all', 'err');
        set = new Set(vals);
      }
      editClause('bias', biasClause(set));
      return log(`query → ${esc(qInput.value || '(empty)')}`);
    }
    case 'mode':
      if (arg === 'blindspot') { if (!hasClause(qInput.value, 'blindspot')) toggleBlindspot(); return log('blindspot:any added to the query'); }
      if (!['stories', 'stream'].includes(arg)) return log('usage: mode stories|stream', 'err');
      state.mode = arg; return update();
    case 'sort':
      if (!['top', 'latest', 'coverage'].includes(arg)) return log('usage: sort top|latest|coverage', 'err');
      state.sort = arg; return update();
    case 'srcsort': case 'sources':
      if (!['bias', 'votes', 'name', 'items', 'status'].includes(arg)) return log('usage: srcsort bias|votes|name|items|status', 'err');
      state.srcSort = arg; store.set('srcSort', arg); setPane('sources'); renderSources(); return log(`sources sorted by ${arg}`);
    case 'window': case 'hours': {
      const w = arg.toLowerCase().replace(/^(\d+)$/, '$1h').replace(/^168h$/, '7d').replace(/^0$/, 'all');
      if (w === 'off' || w === 'none') { setWindow(null); return log('time clause removed'); }
      if (!WINDOW_CLAUSES[w]) return log('usage: window 12h|24h|48h|7d|all|off', 'err');
      setWindow(w); return log(`window → ${WINDOW_CLAUSES[w]}`);
    }
    case 'media': case 'type':
      if (!['all', 'legacy', 'new'].includes(arg)) return log('usage: media all|legacy|new', 'err');
      setMedia(arg); return log(`query → ${esc(qInput.value || '(empty)')}`);
    case 'theme':
      if (!THEMES.includes(arg)) return log(`themes: ${THEMES.join(', ')}`, 'err');
      state.theme = arg; syncToolbar(); return log(`theme → ${arg}`);
    case 'img': case 'images':
      state.img = arg ? arg === 'on' : !state.img; syncToolbar(); return log(`images ${state.img ? 'on' : 'off'}`);
    case 'crt':
      state.crt = arg ? arg === 'on' : !state.crt; syncToolbar(); return log(`crt ${state.crt ? 'on' : 'off'}`);
    case 'side': case 'pane': case 'sidebar':
      if (['hide', 'collapse', 'off', 'close'].includes(arg)) { setSideHidden(true); return log('sidebar collapsed (h or » brings it back)'); }
      if (['show', 'expand', 'on', 'open'].includes(arg)) { setSideHidden(false); return log(`sidebar → ${state.pane}`); }
      if (arg && arg !== 'stats' && arg !== 'sources') return log('usage: side stats|sources|hide|show', 'err');
      setSideHidden(false);
      setPane(arg || (state.pane === 'stats' ? 'sources' : 'stats')); return log(`sidebar → ${state.pane}`);
    case 'ticker':
      if (arg in TICKER_SPEEDS) {
        state.tickerSpeed = arg; state.ticker = true; syncToolbar(); setTickerSpeed(); loadTicker();
        return log(arg === 'stop' ? 'ticker stopped — scroll it sideways (wheel / drag / shift+wheel)' : `ticker speed → ${arg}`);
      }
      if (arg && arg !== 'on' && arg !== 'off') return log(`ticker on|off|${Object.keys(TICKER_SPEEDS).join('|')}`, 'err');
      state.ticker = arg ? arg === 'on' : !state.ticker; syncToolbar(); if (state.ticker) loadTicker(); return log(`ticker ${state.ticker ? 'on' : 'off'}`);
    case 'top': {
      const ranked = [...state.sources].filter((s) => s.votes).sort((a, b) => b.votes - a.votes);
      if (!ranked.length) return log('no votes cast yet.');
      return log(esc(ranked.map((s) => `${(s.votes > 0 ? '+' : '') + s.votes}`.padStart(4) + `  ×${s.weight.toFixed(2).padEnd(6)} ${s.name}`).join('\n')));
    }
    case 'blindspots':
    case 'blindspot': {
      if (!rest.length || rest[0] === 'on' || rest[0] === 'off') { if ((rest[0] !== 'off') !== hasClause(qInput.value, 'blindspot')) toggleBlindspot(); return log(`query → ${esc(qInput.value || '(empty)')}`); }
      const v = parseInt(rest[1] ?? rest[0], 10);
      if (!(v >= 2 && v <= 20)) return log(`blindspot min is ${state.bmin}. usage: blindspot min <2-20>`);
      state.bmin = v; persist(); log(`blindspot min sources → ${v}`); return loadNews();
    }
    case 'save': {
      const qs = qInput.value.trim();
      if (!qs) return log('nothing to save — enter a query first (or use the dialog: press s)', 'err');
      if (!arg) return openQueryDialog();
      try {
        const sq = await api('queries', { method: 'POST', body: { name: arg, query: qs, pinned: true } });
        state.saved.push(sq);
        log(`★ saved “${esc(sq.name)}” → ${esc(sq.query)} [tab]`, 'ok');
        applySaved(sq);
      } catch (e) { log(`save failed: ${esc(e.message)}`, 'err'); }
      return;
    }
    case 'saved': case 'tabs': {
      if (!state.saved.length) return log('no saved queries. type a query and press s to save one.');
      const pinned = state.saved.filter((x) => x.pinned);
      return log(esc(state.saved.map((x) => {
        const k = pinned.indexOf(x);
        return `${x.pinned ? `[${k + 1}]`.padStart(4) : '    '} ${(x.name).padEnd(22)} ${String(state.counts[x.id] ?? '').padStart(4)}  ${x.query}${x.view ? `   (${x.view.mode}/${x.view.sort})` : ''}`;
      }).join('\n')));
    }
    case 'open': case 'tab': {
      if (!arg || arg === 'all') { applySaved(null); return log('tab → ALL'); }
      const sq = findSaved(arg);
      if (!sq) return log(`no saved query matching "${esc(arg)}"`, 'err');
      applySaved(sq); return log(`tab → ${esc(sq.name)}`);
    }
    case 'pin': case 'unpin': {
      const sq = findSaved(arg);
      if (!sq) return log(`no saved query matching "${esc(arg)}"`, 'err');
      return setPinned(sq, cmd === 'pin');
    }
    case 'unsave': case 'rm': {
      const sq = findSaved(arg);
      if (!sq) return log(`no saved query matching "${esc(arg)}"`, 'err');
      await api(`queries/${sq.id}`, { method: 'DELETE' });
      state.saved = state.saved.filter((x) => x !== sq);
      renderTabs();
      return log(`deleted saved query “${esc(sq.name)}”`, 'warn');
    }
    case 'advanced': case 'adv': case 'edit-query': case 'build': return editor.open();
    case 'stats': case 'summary': return stats.open();
    case 'archive': {
      const sub = (rest[0] || '').toLowerCase();
      if (sub === 'open' || sub === '') {
        if (sub === 'open') return openArchive();
        const a = await api('archive');
        const b = a.backfill;
        const srcs = Object.values(a.sources);
        return log(esc(`archive: ${a.total.toLocaleString()} articles · ${srcs.filter((x) => x.count).length}/${srcs.length} outlets · backfill ${b.running ? 'RUNNING' : 'paused'} since ${isoDay(b.since)}${b.active.length ? ' · now: ' + b.active.map((x) => x.source + '/' + x.kind).join(', ') : ''}\n'archive open' for per-outlet coverage · 'archive pause' · 'archive start [YYYY]'`));
      }
      if (sub === 'pause') { await api('archive', { method: 'POST', body: { action: 'pause' } }); loadArchiveStatus(); return log('backfill paused', 'warn'); }
      if (sub === 'start') {
        let since = rest[1];
        if (since && /^\d{4}$/.test(since)) since = `${since}-01-01`;
        try { await api('archive', { method: 'POST', body: { action: 'start', ...(since ? { since } : {}) } }); }
        catch (e) { return log(`archive: ${esc(e.message)}`, 'err'); }
        loadArchiveStatus();
        return log(`backfill running${since ? ' back to ' + esc(since) : ''}`, 'ok');
      }
      return log('usage: archive [open|start [YYYY]|pause]', 'err');
    }
    case 'whoami': return setCmds.handle('whoami', rest);
    case 'sudo': return log('nice try.', 'warn');
    default:
      if (await setCmds.handle(cmd.toLowerCase(), rest)) return;
      return log(`command not found: ${esc(cmd)} — type 'help'`, 'err');
  }
}

// terminal autocomplete
const COMMANDS = [
  ['help', '[query]', 'show help / query syntax'], ['query', '<lucene>', 'filter with query syntax'],
  ['add', '[url]', 'add a source'], ['up', '<source>', 'upvote a source'], ['down', '<source>', 'downvote a source'],
  ['solo', '[source]', 'show only one source'], ['on', '<source>', 'enable a source'], ['off', '<source>', 'disable a source'],
  ['edit', '<source>', 'edit a source'], ['bias', '<l ll c lr r|all>', 'bias filter'], ['mode', '<mode>', 'stories / stream / blindspot'],
  ['sort', '<order>', 'top / latest / coverage'], ['srcsort', '<order>', 'sources sidebar: bias / votes / name / items / status'], ['window', '<12h|24h|48h|7d|all|off>', 'set the query time clause'], ['media', '<type>', 'all / legacy / new'],
  ['theme', '<name>', 'color theme'], ['img', 'on|off', 'thumbnails'], ['crt', 'on|off', 'scanline effect'], ['ticker', 'on|off|stop|slow|medium|fast', 'headline ticker'], ['side', 'stats|sources', 'sidebar tab'],
  ['blindspot', 'min <n>', 'blindspot threshold'], ['top', '', 'most up/downvoted sources'], ['sync', '', 'refetch all feeds'],
  ['save', '[name]', 'save current query as a tab'], ['saved', '', 'list saved queries'],
  ['open', '<saved|n|all>', 'switch to a saved query tab'], ['pin', '<saved>', 'show saved query as a tab'],
  ['unpin', '<saved>', 'remove from tab bar'], ['unsave', '<saved>', 'delete a saved query'],
  ['advanced', '', 'open the advanced query editor'], ['stats', '', 'summary & charts for the current query'], ['archive', '[open|start|pause]', 'historical archive / backfill'],
  ['clear', '', 'clear console'],
  ['log', '[n|all|kind|words|clear]', 'your activity history: opened, searched, saved, marked'], ['history', '[n|all|kind|words|clear]', 'same as log'],
  ...setCmds.commands,
];
const SOURCE_CMDS = new Set(['up', 'down', '+', '-', 'solo', 'only', 'on', 'off', 'enable', 'disable', 'edit']);
const QUERY_CMDS = new Set(['query', 'q', 'grep', 'search', 'find']);
const ARG_LISTS = {
  bias: [['l', 'left'], ['ll', 'lean left'], ['c', 'center'], ['lr', 'lean right'], ['r', 'right'], ['all', 'everything']],
  mode: [['stories', 'clustered stories'], ['stream', 'flat article list'], ['blindspot', 'adds blindspot:any to the query']],
  sort: [['top', 'score'], ['latest', 'newest first'], ['coverage', 'most sources']],
  media: [['all', ''], ['legacy', 'traditional outlets'], ['new', 'new media']],
  window: [['12h', 'age:<12h'], ['24h', 'age:<24h'], ['48h', 'age:<48h'], ['7d', 'age:<7d'], ['all', 'date:* (archive)'], ['off', 'remove time clause']],
  archive: [['open', 'show archive status'], ['start', '[since YYYY or YYYY-MM-DD] resume backfill'], ['pause', 'pause backfill']],
  advanced: [], stats: [],
  theme: THEMES.map((t) => [t, 'theme']),
  img: [['on', ''], ['off', '']], crt: [['on', ''], ['off', '']], side: [['stats', 'quick stats for the query'], ['sources', 'the outlet list']],
  ticker: [['on', ''], ['off', ''], ['stop', 'still; scroll it by hand'], ['slow', 'scroll speed'], ['medium', 'scroll speed'], ['fast', 'scroll speed']],
  blindspot: [['min', 'min sources for a blindspot']],
  help: [['query', 'query syntax'], ['settings', 'settings commands']],
  // (activity kinds: the names `log` filters by)
  log: [['all', 'everything kept (up to 1,000)'], ['50', 'the last 50'], ['story', 'stories opened'], ['read', 'articles read'], ['archive', 'archive views'], ['query', 'searches'],
    ['save', 'saved to the binder'], ['quote', 'quotes saved'], ['note', 'notes'], ['mark', 'marked read / unread'], ['vote', 'outlet votes'], ['remove', 'removed from the binder'], ['clear', 'forget the history']],
};
ARG_LISTS.history = ARG_LISTS.log;

function terminalProvider(v, caret, force) {
  if (!v.trim() && !force) return null;
  const head = v.match(/^(\s*)(\S*)/);
  const cmdEnd = head[0].length;
  if (caret <= cmdEnd) {
    const p = head[2].slice(0, caret - head[1].length).toLowerCase();
    return {
      from: head[1].length, to: cmdEnd,
      items: COMMANDS.filter(([c]) => c.startsWith(p)).map(([c, a, d]) => ({ label: `${c} ${a}`.trim(), insert: c + ' ', hint: d, kind: 'cmd', keepOpen: true })),
    };
  }
  const cmd = head[2].toLowerCase();
  const argStart = cmdEnd + (v.slice(cmdEnd).match(/^\s*/)[0].length);
  if (QUERY_CMDS.has(cmd)) {
    if (caret < argStart) return null;
    const r = suggest(v.slice(argStart), caret - argStart, acCtx());
    return { from: r.from + argStart, to: r.to + argStart, items: r.items };
  }
  const word = v.slice(0, caret).match(/(\S*)$/)[1];
  const from = caret - word.length;
  const to = from + v.slice(from).match(/^\S*/)[0].length;
  const w = word.toLowerCase();
  let items = [];
  if (SOURCE_CMDS.has(cmd)) {
    items = state.sources.filter((s) => s.id.startsWith(w) || s.name.toLowerCase().includes(w))
      .sort((a, b) => (b.id.startsWith(w) - a.id.startsWith(w)) || a.id.localeCompare(b.id))
      .map((s) => ({ label: s.id, insert: s.id, hint: `${s.name}  ${s.votes > 0 ? '+' : ''}${s.votes}`, bias: s.bias }));
  } else if (cmd === 'blindspot' && /min\s+\S*$/.test(v.slice(0, caret))) {
    items = ['2', '3', '4', '5'].filter((x) => x.startsWith(w)).map((x) => ({ label: x, insert: x, hint: 'sources' }));
  } else if (['open', 'tab', 'pin', 'unpin', 'unsave', 'rm'].includes(cmd)) {
    const rest = v.slice(argStart, caret).toLowerCase();
    const pool = cmd === 'pin' ? state.saved.filter((x) => !x.pinned) : cmd === 'unpin' ? state.saved.filter((x) => x.pinned) : state.saved;
    const list = pool.filter((x) => x.name.toLowerCase().startsWith(rest) || x.name.toLowerCase().includes(rest))
      .map((x) => ({ label: x.name, insert: x.name, hint: x.query, kind: 'saved' }));
    if ((cmd === 'open' || cmd === 'tab') && 'all'.startsWith(rest)) list.unshift({ label: 'all', insert: 'all', hint: 'clear query' });
    return { from: argStart, to: v.length, items: list.slice(0, 14) };
  } else if (setCmds.complete(cmd, v.slice(argStart, from).trim().split(/\s+/).filter(Boolean))) {
    items = setCmds.complete(cmd, v.slice(argStart, from).trim().split(/\s+/).filter(Boolean))
      .filter(([x]) => x.toLowerCase().startsWith(w)).map(([x, h]) => ({ label: x, insert: x, hint: h }));
  } else if (ARG_LISTS[cmd]) {
    items = ARG_LISTS[cmd].filter(([x]) => x.startsWith(w)).map(([x, h]) => ({ label: x, insert: x, hint: h }));
  }
  return { from, to, items: items.slice(0, 14) };
}
attachAutocomplete($('#cmd'), terminalProvider, { above: true });

const history = store.get('history', []);
let hIdx = history.length;
$('#cmd').addEventListener('keydown', (e) => {
  const inp = e.target;
  if (e.key === 'Enter') {
    const v = inp.value;
    if (v.trim()) { history.push(setCmds.redact(v)); while (history.length > 50) history.shift(); store.set('history', history); }
    hIdx = history.length;
    inp.value = '';
    runCommand(v);
  } else if (e.key === 'ArrowUp') { e.preventDefault(); if (hIdx > 0) inp.value = history[--hIdx]; }
  else if (e.key === 'ArrowDown') { e.preventDefault(); hIdx = Math.min(history.length, hIdx + 1); inp.value = history[hIdx] || ''; }
  else if (e.key === 'Escape') inp.blur();
});

// ───────────────────────── keyboard ─────────────────────────
function selectedSourceId() {
  const it = state.items[state.sel];
  return it ? (it.leadSource || it.sourceId) : null;
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;                // any popover handles its own keys (Esc closes it)
  if (e.altKey && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    const sq = state.saved.filter((x) => x.pinned)[Number(e.key) - 1];
    if (sq) { e.preventDefault(); applySaved(sq); }
    return;
  }
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const n = state.items.length;
  switch (e.key) {
    case 'j': case 'ArrowDown':
      e.preventDefault();
      if (state.sel >= n - 1 && state.page < pageCount() - 1) { gotoPage(state.page + 1, 0); break; }   // roll onto the next page
      state.sel = Math.min(n - 1, state.sel + 1); highlight(); break;
    case 'k': case 'ArrowUp':
      e.preventDefault();
      if (state.sel === 0 && state.page > 0) { gotoPage(state.page - 1, 'last'); break; }
      state.sel = Math.max(0, state.sel - 1); highlight(); break;
    case '>': gotoPage(state.page + 1); break;
    case '<': gotoPage(state.page - 1); break;
    case 'Home': $('.feed').scrollTo({ top: 0 }); break;
    case 'End': $('.feed').scrollTo({ top: $('.feed').scrollHeight }); break;
    case 'o': { const it = state.items[state.sel]; if (it) reader.open(asArticle(it)); break; }
    case 'Enter': case 'i': if (state.sel >= 0) openRow(state.sel); break;
    case 'x': case ' ': { const el = $(`.story[data-i="${state.sel}"]`); if (el) { e.preventDefault(); toggleRow(el); } break; }
    case 'u': { const id = selectedSourceId(); if (id) vote(id, 1); break; }
    case 'm': { const it = state.items[state.sel]; if (it) toggleRead(it); break; }
    case 'd': { const id = selectedSourceId(); if (id) vote(id, -1); break; }
    case '/': e.preventDefault(); $('#q').focus(); $('#q').select(); break;
    case ':': e.preventDefault(); $('#cmd').focus(); break;
    case 'a': e.preventDefault(); openSourceDialog(); break;
    case 'r': refresh(); break;
    case 's': e.preventDefault(); openQueryDialog(); break;
    case 'e': e.preventDefault(); editor.open(); break;
    case 'g': e.preventDefault(); stats.open(); break;
    case 'h': setSideHidden(!state.sideHidden); break;
    case '[': cycleTab(-1); break;
    case ']': cycleTab(1); break;
    case '1': state.mode = 'stories'; update(); break;
    case '2': state.mode = 'stream'; update(); break;
    case '3': toggleBlindspot(); break;
    case 'Escape': if (state.sel >= 0) { state.sel = -1; highlight(false); } else confirmClearQuery(); break;
    case '?': $('#cmd').focus(); runCommand('help'); break;
    default: return;
  }
  // consume handled keys: otherwise e.g. Enter's keypress is delivered to whatever just got focus
  // (the popover's first button) and activates it
  e.preventDefault();
});

// ───────────────────────── advanced query editor ─────────────────────────
reader = createReader({ esc, chip, srcById, safeUrl, api, store, onRead: noteRead, log: (m, c) => log(m, c),
  queryRegexes: () => (hlMuted() ? [] : hlRegs().body),
  onOpen: (a) => activity.record('read', `read: ${a.title || a.link} — ${srcById(a.sourceId)?.name || ''}`, { link: a.link, title: a.title, sourceId: a.sourceId, date: a.date }),
  readState: { signedIn: () => !!auth.me?.user, isRead: (link) => !!state.readLinks?.has(link), toggle: (a) => setRead(a, !state.readLinks?.has(a.link)) },
  discussion: { aside: cmAside, collapsed: cmCollapsed, toggle: toggleComments, toggleDetails, pane: paneAttr, place: () => { placeCmTabs(); requestAnimationFrame(placeCmTabs); },
    details: (slotId, a) => mountDetails(slotId, a),
    mount: (slotId, link) => mountThread(slotId, `article:${link}`, { scope: 'article', link }),
    notes: (slotId, a) => mountNote(slotId, `article:${a.link}`, { kind: 'article', a }) } });

installPasswordMask();                                     // * instead of dots in every password field

// an article just got a morgue no. (saving it or quoting it files it, as a fragment if it has no text yet): show
// its tag everywhere it's on screen — results, popovers, the reader and its details pane
function noteMorgue(link, morgue) {
  const known = [...(state.items || []).flatMap((it) => it.articles || [it]), ...(state.openStory?.st?.articles || []), artOpen?.a].filter(Boolean);
  let touched = false;
  for (const a of known) if (a.link === link && a.id && !state.fulltext?.[a.id]?.morgue) { (state.fulltext ??= {})[a.id] = { words: 0, morgue, saved: Date.now(), fragment: true }; touched = true; }
  if (artOpen?.a?.link === link && artOpen.data && !artOpen.data.body?.morgue) {
    artOpen.data.body = { words: 0, ...(artOpen.data.body || {}), status: artOpen.data.body?.status || 'fragment', morgue, fetched: artOpen.data.body?.fetched || Date.now() };
    touched = true;
  }
  if (touched) rerenderReads();
  reader.noteMorgue(link, morgue);
  const slot = document.getElementById('rd-info');
  if (slot?._data?.a?.link === link) { delete mountDetails.kept['rd-info']; delete slot.dataset.key; mountDetails('rd-info', slot._data.a); }
}

// ───────────────────────── activity history: the terminal's `log` command ─────────────────────────
const activity = createActivity({ store, auth });
// log [n] · log <kind> (story read archive query save remove quote note mark vote) · log <words> · log clear
function showActivity(args = []) {
  if (args[0] === 'clear') { activity.clear(); return log('activity history cleared'); }
  let all = activity.list();
  let n = 25;
  const words = [];
  for (const a of args) { if (/^\d+$/.test(a)) n = Math.min(1000, Number(a)); else if (a === 'all') n = 1000; else words.push(a.toLowerCase()); }
  const kinds = words.filter((w) => ACT_ICON[w] || ACT_ICON[w.replace(/s$/, '')]).map((w) => (ACT_ICON[w] ? w : w.replace(/s$/, '')));
  const text = words.filter((w) => !kinds.includes(w) && !kinds.includes(w.replace(/s$/, '')));
  if (kinds.length) all = all.filter((e) => kinds.includes(e.k));
  if (text.length) all = all.filter((e) => text.every((w) => e.x.toLowerCase().includes(w)));
  if (!all.length) return log(activity.list().length ? 'no activity matches that' : 'no activity yet — opening, searching, saving, marking and voting are recorded here', 'warn');
  const shown = all.slice(-n);
  const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  let prevDay = '';
  const lines = shown.map((e, i) => {
    const d = day(e.t), head = d !== prevDay ? `<span class="act-day">${esc(d)}</span>\n` : '';
    prevDay = d;
    const open = e.r?.sid ? `story:${e.r.sid}` : e.r?.link ? 'article' : e.r?.q ? 'query' : '';
    return `${head}<span class="dim">${hhmmss(new Date(e.t)).slice(0, 5)}</span> <span class="act-k">${ACT_ICON[e.k] || '·'}</span> ${open
      ? `<button type="button" class="link act-open" data-act-i="${all.length - shown.length + i}" title="${open === 'query' ? 'run this query again' : 'open it'}">${esc(e.x)}</button>`
      : esc(e.x)}`;
  });
  activity._shown = all;                                   // what the clickable lines refer to
  log(`<span class="dim">activity — last ${shown.length} of ${all.length}${kinds.length || text.length ? ' matching' : ''} · log [n|all] · log story|read|query|save|quote|note|mark|vote|… · log &lt;words&gt; · log clear</span>\n${lines.join('\n')}`);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.act-open');
  if (!b) return;
  const ent = activity._shown?.[Number(b.dataset.actI)];
  if (!ent?.r) return;
  if (ent.r.sid) return openStoryBySid(ent.r.sid, ent.r.link);
  if (ent.r.q) { state.tabId = null; setQuery(ent.r.q); return log(`query → ${esc(ent.r.q)}`); }
  if (ent.r.link) reader.open({ link: ent.r.link, title: ent.r.title, sourceId: ent.r.sourceId, date: ent.r.date });
});

// ───────────────────────── research: binder, right-click menu, query builder ─────────────────────────
// which article / story a right-click (or a selection) belongs to
function contextAt(node) {
  if (!node?.closest) return null;
  const rd = node.closest('#dlg-reader');
  if (rd) { const a = reader.current(); return a ? { el: rd, article: a, inReader: true } : null; }
  const sb = node.closest('#story-body');
  if (sb && state.openStory) {
    const st = state.openStory.st, hit = node.closest('[data-link]');
    const head = st.articles.find((x) => x.id === state.openStory.focusId) || st.articles.find((x) => x.link === st.link) || st.articles[0];
    return { el: hit || sb, article: (hit && st.articles.find((x) => x.link === hit.dataset.link)) || head, story: st };
  }
  const ab = node.closest('#article-body');
  if (ab && artOpen) {
    const hit = node.closest('[data-link]');
    return { el: hit || ab, article: (hit && artOpen.data?.related?.find((x) => x.link === hit.dataset.link)) || artOpen.a };
  }
  const row = node.closest('#feed-list .story[data-i]');
  if (row) {
    const it = state.items[Number(row.dataset.i)];
    if (!it) return null;
    if (it.articles) {
      const href = node.closest('a[href]')?.getAttribute('href');
      return { el: row, article: it.articles.find((x) => x.link === href) || it.articles.find((x) => x.link === it.link) || it.articles[0], story: it };
    }
    return { el: row, article: it, story: it.story?.sid ? { sid: it.story.sid, sourceCount: it.story.sources, title: it.title } : null,
      openStory: () => openStoryAt(Number(row.dataset.i)), openStoryLabel: state.inArchive ? 'details' : 'story' };
  }
  const tk = node.closest('.tk-item[data-tk]');
  if (tk) { const st = tickerItems[Number(tk.dataset.tk)]; return st ? { el: tk, article: st.articles?.find((x) => x.link === st.link) || st, story: st.sid ? st : null } : null; }
  return null;
}
const research = createResearch({ api, esc, chip, srcById, log: (m, c) => log(m, c), auth, store, fmtTime, agoText: (t) => agoText(t),
  openStoryBySid, reader, queryError, setQuery: (q) => { state.tabId = null; return setQuery(q); }, mainQuery: () => qInput.value,
  attachAutocomplete, suggest, acCtx, asArticle, contextAt, highlight: highlightHTML, articleTip: (a, o) => articleTip(a, o), onMorgue: (l, no) => noteMorgue(l, no), morgueOf: (a) => (a?.id != null && state.fulltext?.[a.id]?.morgue) || a?.morgue || null, activity: (k, x, r) => activity.record(k, x, r), onQueryEdit: (q) => mirrorQuery('builder', q) });
queryMirrors.builder = research.builder.setText;
$('#q-binder')?.addEventListener('click', () => research.open());
// b: the binder · q: the query builder (anywhere, popovers included; not while typing)
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'b') { e.preventDefault(); research.toggle(); }
  else if (e.key === 'B') { e.preventDefault(); research.toggleSide(); }        // in a popover: the floating binder
  else if (e.key === 'q') { e.preventDefault(); research.builder.toggle(); }
}, true);

const editor = createEditor({
  esc, highlight: highlightHTML, attachAutocomplete,
  suggest: (v, caret) => suggest(v, caret, acCtx()),
  getQuery: () => activeQueryText(),
  onChange: (q) => mirrorQuery('editor', q),
  apply: (q) => { state.tabId = null; const err = setQuery(q); if (!err) log(`query → ${esc(q || '(cleared)')}`); },
  saveAs: (q) => { setQuery(q); openQueryDialog(); },
  count: async (q) => {
    const p = new URLSearchParams(newsQuery());
    p.set('q', q); p.set('limit', '1');
    const d = await api('news?' + p);
    return { total: d.total, unit: d.mode === 'stream' ? 'articles' : 'stories', archive: d.archive };
  },
});
queryMirrors.editor = editor.setText;
renderQTabs();
if (activeDraft()) queryMirrors.builder(activeDraft().text);
$('#q-adv').addEventListener('click', () => editor.open());

// ───────────────────────── query summary / stats ─────────────────────────
const stats = createStats({
  esc, chip, api,
  params: () => newsQuery(),
  getQuery: () => state.q,
  outletCount: () => state.sources.filter((s) => s.enabled).length,
  openArchive: () => openArchive(),
  apply: (q) => { state.tabId = null; const err = setQuery(q); if (!err) log(`query → ${esc(q)}`); },
});
$('#q-stats').addEventListener('click', () => stats.open());

// ───────────────────────── sidebar tabs: STATS (default) / SOURCES ─────────────────────────
const statsParams = () => { const p = new URLSearchParams(newsQuery()); p.delete('offset'); p.delete('limit'); return p.toString(); };
const sideStats = createSideStats({
  esc, chip, api,
  params: statsParams,
  getQuery: () => state.q,
  visible: () => state.pane === 'stats',
  apply: (q) => { state.tabId = null; const err = setQuery(q); if (!err) log(`query → ${esc(q)}`); },
  solo: (id) => soloSource(id),
  openFull: () => stats.open(),
});
function setPane(p) {
  state.pane = p === 'sources' ? 'sources' : 'stats';
  store.set('pane', state.pane);
  $$('[data-pane]').forEach((b) => { const on = b.dataset.pane === state.pane; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $$('[data-pane-body]').forEach((el) => { el.hidden = el.dataset.paneBody !== state.pane; });
  $('#btn-add').hidden = state.pane !== 'sources';
  if (state.pane === 'stats') sideStats.refresh();
}
$('.pane-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-pane]'); if (b) setPane(b.dataset.pane); });
setPane(state.pane);
// the whole sidebar collapses to a thin rail on the left edge; the results take the space
function setSideHidden(hide) {
  state.sideHidden = !!hide;
  store.set('sideHidden', state.sideHidden);
  document.body.classList.toggle('side-hidden', state.sideHidden);
  if (!state.sideHidden && state.pane === 'stats') sideStats.refresh();
}
$('#side-hide').addEventListener('click', () => setSideHidden(true));
$('#side-rail').addEventListener('click', (e) => { const b = e.target.closest('[data-rail]'); if (!b) return; setPane(b.dataset.rail); setSideHidden(false); });
setSideHidden(store.get('sideHidden', false));

// ───────────────────────── archive panel ─────────────────────────
const arDlg = $('#dlg-archive');
const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n.toLocaleString());

async function loadArchiveStatus() {
  try {
    const a = await api('archive');
    const b = a.backfill;
    $('#st-archive').innerHTML = `${fmtN(a.total)} <span class="${b.running ? 'ok spin' : 'dim'}" title="backfill ${b.running ? 'running' : 'paused'}">${b.running ? '⟳' : '❚❚'}</span>`;
    if (arDlg.open) renderArchive(a);
  } catch { $('#st-archive').textContent = 'n/a'; }
}

// The panel is built once; the 5-second refresh only updates numbers and table rows in place, so the
// scroll position and a half-picked date are never disturbed.
let arPicker = null, arSinceDirty = false;
function archiveShell() {
  const help = (head, text) => `<span class="dt-help ar-help" title="${esc(text)}" data-tip-head="${esc(head)}">ⓘ</span>`;
  $('#archive-body').innerHTML = `
    <div class="st-head">
      <div class="dlg-head"><span>// HISTORICAL ARCHIVE</span><button type="button" class="link" data-act="close" title="close (esc)">[esc]</button></div>
      <div class="ar-status ok" id="ar-status">—</div>
    </div>
    <section class="ar-sec">
      <h4>CATALOG ${help('THE CATALOG', 'Every headline STRINGER knows, searchable with date: / age: queries. It grows from the live feeds and from the backfill, which crawls each outlet back to the date you pick: outlet sitemaps (headlines rebuilt from the URL, shown with ≈ — "real" counts the rest) · Wayback Machine snapshots of each RSS feed (real headlines, sampled monthly → weekly → daily) · the Hacker News API. Outlets that block the crawler fill from the Wayback Machine only.')}</h4>
      <div class="st-tiles ar-tiles" id="ar-cat-tiles"></div>
      <div class="ar-ctl">backfill <b id="ar-state">—</b> <span class="dim">· back to</span>
        <input id="ar-since" />
        <button type="button" data-act="start" id="ar-start" class="needs-perm-archive-manage">START</button>
        <button type="button" data-act="pause" id="ar-pause" class="needs-perm-archive-manage">PAUSE</button></div>
    </section>
    <section class="ar-sec">
      <h4>MORGUE ${help('THE MORGUE', 'Articles fetched once, run through the reader-view extraction and filed under a morgue no. — their text is indexed for body: / author: / words: / morgue: queries, and the reader opens the morgue copy. The mode decides what gets filed (hover the buttons); outlets can have their own. In every mode a binder save files the article, right-click → File in the morgue files any article, and removing something from a binder never unfiles it. Fragments are headline + summary only. Sites that refuse requests (HTTP 401/403) are left alone; their articles are filed from the Wayback Machine’s copy once it has one.')}</h4>
      <div class="st-tiles ar-tiles" id="ar-morgue-tiles"></div>
      <div class="ar-ctl">mode <b id="ft-state">—</b>
        <span class="ft-modes needs-perm-archive-manage">${Object.entries(MORGUE_MODES).map(([k, [l, d]]) => `<button type="button" data-act="ft-mode" data-mode="${k}" title="${esc(d)}">${l}</button>`).join('')}</span>
        <label class="chk small needs-perm-archive-manage" title="each article's headline and summary get a morgue no. as they arrive from the feeds — a record of good headlines and summaries even when the text is never fetched (in auto and ad-hoc mode the full text replaces it later, keeping the number)"><input type="checkbox" id="ft-fragall" /> fragment every incoming headline</label></div>
      <div class="ar-ctl small" id="ft-filers"></div>
    </section>
    <section class="ar-sec">
      <h4>STORAGE ${help('STORAGE', 'archive.db (with its write-ahead log) holds the headline catalog, its search index and the morgue. The disk bar is the whole disk the data directory is on.')}</h4>
      <div class="st-tiles ar-tiles" id="ar-disk-tiles"></div>
    </section>
    <section class="ar-sec">
      <h4>BY OUTLET ${help('BY OUTLET', 'articles = headlines in the catalog · earliest = the oldest one · depth = how far back that reaches · real = share of real (not URL-derived) headlines · sitemaps / wayback = backfill progress · morgue = filed · +fragments · ✗ couldn’t be filed. ▣ marks an outlet with its own morgue mode.')}</h4>
      <div class="ar-table-wrap"><table class="ar-table">
        <thead><tr><th>outlet</th><th>articles</th><th>earliest</th><th>depth</th><th title="share of real (not URL-derived) headlines">real</th><th>sitemaps</th><th>wayback</th><th title="articles filed in the morgue: complete · fragments · refused/failed">morgue</th><th></th><th class="needs-perm-sources-manage"></th></tr></thead>
        <tbody id="ar-tbody"></tbody>
      </table></div>
    </section>
    <div class="st-foot-bar"><span class="dim" title="an outlet's own morgue mode: edit the outlet (edit <outlet>)">esc close · <b>archive start [date]</b> · <b>archive pause</b> · <b>morgue &lt;mode&gt;</b> · <b>morgue fragments on|off</b></span><button type="button" data-act="close">CLOSE</button></div>`;
  arSinceDirty = false;
  arPicker = attachDatePicker($('#ar-since'), { min: '1980-01-01', max: isoDay(Date.now()), presets: ['1990-01-01', '2000-01-01', '2010-01-01', '2015-01-01', '2020-01-01'] });
  $('#ar-since').addEventListener('input', () => { arSinceDirty = true; });
}

function renderArchive(a) {
  if (!$('#ar-tbody')) archiveShell();
  const b = a.backfill;
  const rows = Object.entries(a.sources).sort((x, y) => x[1].bias - y[1].bias || y[1].count - x[1].count);
  const tile = (label, value, sub = '', tip = '') => `<div class="st-tile"${tip ? ` title="${esc(tip)}"` : ''}><div class="st-tile-l">${label}</div><div class="st-tile-v">${value}</div>${sub ? `<div class="st-tile-s">${sub}</div>` : ''}</div>`;
  const pctOf = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
  const prog = (f) => {
    if (!f) return '<span class="dim">—</span>';
    const tot = f.pending + f.done + f.error + f.skip;
    if (!tot) return '<span class="dim">—</span>';
    const pct = Math.floor((100 * (tot - f.pending)) / tot);
    return `<span class="ar-bar" title="${tot - f.pending}/${tot} files"><span style="width:${pct}%"></span></span> ${pct}%${f.error ? ` <span class="err" title="${f.error} failed">${f.error}✗</span>` : ''}`;
  };
  const srcName = (id) => srcById(id)?.name || id;

  // ── catalog ──
  const withArticles = rows.filter((r) => r[1].count);
  const firsts = withArticles.map((r) => r[1].first).filter(Boolean), lasts = withArticles.map((r) => r[1].last).filter(Boolean);
  const real = rows.reduce((t, r) => t + (r[1].real || 0), 0), counted = rows.reduce((t, r) => t + (r[1].count || 0), 0);
  const files = { sitemap: { pending: 0, done: 0, error: 0, skip: 0 }, wayback: { pending: 0, done: 0, error: 0, skip: 0 } };
  for (const [, x] of rows) for (const k of ['sitemap', 'wayback', 'hn']) { const f = x.files?.[k]; if (!f) continue; const t = files[k === 'hn' ? 'wayback' : k]; for (const q of ['pending', 'done', 'error', 'skip']) t[q] += f[q] || 0; }
  const crawl = (f) => { const tot = f.pending + f.done + f.error + f.skip; return tot ? `${Math.floor((100 * (tot - f.pending)) / tot)}%` : '—'; };
  const crawlSub = (f) => { const tot = f.pending + f.done + f.error + f.skip; return tot ? `${(tot - f.pending).toLocaleString()} of ${tot.toLocaleString()} files${f.error ? ` · <span class="err">${f.error.toLocaleString()} failed</span>` : ''}` : 'nothing to crawl'; };
  $('#ar-cat-tiles').innerHTML = [
    tile('headlines', fmtN(a.total), `${a.total.toLocaleString()} in the catalog`),
    tile('outlets covered', `${withArticles.length}/${rows.length}`, `${rows.length - withArticles.length} with nothing yet`),
    tile('earliest', firsts.length ? isoDay(Math.min(...firsts)) : '—', firsts.length ? `${((Date.now() - Math.min(...firsts)) / 31557600000).toFixed(1)} years back` : ''),
    tile('newest', lasts.length ? isoDay(Math.max(...lasts)) : '—', lasts.length ? relAge(Math.max(...lasts)) : ''),
    tile('real headlines', pctOf(real, counted), `${fmtN(counted - real)} rebuilt from URLs (≈)`, 'the rest were rebuilt from the article URL by the sitemap crawl'),
    tile('sitemap crawl', crawl(files.sitemap), crawlSub(files.sitemap)),
    tile('wayback / HN crawl', crawl(files.wayback), crawlSub(files.wayback)),
  ].join('');
  const stEl = $('#ar-state');
  stEl.textContent = b.running ? 'RUNNING' : 'PAUSED';
  stEl.className = b.running ? 'ok' : 'warn';
  $('#ar-start').textContent = b.running ? 'APPLY DATE' : 'START';
  $('#ar-pause').hidden = !b.running;
  const since = $('#ar-since');
  if (b.since && !arSinceDirty && document.activeElement !== since && !arPicker?.isOpen()) since.value = new Date(b.since).toISOString().slice(0, 10);

  // ── morgue ──
  const ft = a.fulltext, h = ft?.harvester || {};
  const status = [];
  // what's happening right now (the header's status line)
  if (b.running) status.push(b.active.length ? `<span class="spin">⟳</span> backfill crawling ${b.active.map((x) => `${esc(srcName(x.source))}${x.kind ? ` <span class="ar-st-dim">(${esc(x.kind)})</span>` : ''}`).join(', ')}` : '● backfill running — between files');
  else status.push('❚❚ backfill paused');
  if (ft) {
    const mm = MORGUE_MODES[h.mode] ? h.mode : 'auto';
    $('#ft-state').textContent = MORGUE_MODES[mm][0];
    $('#ft-state').className = mm === 'auto' ? 'ok' : 'warn';
    $('#ft-state').title = MORGUE_MODES[mm][1];
    for (const x of $$('.ft-modes [data-mode]')) x.classList.toggle('on', x.dataset.mode === mm);
    $('#ft-fragall').checked = h.fragmentAll !== false;
    const filed = (ft.ok || 0) + (ft.partial || 0), bad = (ft.blocked || 0) + (ft.failed || 0), ses = h.session || {};
    $('#ar-morgue-tiles').innerHTML = [
      tile('filed', fmtN(filed), `${fmtN(ft.words || 0)} words · ${(ft.partial || 0).toLocaleString()} partial`, 'complete articles, and partial ones (paywall or script-rendered pages)'),
      tile('fragments', fmtN(ft.fragment || 0), 'headline + summary only'),
      tile("couldn't file", fmtN(bad), `${(ft.blocked || 0).toLocaleString()} refused · ${(ft.failed || 0).toLocaleString()} failed`, 'refused: the site turned the request away or the page is gone; failed: errors, timeouts, no article text'),
      tile('filed in 24h', (ft.lastDay ?? 0).toLocaleString(), `${(ft.lastWeek ?? 0).toLocaleString()} in 7 days`),
      tile('average length', filed ? `${Math.round((ft.words || 0) / filed).toLocaleString()}` : '—', 'words per filed article'),
      tile('from wayback', fmtN(ft.wayback || 0), "filed from the Wayback Machine's copy"),
      tile('this session', `${((ses.ok || 0) + (ses.partial || 0)).toLocaleString()}`, `filed since the server started${ses.blocked || ses.failed ? ` · ${((ses.blocked || 0) + (ses.failed || 0)).toLocaleString()} couldn't` : ''}${ses.wayback ? ` · ${ses.wayback} via Wayback` : ''}`),
    ].join('');
    // who filed what: opening an unfiled article in the reader (or saving it to a binder) files it in your name;
    // the rest is the auto-filer's
    const fl = ft.filers || [];
    $('#ft-filers').innerHTML = fl.length ? `<span class="dim">filed by</span> ${fl.slice(0, 8).map((f) => `<span title="${esc(f.auto ? 'fetched and filed automatically as articles appear in the feeds' : f.untracked ? 'filed before STRINGER recorded who filed what' : 'filed when they opened it in the reader or saved it to a binder')}">${f.untracked ? '<span class="dim">' : f.auto ? '' : '<b>'}${esc(f.name)}${f.untracked ? '</span>' : f.auto ? '' : '</b>'} <span class="dim">${f.n.toLocaleString()}</span></span>`).join(' · ')}${fl.length > 8 ? ` <span class="dim">· +${fl.length - 8} more</span>` : ''}` : '';
    const busy = h.active ? `fetching ${h.active}` : '';
    status.push(`${busy ? '<span class="spin">⟳</span> ' : '● '}morgue ${MORGUE_MODES[mm][0]}${busy ? ` — ${busy}` : ''}${h.queued ? `${busy ? ',' : ' —'} ${h.queued.toLocaleString()} queued` : busy ? '' : ' — idle'}`);
    const sites = (h.cooling || []).filter((c) => c.host !== 'web.archive.org'), wb = (h.cooling || []).find((c) => c.host === 'web.archive.org');
    if (sites.length) status.push(`<span title="${esc(`these sites refused several requests in a row (HTTP 401/403), so they are left alone for 6h — their articles are filed from the Wayback Machine's copy once it has one:\n${sites.map((c) => c.host).join(', ')}`)}">${sites.length} site${sites.length === 1 ? '' : 's'} resting</span>`);
    if (wb) status.push(`Wayback lookups paused until ${new Date(wb.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  } else { $('#ft-state').textContent = 'off'; status.push('morgue unavailable'); }
  $('#ar-status').innerHTML = status.join(' <span class="ar-st-dim">·</span> ');

  // ── storage ──
  const dk = a.disk;
  if (dk) {
    const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
    const filed = ft ? (ft.ok || 0) + (ft.partial || 0) : 0;
    const usedPct = dk.disk ? Math.round((100 * (dk.disk - dk.free)) / dk.disk) : null;
    $('#ar-disk-tiles').innerHTML = [
      tile('on disk', gb(dk.total), 'archive.db + its write-ahead log'),
      dk.morgue != null ? tile('morgue', gb(dk.morgue), filed ? `~${gb(dk.morgue / filed)} per filed article` : '') : '',
      dk.morgue != null ? tile('catalog & search index', gb(dk.total - dk.morgue), a.total ? `~${gb((dk.total - dk.morgue) / a.total)} per headline` : '') : '',
      dk.free != null ? tile('free on this disk', gb(dk.free), `<span class="ar-diskbar" title="${usedPct}% of ${gb(dk.disk)} used"><span style="width:${usedPct}%"></span></span> of ${gb(dk.disk)}`) : '',
    ].join('');
  }

  // ── by outlet ──
  const depth = (s) => (s.first ? ((Date.now() - s.first) / 31557600000).toFixed(1) + 'y' : '—');
  const active = new Map(b.active.map((x) => [x.source, x.kind]));
  $('#ar-tbody').innerHTML = rows.map(([id, s]) => `<tr>
    <td>${chip(s.bias)} ${esc(s.name)}${active.has(id) ? ` <span class="ok spin" title="crawling ${active.get(id)}">⟳</span>` : ''}${MORGUE_MODES[srcById(id)?.morgueMode] ? ` <span class="src-mm" title="this outlet's own morgue mode: ${esc(MORGUE_MODES[srcById(id).morgueMode][1])} (edit the outlet to change it)">▣ ${MORGUE_MODES[srcById(id).morgueMode][0]}</span>` : ''}</td>
    <td class="num">${s.count.toLocaleString()}</td><td>${s.first ? isoDay(s.first) : '—'}</td><td class="num">${depth(s)}</td>
    <td class="num">${s.count ? Math.round((100 * s.real) / s.count) + '%' : '—'}</td>
    <td>${prog(s.files.sitemap)}</td><td>${prog(s.files.wayback || s.files.hn)}</td><td class="num">${ftCell(a.fulltext?.bySource?.[id])}</td>
    <td class="err small" title="${esc(b.errors[id] || '')}">${b.errors[id] ? '!' : ''}</td>
    <td class="needs-perm-sources-manage"><button type="button" class="gear" data-act="ar-edit" data-src="${esc(id)}" title="${esc(s.name)} settings — name, bias, media type, morgue mode">⚙</button></td></tr>`).join('');
}

function ftCell(f) {
  if (!f) return '<span class="dim">—</span>';
  return `<span title="in the morgue: ${f.ok} complete · ${f.partial} fragments · ${f.bad} couldn't be filed (refused/failed)">${f.ok.toLocaleString()}${f.partial ? ` <span class="dim">+${f.partial}</span>` : ''}${f.bad ? ` <span class="err">${f.bad}✗</span>` : ''}</span>`;
}

async function openArchive() {
  archiveShell();
  arDlg.showModal();
  await loadArchiveStatus();
}
$('#btn-archive').addEventListener('click', openArchive);
arDlg.addEventListener('change', async (e) => {
  if (e.target.id !== 'ft-fragall') return;
  const on = e.target.checked;
  try { await api('archive', { method: 'POST', body: { action: 'fragment-all', on } }); log(`morgue: every incoming headline + summary ${on ? 'is filed as a fragment' : 'is no longer filed on arrival'}`, 'ok'); }
  catch (err) { log(`couldn't change it: ${esc(err.message)}`, 'err'); }
  loadArchiveStatus();
});
arDlg.addEventListener('click', async (e) => {
  if (e.target === arDlg) return arDlg.close();
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') arDlg.close();
  else if (act === 'ar-edit') { const s = srcById(e.target.closest('[data-src]').dataset.src); if (s) openSourceDialog(s); }
  else if (act === 'pause') { await api('archive', { method: 'POST', body: { action: 'pause' } }); log('backfill paused', 'warn'); loadArchiveStatus(); }
  else if (act === 'ft-mode') {
    const mode = e.target.closest('[data-mode]').dataset.mode;
    try { await api('archive', { method: 'POST', body: { action: 'morgue-mode', mode } }); log(`morgue mode → <b>${MORGUE_MODES[mode][0]}</b> <span class="dim">· ${esc(MORGUE_MODES[mode][1])}</span>`, 'ok'); }
    catch (err) { log(`couldn't change the morgue mode: ${esc(err.message)}`, 'err'); }
    loadArchiveStatus();
  }
  else if (act === 'start') {
    const since = $('#ar-since').value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return log('archive: date must be YYYY-MM-DD', 'err');
    arSinceDirty = false;
    try { await api('archive', { method: 'POST', body: { action: 'start', since } }); log(`backfill running back to ${esc(since)}`, 'ok'); }
    catch (err) { log(`archive: ${esc(err.message)}`, 'err'); }
    loadArchiveStatus();
  }
});
setInterval(() => { if (arDlg.open) loadArchiveStatus(); }, 5000);
setInterval(loadArchiveStatus, 30000);

// ───────────────────────── boot ─────────────────────────
async function boot() {
  syncToolbar();
  // who's here, and is the server set up? (first run → onboarding; private server → sign in)
  try { await auth.refresh(); } catch (e) { log(`can't reach the server: ${esc(e.message)}`, 'err'); }
  research.load();                                  // the binder (and its sidebar) need to know who's signed in
  setPrompt();
  if (auth.me?.setupNeeded) { $('#boot').remove(); return auth.onboarding(); }
  document.title = `${auth.me?.site?.siteName || 'STRINGER'} // terminal`;
  if (new URLSearchParams(location.search).get('login_error')) { auth.openLogin(); history.replaceState(null, '', location.pathname); }
  if (!auth.can('news.read')) {
    $('#boot').remove();
    $('#feed-list').innerHTML = '<div class="empty">&gt; this server is private — sign in to read</div>';
    return auth.openLogin('this server is private — sign in to read');
  }
  const lines = [
    'STRINGER BIOS v1.0 — (c) nobody. no ads. no trackers.',
    'memory check ........................ OK',
    'loading bias matrix [L|LL|C|LR|R] ... OK',
    'mounting /dev/rss ................... OK',
    'disabling advertising subsystem ..... OK',
    'disabling engagement algorithms ..... OK',
    'handshaking with feeds …',
  ];
  const el = $('#boot-log');
  // the boot sequence plays on a first visit and again after 3+ hours away (lastSeen is kept fresh while open)
  const skip = Date.now() - store.get('lastSeen', 0) < 3 * 3600e3;
  const seen = () => store.set('lastSeen', Date.now());
  seen();
  setInterval(seen, 60e3);
  addEventListener('pagehide', seen);
  document.addEventListener('visibilitychange', seen);
  if (!skip) {
    for (const l of lines) { el.textContent += l + '\n'; await new Promise((r) => setTimeout(r, 110)); }
  }
  const sourcesP = loadSources().catch((e) => log(`failed to load sources: ${esc(e.message)}`, 'err'));
  await sourcesP;
  if (!skip) { el.textContent += `${state.sources.length} sources registered.\n> ready_`; await new Promise((r) => setTimeout(r, 250)); }
  $('#boot').classList.add('done');
  setTimeout(() => $('#boot').remove(), 400);
  log(`stringer online. ${state.sources.length} sources. type <b>help</b> or press <b>?</b>`, 'ok');
  await loadStatus();
  await loadSaved();
  await loadNews();
  loadTicker();
  loadArchiveStatus();
  // poll faster until the first sync lands
  const fast = setInterval(async () => {
    const st = await loadStatus();
    if (st?.lastRefresh) clearInterval(fast);
  }, 2000);
  $('#st-clock').textContent = hhmmss(new Date());
}
boot();
