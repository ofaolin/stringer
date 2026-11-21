// Research tools: the per-user binder (saved stories, articles and quotes, each citing its article by morgue no.),
// a custom right-click menu (save a quote / article / story, gather a word into the query builder, search it), and
// the floating query builder — a scratch query you can build up while reading in any popover.
export function createResearch(ctx) {
  const { api, esc, chip, srcById, log, auth, store } = ctx;
  const signedIn = () => !!auth.me?.user;
  const canBinder = () => signedIn() && auth.can('binder.use');
  let items = null;                       // binder entries, all binders (loaded on demand)
  let books = [];                         // the user's binders [{ id, name, count }]
  let book = store.get('binderBook', null);   // the open binder (saves go here)
  const bookName = () => books.find((b) => b.id === book)?.name || 'binder';
  const savedLinks = new Set(), savedSids = new Set();

  // ───────────────────────── binder data ─────────────────────────
  async function load() {
    if (!canBinder()) { items = []; books = []; savedLinks.clear(); savedSids.clear(); renderSide(); return items; }
    try { const r = await api('binder'); items = r.items; books = r.books || []; } catch { items = items || []; }
    if (!books.some((b) => b.id === book)) { book = books[0]?.id ?? null; store.set('binderBook', book); }
    savedLinks.clear(); savedSids.clear();
    for (const e of items) {
      if (e.book !== book) continue;                                  // "saved" = in the open binder
      if (e.kind === 'story') savedSids.add(e.sid); else if (e.kind === 'article') savedLinks.add(norm(e.link));
    }
    redrawNotes();
    renderSide();
    return items;
  }
  const norm = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  const isSavedArticle = (a) => savedLinks.has(norm(a?.link));
  const isSavedStory = (st) => savedSids.has(st?.sid);

  function needBinder() {
    if (!signedIn()) { auth.openLogin('sign in to keep a research binder'); return false; }
    if (!auth.can('binder.use')) { log("your role can't keep a research binder", 'warn'); return false; }
    return true;
  }
  async function save(body, what) {
    if (!needBinder()) return null;
    try {
      if (!books.length) await load();
      const r = await api('binder', { method: 'POST', body: { ...body, book } });
      await load();
      if (dlg.open) render();
      if (r.item?.morgue && r.item.link) ctx.onMorgue?.(r.item.link, r.item.morgue);
      if (r.item) ctx.activity?.(body.kind === 'quote' ? 'quote' : 'save', `${body.kind === 'quote' ? `quoted “${(body.quote || '').slice(0, 90)}” from` : `saved ${body.kind}`} ${body.kind === 'story' ? `${r.item.sid}: ` : ''}${r.item.title || ''} → ${bookName()}${r.item.morgue ? ` (morgue no. ${r.item.morgue})` : ''}`,
        body.kind === 'story' ? { sid: r.item.sid, link: r.item.link } : { link: r.item.link, title: r.item.title, sourceId: r.item.source_id, date: r.item.published });
      if (r.item) log(`▤ ${what} <span class="dim">→ ${esc(bookName())}${r.item.morgue ? ` · morgue no. ${esc(r.item.morgue)}` : ''}</span>`, 'ok');
      return r.item;
    } catch (e) { if (!auth.denied(e)) log(`couldn't save: ${esc(e.data?.error || e.message)}`, 'err'); return null; }
  }
  const saveArticle = (a) => save({ kind: 'article', link: a.link }, `saved article: ${esc((a.title || '').slice(0, 70))}`);
  const saveStory = (st) => save({ kind: 'story', sid: st.sid }, `saved story <b>${esc(st.sid)}</b>: ${esc((st.title || '').slice(0, 60))}`);
  const saveQuote = (a, quote) => save({ kind: 'quote', link: a.link, quote }, `saved quote from ${esc(srcById(a.sourceId)?.name || 'the article')}: “${esc(quote.slice(0, 60))}${quote.length > 60 ? '…' : ''}”`);
  async function unsave(body, what) {
    try {
      await api('binder', { method: 'POST', body: { ...body, book, remove: true } }); await load(); if (dlg.open) render(); log(`removed from ${esc(bookName())}: ${what}`);
      ctx.activity?.('remove', `removed ${body.kind}${body.sid ? ` ${body.sid}` : ''} from ${bookName()}: ${String(what).replace(/<[^>]+>/g, '')}`, body.sid ? { sid: body.sid } : { link: body.link });
    }
    catch (e) { log(`couldn't remove: ${esc(e.message)}`, 'err'); }
  }

  // a citation for an entry (plain text, for copying)
  function citation(e) {
    const s = srcById(e.sourceId);
    const date = e.published ? new Date(e.published).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    if (e.kind === 'story') return `STRINGER story ${e.sid}: “${e.title}”${e.sources ? ` (${e.sources} outlets, ${e.articles} articles)` : ''}${e.link ? ` — lead: ${e.link}` : ''}`;
    const src = `${s?.name || e.sourceId || ''}, “${e.title}”${date ? `, ${date}` : ''}. ${e.link}${e.morgue ? ` · STRINGER morgue no. ${e.morgue}` : ''}`;
    return e.kind === 'quote' ? `“${e.quote}” — ${src}` : src;
  }

  // ───────────────────────── binder popover ─────────────────────────
  const dlg = document.createElement('dialog');
  dlg.id = 'dlg-binder';
  dlg.className = 'wide-dlg stats-dlg';
  dlg.innerHTML = '<div class="dlg" id="binder-body" tabindex="-1"></div>';
  document.body.append(dlg);
  const body = dlg.querySelector('#binder-body');
  let tab = store.get('binderTab', 'all');
  let editing = null, renaming = null, moving = null;
  const focusRename = () => { const i = body.querySelector('.bd-rename'); if (i) { i.focus(); i.select(); } };
  async function finishRename(save) {
    const i = body.querySelector('.bd-rename');
    if (!i) return;
    const id = Number(i.dataset.bdRename), name = i.value.trim();
    renaming = null;
    if (save && name) { try { await api(`binder/books/${id}`, { method: 'PATCH', body: { name } }); } catch (ex) { log(`couldn't rename: ${esc(ex.message)}`, 'err'); } }
    await load(); render();
  }
  const TABS = [['all', 'ALL'], ['quote', 'QUOTES'], ['article', 'ARTICLES'], ['story', 'STORIES']];

  function render() {
    const inBook = (items || []).filter((e) => e.book === book);
    const list = inBook.filter((e) => tab === 'all' || e.kind === tab);
    const n = (k) => inBook.filter((e) => k === 'all' || e.kind === k).length;
    const row = (e) => {
      const s = srcById(e.sourceId);
      const when = e.published ? ctx.fmtTime(e.published) : '';
      const head = e.kind === 'story'
        ? `<span class="bd-kind">▤ STORY <b class="sid">${esc(e.sid)}</b></span> <span class="dim">${e.sources != null ? `${e.sources} outlets · ${e.articles} articles` : ''}${e.newest ? ` · updated ${esc(ctx.agoText(e.newest))}` : ''}${e.live === false ? ' · left the live window' : ''}</span>`
        : `<span class="bd-kind">${e.kind === 'quote' ? '❝ QUOTE' : '▣ ARTICLE'}</span> ${s ? `${chip(s.bias)} ${esc(s.name)}` : ''} <span class="dim">· ${esc(when)}</span>
           ${e.morgue ? `<button type="button" class="ft bd-morgue${e.fragment ? ' partial' : ''}" data-bd="copy-morgue" data-morgue="${esc(e.morgue)}" title="${e.fragment ? 'filed as a fragment: headline and summary only, until the full text is fetched' : `${(e.words || 0).toLocaleString()} words in the morgue`} — click to copy" >▣ MORGUE ${esc(e.morgue)}${e.fragment ? ' · fragment' : ''}</button>` : ''}`;
      return `<div class="bd-item bd-${e.kind}" data-id="${e.id}">
        <div class="bd-head">${head}<span class="bd-sp"></span><span class="dim small">saved ${esc(ctx.agoText(e.created))}</span></div>
        ${e.kind === 'quote' ? `<blockquote class="bd-quote">${esc(e.quote)}</blockquote>` : ''}
        <div class="bd-title">${e.kind === 'quote' ? '<span class="dim">from </span>' : ''}<button type="button" class="link bd-open" data-bd="open">${esc(e.title || e.link)}</button></div>
        ${editing === e.id ? `<div class="bd-note-edit"><textarea data-bd-note maxlength="4000" placeholder="a note for yourself…">${esc(e.note || '')}</textarea>
            <div class="bd-acts"><button type="button" class="link" data-bd="note-cancel">[cancel]</button> <button type="button" data-bd="note-save">SAVE NOTE</button></div></div>`
          : e.note ? `<div class="bd-note">✎ ${esc(e.note)}</div>` : ''}
        <div class="bd-acts">
          <button type="button" class="link" data-bd="open">[${e.kind === 'story' ? 'open story' : 'read'} ▸]</button>
          <button type="button" class="link" data-bd="cite" title="copy a citation">[⧉ cite]</button>
          <button type="button" class="link" data-bd="note">[✎ ${e.note ? 'edit note' : 'note'}]</button>
          ${e.kind !== 'story' ? `<button type="button" class="link" data-bd="query" title="add this article's morgue no. to the query builder">[＋ query]</button>` : `<button type="button" class="link" data-bd="query" title="add story:${esc(e.sid)} to the query builder">[＋ query]</button>`}
          ${books.length > 1 ? `<span class="bd-move-w"><button type="button" class="link" data-bd="move" aria-expanded="${moving === e.id}" title="move to another binder">[⇄ move ▾]</button>${moving === e.id
            ? `<div class="ctx-menu bd-move-menu"><div class="ctx-head">move to…</div>${books.filter((b) => b.id !== e.book).map((b) => `<button type="button" class="ctx-item" data-bd-move-to="${b.id}"><span class="ctx-ic">▤</span><span class="ctx-l">${esc(b.name)}</span><span class="ctx-h">${b.count}</span></button>`).join('')}</div>` : ''}</span>` : ''}
          <button type="button" class="link err" data-bd="delete">[remove]</button>
        </div>
      </div>`;
    };
    body.innerHTML = `
      <div class="st-head"><div class="dlg-head"><span>// RESEARCH BINDER <span class="dim">${inBook.length} saved in ${esc(bookName())}</span></span><button type="button" class="link" data-bd="close" title="close (esc)">[esc]</button></div></div>
      <div class="bd-books">${books.map((b) => renaming === b.id
          ? `<span class="bd-book on"><input class="bd-rename" data-bd-rename="${b.id}" maxlength="40" value="${esc(b.name)}" /></span>`
          : `<span class="bd-book${b.id === book ? ' on' : ''}"><button type="button" data-bd-book="${b.id}" title="${b.id === book ? 'double-click to rename' : `open ${esc(b.name)}`}">${esc(b.name)} <span class="dim">${b.count}</span></button>${b.id === book && books.length > 1 ? `<button type="button" class="bd-book-x" data-bd="book-delete" title="delete this binder and everything in it">×</button>` : ''}</span>`).join('')}
          <button type="button" class="bd-book-add" data-bd="book-add" title="a new binder">＋ new binder</button></div>
      <div class="bd-tabs">${TABS.map(([k, l]) => `<button type="button" class="${k === tab ? 'on' : ''}" data-bd-tab="${k}">${l} <span class="dim">${n(k)}</span></button>`).join('')}</div>
      <div class="bd-list">${!signedIn() ? '<div class="dim bd-empty">&gt; sign in to keep a research binder</div>'
        : list.length ? list.map(row).join('') : `<div class="dim bd-empty">&gt; nothing here yet — right-click an article or story to save it, or select text and right-click to save a quote</div>`}</div>
      <div class="st-foot-bar bd-foot"><span class="dim small bd-help">quotes cite their article by morgue no. · right-click anything to save it<br><b>saved:yes</b> finds saved articles (in STORIES mode: saved stories)</span>
        <span class="bd-foot-btns">${list.length ? '<button type="button" data-bd="export">⧉ COPY ALL AS CITATIONS</button> ' : ''}<button type="button" data-bd="close">CLOSE</button></span></div>`;
  }
  async function open() {
    if (!needBinder()) return;
    editing = null;
    body.innerHTML = '<div class="dim st-loading"><span class="spin">⟳</span> opening the binder…</div>';
    if (!dlg.open) dlg.showModal();
    await load();
    render();
    body.focus({ preventScroll: true });
  }
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); log(`⧉ copied ${what}`, 'ok'); } catch { log("couldn't copy (clipboard blocked)", 'warn'); } };
  dlg.addEventListener('click', async (e) => {
    if (e.target === dlg) return dlg.close();
    const bk = e.target.closest('[data-bd-book]');
    if (bk) {
      const id = Number(bk.dataset.bdBook);
      if (id === book && e.detail >= 2) { renaming = id; render(); return focusRename(); }        // double-click: rename
      if (id !== book) { book = id; store.set('binderBook', book); editing = null; await load(); render(); }
      return;
    }
    const t = e.target.closest('[data-bd-tab]');
    if (t) { tab = t.dataset.bdTab; store.set('binderTab', tab); return render(); }
    const mv = e.target.closest('[data-bd-move-to]');
    if (mv) {
      const id = Number(mv.closest('[data-id]').dataset.id), to = Number(mv.dataset.bdMoveTo);
      moving = null;
      try { await api(`binder/${id}`, { method: 'PATCH', body: { book: to } }); await load(); render(); log(`moved to ${esc(books.find((x) => x.id === to)?.name || 'binder')}`); }
      catch (ex) { log(`couldn't move: ${esc(ex.message)}`, 'err'); }
      return;
    }
    const b = e.target.closest('[data-bd]');
    if (moving != null && b?.dataset.bd !== 'move') { moving = null; render(); if (!b) return; }
    if (!b) return;
    const act = b.dataset.bd, id = Number(b.closest('[data-id]')?.dataset.id);
    const ent = (items || []).find((x) => x.id === id);
    if (act === 'close') return dlg.close();
    if (act === 'book-add') {
      try { const r = await api('binder/books', { method: 'POST', body: { name: `Binder ${books.length + 1}` } }); book = r.book.id; store.set('binderBook', book); await load(); renaming = book; render(); focusRename(); }
      catch (ex) { log(`couldn't add a binder: ${esc(ex.message)}`, 'err'); }
      return;
    }
    if (act === 'book-delete') {
      const cur = books.find((x) => x.id === book);
      if (!cur || !confirm(`delete the binder “${cur.name}”${cur.count ? ` and the ${cur.count} thing${cur.count === 1 ? '' : 's'} in it` : ''}?`)) return;
      try { await api(`binder/books/${book}`, { method: 'DELETE' }); book = null; await load(); render(); log(`binder “${esc(cur.name)}” deleted`); }
      catch (ex) { log(`couldn't delete: ${esc(ex.data?.error || ex.message)}`, 'err'); }
      return;
    }
    if (act === 'export') { const list = (items || []).filter((x) => x.book === book && (tab === 'all' || x.kind === tab)); return copy(list.map(citation).join('\n\n'), `${list.length} citation${list.length === 1 ? '' : 's'}`); }
    if (!ent) return;
    if (act === 'open') {
      if (ent.kind === 'story') { dlg.close(); return ctx.openStoryBySid(ent.sid, ent.link); }
      dlg.close();
      return ctx.reader.open({ link: ent.link, title: ent.title, sourceId: ent.sourceId, date: ent.published });
    }
    if (act === 'move') { moving = moving === id ? null : id; render(); return body.querySelector('.bd-move-menu .ctx-item')?.focus({ preventScroll: true }); }
    if (act === 'cite') return copy(citation(ent), 'the citation');
    if (act === 'copy-morgue') return copy(ent.morgue, `morgue no. ${esc(ent.morgue)}`);
    if (act === 'query') return builder.add(ent.kind === 'story' ? `story:${ent.sid}` : ent.morgue ? `morgue:${ent.morgue}` : `url:${ent.link}`, { open: true });
    if (act === 'note') { editing = id; render(); return body.querySelector('[data-bd-note]')?.focus(); }
    if (act === 'note-cancel') { editing = null; return render(); }
    if (act === 'note-save') {
      const note = body.querySelector('[data-bd-note]').value;
      try { await api(`binder/${id}`, { method: 'PATCH', body: { note } }); ent.note = note.trim() || null; editing = null; render(); }
      catch (ex) { log(`couldn't save the note: ${esc(ex.message)}`, 'err'); }
      return;
    }
    if (act === 'delete') {
      try { await api(`binder/${id}`, { method: 'DELETE' }); await load(); render(); log('removed from the binder'); }
      catch (ex) { log(`couldn't remove: ${esc(ex.message)}`, 'err'); }
    }
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.target.matches?.('.bd-rename')) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
      if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
      return;
    }
    if (moving != null && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); moving = null; render(); return; }
    if (moving != null && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const btns = [...body.querySelectorAll('.bd-move-menu .ctx-item')], k = btns.indexOf(document.activeElement);
      e.preventDefault(); btns[(k + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
      return;
    }
    if (/TEXTAREA|INPUT|SELECT/.test(e.target.tagName)) e.stopPropagation();
  });
  dlg.addEventListener('focusout', (e) => { if (e.target.matches?.('.bd-rename')) setTimeout(() => finishRename(true), 0); });


  // ───────────────────────── query builder (floating, right side) ─────────────────────────
  const builder = (() => {
    const el = document.createElement('div');
    el.className = 'qb' + (store.get('qbOpen', false) ? ' open' : '');
    el.innerHTML = `
      <div class="qb-tabs">
        <button type="button" class="qb-tab qb-bs-tab" data-qb="binder" title="your research binder, over this popover (shift+B)"><span>▤ BINDER</span></button>
        <button type="button" class="qb-tab" data-qb="toggle" title="query builder — gather words while you read, then run it (q)"><span>⌕ QUERY BUILDER</span> <span class="qb-n"></span></button>
      </div>
      <div class="qb-panel">
        <div class="qb-head"><span>// QUERY BUILDER</span><button type="button" class="link" data-qb="toggle" title="hide (q)">[–]</button></div>
        <div class="qtabs" data-qtabs></div>
        <div class="ac-host qb-host"><pre class="qb-hl" aria-hidden="true"></pre><textarea class="qb-q" rows="4" spellcheck="false" placeholder="select a word anywhere, right-click → add to query… or type here (autocomplete works)"></textarea></div>
        <div class="qb-status small"></div>
        <div class="qb-foot">
          <span class="dim qb-keys">ctrl+⏎ run · esc leave<br>added words join with AND</span>
          <span class="qb-foot-btns"><button type="button" class="link" data-qb="clear">[clear]</button><button type="button" class="qb-run" data-qb="run" title="run it in the main results (ctrl+⏎)">RUN ▸</button></span>
        </div>
      </div>`;
    document.body.append(el);
    const ta = el.querySelector('.qb-q'), status = el.querySelector('.qb-status'), countEl = el.querySelector('.qb-n'), hl = el.querySelector('.qb-hl');
    ta.value = ctx.mainQuery();                       // the same query as the query bar and the advanced editor
    const validate = (notify = true) => {
      const v = ta.value.trim();
      if (notify) ctx.onQueryEdit?.(ta.value);
      const err = v ? ctx.queryError(v) : null;
      // the same syntax colors as the query bar: drawn under the (transparent) text, scrolled with it
      hl.innerHTML = ctx.highlight(ta.value, err) + '\n';
      hl.scrollTop = ta.scrollTop;
      status.className = 'qb-status small ' + (err ? (err.incomplete ? 'wip' : 'bad') : 'ok');
      status.textContent = !v ? '' : err ? `${err.incomplete ? '…' : '✗'} ${err.message}` : '✓ valid — RUN ▸ or ctrl+⏎';
      const terms = v ? v.split(/\s+(?:AND|OR)\s+|\s+/).filter((x) => x && x !== '(' && x !== ')').length : 0;
      countEl.textContent = terms ? String(terms) : '';
    };
    validate(false);
    ctx.attachAutocomplete(ta, (v, caret) => ctx.suggest(v, caret, ctx.acCtx()), { position: (box) => { box.style.left = '0'; box.style.right = '0'; } });
    // live inside whichever modal is open (they sit in the top layer, above everything else)
    const place = () => {
      const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
      if (el.parentNode !== host) host.append(el);
    };
    new MutationObserver(place).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    const setOpen = (o) => { el.classList.toggle('open', o); store.set('qbOpen', o); if (o) { place(); ta.focus(); } };
    function add(clause, { open = true } = {}) {
      const cur = ta.value.trim();
      ta.value = cur ? `${cur} ${clause}` : clause;            // (implicit AND; OR is typed, as in the query bar)
      validate();
      if (open) setOpen(true);
      log(`＋ query builder ← <b>${esc(clause)}</b>`);
    }
    function run() {
      const v = ta.value.trim();
      if (!v) return;
      const err = ctx.queryError(v);
      if (err && !err.incomplete) { validate(); return log(`query builder: ${esc(err.message)}`, 'err'); }
      ctx.setQuery(v);
      log(`⌕ query → ${esc(v)}${document.querySelector('dialog[open]') ? ' <span class="dim">(results updated behind this popover)</span>' : ''}`);
    }
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-qb]')?.dataset.qb;
      if (a === 'toggle') setOpen(!el.classList.contains('open'));        // (alongside the floating binder if it's open)
      else if (a === 'binder') toggleFloat();
      else if (a === 'clear') { ta.value = ''; validate(); ta.focus(); }
      else if (a === 'run') run();
    });
    ta.addEventListener('input', validate);
    ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; });
    // typing here must not trigger popover / page shortcuts; Esc leaves the box instead of closing the popover
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
      if (e.key === 'Escape') { e.preventDefault(); ta.blur(); }
    });
    place();
    // mirror the query bar / advanced editor
    function setText(v) {
      const one = (x) => String(x || '').replace(/\s+/g, ' ').trim();
      if (one(ta.value) === one(v)) return;
      const atEnd = ta.selectionStart === ta.value.length;
      ta.value = v || '';
      if (atEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
      validate(false);
    }
    return { add, setText, toggle: () => setOpen(!el.classList.contains('open')), place, close: () => setOpen(false), el };
  })();

  // how a selected word / phrase goes into a query
  const termOf = (text) => {
    const t = text.replace(/\s+/g, ' ').trim().replace(/^[“"'‘(]+|[”"'’).,;:!?]+$/g, '');
    if (!t) return null;
    return /^[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u.test(t) && !/^(AND|OR|NOT|TO)$/.test(t) ? t.toLowerCase() : `"${t.replace(/"/g, '')}"`;
  };

  // ───────────────────────── right-click menu ─────────────────────────
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.hidden = true;
  document.body.append(menu);
  let menuActs = [];
  const hideMenu = () => { menu.hidden = true; menuActs = []; };
  function showMenu(x, y, entries) {
    const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
    if (menu.parentNode !== host) host.append(menu);
    menuActs = entries.filter((e) => e && e.label);
    menu.innerHTML = entries.map((e, i) => (!e ? '<div class="ctx-sep"></div>'
      : e.head ? `<div class="ctx-head">${e.head}</div>`
        : `<button type="button" class="ctx-item${e.cls ? ' ' + e.cls : ''}" data-i="${menuActs.indexOf(e)}"${e.disabled ? ' disabled' : ''}><span class="ctx-ic">${e.icon || ''}</span><span class="ctx-l">${e.label}</span>${e.hint ? `<span class="ctx-h">${e.hint}</span>` : ''}</button>`)).join('')
      + '<div class="ctx-foot">shift + right-click for the browser menu</div>';
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, y + r.height > innerHeight - 4 ? y - r.height : y)}px`;
    menu.querySelector('.ctx-item:not([disabled])')?.focus({ preventScroll: true });
  }
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.ctx-item');
    if (!b || b.disabled) return;
    const act = menuActs[Number(b.dataset.i)];
    hideMenu();
    act?.run();
  });
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const btns = [...menu.querySelectorAll('.ctx-item:not([disabled])')];
    const k = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); hideMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(k + 1) % btns.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(k - 1 + btns.length) % btns.length]?.focus(); }
  });
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target)) hideMenu(); }, true);
  document.addEventListener('scroll', () => { if (!menu.hidden) hideMenu(); }, true);

  // an entry in the binder sidebar or the binder popover, as a right-click context
  function binderContext(node) {
    const it = node.closest?.('#binder-side .bs-item, #binder-body .bd-item');
    const ent = it && (items || []).find((x) => x.id === Number(it.dataset.id));
    if (!ent) return null;
    if (ent.kind === 'story') return { el: it, story: { sid: ent.sid, title: ent.title, sourceCount: ent.sources, articles: [] }, entry: ent };
    return { el: it, article: asArt(ent), entry: ent };
  }
  document.addEventListener('contextmenu', (e) => {
    if (e.shiftKey || e.target.closest('input, textarea, .ctx-menu, .qb')) return;   // the browser's own menu
    const where = binderContext(e.target) || ctx.contextAt(e.target);   // { article?, story? } or null
    const sel = String(getSelection()?.toString() || '').trim();
    const selIn = sel && getSelection().rangeCount && where?.el?.contains(getSelection().getRangeAt(0).commonAncestorContainer);
    if (!where && !sel) return;
    e.preventDefault();
    const a = where?.article, st = where?.story;
    const entries = [];
    if (sel) {
      // a word or short phrase can go into a query; a longer selection is for quoting / copying
      const words = sel.split(/\s+/).filter(Boolean).length;
      const term = words <= 12 && sel.length <= 120 ? termOf(sel) : null;
      const short = esc(sel.length > 36 ? sel.slice(0, 36) + '…' : sel);
      entries.push({ head: `“${short}”` });
      if (a && (selIn || where)) entries.push({ icon: '❝', label: `Save quote to <b>${esc(bookName())}</b>`, hint: esc(srcById(a.sourceId)?.name || ''), run: () => saveQuote(a, sel) });
      if (term) {
        entries.push({ icon: '＋', label: `Add <b>${esc(term)}</b> to query`, hint: 'builder', run: () => builder.add(term) });
        entries.push({ icon: '＋', label: `Add as <b>body:${esc(term)}</b>`, hint: 'full text', run: () => builder.add(`body:${term}`) });
        entries.push({ icon: '−', label: `Exclude <b>${esc(term)}</b>`, run: () => builder.add(`-${term}`) });
        entries.push({ icon: '⌕', label: `Search <b>${esc(term)}</b> now`, hint: 'all time', run: () => { ctx.setQuery(`text:${term} date:*`); log(`⌕ query → text:${esc(term)} date:*`); } });
      } else entries.push({ icon: '＋', label: 'Add to query', hint: `select 12 words or fewer (${words})`, disabled: true });
      entries.push({ icon: '⧉', label: 'Copy', run: () => copy(sel, 'the selection') });
    }
    if (a || st) {
      if (entries.length) entries.push(null);
      if (st?.sid) entries.push(isSavedStory(st)
        ? { icon: '★', label: `Story <b>${esc(st.sid)}</b> is in ${esc(bookName())}`, hint: 'remove', run: () => unsave({ kind: 'story', sid: st.sid }, `story ${esc(st.sid)}`) }
        : { icon: '▤', label: `Save story <b>${esc(st.sid)}</b> to ${esc(bookName())}`, hint: `${st.sourceCount || new Set((st.articles || []).map((x) => x.sourceId)).size} outlets`, run: () => saveStory(st) });
      if (a) entries.push(isSavedArticle(a)
        ? { icon: '★', label: `Article is in ${esc(bookName())}`, hint: 'remove', run: () => unsave({ kind: 'article', link: a.link }, esc((a.title || '').slice(0, 60))) }
        : { icon: '▣', label: `Save article to ${esc(bookName())}`, hint: esc(srcById(a.sourceId)?.name || ''), run: () => saveArticle(a) });
      if (where.openStory) entries.push(where.openStoryLabel === 'details'
        ? { icon: '▣', label: 'Open article details', hint: 'archive', run: where.openStory }
        : { icon: '▤', label: `Open story${st?.sid ? ` <b>${esc(st.sid)}</b>` : ''}`, hint: st?.sourceCount ? `${st.sourceCount} outlets` : '', run: where.openStory });
      if (a && !where.inReader) entries.push({ icon: '▸', label: 'Open in reader', run: () => ctx.reader.open(ctx.asArticle(a)) });
      if (a) entries.push({ icon: '⧉', label: 'Copy link', run: () => copy(a.link, 'the link') });
      if (st?.sid) entries.push({ icon: '＋', label: `Add <b>story:${esc(st.sid)}</b> to query`, run: () => builder.add(`story:${st.sid}`) });
    }
    if (where?.entry) {
      const ent = where.entry;
      entries.push(null, { icon: '⧉', label: 'Copy citation', run: () => copy(citation(ent), 'the citation') });
      if (ent.morgue) entries.push({ icon: '▣', label: `Copy morgue no. <b>${esc(ent.morgue)}</b>`, run: () => copy(ent.morgue, `morgue no. ${esc(ent.morgue)}`) });
      if (ent.kind === 'quote') entries.push({ icon: '❝', label: 'Copy the quote', run: () => copy(ent.quote, 'the quote') });
      if (ent.kind === 'quote') entries.push({ icon: '×', label: 'Remove this quote', cls: 'err', run: async () => { try { await api(`binder/${ent.id}`, { method: 'DELETE' }); await load(); if (dlg.open) render(); log(`removed from ${esc(bookName())}`); } catch (ex) { log(`couldn't remove: ${esc(ex.message)}`, 'err'); } } });
    }
    entries.push(null, { icon: '❏', label: 'Open the binder', hint: 'b', run: open }, { icon: '⌕', label: 'Show the query builder', hint: 'q', run: () => builder.toggle() });
    showMenu(e.clientX, e.clientY, entries);
  });

  load();
  const toggle = () => (dlg.open ? dlg.close() : open());

  // ───────────────────────── the binder sidebar (main page, right side) ─────────────────────────
  // A compact view of the open binder: switch binders, filter by kind, click an entry to open it, drag a headline
  // from the results onto it to save the article. Collapses to a rail on the right edge.
  // (var, not const: load() can draw the sidebar during start-up, before this line has run)
  var side = document.getElementById('binder-side');  // eslint-disable-line no-var
  var sideKind = store.get('bsideKind', 'all');   // eslint-disable-line no-var
  var sideRenaming = null;                         // eslint-disable-line no-var
  async function finishSideRename(save) {
    const i = document.querySelector('.bs-rename');
    if (!i) return;
    const id = Number(i.dataset.bsRename), name = i.value.trim();
    sideRenaming = null;
    if (save && name) { try { await api(`binder/books/${id}`, { method: 'PATCH', body: { name } }); } catch (ex) { log(`couldn't rename: ${esc(ex.message)}`, 'err'); } }
    await load(); if (dlg.open) render();
  }
  function sideOpen() { return document.body.classList.contains('bside-open'); }
  function setSide(open) { document.body.classList.toggle('bside-open', open); store.set('bsideOpen', open); renderSide(); }
  // the article details tooltip (as in the popovers) for an entry; stories get the same frame
  const asArt = (e) => ({ link: e.link, title: e.title, sourceId: e.sourceId, date: e.published, summary: e.summary || '' });
  function entryTip(e) {
    if (e.kind === 'story') {
      return ` title="${esc(e.title || '')}" data-tip-head="${esc(`STORY ${e.sid}${e.sources != null ? ` · ${e.sources} outlets · ${e.articles} articles` : ''}`)}" data-tip-title="${esc(`“${e.title || ''}”`)}"`
        + ` data-tip-sub="${esc([e.newest ? `updated ${ctx.agoText(e.newest)}` : '', e.live === false ? 'no longer in the live window' : ''].filter(Boolean).join(' · ') || ' ')}"`
        + ` data-tip-foot="click to open the story · right-click for more"`;
    }
    return ctx.articleTip(asArt(e), { alert: e.kind === 'quote' ? `❝ ${e.quote.length > 140 ? e.quote.slice(0, 140) + '…' : e.quote}` : '', foot: 'click to read · right-click for more' });
  }
  function renderSide() {
    side ??= document.getElementById('binder-side');
    if (floatEl && !floatEl.hidden) renderPanel(floatEl, true);
    if (!side) return;
    if (!sideOpen()) {
      side.innerHTML = '<button type="button" class="bs-rail" data-bs="open" title="your research binder — show it here (shift+B)">« <span>BINDER</span></button>';
      return;
    }
    renderPanel(side, false);
  }
  // the binder panel's contents (docked on the main page, or floating over a popover)
  // quotes are clamped to 4 lines; a cut-off one gets a toggle to unfold it (remembered across re-renders)
  var quoteOpen = new Set();   // eslint-disable-line no-var
  const markCutQuotes = (target) => {
    for (const q of target.querySelectorAll('.bs-quote')) {
      const more = q.nextElementSibling;
      if (more?.classList.contains('bs-more')) more.hidden = !(q.classList.contains('open') || q.scrollHeight > q.clientHeight + 1);
    }
  };
  function renderPanel(target, floating) {
    const icon = { quote: '❝', article: '▣', story: '▤' };
    const list = (items || []).filter((e) => e.book === book && (sideKind === 'all' || e.kind === sideKind));
    const entry = (e) => {
      const s = srcById(e.sourceId);
      return `<div class="bs-item" data-id="${e.id}">
        <div class="bs-meta"><span class="bs-ic">${icon[e.kind]}</span>${e.kind === 'story' ? `<b class="sid">${esc(e.sid)}</b> <span class="dim">${e.sources ?? ''}${e.sources != null ? ' outlets' : ''}</span>` : `${s ? chip(s.bias) + ' ' : ''}<span class="dim">${esc(s?.name || '')}</span>`}
          <span class="bs-acts"><button type="button" class="link" data-bs="cite" title="copy a citation">⧉</button><button type="button" class="link err" data-bs="remove" title="remove from ${esc(bookName())}">×</button></span></div>
        ${e.kind === 'quote' ? `<div class="bs-quote${quoteOpen.has(e.id) ? ' open' : ''}">“${esc(e.quote)}”</div><button type="button" class="link bs-more" data-bs="more" hidden>${quoteOpen.has(e.id) ? '▴ less' : '▾ show the whole quote'}</button>` : ''}
        <button type="button" class="bs-title" data-bs="open-item"${entryTip(e)}>${esc(e.title || e.link || '')}</button>
        ${e.note ? `<div class="bs-note">✎ ${esc(e.note)}</div>` : ''}
      </div>`;
    };
    target.innerHTML = `
      <div class="bs-head"><span>// BINDER</span><button type="button" class="link" data-bs="${floating ? 'float-close' : 'close'}" title="${floating ? 'close' : 'collapse (shift+B)'}">[»]</button></div>
      ${!signedIn() ? '<div class="dim bs-empty"><button type="button" class="link" data-bs="signin">[sign in]</button> to keep a research binder</div>'
      : !canBinder() ? '<div class="dim bs-empty">your role can\'t keep a binder</div>' : `
      <div class="bs-books">${books.map((b) => (sideRenaming === b.id
        ? `<input class="bs-rename" data-bs-rename="${b.id}" maxlength="40" value="${esc(b.name)}" />`
        : `<button type="button" class="${b.id === book ? 'on' : ''}" data-bs-book="${b.id}" title="${b.id === book ? 'double-click to rename' : `open ${esc(b.name)}`}">${esc(b.name)} <span class="dim">${b.count}</span></button>`)).join('')}<button type="button" class="bs-add" data-bs="add" title="a new binder">＋</button></div>
      <div class="bs-kinds">${[['all', 'ALL'], ['quote', '❝'], ['article', '▣'], ['story', '▤']].map(([k, l]) => `<button type="button" class="${k === sideKind ? 'on' : ''}" data-bs-kind="${k}" title="${k === 'all' ? 'everything' : k + 's'}">${l}</button>`).join('')}</div>
      <div class="bs-list">${list.length ? list.map(entry).join('') : `<div class="dim bs-empty">${(items || []).some((e) => e.book === book) ? 'nothing of this kind here' : 'empty — right-click anything to save it, or drag a headline here'}</div>`}</div>
      <div class="bs-foot"><button type="button" class="link" data-bs="full">[open the full binder ▸]</button></div>`}`;
    markCutQuotes(target);
  }
  async function onPanelClick(e) {
    const panel = e.currentTarget;
    const bk = e.target.closest('[data-bs-book]');
    if (bk) {
      const id = Number(bk.dataset.bsBook);
      if (id === book && e.detail >= 2) { sideRenaming = id; renderSide(); const i = panel.querySelector('.bs-rename'); i?.focus(); i?.select(); return; }
      if (id !== book) { book = id; store.set('binderBook', book); await load(); if (dlg.open) render(); }
      return;
    }
    const kd = e.target.closest('[data-bs-kind]');
    if (kd) { sideKind = kd.dataset.bsKind; store.set('bsideKind', sideKind); return renderSide(); }
    const a = e.target.closest('[data-bs]')?.dataset.bs;
    if (!a) return;
    if (a === 'open') return setSide(true);
    if (a === 'close') return setSide(false);
    if (a === 'float-close') return closeFloat();
    if (a === 'signin') return auth.openLogin('sign in to keep a research binder');
    if (a === 'full') return open();
    if (a === 'add') {
      try {
        const r = await api('binder/books', { method: 'POST', body: { name: `Binder ${books.length + 1}` } });
        book = r.book.id; store.set('binderBook', book);
        sideRenaming = book;
        await load(); if (dlg.open) render();
        const i = panel.querySelector('.bs-rename'); i?.focus(); i?.select();
        log(`▤ new binder — name it and press ⏎`);
      } catch (ex) { log(`couldn't add a binder: ${esc(ex.message)}`, 'err'); }
      return;
    }
    const ent = (items || []).find((x) => x.id === Number(e.target.closest('[data-id]')?.dataset.id));
    if (!ent) return;
    if (a === 'more') {
      if (quoteOpen.has(ent.id)) quoteOpen.delete(ent.id); else quoteOpen.add(ent.id);
      const item = e.target.closest('.bs-item');
      item.querySelector('.bs-quote').classList.toggle('open', quoteOpen.has(ent.id));
      e.target.closest('.bs-more').textContent = quoteOpen.has(ent.id) ? '▴ less' : '▾ show the whole quote';
      return;
    }
    if (a === 'cite') return copy(citation(ent), 'the citation');
    if (a === 'remove') { try { await api(`binder/${ent.id}`, { method: 'DELETE' }); await load(); if (dlg.open) render(); log(`removed from ${esc(bookName())}`); } catch (ex) { log(`couldn't remove: ${esc(ex.message)}`, 'err'); } return; }
    if (a === 'open-item') {
      if (ent.kind === 'story') return ctx.openStoryBySid(ent.sid, ent.link);
      return ctx.reader.open({ link: ent.link, title: ent.title, sourceId: ent.sourceId, date: ent.published });
    }
  }
  side?.addEventListener('click', onPanelClick);
  function onPanelKey(e) {
    if (!e.target.matches?.('.bs-rename')) return;
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finishSideRename(true); }
    if (e.key === 'Escape') { e.preventDefault(); finishSideRename(false); }
  }
  const onPanelFocusOut = (e) => { if (e.target.matches?.('.bs-rename')) setTimeout(() => finishSideRename(true), 0); };
  side?.addEventListener('keydown', onPanelKey);
  side?.addEventListener('focusout', onPanelFocusOut);
  // drop a headline (any article link) onto the sidebar to save it
  function attachDrop(el) {
  el?.addEventListener('dragover', (e) => { if (canBinder() && [...e.dataTransfer.types].some((t) => t === 'text/uri-list' || t === 'text/plain')) { e.preventDefault(); el.classList.add('bs-drop'); } });
  el?.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('bs-drop'); });
  el?.addEventListener('drop', async (e) => {
    el.classList.remove('bs-drop');
    const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n').find((l) => /^https?:\/\//.test(l.trim()))?.trim();
    if (!url) return;
    e.preventDefault();
    if (el === side && !sideOpen()) setSide(true);
    const it = await save({ kind: 'article', link: url }, 'saved article');
    if (it) log(`<span class="dim">dropped: ${esc((it.title || url).slice(0, 70))}</span>`);
  });
  }
  attachDrop(side);

  // the floating binder: the same panel over a popover, opened from its tab beside the query builder's
  // (var, not const: the sidebar can be drawn during start-up, before this line has run)
  var floatEl = document.createElement('aside');   // eslint-disable-line no-var
  floatEl.className = 'binder-side bs-float';
  floatEl.hidden = true;
  floatEl.setAttribute('aria-label', 'research binder');
  floatEl.addEventListener('click', onPanelClick);
  floatEl.addEventListener('keydown', (e) => { e.stopPropagation(); onPanelKey(e); if (e.key === 'Escape' && !e.target.matches?.('.bs-rename')) { e.preventDefault(); closeFloat(); } });
  floatEl.addEventListener('focusout', onPanelFocusOut);
  attachDrop(floatEl);
  document.body.append(floatEl);
  // Remembered: once opened it comes back with every popover until you close it ([»], Esc, shift+B, or the builder)
  function placeFloat() {
    const host = [...document.querySelectorAll('dialog[open]')].pop();
    if (!host) { hideFloat(); return false; }                    // it only floats over popovers
    if (floatEl.parentNode !== host) host.append(floatEl);
    return true;
  }
  // shown at once — the popover's opening animation never moves or fades it (see dlg-frame-in in the CSS)
  function showFloat() {
    if (!placeFloat()) return;
    floatEl.hidden = false;
    builder.el.classList.add('bs-float-open');
    renderPanel(floatEl, true);
    if (!items) load();
  }
  function hideFloat() { if (floatEl.hidden) return; floatEl.hidden = true; builder?.el?.classList.remove('bs-float-open'); }
  function openFloat() {
    if (!document.querySelector('dialog[open]')) return setSide(true);   // on the main page: the docked sidebar
    store.set('bsFloatOpen', true);
    showFloat();
  }
  // closed by hand while the docked sidebar is open: stays closed until you're back on the main page
  var floatDismissed = false;   // eslint-disable-line no-var
  function closeFloat() { store.set('bsFloatOpen', false); if (sideOpen() && !floatEl.hidden) floatDismissed = true; hideFloat(); }
  function toggleFloat() { (floatEl.hidden ? openFloat : closeFloat)(); }
  // a popover opened / closed: follow it, or reopen in the next one if it was left open
  // (also open whenever the docked binder sidebar is open on the main page)
  new MutationObserver(() => {
    if (!document.querySelector('dialog[open]')) { floatDismissed = false; return hideFloat(); }
    if (store.get('bsFloatOpen', false) || (sideOpen() && !floatDismissed)) showFloat();
    else if (!floatEl.hidden) placeFloat();
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  document.body.classList.toggle('bside-open', !!store.get('bsideOpen', false));

  // ───────────────────────── notes in the popover sidebars ─────────────────────────
  // target: { kind: 'story', st } | { kind: 'article', a }. Saving a note puts the story / article into the open
  // binder with that note (or updates the note if it's already there).
  const entryFor = (t) => (items || []).find((e) => e.book === book && (t.kind === 'story' ? e.kind === 'story' && e.sid === t.st.sid : e.kind === 'article' && norm(e.link) === norm(t.a.link)));
  async function mountNote(el, t) {
    if (!el) return;
    if (!signedIn()) {
      el.innerHTML = '<div class="dim small"><button type="button" class="link" data-note="signin">[sign in]</button> to keep notes — they go into your research binder</div>';
      el.onclick = (e) => { if (e.target.closest('[data-note=signin]')) auth.openLogin('sign in to keep notes'); };
      return;
    }
    if (!auth.can('binder.use')) { el.closest('.pop-note-sec')?.remove(); return; }
    if (!items || !books.length) await load();       // (the first load can run before sign-in is known)
    let editingNote = false;
    const draw = () => {
      const e = entryFor(t);
      const where = el.closest('.pop-note-sec')?.querySelector('.note-where');     // looked up each time: popovers re-render
      if (where) where.textContent = e ? `· in ${bookName()}` : '';
      if (editingNote) {
        el.innerHTML = `<div class="note-form"><textarea data-note-text maxlength="4000" placeholder="${t.kind === 'story' ? 'notes on this story…' : 'notes on this article…'}">${esc(e?.note || '')}</textarea>
          <div class="note-acts"><span class="dim small">ctrl+⏎ to save · saves to ${esc(bookName())}</span><button type="button" class="link" data-note="cancel">[cancel]</button> <button type="button" class="note-save" data-note="save">SAVE</button></div></div>`;
        const ta = el.querySelector('textarea');
        ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
        return;
      }
      el.innerHTML = e?.note
        ? `<div class="note-text">${esc(e.note)}</div><button type="button" class="link note-edit" data-note="edit">[✎ edit]</button>`
        : `<button type="button" class="link note-add" data-note="edit">[+ add a note]</button>${e ? '' : ` <span class="dim small">saves the ${t.kind} to ${esc(bookName())}</span>`}`;
    };
    async function saveNote() {
      const note = el.querySelector('[data-note-text]')?.value.trim() || '';
      const e = entryFor(t);
      try {
        ctx.activity?.('note', `${note ? 'noted' : 'cleared the note'} on ${t.kind === 'story' ? `story ${t.st.sid}` : 'an article'}${note ? `: “${note.slice(0, 80)}”` : ''} — ${(t.kind === 'story' ? t.st.title : t.a.title) || ''}`,
          t.kind === 'story' ? { sid: t.st.sid } : { link: t.a.link, title: t.a.title, sourceId: t.a.sourceId, date: t.a.date });
        if (e) { await api(`binder/${e.id}`, { method: 'PATCH', body: { note } }); e.note = note || null; log(`✎ note ${note ? 'saved' : 'cleared'} <span class="dim">· ${esc(bookName())}</span>`, 'ok'); }
        else if (note) {
          const body = t.kind === 'story' ? { kind: 'story', sid: t.st.sid, note, book } : { kind: 'article', link: t.a.link, note, book };
          const r = await api('binder', { method: 'POST', body });
          if (r.item?.morgue && r.item.link) ctx.onMorgue?.(r.item.link, r.item.morgue);
          // saving an item that was already there returns it unchanged: set the note on it
          if (r.item && (r.item.note || '') !== note) await api(`binder/${r.item.id}`, { method: 'PATCH', body: { note } });
          await load();
          log(`✎ note saved — ${t.kind === 'story' ? `story <b>${esc(t.st.sid)}</b>` : 'the article'} is now in ${esc(bookName())}${r.item?.morgue ? ` <span class="dim">· morgue no. ${esc(r.item.morgue)}</span>` : ''}`, 'ok');
        }
        editingNote = false; draw();
        if (dlg.open) render();
      } catch (ex) { if (!auth.denied(ex)) log(`couldn't save the note: ${esc(ex.data?.error || ex.message)}`, 'err'); }
    }
    el.onclick = (e) => {
      const a = e.target.closest('[data-note]')?.dataset.note;
      if (a === 'edit') { editingNote = true; draw(); }
      else if (a === 'cancel') { editingNote = false; draw(); }
      else if (a === 'save') saveNote();
    };
    el.onkeydown = (e) => {
      e.stopPropagation();                                     // typing must not trigger popover shortcuts
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); }
      if (e.key === 'Escape' && editingNote) { e.preventDefault(); editingNote = false; draw(); }
    };
    el._redraw = draw;
    draw();
  }
  // the open binder changed (or an entry did): refresh any note boxes on screen
  const redrawNotes = () => { for (const el of document.querySelectorAll('.note-slot')) if (el._redraw && !el.querySelector('textarea')) el._redraw(); };
  return { open, toggle, load, mountNote, redrawNotes, toggleSide: () => (document.querySelector('dialog[open]') ? toggleFloat() : setSide(!sideOpen())), renderSide, builder, saveArticle, saveStory, isSavedArticle, isSavedStory };
}
