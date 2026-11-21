import { TOPIC_DESC } from '/topics.js';
// Query summary popover: totals and charts for the current query's full result set.
// Charts are plain HTML/CSS (crisp at any size, themeable). Color jobs:
//   bias / side  → the app's diverging scale (blue ↔ neutral gray ↔ red), validated for CVD on the dark surface
//   ranked bars  → one hue (the theme accent); the outlet's bias chip carries identity, not the bar
const BIAS_KEYS = ['L', 'LL', 'C', 'LR', 'R'];
const BIAS_NAMES = { L: 'Left', LL: 'Lean left', C: 'Center', LR: 'Lean right', R: 'Right' };
const BIAS_QUERY = { L: 'l', LL: 'll', C: 'c', LR: 'lr', R: 'r' };
const SIDES = [['left', 'Left', 'var(--L)'], ['center', 'Center', 'var(--C)'], ['right', 'Right', 'var(--R)']];
const LEANS = [['left', 'Left-leaning', 'var(--L)'], ['balanced', 'Balanced', 'var(--C)'], ['right', 'Right-leaning', 'var(--R)']];

const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K' : n.toLocaleString());
const pct = (x, t) => (t ? Math.round((100 * x) / t) : 0);
const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);

function bucketLabel(t, unit, long = false) {
  const d = new Date(t);
  const o = { timeZone: 'UTC' };
  switch (unit) {
    case 'hour': case '6 hours': return d.toLocaleString([], { ...o, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    case 'day': return d.toLocaleDateString([], { ...o, month: 'short', day: 'numeric', ...(long ? { year: 'numeric' } : {}) });
    case 'week': return (long ? 'week of ' : '') + d.toLocaleDateString([], { ...o, month: 'short', day: 'numeric', year: 'numeric' });
    case 'month': return d.toLocaleDateString([], { ...o, month: 'short', year: 'numeric' });
    case 'quarter': return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
    default: return String(d.getUTCFullYear());
  }
}

export function createStats(ctx) {
  const dlg = document.getElementById('dlg-stats');
  const body = document.getElementById('stats-body');
  const tip = document.createElement('div');
  tip.className = 'st-tip';
  tip.hidden = true;
  const esc = ctx.esc;
  let data = null, showAllOutlets = false, timelineTable = false, query = '';

  // sticky header (title, query, close) and footer (hint, CLOSE), like the story and reader popovers
  const headHTML = (meta = '') => `<div class="st-head">
      <div class="dlg-head"><span>// QUERY SUMMARY</span><button type="button" class="link" data-act="close" title="close (esc)">[esc]</button></div>
      <div class="st-q"><span class="dim">query <span class="q-sl">//</span></span> <code>${query ? esc(query) : '<span class="dim">(none — everything in view)</span>'}</code>${meta}</div>
    </div>`;
  const footHTML = (hint = '') => `<div class="st-foot-bar"><span class="dim">${hint || 'esc close'}</span><button type="button" data-act="close">CLOSE</button></div>`;

  // ── pieces ──
  const tile = (label, value, sub = '') => `<div class="st-tile"><div class="st-tile-l">${label}</div><div class="st-tile-v">${value}</div>${sub ? `<div class="st-tile-s">${sub}</div>` : ''}</div>`;

  // tall segmented bar: one whole, ≤ 6 parts, share printed inside where it fits; legend names the parts
  function tallBar(parts, total, drill) {
    const shown = parts.filter((p) => p.value > 0);
    return `<div class="st-tall" role="img" aria-label="${esc(shown.map((p) => `${p.name} ${p.value} (${pct(p.value, total)}%)`).join(', '))}">
      ${shown.map((p) => {
        const w = (100 * p.value) / total;
        return `<div class="st-seg${drill ? ' drill' : ''}" style="flex:${p.value} 1 0;background:${p.color}" data-tip="${esc(`${p.name}|${E(p.value)} articles|${pct(p.value, total)}%`)}"${drill ? ` data-drill="${esc(drill(p))}"` : ''}>${w >= 7 ? `<span>${pct(p.value, total)}%</span>` : ''}</div>`;
      }).join('')}
    </div>
    <div class="st-legend">${parts.map((p) => `<span><i style="background:${p.color}"></i>${p.name}${(100 * p.value) / total < 7 ? ` <b>${pct(p.value, total)}%</b>` : ''}</span>`).join('')}</div>`;
  }

  // thin segmented bar with its figures beside it (no text on the bar)
  function thinRow(label, parts, total, unit) {
    return `<div class="st-thin-row"><div class="st-thin-l">${label}</div>
      <div class="st-thin" role="img" aria-label="${esc(parts.map((p) => `${p.name} ${p.value}`).join(', '))}">${parts.filter((p) => p.value).map((p) =>
        `<div style="flex:${p.value} 1 0;background:${p.color}" data-tip="${esc(`${p.name}|${unit === 'articles' ? E(p.value) : p.value.toLocaleString()} ${unit}|${pct(p.value, total)}%`)}"></div>`).join('')}</div>
      <div class="st-thin-f">${parts.map((p) => `<span><i style="background:${p.color}"></i>${p.name} <b>${unit === 'articles' ? E(p.value) : p.value.toLocaleString()}</b></span>`).join('')}</div></div>`;
  }

  // ranked horizontal bars, one hue
  function rankRows(rows, max, { label, drill, unit }) {
    return rows.map((r) => `<div class="st-rank${drill ? ' drill' : ''}"${drill ? ` data-drill="${esc(drill(r))}"` : ''} data-tip="${esc(`${r.plain ?? r.name}|${r.count.toLocaleString()} ${unit}`)}">
      <div class="st-rank-l">${label(r)}</div>
      <div class="st-rank-track"><div style="width:${Math.max(0.5, (100 * r.count) / max)}%"></div></div>
      <div class="st-rank-v">${r.count.toLocaleString()}</div></div>`).join('');
  }

  // topics: stories per topic in STORIES mode, else articles (sampled archive results are estimates)
  let topicData = null;
  function topicCard() {
    const d = topicData;
    if (!d) return '';
    const byStory = !!d.storiesByTopic;
    const src = byStory ? d.storiesByTopic : d.byTopic;
    const rows = Object.entries(src || {}).sort((a, b) => (a[0] === 'other') - (b[0] === 'other') || b[1] - a[1])
      .map(([t, n]) => ({ name: `#${t}`, plain: `${t} — ${TOPIC_DESC[t] || ''}`, t, count: byStory ? n : est(n) }));
    if (!rows.length) return '';
    const tot = rows.reduce((a, r) => a + r.count, 0);
    return `<section class="st-card"><h3>Topics <span class="dim">— ${byStory ? 'stories' : 'articles'} per topic · from the link's section, else headline keywords</span></h3>
      ${rankRows(rows, Math.max(...rows.map((r) => r.count)), { unit: `${byStory ? 'stories' : tilde ? 'articles (est.)' : 'articles'}`,
        label: (r) => `${esc(r.name)} <span class="dim">${Math.round((100 * r.count) / tot)}%</span>`, drill: (r) => `topic:${r.t}` })}
    </section>`;
  }

  let est = (n) => n, tilde = '';
  const E = (n) => (n && tilde ? '~' : '') + est(n).toLocaleString();   // estimated count; exact zero stays "0"
  function timeline(tl) {
    const b = tl.buckets;
    const max = Math.max(1, ...b.map((x) => x.left + x.center + x.right));
    const drillable = !['hour', '6 hours'].includes(tl.unit);
    if (timelineTable) {
      return `<div class="st-table-wrap"><table class="st-table"><thead><tr><th>${tl.unit}</th><th>left</th><th>center</th><th>right</th><th>total</th></tr></thead><tbody>
        ${b.map((x) => `<tr><td>${esc(bucketLabel(x.t, tl.unit, true))}</td><td>${est(x.left)}</td><td>${est(x.center)}</td><td>${est(x.right)}</td><td>${est(x.left + x.center + x.right)}</td></tr>`).join('')}
      </tbody></table></div>`;
    }
    const ticks = [0, Math.floor((b.length - 1) / 2), b.length - 1].filter((v, i, a) => a.indexOf(v) === i);
    return `<div class="st-tl">
      <div class="st-tl-y"><span>${tilde}${compact(est(max))}</span><span>${tilde}${compact(est(Math.round(max / 2)))}</span><span>0</span></div>
      <div class="st-tl-plot">
        <div class="st-grid"><i></i><i></i><i></i></div>
        <div class="st-cols">${b.map((x) => {
          const tot = x.left + x.center + x.right;
          const tipText = `${bucketLabel(x.t, tl.unit, true)}|${E(tot)} articles|L ${E(x.left)} · C ${E(x.center)} · R ${E(x.right)}`;
          const drill = drillable && tot ? `date:[${isoDay(x.t)} TO ${isoDay(x.end - 86400e3)}]` : '';
          return `<div class="st-col${drill ? ' drill' : ''}" data-tip="${esc(tipText)}"${drill ? ` data-drill="${esc(drill)}"` : ''}>
            <div class="st-stack" style="height:${(100 * tot) / max}%">${SIDES.map(([k, , c]) => (x[k] ? `<div style="flex:${x[k]} 1 0;background:${c}"></div>` : '')).reverse().join('')}</div></div>`;
        }).join('')}</div>
        <div class="st-tl-x">${ticks.map((i) => `<span style="left:${((i + 0.5) / b.length) * 100}%">${esc(bucketLabel(b[i].t, tl.unit))}</span>`).join('')}</div>
      </div>
    </div>`;
  }

  function render() {
    const d = data;
    const T = d.totals;
    const k = d.sample?.k > 1 ? d.sample.k : 1;            // sampled 1-in-k → scale counts back up
    est = (n) => (k > 1 ? Math.round(n * k) : n);
    tilde = k > 1 ? '~' : '';
    const head = headHTML(`<span class="dim">· ${esc(d.mode)}${d.archive ? ' · <span class="arch-badge">▤ archive</span>' : ' · live feeds'} · ${d.ms} ms</span>`) + `
      ${d.archive ? `<div class="st-warn">▤ Archive results reflect what has been backfilled so far. History arrives unevenly per outlet, so bias splits for past dates can be skewed until the backfill finishes — see <button type="button" class="link" data-act="archive">[archive]</button> for per-outlet coverage.${k > 1 ? ` Counts below are estimated from an evenly spread 1-in-${k} sample of ${d.sample.matched.toLocaleString()} matches; shares are unaffected.` : ''}</div>` : ''}`;
    if (!T.articles) { body.innerHTML = head + '<div class="empty">&gt; no matches for this query</div>' + footHTML(); return; }

    const spanDays = (T.last - T.first) / 86400e3;
    const spanTxt = spanDays < 2 ? `${Math.max(1, Math.round(spanDays * 24))} hours` : spanDays < 120 ? `${Math.round(spanDays)} days` : `${(spanDays / 365.25).toFixed(1)} years`;
    const bl = d.blindspots;
    const tiles = [
      d.totals.stories != null ? tile('Stories', compact(T.stories), d.storiesFromNewest ? `grouped from the newest ${d.archive.candidates.toLocaleString()} matches` : `${(T.articles / Math.max(1, T.stories)).toFixed(1)} articles each`) : '',
      tile('Articles', tilde + compact(est(T.articles)), k > 1 ? `estimated · sampled 1 in ${k}` : T.approx ? `${pct(T.approx, T.articles)}% ≈ URL headlines` : 'real headlines'),
      tile('Outlets', T.outlets, `of ${ctx.outletCount()} enabled`),
      tile('Time span', spanTxt, `${isoDay(T.first)} → ${isoDay(T.last)}`),
      bl ? tile('Blindspots', (bl.left + bl.right).toLocaleString(), `left ignoring ${bl.left} · right ignoring ${bl.right}`) : '',
    ].join('');

    const biasParts = BIAS_KEYS.map((k) => ({ key: k, name: BIAS_NAMES[k], value: d.byBias[k], color: `var(--${k})` }));
    const outletsByBias = BIAS_KEYS.map((k) => ({ name: BIAS_NAMES[k], value: d.outletsByBias[k], color: `var(--${k})` }));
    const L = d.byBias.L + d.byBias.LL, R = d.byBias.R + d.byBias.LR;

    const outlets = showAllOutlets ? d.outlets : d.outlets.slice(0, 12);
    const outletMax = d.outlets[0]?.count || 1;
    topicData = d;
    const terms = d.terms;
    const termTable = (rows, side) => (rows.length
      ? `<table class="st-table st-terms"><thead><tr><th>word</th><th title="left-leaning outlets">L</th><th title="right-leaning outlets">R</th></tr></thead><tbody>${rows.map((r) =>
          `<tr class="drill" data-drill="title:${esc(r.w)}" data-tip="${esc(`${r.w}|left ${r.l} · right ${r.r}|${side} uses it more`)}"><td>${esc(r.w)}</td><td>${r.l}</td><td>${r.r}</td></tr>`).join('')}</tbody></table>`
      : '<div class="dim small">not enough partisan coverage to compare</div>');

    body.innerHTML = head + `
      <div class="st-tiles">${tiles}</div>

      <section class="st-card"><h3>Coverage by outlet bias <span class="dim">— share of articles</span></h3>
        ${tallBar(biasParts, T.articles, (p) => `bias:${BIAS_QUERY[p.key]}`)}
        <div class="st-thin-wrap">
          ${thinRow('outlets', outletsByBias, T.outlets, 'outlets')}
          ${thinRow('sides', [{ name: 'Left', value: L, color: 'var(--L)' }, { name: 'Center', value: d.byBias.C, color: 'var(--C)' }, { name: 'Right', value: R, color: 'var(--R)' }], T.articles, 'articles')}
          ${thinRow('media', [{ name: 'Legacy', value: d.media.legacy, color: 'var(--dim)' }, { name: 'New media', value: d.media.new, color: 'var(--fg)' }], T.articles, 'articles')}
          ${d.lean ? thinRow('story lean', LEANS.map(([k, n, c]) => ({ name: n, value: d.lean[k], color: c })), T.stories, 'stories') : ''}
        </div>
      </section>

      <section class="st-card"><h3>Coverage over time <span class="dim">— articles per ${esc(d.timeline.unit)}, by side</span>
          <span class="st-sp"></span><button type="button" class="link" data-act="tl-table">[${timelineTable ? 'chart' : 'table'}]</button></h3>
        <div class="st-legend">${SIDES.map(([, n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('')}</div>
        ${timeline(d.timeline)}
      </section>

      ${topicCard()}

      <div class="st-two">
        <section class="st-card"><h3>Top outlets <span class="dim">— ${d.outlets.length} total</span></h3>
          ${rankRows(outlets.map((o) => ({ ...o, count: est(o.count) })), est(outletMax), { unit: tilde ? 'articles (est.)' : 'articles', label: (r) => `${ctx.chip(r.bias)} ${esc(r.name)}`, drill: (r) => `source:${r.id}` })}
          ${d.outlets.length > 12 ? `<button type="button" class="link st-more" data-act="outlets">[${showAllOutlets ? 'top 12' : `all ${d.outlets.length}`}]</button>` : ''}
        </section>
        ${d.storyCoverage ? `<section class="st-card"><h3>Stories by number of outlets</h3>
          ${rankRows(d.storyCoverage.map((c) => ({ ...c, name: `${c.label} outlet${c.label === '1' ? '' : 's'}`, plain: `${c.label} outlets` })), Math.max(1, ...d.storyCoverage.map((c) => c.count)),
            { unit: 'stories', label: (r) => esc(r.name), drill: (r) => (r.hi == null ? `sources:>=${r.lo}` : r.lo === r.hi ? `sources:${r.lo}` : `sources:[${r.lo} TO ${r.hi}]`) })}
          <h3 class="st-h3b">Most common headline words</h3>
          <div class="st-chips">${terms.common.map((t) => `<button type="button" class="st-chip drill" data-drill="title:${esc(t.w)}" data-tip="${esc(`${t.w}|${t.c} headlines`)}">${esc(t.w)} <b>${t.c}</b></button>`).join('')}</div>
        </section>` : `<section class="st-card"><h3>Most common headline words</h3>
          <div class="st-chips">${terms.common.map((t) => `<button type="button" class="st-chip drill" data-drill="title:${esc(t.w)}" data-tip="${esc(`${t.w}|${t.c} headlines`)}">${esc(t.w)} <b>${t.c}</b></button>`).join('')}</div></section>`}
      </div>

      <section class="st-card"><h3>How each side words it <span class="dim">— headline words used disproportionately by left- vs right-leaning outlets</span></h3>
        <div class="st-two st-two-tight">
          <div><div class="st-side-h" style="--c:var(--L)">left uses more</div>${termTable(terms.distinctive.left, 'left')}</div>
          <div><div class="st-side-h" style="--c:var(--R)">right uses more</div>${termTable(terms.distinctive.right, 'right')}</div>
        </div>
      </section>
      ${footHTML('click any bar, outlet, word or column to narrow the query to it · hover for values · esc close')}`;
    body.appendChild(tip);
  }

  async function load() {
    body.innerHTML = headHTML() + '<div class="dim st-loading"><span class="spin">⟳</span> crunching…</div>' + footHTML();
    try {
      const p = ctx.params();
      data = await ctx.api('stats?' + p);
      render();
    } catch (e) {
      body.innerHTML = headHTML() + `<div class="err">✗ ${esc(e.message)}</div>` + footHTML();
    }
  }

  // tooltip: values lead, label follows; text via textContent only
  body.addEventListener('pointermove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    const [title, value, extra] = el.dataset.tip.split('|');
    tip.replaceChildren();
    const v = document.createElement('b'); v.textContent = value; tip.appendChild(v);
    const t = document.createElement('div'); t.textContent = title; tip.appendChild(t);
    if (extra) { const x = document.createElement('div'); x.className = 'dim'; x.textContent = extra; tip.appendChild(x); }
    tip.hidden = false;
    const r = body.getBoundingClientRect();
    const x = Math.min(e.clientX - r.left + 14, body.clientWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY - r.top + body.scrollTop + 14}px`;
  });
  body.addEventListener('pointerleave', () => { tip.hidden = true; });

  body.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'close') return dlg.close();
    if (a === 'outlets') { showAllOutlets = !showAllOutlets; return render(); }
    if (a === 'tl-table') { timelineTable = !timelineTable; return render(); }
    if (a === 'archive') { dlg.close(); return ctx.openArchive(); }
    const drill = e.target.closest('[data-drill]')?.dataset.drill;
    if (drill) {
      const q = query.trim() ? `(${query.trim()}) AND ${drill}` : drill;
      dlg.close();
      ctx.apply(q);
    }
  });

  return {
    open() {
      query = ctx.getQuery().trim();
      showAllOutlets = false; timelineTable = false;
      dlg.showModal();
      load();
    },
  };
}
