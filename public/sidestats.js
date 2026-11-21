// Sidebar STATS tab: a compact summary of the current query's results (same /api/stats data as the full
// query-summary popover): totals, bias split, a coverage sparkline, top outlets, story lean / blindspots and
// headline words. Everything clickable narrows the query, like the popover.
const BIAS_KEYS = ['L', 'LL', 'C', 'LR', 'R'];
const BIAS_NAMES = { L: 'Left', LL: 'Lean left', C: 'Center', LR: 'Lean right', R: 'Right' };
const BIAS_QUERY = { L: 'l', LL: 'll', C: 'c', LR: 'lr', R: 'r' };
const pct = (x, t) => (t ? Math.round((100 * x) / t) : 0);
const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n.toLocaleString());
const day = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

// topics of the results: stories in STORIES mode, else articles. Click narrows the query.
function topicsBlock(d, tl, est) {
  const byStory = !!d.storiesByTopic;
  const src = byStory ? d.storiesByTopic : d.byTopic;
  const list = Object.entries(src || {}).filter(([t]) => t !== 'other').sort((a, b) => b[1] - a[1]);
  if (!list.length) return '';
  const tot = Object.values(src).reduce((a, b) => a + b, 0);
  const other = src.other || 0;
  return `<h4>topics <span class="dim">· ${byStory ? 'stories' : 'articles'}</span></h4>
      <div class="ss-words ss-topics">${list.map(([t, n]) => `<button type="button" class="drill" data-drill="topic:${t}" title="${byStory ? n.toLocaleString() + ' stories' : tl + est(n).toLocaleString() + ' articles'} (${pct(n, tot)}%) — click to narrow">#${t}<b>${pct(n, tot)}%</b></button>`).join('')}${other ? `<span class="dim small" title="no clear topic from the link or headline">· ${pct(other, tot)}% other</span>` : ''}</div>`;
}

