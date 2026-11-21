// Advanced query editor: a full-size Lucene-syntax editor (same language as the query box) with
// syntax highlighting, inline errors, caret-anchored autocomplete, live hit counts and a field reference.
import { parseQuery, lex, FIELDS } from '/query.js';

const EXAMPLES = [
  ['big stories the right isn\'t covering', 'sources:>=5 AND right:0'],
  ['an outlet + topic', 'source:(dailywire OR breitbart) AND title:nvidia'],
  ['right-leaning, last 12h, minus Fox', 'bias:[lr TO r] AND age:<12h AND NOT source:fox'],
  ['the 2008 financial crisis', 'date:[2008-09-01 TO 2008-11-30] AND title:(bailout OR lehman OR "wall street")'],
  ['one year, phrase, by side', 'date:2016 AND "health care" AND side:left'],
  ['regex on headlines', 'title:/gta ?(6|vi)/'],
  ['fuzzy + wildcard', 'huang~1 OR nvidi*'],
  ['balanced coverage of a story', 'title:speaker AND lean:balanced AND sources:>=4'],
];
const SNIPPETS = [
  ['date:2016', 'a year'], ['date:2016-05', 'a month'], ['date:[2015 TO 2018]', 'range'], ['date:<2010', 'before'],
  ['age:<24h', 'last day'], ['age:<7d', 'last week'], ['AND', ''], ['OR', ''], ['NOT', ''], ['( )', 'group'], ['" "', 'phrase'],
];

// put each top-level AND/OR clause on its own line (purely cosmetic — whitespace is insignificant)
export function formatQuery(src) {
  const toks = lex(src);
  let depth = 0, out = '', pos = 0;
  for (const t of toks) {
    const gap = src.slice(pos, t.s);
    if (t.t === '(') depth++;
    if (t.t === ')') depth--;
    if (depth === 0 && (t.t === 'AND' || t.t === 'OR') && out) out = out.trimEnd() + '\n' + t.t + ' ';
    else out += (out && !/\s$/.test(out) && gap ? ' ' : '') + src.slice(t.s, t.e);
    pos = t.e;
  }
  return out.trim();
}

