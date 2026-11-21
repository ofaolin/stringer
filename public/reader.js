// Reader view: a floating window that shows an article's text (extracted server-side by /api/read),
// themed like the rest of the site. Browsers don't let pages trigger their own reader mode, and most news
// sites refuse to be framed, so this is the in-app equivalent. Falls back to an embedded frame / new tab.
// morgue no. tag (same markup as app.js; the click-to-copy handler lives there, on the document)
const morgueTag = (morgue, esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])) =>
  `<button type="button" class="link morgue" data-act="copy-morgue" data-morgue="${esc(morgue)}" title="${esc(`STRINGER's catalog number for the copy of this article it filed — newsrooms call their archive of clippings “the morgue”.`)}" data-tip-head="▣ STRINGER MORGUE" data-tip-head-right="no. ${esc(morgue.slice(0, 8))}" data-tip-foot="click to copy · find it with morgue:${esc(morgue.slice(0, 8))}">morgue no. ${esc(morgue.slice(0, 8))}</button>`;
const FONTS = [['mono', 'monospace'], ['serif', 'serif'], ['sans', 'sans-serif']];

export function createReader(ctx) {
  const { esc, chip, srcById, safeUrl, api, store } = ctx;
  const disc = ctx.discussion || null;                // comment sidebar helpers from app.js (aside markup, mount, toggle)
  const dlg = document.getElementById('dlg-reader');
  const body = document.getElementById('reader-body');
  let cur = null, seq = 0;
  let font = store.get('readerFont', 'serif');
  let size = store.get('readerSize', 17);

  const applyPrefs = () => {
    dlg.dataset.font = font;
    dlg.style.setProperty('--rd-size', `${size}px`);
    const f = body.querySelector('[data-act=font]');
    if (f) f.textContent = `Aa ${font}`;
  };
  const fmtDate = (d) => { const t = new Date(d); return Number.isNaN(+t) ? '' : t.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }); };

  // the page to send people to: the original, or its Wayback Machine copy when the original is gone
  const target = () => cur.wayback?.url || cur.link;
  const targetLabel = () => (cur.wayback ? 'archived copy' : 'original');

  function frame(inner, { loading = false } = {}) {
    const a = cur;
    const s = srcById(a.sourceId);
    body.innerHTML = `
      <div class="rd-head">
        <span class="rd-src">// READER${s ? ` <span class="dim">/</span> ${chip(s.bias)} ${esc(s.name)}` : ''}</span>
        <span class="rd-tools">
          <button type="button" class="link" data-act="find" title="find in this article (/ or f)">[⌕ find]</button>
          <button type="button" class="link" data-act="smaller" title="smaller text">[A−]</button>
          <button type="button" class="link" data-act="bigger" title="bigger text">[A+]</button>
          <button type="button" class="link" data-act="font" title="switch typeface: mono / serif / sans"></button>
          <a class="link" href="${esc(safeUrl(target()))}" target="_blank" rel="noopener noreferrer" title="open the ${cur.wayback ? 'Wayback Machine copy (the original page is gone)' : 'original page'} in a new tab (enter / o)">[${targetLabel()} ↗]</a>
          <button type="button" class="link" data-act="close" title="close (esc)">[esc]</button>
        </span>
        <div class="rd-find"${find.open ? '' : ' hidden'}>
          <span class="dim">find ›</span>
          <input class="rd-find-q" type="search" value="${esc(find.q)}" placeholder="find in this article…" spellcheck="false" autocomplete="off" />
          <span class="rd-find-n dim"></span>
          <button type="button" class="link" data-act="find-prev" title="previous match (shift+⏎)">[▲]</button>
          <button type="button" class="link" data-act="find-next" title="next match (⏎)">[▼]</button>
          <button type="button" class="link" data-act="find-close" title="close find (esc)">[×]</button>
        </div>
      </div>
      ${disc ? `<div class="pop-split rd-split ${disc.collapsed() ? 'collapsed' : ''}" data-pane="${disc.pane(true)}">${disc.aside([['ON THIS ARTICLE', 'rd-cm']], { details: 'rd-info', notes: 'rd-note' })}<div class="pop-main">` : ''}
      <article class="rd-page${loading ? ' rd-loading' : ''}">${inner}</article>
      ${disc ? '</div></div>' : ''}
      <div class="rd-foot">
        <span class="dim rd-keys"><span>esc close · ⏎/o open ${targetLabel()} · j/k ↑/↓ space scroll · / find</span>${rs?.signedIn() || disc ? `<span>${[rs?.signedIn() && 'm read/unread', disc && 'c discussion · i details'].filter(Boolean).join(' · ')}</span>` : ''}</span>
        <span class="rd-foot-btns"><button type="button" data-act="close">CLOSE</button> <a class="btn primary" href="${esc(safeUrl(target()))}" target="_blank" rel="noopener noreferrer">OPEN ${targetLabel().toUpperCase()} ↗</a></span>
      </div>`;
    applyPrefs();
    if (find.open && find.q) runFind(find.q, { scroll: false });   // the article text just (re)loaded: mark it again
    disc?.notes?.('rd-note', a);                      // your note on it (saves it to your binder)
    disc?.mount('rd-cm', a.link);                     // the article's discussion (kept across re-renders)
    disc?.details?.('rd-info', a);                    // …and its details (outlet, morgue, stories it's in)
    disc?.place?.();
  }

  // ✓ read / ○ unread (signed in): opening an article marks it read; click or m toggles it
  const rs = ctx.readState || null;
  const readBadge = () => (rs?.signedIn() && cur?.link ? (rs.isRead(cur.link)
    ? ' <button type="button" class="read-badge rd-read" data-act="toggle-read" title="you\'ve read this — click or press m to mark it unread">✓ read</button>'
    : ' <button type="button" class="read-badge unread rd-read" data-act="toggle-read" title="not read — click or press m to mark it read">○ unread</button>') : '');
  async function toggleRead() {
    if (!rs?.signedIn() || !cur?.link) return;
    await rs.toggle(cur);
    const el = body.querySelector('.rd-read');
    if (el) el.outerHTML = readBadge().trim();
  }
  // the page flips an article to read a moment after it opens: redraw the badge (animated) if it's this one
  function refreshRead(link) {
    if (!dlg.open || cur?.link !== link) return;
    const el = body.querySelector('.rd-read');
    if (el) { el.outerHTML = readBadge().trim(); body.querySelector('.rd-read')?.classList.add('just-read'); }
  }

  // ── find in the article: every match marked, the current one emphasised and scrolled to ──
  const find = { open: false, q: '', hits: [], i: -1 };
  function clearHits() {
    const parents = new Set();
    for (const m of find.hits) { if (!m.isConnected) continue; parents.add(m.parentNode); m.replaceWith(document.createTextNode(m.textContent)); }
    for (const p of parents) p.normalize();
    find.hits = []; find.i = -1;
  }
  function runFind(q, { scroll = true } = {}) {
    clearHits();
    const n = body.querySelector('.rd-find-n');
    const page = body.querySelector('.rd-page');
    const needle = q.trim().toLowerCase();
    find.ran = needle;
    if (!needle || !page) { if (n) { n.textContent = ''; n.className = 'rd-find-n dim'; } return; }
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement?.closest('script, style, button, .rd-hit') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const nodes = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if (t.nodeValue.toLowerCase().includes(needle)) nodes.push(t);
    for (const t of nodes) {
      const text = t.nodeValue, low = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (let k = low.indexOf(needle); k !== -1; k = low.indexOf(needle, k + needle.length)) {
        if (k > pos) frag.append(text.slice(pos, k));
        const m = document.createElement('mark');
        m.className = 'rd-hit';
        m.textContent = text.slice(k, k + needle.length);
        frag.append(m);
        find.hits.push(m);
        pos = k + needle.length;
      }
      if (pos < text.length) frag.append(text.slice(pos));
      t.replaceWith(frag);
    }
    find.hits.sort((x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    if (find.hits.length) gotoHit(0, scroll);
    else if (n) { n.textContent = 'no matches'; n.className = 'rd-find-n bad'; }
  }
  function gotoHit(i, scroll = true) {
    if (!find.hits.length) return;
    find.hits[find.i]?.classList.remove('cur');
    find.i = (i + find.hits.length) % find.hits.length;
    const m = find.hits[find.i];
    m.classList.add('cur');
    if (scroll) m.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const n = body.querySelector('.rd-find-n');
    if (n) { n.textContent = `${find.i + 1} / ${find.hits.length}`; n.className = 'rd-find-n'; }
  }
  function openFind() {
    find.open = true;
    const bar = body.querySelector('.rd-find');
    if (!bar) return;
    bar.hidden = false;
    const inp = bar.querySelector('.rd-find-q');
    inp.focus(); inp.select();
    if (find.q && !find.hits.length) runFind(find.q);
  }
  function closeFind() {
    find.open = false;
    clearHits();
    const bar = body.querySelector('.rd-find');
    if (bar) bar.hidden = true;
    body.focus({ preventScroll: true });
  }
  let findTimer;
  body.addEventListener('input', (e) => {
    if (!e.target.matches('.rd-find-q')) return;
    find.q = e.target.value;
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runFind(find.q), 120);
  });
  body.addEventListener('keydown', (e) => {
    if (!e.target.matches?.('.rd-find-q')) return;
    e.stopPropagation();                                   // typing here must not trigger reader shortcuts
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); if (find.ran === find.q.trim().toLowerCase() && find.hits.length) gotoHit(find.i + (e.shiftKey ? -1 : 1)); else runFind(find.q); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });

  // the article just got a morgue no. (saved to a binder as a fragment while open): show its tag now
  let lastR = null;
  function noteMorgue(link, morgue) {
    if (!dlg.open || cur?.link !== link || !lastR || lastR.morgue) return;
    lastR = { ...lastR, morgue, fragment: !lastR.ok, archived: Date.now() };
    const page = body.querySelector('.rd-page');
    if (!page) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = header(lastR);
    page.querySelector('h1')?.replaceWith(tmp.querySelector('h1'));
    page.querySelector('.rd-meta')?.replaceWith(tmp.querySelector('.rd-meta'));
    addQueryTag();
  }
  // Is this picture already in the article text? Sites serve one image under several addresses (another CDN host,
  // a resized path like …/1200/675/…, a -1200x675 suffix, another format, a query string): compare by file name.
  // (A short or generic name falls back to the exact address — better a duplicate than a missing photo.)
  const imgKey = (u) => {
    try {
      const f = decodeURIComponent(new URL(u, 'https://x.invalid').pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
      const k = f.replace(/\.(jpe?g|png|webp|gif|avif)$/, '').replace(/[-_@](\d{2,4}x\d{2,4}|\d{2,4}w|[23]x)$/, '');
      return k.length >= 8 && !/^(image|photo|img|picture|hero|lead|default)[-_]?\d*$/.test(k) && !/^\d+$/.test(k) ? k : '';
    } catch { return ''; }
  };
  function hasImage(html, url) {
    const unamp = (x) => x.replace(/&amp;/g, '&');
    const srcs = [...String(html || '').matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => unamp(m[1]));
    if (srcs.includes(url)) return true;
    const k = imgKey(url);
    return !!k && srcs.some((s) => imgKey(s) === k);
  }
  function header(r) {
    const a = cur;
    const title = r?.retitled || r?.title || a.title || '';
    const bits = [r?.byline && `by ${esc(r.byline)}`, (r?.published || a.date) && esc(fmtDate(r?.published || a.date)), r?.words && `${Math.max(1, Math.round(r.words / 230))} min read`].filter(Boolean);
    // ▣ MORGUE: this text is STRINGER's saved copy (filed in the morgue; survives the page dying)
    const arch = r?.morgue ? `<button type="button" class="ft${r.fragment ? ' partial' : ''}" data-act="copy-morgue" data-morgue="${esc(r.morgue)}" title="${esc(r.fragment ? 'filed in the morgue as a fragment — headline and summary only; the full text could not be filed' : `filed in the morgue ${r.archived ? fmtDate(r.archived) : ''} · ${(r.words || 0).toLocaleString()} words`)}" data-tip-head="▣ STRINGER MORGUE" data-tip-head-right="no. ${esc(r.morgue)}" data-tip-note="searchable with body: · the reader opens this copy" data-tip-foot="click to copy · find it with morgue:${esc(r.morgue)}">▣ MORGUE ${esc(r.morgue)}${r.fragment ? ' · fragment' : ''}</button>` : '';
    // the morgue tag and read badge get their own line under the details, so a long byline can't wrap them oddly
    const tags = [arch, readBadge().trim()].filter(Boolean);
    return `<h1>${esc(title)}</h1><div class="rd-meta"><div>${esc(r?.site || srcById(a.sourceId)?.name || '')}${bits.length ? ' · ' + bits.join(' · ') : ''}</div>${tags.length ? `<div class="rd-tags">${tags.join('')}</div>` : ''}</div>`;
  }

  function fallback(reason, r) {
    return `${header(r)}
      <div class="rd-fail">
        <div>⚠ reader view unavailable — ${esc(reason)}</div>
        ${r?.excerpt || cur.summary ? `<p class="rd-excerpt"><span class="dim">summary:</span> ${esc(r?.excerpt || cur.summary)}</p>` : ''}
        <div class="rd-fail-acts">
          <a class="btn primary" href="${esc(safeUrl(cur.link))}" target="_blank" rel="noopener noreferrer">OPEN ORIGINAL ↗</a>
          <button type="button" data-act="embed" title="many news sites refuse to be shown inside another page — if it stays blank, open the original">TRY EMBEDDED PAGE</button>
        </div>
      </div>`;
  }

  async function open(article) {
    if (!article?.link) return;
    cur = article;
    const my = ++seq;
    ctx.onOpen?.(article);
    const where = srcById(article.sourceId)?.name;
    ctx.log?.(`<span class="dim">⟳ opening in the reader:</span> ${esc((article.title || article.link).slice(0, 80))}${where ? ` <span class="dim">— ${esc(where)}</span>` : ''}`);
    const t0 = Date.now();
    frame(`${header(null)}<div class="rd-wait"><span class="spin">⟳</span> fetching article…</div>`, { loading: true });
    if (!dlg.open) dlg.showModal();
    body.focus({ preventScroll: true });
    dlg.scrollTop = 0;
    let r;
    try { r = await api(`read?url=${encodeURIComponent(article.link)}${Number.isFinite(+article.date) && article.date ? `&date=${+article.date}` : ''}`); }
    catch (e) {
      if (my !== seq) return;
      // an unreadable page can still be a filed fragment: keep its morgue no. for the header (and for a later save)
      lastR = { ok: false, ...(e.data?.morgue ? { morgue: e.data.morgue, fragment: true, archived: e.data.archived } : {}) };
      frame(fallback(e.message, lastR.morgue ? lastR : null));
      return;
    }
    if (my !== seq || !dlg.open) return;
    if (r.wayback) cur = { ...cur, wayback: r.wayback };
    lastR = r;
    ctx.log?.(r.ok || r.content
      ? `<span class="dim">✓ reader:</span> ${r.morgue ? `from the morgue (no. ${esc(r.morgue.slice(0, 8))})` : r.wayback ? 'from the Wayback Machine' : `fetched from ${esc(r.site || 'the site')}`}${r.words ? ` · ${r.words.toLocaleString()} words` : ''} <span class="dim">· ${Date.now() - t0} ms</span>`
      : `reader view unavailable — ${esc(r.reason || 'no article text found')}`, r.ok || r.content ? '' : 'warn');
    ctx.onRead?.(article.link, r);                         // now STRINGER-archived / headline upgraded → update the page
    if (!r.ok && !r.content) return frame(fallback(r.reason || 'no article text found', r));
    const lead = r.image && !hasImage(r.content, r.image) ? `<figure class="rd-lead"><img src="${esc(r.image)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></figure>` : '';
    const wb = r.wayback;
    const wbDate = wb && new Date(+wb.timestamp.slice(0, 4), +wb.timestamp.slice(4, 6) - 1, +wb.timestamp.slice(6, 8)).getTime();   // local day, not UTC midnight
    const wbWhy = wb && (wb.gone !== false ? `the original page is gone (${wb.reason.replace(/^the page no longer exists \(?|\)$/g, '') || 'dead link'})` : `the original couldn't be read — ${wb.reason}`);
    frame(`${header(r)}${wb ? `<div class="rd-warn rd-wayback">⌛ ${esc(wbWhy)} — this is the Wayback Machine copy captured ${esc(fmtDate(wbDate))} · <a href="${esc(safeUrl(wb.url))}" target="_blank" rel="noopener noreferrer">view on archive.org ↗</a></div>` : ''}${r.ok ? '' : `<div class="rd-warn">⚠ ${esc(r.reason)} — <a href="${esc(safeUrl(cur.link))}" target="_blank" rel="noopener noreferrer">open the original ↗</a></div>`}${lead}<div class="rd-content">${r.content}</div>
      ${r.notFiled && !r.morgue ? `<div class="rd-end dim">▣ not filed — the morgue is in ${r.notFiled} mode, so reading doesn't file articles · right-click → <b>File in the morgue</b> to keep it</div>` : ''}
      <div class="rd-end dim">— end of ${r.morgue ? `the morgue copy (filed ${esc(fmtDate(r.archived || Date.now()))}${r.filedBy ? ` by ${esc(r.filedBy)}` : ''} · ${morgueTag(r.morgue)})` : 'extracted text'} · <a href="${esc(safeUrl(wb ? wb.url : r.url || cur.link))}" target="_blank" rel="noopener noreferrer">${wb ? 'read the archived copy' : `read on ${esc(r.site || 'the site')}`} ↗</a></div>`);
    body.querySelectorAll('.rd-content img').forEach((img) => img.addEventListener('error', () => img.remove()));
    markQueryTerms();
  }

  // your query's body: terms, highlighted in the article text; a ⌕ tag by the read badge steps through them
  let qMarks = [], qIdx = -1;
  function markQueryTerms() {
    qMarks = []; qIdx = -1;
    const res = ctx.queryRegexes?.() || [];
    const content = body.querySelector('.rd-content');
    if (!res.length || !content) return;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement?.closest('script, style, mark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const nodes = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) nodes.push(t);
    for (const t of nodes) {
      const text = t.nodeValue, spans = [];
      for (const r of res) { r.lastIndex = 0; for (const m of text.matchAll(r)) if (m[0]) spans.push([m.index, m.index + m[0].length]); }
      if (!spans.length) continue;
      spans.sort((x, y) => x[0] - y[0]);
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const [a, b] of spans) {
        if (b <= pos) continue;
        const s0 = Math.max(a, pos);
        if (s0 > pos) frag.append(text.slice(pos, s0));
        const mk = document.createElement('mark');
        mk.className = 'rd-q';
        mk.textContent = text.slice(s0, b);
        frag.append(mk);
        qMarks.push(mk);
        pos = b;
      }
      if (pos < text.length) frag.append(text.slice(pos));
      t.replaceWith(frag);
    }
    addQueryTag();
  }
  function addQueryTag() {
    if (!qMarks.length || body.querySelector('.rd-qhits')) return;
    const tags = body.querySelector('.rd-tags') || (() => { const d = document.createElement('div'); d.className = 'rd-tags'; body.querySelector('.rd-meta')?.append(d); return d; })();
    tags.insertAdjacentHTML('beforeend', `<button type="button" class="rd-qhits" data-act="qnext" title="your search matched the article text ${qMarks.length} time${qMarks.length === 1 ? '' : 's'} — click to go to the next match">⌕ ${qMarks.length} match${qMarks.length === 1 ? '' : 'es'}</button>`);
  }
  function nextQueryMark() {
    if (!qMarks.length) return;
    qMarks[qIdx]?.classList.remove('cur');
    qIdx = (qIdx + 1) % qMarks.length;
    qMarks[qIdx].classList.add('cur');
    qMarks[qIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    const b = body.querySelector('.rd-qhits');
    if (b) b.textContent = `⌕ ${qIdx + 1} / ${qMarks.length}`;
  }

  body.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') dlg.close();
    else if (act === 'cm-toggle') disc?.toggle();
    else if (act === 'find') (find.open ? closeFind() : openFind());
    else if (act === 'qnext') nextQueryMark();
    else if (act === 'find-next') gotoHit(find.i + 1);
    else if (act === 'find-prev') gotoHit(find.i - 1);
    else if (act === 'find-close') closeFind();
    else if (act === 'info-toggle') disc?.toggleDetails?.();
    else if (act === 'toggle-read') toggleRead();
    else if (act === 'bigger' || act === 'smaller') { size = Math.max(13, Math.min(24, size + (act === 'bigger' ? 1 : -1))); store.set('readerSize', size); applyPrefs(); }
    else if (act === 'font') { font = FONTS[(FONTS.findIndex(([k]) => k === font) + 1) % FONTS.length][0]; store.set('readerFont', font); applyPrefs(); }
    else if (act === 'embed') {
      body.querySelector('.rd-page').innerHTML = `<iframe class="rd-frame" src="${esc(safeUrl(cur.link))}" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms" referrerpolicy="no-referrer"></iframe>
        <div class="dim rd-frame-note">if this stays blank the site refuses to be embedded — use OPEN ORIGINAL ↗</div>`;
    }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });     // backdrop
  dlg.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === '/' || e.key === 'f') { e.preventDefault(); openFind(); return; }
    if (find.hits.length && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); gotoHit(find.i + (e.key === 'N' ? -1 : 1)); return; }
    if (e.key === 'c' && disc) { e.preventDefault(); disc.toggle(); return; }
    if (e.key === 'i' && disc?.toggleDetails) { e.preventDefault(); disc.toggleDetails(); return; }
    if (e.key === 'm' && rs?.signedIn()) { e.preventDefault(); toggleRead(); return; }
    if (e.key === 'j' || e.key === 'k') {                          // vim-style scrolling
      e.preventDefault();
      dlg.scrollBy({ top: (e.key === 'j' ? 1 : -1) * 120, behavior: e.repeat ? 'auto' : 'smooth' });
      return;
    }
    // o, or Enter when focus isn't on a link/button (those keep their own Enter), opens the original page
    if (e.key === 'o' || (e.key === 'Enter' && !e.target.closest('a, button'))) { e.preventDefault(); window.open(safeUrl(target()), '_blank', 'noopener'); }
  });
  dlg.addEventListener('close', () => { seq++; body.innerHTML = ''; find.open = false; find.hits = []; find.i = -1; });

  // settings from the command line: font mono|serif|sans, size 13–24
  function setPref(k, v) {
    if (k === 'font') { if (!FONTS.some(([f]) => f === v)) throw new Error('font: mono, serif or sans'); font = v; store.set('readerFont', font); }
    else if (k === 'size') { const n = Math.round(Number(v)); if (!(n >= 13 && n <= 24)) throw new Error('size: 13–24'); size = n; store.set('readerSize', size); }
    applyPrefs();
    return { font, size };
  }
  return { open, isOpen: () => dlg.open, refreshRead, noteMorgue, setPref, prefs: () => ({ font, size }), current: () => cur };
}