export function createSideStats(ctx) {
  const { esc, chip, api } = ctx;
  const el = document.getElementById('side-stats');
  let key = null, seq = 0, timer = null, data = null;

  function render(d, q) {
    const T = d.totals;
    const k = d.sample?.k > 1 ? d.sample.k : 1;
    const est = (n) => (k > 1 ? Math.round(n * k) : n);
    const tl = k > 1 ? '~' : '';
    const head = `<div class="ss-q" title="${esc(q || 'no query — everything in view')}"><span class="dim">query <span class="q-sl">//</span></span> ${q ? esc(q) : '<span class="dim">(everything)</span>'}</div>`;
    if (!T.articles) { el.innerHTML = head + '<div class="ss-empty dim">&gt; no matches</div>'; return; }

    const spanDays = (T.last - T.first) / 86400e3;
    const span = spanDays < 2 ? `${Math.max(1, Math.round(spanDays * 24))}h` : spanDays < 120 ? `${Math.round(spanDays)}d` : `${(spanDays / 365.25).toFixed(1)}y`;
    const L = d.byBias.L + d.byBias.LL, R = d.byBias.R + d.byBias.LR, C = d.byBias.C;

    // coverage over time: tiny stacked columns
    const b = d.timeline.buckets;
    const max = Math.max(1, ...b.map((x) => x.left + x.center + x.right));
    const spark = `<div class="ss-spark" role="img" aria-label="articles per ${esc(d.timeline.unit)}">${b.map((x) => {
      const tot = x.left + x.center + x.right;
      return `<div class="ss-col" title="${esc(day(x.t))}: ${tl}${est(tot).toLocaleString()} · L ${est(x.left)} · C ${est(x.center)} · R ${est(x.right)}"><div style="height:${(100 * tot) / max}%">${
        [['right', 'R'], ['center', 'C'], ['left', 'L']].map(([s, v]) => (x[s] ? `<i style="flex:${x[s]} 1 0;background:var(--${v})"></i>` : '')).join('')}</div></div>`;
    }).join('')}</div>
      <div class="ss-axis dim"><span>${esc(day(T.first))}</span><span>per ${esc(d.timeline.unit)}</span><span>${esc(day(T.last))}</span></div>`;

    const outlets = d.outlets.slice(0, 8);
    const omax = outlets[0]?.count || 1;
    const bl = d.blindspots, lean = d.lean;
    const words = d.terms?.common.slice(0, 14) || [];
    const dl = d.terms?.distinctive.left.slice(0, 5) || [], dr = d.terms?.distinctive.right.slice(0, 5) || [];

    el.innerHTML = head + `
      <div class="ss-totals">
        <div><b>${tl}${compact(est(T.articles))}</b><span>articles</span></div>
        ${T.stories != null ? `<div><b>${compact(T.stories)}</b><span>stories</span></div>` : ''}
        <div><b>${T.outlets}</b><span>outlets</span></div>
        <div title="${esc(day(T.first))} → ${esc(day(T.last))}"><b>${span}</b><span>span</span></div>
      </div>
      ${d.archive ? `<div class="ss-note dim">▤ archive${k > 1 ? ` · sampled 1 in ${k}` : ''}</div>` : ''}

      <h4>bias of coverage</h4>
      <div class="ss-bias">${BIAS_KEYS.filter((x) => d.byBias[x]).map((x) =>
        `<div class="drill" data-drill="bias:${BIAS_QUERY[x]}" style="flex:${d.byBias[x]} 1 0;background:var(--${x})" title="${BIAS_NAMES[x]}: ${tl}${est(d.byBias[x]).toLocaleString()} articles (${pct(d.byBias[x], T.articles)}%) — click to narrow"></div>`).join('')}</div>
      <div class="ss-sides"><span class="l">L ${pct(L, T.articles)}%</span><span class="c">C ${pct(C, T.articles)}%</span><span class="r">R ${pct(R, T.articles)}%</span></div>

      ${topicsBlock(d, tl, est)}

      <h4>over time</h4>
      ${spark}

      ${lean ? `<h4>story lean</h4>
      <div class="ss-lean">${[['left', 'L'], ['balanced', 'C'], ['right', 'R']].filter(([x]) => lean[x]).map(([x, v]) =>
        `<div class="drill" data-drill="lean:${x}" style="flex:${lean[x]} 1 0;background:var(--${v})" title="${x}: ${lean[x]} stories — click to narrow"></div>`).join('')}</div>
      <div class="ss-sides"><span class="l">${lean.left} left</span><span class="c">${lean.balanced} balanced</span><span class="r">${lean.right} right</span></div>
      ${bl && bl.left + bl.right ? `<div class="ss-blind">blindspots:
        <button type="button" class="link drill" data-drill="blindspot:left" title="stories the left is ignoring">${bl.left} left</button> ·
        <button type="button" class="link drill" data-drill="blindspot:right" title="stories the right is ignoring">${bl.right} right</button></div>` : ''}` : ''}

      <h4>top outlets <span class="dim">· ${d.outlets.length}</span></h4>
      ${outlets.map((o) => `<div class="ss-out drill" data-solo="${esc(o.id)}" title="${esc(o.name)}: ${tl}${est(o.count).toLocaleString()} articles — click to show only this outlet">
        ${chip(o.bias)}<span class="ss-name">${esc(o.name)}</span><span class="ss-track"><i style="width:${Math.max(2, (100 * o.count) / omax)}%"></i></span><span class="ss-n">${tl}${compact(est(o.count))}</span></div>`).join('')}

      ${words.length ? `<h4>headline words</h4>
      <div class="ss-words">${words.map((w) => `<button type="button" class="drill" data-drill="title:${esc(w.w)}" title="${w.c} headlines — click to narrow">${esc(w.w)}<b>${w.c}</b></button>`).join('')}</div>` : ''}
      ${dl.length || dr.length ? `<h4>each side's words</h4>
      <div class="ss-split">
        <div><span class="l">left ›</span> ${dl.map((w) => `<button type="button" class="link drill" data-drill="title:${esc(w.w)}" title="left ${w.l} · right ${w.r}">${esc(w.w)}</button>`).join(' ') || '<span class="dim">—</span>'}</div>
        <div><span class="r">right ›</span> ${dr.map((w) => `<button type="button" class="link drill" data-drill="title:${esc(w.w)}" title="left ${w.l} · right ${w.r}">${esc(w.w)}</button>`).join(' ') || '<span class="dim">—</span>'}</div>
      </div>` : ''}
      <button type="button" class="link ss-full" data-act="full">[full query summary ▸]</button>`;
  }

  async function load(force = false) {
    const p = ctx.params();
    const q = ctx.getQuery();
    if (!force && p === key && data) return;
    key = p;
    const my = ++seq;
    el.classList.add('ss-busy');
    if (!data) el.innerHTML = '<div class="ss-empty dim"><span class="spin">⟳</span> crunching…</div>';
    try {
      const d = await api('stats?' + p);
      if (my !== seq) return;
      data = d;
      render(d, q);
    } catch (e) {
      if (my !== seq) return;
      data = null;
      el.innerHTML = `<div class="ss-q"><span class="dim">query <span class="q-sl">//</span></span> ${esc(q)}</div><div class="ss-empty err">✗ ${esc(e.data?.error || e.message)}</div>`;
    } finally { if (my === seq) el.classList.remove('ss-busy'); }
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-act=full]')) return ctx.openFull();
    const solo = e.target.closest('[data-solo]');
    if (solo) return ctx.solo(solo.dataset.solo);
    const d = e.target.closest('[data-drill]')?.dataset.drill;
    if (!d) return;
    const q = ctx.getQuery().trim();
    ctx.apply(!q ? d : /\bOR\b|\|\|/.test(q) ? `(${q}) AND ${d}` : `${q} AND ${d}`);   // parens only when needed
  });

  return {
    // called after every results load; cheap when nothing changed, debounced so paging/typing doesn't spam
    refresh(force = false) { clearTimeout(timer); timer = setTimeout(() => { if (ctx.visible()) load(force); }, 250); },
  };
}