export function createEditor(ctx) {
  const dlg = document.getElementById('dlg-advanced');
  const body = document.getElementById('advanced-body');
  const esc = ctx.esc;

  body.innerHTML = `
    <div class="dlg-head"><span>// ADVANCED QUERY <span class="dim">— Lucene syntax</span></span><button type="button" class="link" data-act="close" title="close (esc)">[esc]</button></div>
    <div class="qtabs" data-qtabs></div>
    <div class="ae-grid">
      <div class="ae-main">
        <div class="ae-wrap ac-host">
          <pre class="ae-hl" aria-hidden="true"></pre>
          <div class="ae-mirror" aria-hidden="true"></div>
          <textarea id="ae-input" spellcheck="false" autocomplete="off" rows="8"
            placeholder="title:(trump OR clinton) AND date:[2016-01-01 TO 2016-11-30]&#10;AND source:(nyt OR breitbart) AND NOT bias:c"></textarea>
        </div>
        <div class="ae-status" id="ae-status"></div>
        <div class="ae-snips">${SNIPPETS.map(([s, h]) => `<button type="button" class="ae-snip" data-ins="${esc(s)}" title="${esc(h)}">${esc(s)}</button>`).join('')}</div>
        <div class="dlg-foot">
          <button type="button" data-act="format" title="one top-level clause per line">FORMAT</button>
          <button type="button" data-act="clear">CLEAR</button>
          <button type="button" data-act="load" title="reload the query from the query box">LOAD CURRENT</button>
          <span class="qb-sp"></span>
          <button type="button" data-act="save">SAVE AS TAB…</button>
          <button type="button" data-act="apply" class="primary" title="Enter applies · shift+Enter adds a line">APPLY ⏎</button>
        </div>
      </div>
      <aside class="ae-ref">
        <div class="ae-ref-h">fields <span class="dim">— click to insert</span></div>
        ${['article', 'story'].map((scope) => `<div class="ae-scope">${scope === 'story' ? 'story-level' : 'per article'}</div>` +
          Object.entries(FIELDS).filter(([, f]) => f.scope === scope).map(([name, f]) =>
            `<button type="button" class="ae-field" data-ins="${name}:" title="${esc((f.examples || []).map((x) => name + ':' + x).join('   '))}"><b>${name}:</b> <span>${esc(f.desc)}</span></button>`).join('')).join('')}
        <div class="ae-ref-h">examples <span class="dim">— click to load</span></div>
        ${EXAMPLES.map(([d, q]) => `<button type="button" class="ae-ex" data-q="${esc(q)}"><span class="dim">${esc(d)}</span><code>${esc(q)}</code></button>`).join('')}
        <div class="ae-ref-h">syntax</div>
        <div class="ae-syntax dim">terms AND by default · <b>"phrase"</b> · <b>field:(a OR b)</b> · <b>NOT</b> / <b>-x</b> · <b>( )</b> grouping ·
          <b>x*</b> <b>x?</b> wildcards · <b>x~1</b> fuzzy · <b>/re/</b> regex · <b>[a TO b]</b> ranges · <b>&gt; &gt;= &lt; &lt;=</b> ·
          dates outside the live window search the <span class="arch-badge">▤ archive</span> · Tab autocompletes</div>
      </aside>
    </div>`;

  const ta = body.querySelector('#ae-input');
  const hl = body.querySelector('.ae-hl');
  const mirror = body.querySelector('.ae-mirror');
  const status = body.querySelector('#ae-status');
  const oneLine = (q) => q.replace(/\s*\n\s*/g, ' ').trim();

  let countTimer, countSeq = 0, quiet = false;
  function refresh() {
    const q = ta.value;
    if (!quiet) ctx.onChange?.(oneLine(q));            // keep the query bar and the builder in step
    const my = ++countSeq;                 // invalidates any count still in flight for an older text
    let err = null;
    try { parseQuery(q); } catch (e) { err = e; }
    hl.innerHTML = ctx.highlight(q, err) + '\n';
    hl.scrollTop = ta.scrollTop;
    clearTimeout(countTimer);
    if (err) {
      const line = q.slice(0, err.pos).split('\n').length;
      status.className = 'ae-status bad';
      status.textContent = `✗ ${err.message}${q.includes('\n') ? `  (line ${line})` : ''}`;
      return;
    }
    status.className = 'ae-status';
    status.textContent = q.trim() ? '✓ valid · counting…' : 'empty query matches everything';
    if (!q.trim()) return;
    countTimer = setTimeout(async () => {
      try {
        const r = await ctx.count(oneLine(q));
        if (my !== countSeq) return;
        status.innerHTML = `✓ valid · <b>${r.archive?.approx ? '~' : ''}${r.total.toLocaleString()}</b> ${r.unit}${r.archive ? ` <span class="arch-badge">▤ archive</span> <span class="dim">of ${r.archive.indexed.toLocaleString()} indexed · articles only</span>` : ' <span class="dim">(live feeds)</span>'}`;
      } catch (e) { if (my === countSeq) { status.className = 'ae-status bad'; status.textContent = `✗ ${e.message}`; } }
    }, 300);
  }

  function insert(text) {
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    let ins = text;
    if (text === '( )') ins = '()';
    if (text === '" "') ins = '""';
    const before = v.slice(0, s);
    if (before && !/[\s(]$/.test(before)) ins = ' ' + ins;
    if (/^(AND|OR|NOT)$/.test(text)) ins += ' ';
    ta.value = before + ins + v.slice(e);
    let caret = s + ins.length;
    if (text === '( )' || text === '" "') caret -= 1;               // land inside the pair
    ta.focus();
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // autocomplete anchored at the caret (mirror div measures where the caret is)
  ctx.attachAutocomplete(ta, (v, caret, force) => ctx.suggest(v, caret, force), {
    position(box) {
      mirror.textContent = ta.value.slice(0, ta.selectionStart);
      const mark = document.createElement('span');
      mark.textContent = '​';
      mirror.appendChild(mark);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      const top = mark.offsetTop - ta.scrollTop + lh + 4;
      const maxLeft = Math.max(0, ta.clientWidth - 420);
      box.style.top = `${Math.min(top, ta.clientHeight + 4)}px`;
      box.style.left = `${Math.min(mark.offsetLeft, maxLeft)}px`;
      box.style.right = 'auto';
      box.style.width = '420px';
    },
  });

  ta.addEventListener('input', refresh);
  ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    // Enter (or ⌃⏎) applies, like the query bar; shift+Enter adds a line. A highlighted suggestion takes a
    // plain Enter first (the autocomplete handler runs before this one).
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); act('apply'); }
  });

  function act(a, el) {
    const q = ta.value;
    switch (a) {
      case 'close': return dlg.close();
      case 'apply': if (!refreshValid()) return; ctx.apply(oneLine(q)); return dlg.close();
      case 'save': if (!refreshValid()) return; dlg.close(); return ctx.saveAs(oneLine(q));
      case 'format': ta.value = formatQuery(q); break;
      case 'clear': ta.value = ''; break;
      case 'load': ta.value = formatQuery(ctx.getQuery()); break;
      case 'example': ta.value = formatQuery(el.dataset.q); break;
      default: return;
    }
    ta.focus();
    refresh();
  }
  function refreshValid() {
    try { parseQuery(ta.value); return true; } catch { refresh(); ta.focus(); return false; }
  }

  body.addEventListener('click', (e) => {
    const ins = e.target.closest('[data-ins]');
    if (ins) return insert(ins.dataset.ins);
    const ex = e.target.closest('.ae-ex');
    if (ex) return act('example', ex);
    const a = e.target.closest('[data-act]');
    if (a) act(a.dataset.act);
  });

  return {
    // mirror a query typed elsewhere (only while open; opening loads the current query anyway)
    setText(q) {
      if (!dlg.open || oneLine(ta.value) === oneLine(q || '')) return;
      const atEnd = ta.selectionStart === ta.value.length;
      ta.value = q || '';
      if (atEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
      quiet = true; try { refresh(); } finally { quiet = false; }
    },
    open(q = ctx.getQuery()) {
      ta.value = q && q.length > 60 ? formatQuery(q) : (q || '');
      dlg.showModal();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      refresh();
    },
  };
}
