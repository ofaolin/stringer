// Reader view: fetch an article page and pull out its main text, Readability-style, with no dependencies.
import { isGoogleNewsLink } from './feeds.js';
// The page is parsed into a small DOM-ish tree, paragraphs vote for their containers, the best container
// wins, and its content is re-serialized through a tag/attribute whitelist (so nothing from the page — no
// scripts, styles, handlers or tracking — survives). JSON-LD articleBody is the fallback.
import { decodeEntities } from './feeds.js';
import { safeFetch } from './netguard.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MAX_BYTES = 6 * 1024 * 1024;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param']);
const RAW = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'svg', 'math', 'iframe', 'object', 'canvas', 'select']);
const CLOSES_P = new Set(['p', 'div', 'ul', 'ol', 'dl', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'table', 'blockquote', 'pre', 'section', 'article', 'aside', 'header', 'footer', 'form', 'hr', 'main', 'nav']);
const DROP = new Set(['nav', 'header', 'footer', 'aside', 'form', 'button', 'input', 'select', 'label', 'dialog', 'menu', 'fieldset']);
const UNLIKELY = /(comment|sidebar|side-bar|footer|related|recommend|promo|newsletter|subscri|share|social|advert|\bads?\b|ad-?slot|ad-?container|dfp|outbrain|taboola|popup|modal|cookie|consent|breadcrumb|\bnav\b|navbar|menu|masthead|signup|sign-up|paywall|trending|most-?popular|more-?stories|read-?more|byline-?tools|toolbar|audio-?player|video-?player|skip-?link|\bhidden\b|visually-?hidden|sr-only|tags?-?list|author-?bio|disclaimer|correction-?form|sponsor)/i;
const LIKELY = /(article|body|content|story|entry|main|post|text|blog|prose|rich-?text|paragraph)/i;
const POSITIVE = /(article|body|content|entry|main|page|post|text|blog|story|prose)/i;
const NEGATIVE = /(hidden|banner|combx|comment|com-|contact|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|caption|credit)/i;

// ── tiny HTML parser ──
function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}
export function parseHTML(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=\/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0, m;
  const text = (t) => { if (t) cur.children.push(t); };
  while ((m = re.exec(html))) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) {                                         // close tag: pop to the nearest matching open element
      const tag = m[1].toLowerCase();
      for (let n = cur; n !== root; n = n.parent) if (n.tag === tag) { cur = n.parent; break; }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (cur.tag === 'p' && CLOSES_P.has(tag)) cur = cur.parent;
      if (tag === 'li' && cur.tag === 'li') cur = cur.parent;
      const el = { tag, attrs: parseAttrs(m[3] || ''), children: [], parent: cur };
      cur.children.push(el);
      if (RAW.has(tag)) {                               // skip raw-text contents entirely
        const end = html.toLowerCase().indexOf(`</${tag}`, last);
        last = re.lastIndex = end < 0 ? html.length : end;
        continue;
      }
      if (!VOID.has(tag) && !m[4]) cur = el;
    }
  }
  text(html.slice(last));
  return root;
}

const isEl = (n) => typeof n === 'object';
const textOf = (n) => (typeof n === 'string' ? decodeEntities(n) : n.tag === 'br' ? '\n' : n.children.map(textOf).join(''));
const clean = (s) => s.replace(/\s+/g, ' ').trim();
function* walk(n) { for (const c of n.children) if (isEl(c)) { yield c; yield* walk(c); } }
const classId = (n) => `${n.attrs.class || ''} ${n.attrs.id || ''}`;
function linkDensity(n) {
  const all = clean(textOf(n)).length || 1;
  let links = 0;
  for (const a of walk(n)) if (a.tag === 'a') links += clean(textOf(a)).length;
  return links / all;
}

// ── metadata ──
function meta(root) {
  const m = {};
  for (const n of walk(root)) {
    if (n.tag !== 'meta') continue;
    const k = (n.attrs.property || n.attrs.name || n.attrs.itemprop || '').toLowerCase();
    if (k && n.attrs.content && !m[k]) m[k] = n.attrs.content;
  }
  return m;
}
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1].trim());
      const stack = [v];
      while (stack.length) {
        const x = stack.pop();
        if (Array.isArray(x)) stack.push(...x);
        else if (x && typeof x === 'object') {
          if (x['@graph']) stack.push(x['@graph']);
          const t = [].concat(x['@type'] || []).join(' ');
          if (/Article|BlogPosting|Report/i.test(t)) out.push(x);
        }
      }
    } catch { /* malformed JSON-LD is common */ }
  }
  return out[0] || null;
}
const authorName = (a) => [].concat(a || []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean).join(', ');

// ── content scoring ──
// class/id tokens only (utility-CSS variants like `md:hidden` or `overflow-hidden` say nothing about content)
const tokensOf = (n) => classId(n).split(/\s+/).filter((t) => t && !t.includes(':') && !/^(overflow|group|peer)-/.test(t)).join(' ');
const pTextLen = (n) => { let k = 0; for (const c of walk(n)) if (c.tag === 'p') k += clean(textOf(c)).length; return k; };
function prune(root) {
  const total = pTextLen(root) || 1;
  const kill = [];
  for (const n of walk(root)) {
    const ci = tokensOf(n);
    const role = n.attrs.role || '';
    const junk = DROP.has(n.tag) || /^(navigation|banner|complementary|contentinfo|dialog|search)$/.test(role) ||
      n.attrs.hidden != null || n.attrs['aria-hidden'] === 'true' || /display:\s*none/.test(n.attrs.style || '') ||
      (UNLIKELY.test(ci) && !LIKELY.test(ci) && n.tag !== 'body' && n.tag !== 'article' && n.tag !== 'main');
    // never drop a container that holds a big share of the page's paragraph text — that's the article
    if (junk && pTextLen(n) < total * 0.3) kill.push(n);
  }
  for (const n of kill) { const p = n.parent; if (p) p.children = p.children.filter((c) => c !== n); }
}
function bestContainer(root) {
  const score = new Map();
  const classWeight = (n) => (NEGATIVE.test(tokensOf(n)) ? -25 : 0) + (POSITIVE.test(tokensOf(n)) ? 25 : 0);
  const add = (n, s) => { if (!n || n.tag === '#root') return; if (!score.has(n)) score.set(n, classWeight(n) + (n.tag === 'article' ? 10 : n.tag === 'div' || n.tag === 'section' || n.tag === 'main' ? 5 : 0)); score.set(n, score.get(n) + s); };
  for (const p of walk(root)) {
    if (p.tag !== 'p' && p.tag !== 'pre' && p.tag !== 'blockquote') continue;
    const t = clean(textOf(p));
    if (t.length < 25) continue;
    const s = 1 + (t.match(/,/g) || []).length + Math.min(3, Math.floor(t.length / 100));
    add(p.parent, s);
    add(p.parent?.parent, s / 2);
    add(p.parent?.parent?.parent, s / 3);
  }
  let best = null, bestScore = 0;
  for (const [n, s] of score) {
    const f = s * (1 - linkDensity(n));
    if (f > bestScore) { best = n; bestScore = f; }
  }
  if (!best) return null;
  // articles split over several sibling wrappers (BBC, many CMSes): climb while an ancestor holds clearly
  // more paragraph text without turning into a link farm
  for (let i = 0, base = pTextLen(best); i < 4; i++) {
    const up = best.parent;
    if (!up || up.tag === '#root' || up.tag === 'body' || up.tag === 'html') break;
    if (pTextLen(up) >= base * 1.4 && linkDensity(up) < 0.3) { best = up; base = pTextLen(up); bestScore = Math.max(bestScore, score.get(up) || 0); }
    else if (pTextLen(up) > base) continue;
    else break;
  }
  // pull in siblings that look like more of the same article (split bodies are common)
  const parent = best.parent;
  if (!parent || parent.tag === '#root') return [best];
  const thresh = Math.max(10, bestScore * 0.2);
  return parent.children.filter((c) => {
    if (c === best) return true;
    if (!isEl(c)) return false;
    if ((score.get(c) || 0) * (1 - linkDensity(c)) >= thresh) return true;
    if (c.tag === 'p') { const t = clean(textOf(c)); return t.length > 80 && linkDensity(c) < 0.25; }
    return false;
  });
}

// ── whitelist serializer ──
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const KEEP = { p: 'p', h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4', ul: 'ul', ol: 'ol', li: 'li', blockquote: 'blockquote',
  figure: 'figure', figcaption: 'figcaption', strong: 'strong', b: 'strong', em: 'em', i: 'em', pre: 'pre', code: 'code', br: 'br', hr: 'hr',
  table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', td: 'td', th: 'th', sup: 'sup', sub: 'sub' };
function absUrl(u, base) {
  try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
function imgSrc(n, base) {
  const a = n.attrs;
  let src = a['data-src'] || a['data-original'] || a['data-lazy-src'] || a['data-url'] || a.src || '';
  if ((!src || src.startsWith('data:')) && (a.srcset || a['data-srcset'])) {
    const set = (a.srcset || a['data-srcset']).split(',').map((x) => x.trim().split(/\s+/));
    src = (set[set.length - 1] || [])[0] || '';                  // largest candidate is usually last
  }
  if (!src || src.startsWith('data:')) return null;
  if (Number(a.width) && Number(a.width) < 80) return null;     // tracking pixels / icons
  return absUrl(src.replace(/\{width\}/g, '1024'), base);
}
function serialize(nodes, base) {
  let out = '';
  const seenImg = new Set();
  const emit = (n) => {
    if (!isEl(n)) { out += escHtml(decodeEntities(n)); return; }
    if (n.tag === 'img') {
      const src = imgSrc(n, base);
      if (src && !seenImg.has(src)) { seenImg.add(src); out += `<img src="${escHtml(src)}" alt="${escHtml(clean(n.attrs.alt || ''))}" loading="lazy" referrerpolicy="no-referrer">`; }
      return;
    }
    if (n.tag === 'picture') { const img = [...walk(n)].find((c) => c.tag === 'img'); if (img) emit(img); return; }
    if (n.tag === 'a') {
      const href = absUrl(n.attrs.href || '', base);
      const inner = n.children.map(emitTo).join('');
      out += href && inner.trim() ? `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
      return;
    }
    const tag = KEEP[n.tag];
    if (!tag) { n.children.forEach(emit); if (/^(div|section|article|main)$/.test(n.tag)) out += '\n'; return; }
    if (tag === 'br' || tag === 'hr') { out += `<${tag}>`; return; }
    const inner = n.children.map(emitTo).join('');
    if (/^(p|h2|h3|h4|li|figcaption|blockquote)$/.test(tag) && !inner.replace(/<[^>]+>/g, '').trim() && !/<img /.test(inner)) return;
    out += `<${tag}>${inner}</${tag}>`;
  };
  const emitTo = (n) => { const save = out; out = ''; emit(n); const r = out; out = save; return r; };
  nodes.forEach(emit);
  return out.replace(/\n{2,}/g, '\n').trim();
}

// ── fetch ──
async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    // (safeFetch: public addresses only, every redirect re-checked — see lib/netguard.js)
    const r = await safeFetch(url, { signal: ctrl.signal, headers: {
      'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!r.ok) {
      throw Object.assign(new Error(r.status === 401 || r.status === 403 ? `the site blocks reader requests (HTTP ${r.status})`
        : r.status === 404 || r.status === 410 ? `the page no longer exists (HTTP ${r.status})` : `the site answered HTTP ${r.status}`),
      { gone: r.status === 404 || r.status === 410 });
    }
    // a dead article link often just redirects to the site's front page
    try {
      const from = new URL(url), to = new URL(r.finalUrl || url);
      if (from.pathname.length > 1 && to.pathname.replace(/\/+$/, '') === '' && !from.search) throw Object.assign(new Error('the page no longer exists (the site redirects it to its front page)'), { gone: true });
    } catch (e) { if (e.gone) throw e; }
    const type = r.headers.get('content-type') || '';
    if (type && !/html|xml/i.test(type)) throw new Error(`not a web page (${type.split(';')[0]})`);
    const chunks = []; let size = 0;
    for await (const c of r.body) { chunks.push(c); size += c.length; if (size > MAX_BYTES) break; }
    const buf = Buffer.concat(chunks);
    let charset = type.match(/charset=([\w-]+)/i)?.[1];
    if (!charset) charset = buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(charset.toLowerCase()).decode(buf); } catch { html = buf.toString('utf8'); }
    return { html, url: r.finalUrl || url };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('the site took too long to respond');
    if (e.gone || e.blocked) throw e;
    throw new Error(e.cause?.code ? `could not reach the site (${e.cause.code})` : e.message);
  } finally { clearTimeout(t); }
}

const cache = new Map();

// Link rot: old article URLs die (sites restructure, e.g. foxnews.com/politics/2015/01/04/<slug>/ → 404). The
// Wayback Machine usually saved the page; take the snapshot closest to the publish date. `id_` asks for the page
// exactly as it was captured, without the archive's toolbar or rewritten links.
const stamp = (t) => new Date(t).toISOString().replace(/\D/g, '').slice(0, 14);
async function waybackSnapshot(url, date, { cdxTimeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const q = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}${date ? `&timestamp=${stamp(date)}` : ''}`;
    // archive.org down / overloaded / slow (5xx, timeouts) is "try again later", not "no copy"
    const flaky = (what) => Object.assign(new Error(`the Wayback Machine is unavailable right now (${what})`), { waybackTransient: true });
    let r;
    try { r = await safeFetch(q, { signal: ctrl.signal, headers: { 'User-Agent': UA } }); } catch (e) { throw flaky(e.name === 'AbortError' ? 'timed out' : e.cause?.code || e.message); }
    // archive.org rate-limiting us (429) isn't "no copy": say so (the harvester backs off on it). (A 403 is about the
    // page or the kind of query — e.g. sites excluded from the archive — not about us.)
    if (r.status === 429) throw Object.assign(new Error(`the Wayback Machine refused the lookup (HTTP ${r.status})`), { waybackRefused: true });
    if (r.status >= 500) throw flaky(`HTTP ${r.status}`);
    if (!r.ok) return null;
    const c = await r.json().then((j) => j?.archived_snapshots?.closest, () => null);
    let ts = c?.available && String(c.status) === '200' && /^\d{14}$/.test(c.timestamp) ? c.timestamp : null;
    // the availability API sometimes says "none" for pages the archive does have: ask its capture index (CDX) too
    // Captures are often stored under the address with a tracking parameter (…/?srsltid=…), so search the address
    // with any query string after it and keep only captures of this same page.
    let orig = url;
    if (!ts) {
      const bare = url.replace(/[?#].*$/, '');
      const same = (x) => String(x).replace(/^https?:\/\//i, '').replace(/:80\//, '/').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase() === bare.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
      const cdx = async (prefix) => {
        const cq = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(bare)}${prefix ? '&matchType=prefix' : ''}&filter=statuscode:200&fl=timestamp,original&output=json&limit=50${date ? `&closest=${stamp(date)}&sort=closest` : ''}`;
        const c2 = new AbortController(), t2 = setTimeout(() => c2.abort(), cdxTimeout);   // (the capture index is slow: often 15–40s)
        try {
          const cr = await safeFetch(cq, { signal: c2.signal, headers: { 'User-Agent': UA } });
          if (cr.status === 429) throw Object.assign(new Error('the Wayback Machine refused the lookup (HTTP 429)'), { waybackRefused: true });
          return { status: cr.status, rows: cr.ok ? await cr.json().catch(() => null) : null };
        } catch (e) { if (e.waybackRefused) throw e; return { status: 0, rows: null }; } finally { clearTimeout(t2); }
      };
      // (some sites' addresses can't be searched with a prefix — "requires authorization": ask for the exact address)
      let { status, rows } = await cdx(true);
      if (status === 403) ({ status, rows } = await cdx(false));
      if (status === 0 || status >= 500) throw flaky(status ? `HTTP ${status}` : 'its capture index timed out');
      const hit = Array.isArray(rows) ? rows.find((x) => Array.isArray(x) && /^\d{14}$/.test(x[0]) && same(x[1])) : null;   // (row 0 is the header)
      if (!hit) return null;
      [ts, orig] = hit;
      if (!/^https?:\/\//i.test(orig)) orig = `https://${orig}`;
    }
    return { timestamp: ts, raw: `https://web.archive.org/web/${ts}id_/${orig}`, view: `https://web.archive.org/web/${ts}/${orig}` };
  } finally { clearTimeout(t); }
}
const looksLikeNotFound = (r) => !r.ok && /\b(404|page not found|not found|page (?:does not|doesn't|cannot be) (?:exist|found))\b/i.test(`${r.title} ${r.excerpt}`);

// The Wayback Machine's copy of a page (the capture closest to `date`), extracted like the page itself. Throws when
// there's no copy or it can't be loaded; `reason` (why the original wasn't used) prefixes those errors and is kept
// on the result. Also used by the harvester for sites that refuse automated requests.
// cdxTimeout: how long to wait for archive.org's capture index — short for someone waiting in the reader, long for
// the harvester (background, one lookup at a time).
export async function readWayback(url, { date = null, reason = 'the original could not be read', gone = false, cdxTimeout } = {}) {
  const snap = await waybackSnapshot(url, date, { cdxTimeout }).catch((e) => { throw Object.assign(new Error(`${reason} — and ${e.message}`), { waybackRefused: !!e.waybackRefused, waybackTransient: !!e.waybackTransient }); });
  if (!snap) throw new Error(`${reason} — and the Wayback Machine has no copy of it`);
  const page = await fetchPage(snap.raw).catch((e2) => {
    throw Object.assign(new Error(`${reason} — and its Wayback Machine copy could not be loaded (${e2.message})`), { waybackRefused: /HTTP 429\b/.test(e2.message), waybackTransient: /HTTP 5\d\d\b|timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(e2.message) });
  });
  const res = extract(page.html, url);                     // resolve the page's own relative links against the original
  res.url = url;
  res.wayback = { url: snap.view, timestamp: snap.timestamp, reason, gone };
  return res;
}

// opts.wayback: when the page is gone, read the Wayback Machine's copy instead (opts.date picks the snapshot).
// opts.onRefusal: also when the site refuses the request (401/403/451) — e.g. outlets that turn away automated readers
// opts.anyFailure (archive articles): also when the original can't be read at all — refused, unreachable, timed
// out, or no article text on it — since the Wayback copy is the historical record of that page.
export async function readArticle(url, opts = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('bad url'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) pages can be read');   // (private addresses: safeFetch)
  // a Google News redirect: the page is Google's, not the article (whose address Google doesn't put in its feeds)
  if (isGoogleNewsLink(u.href)) throw Object.assign(new Error("this is a Google News link — Google's feeds don't include the article's own address, so its text can't be fetched (open the original, or switch the outlet to its own feed or news sitemap)"), { googleNews: true });
  const key = (opts.wayback ? (opts.anyFailure ? 'wa|' : opts.onRefusal ? 'wr|' : 'w|') : '') + u.href;
  if (cache.has(key)) return cache.get(key);

  let res;
  try {
    const page = await fetchPage(u.href);
    res = extract(page.html, page.url);
    if (opts.wayback && looksLikeNotFound(res)) throw Object.assign(new Error('the page no longer exists (the site shows a "not found" page)'), { gone: true });
    if (opts.wayback && opts.anyFailure && !res.content) throw new Error(res.reason || 'no article text found on the page');
  } catch (e) {
    // (never look up a refused private address or a Google News redirect)
    const refused = opts.onRefusal && /HTTP (401|403|451)\b/.test(e.message);
    if (e.blocked || e.googleNews || !opts.wayback || !(e.gone || opts.anyFailure || refused)) throw e;
    res = await readWayback(u.href, { date: opts.date, reason: e.message, gone: !!e.gone });
  }
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(key, res);
  return res;
}

// Text-based cleanup of the extracted HTML, for widgets whose markup gives no class/role hint: a "Recommended
// stories" / "Related" / "Read more"-style heading with the link list under it, "Read more: <link>" lines,
// and screen-reader labels like Al Jazeera's "list of 4 items" / "list 1 of 4" / "end of list". Also applied to morgue copies
// filed before this existed.
const PROMO_HEAD = /^(recommended( stories| reading| for you)?|related( stories| articles| coverage| content| reading| news| links)?|read more|more (stories|news|coverage|reading|on this( story| topic)?|from [\w .'’-]{1,40})|you (may|might) (also )?(like|be interested in)|also (read|see|on [\w .'’-]{1,30})|read also|see also|further reading|keep reading|what to read next|top stories|most (read|popular|viewed)|trending( now)?|editor[’']?s picks|latest( news| stories)?|popular( now| stories)?|don[’']?t miss|more to explore)[\s:.!…-]*$/i;
const PROMO_LINE = /^\s*(read more|also read|read also|related|see also|recommended|more|watch|listen|click here|related coverage|related article|related story|read next|explore more)\s*[:|»›→-]/i;
const plain = (h) => decodeEntities(h.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
export function declutter(html) {
  if (!html) return html;
  let out = html
    .replace(/\blist of \d+ items?\b/gi, '')
    .replace(/(^|>)\s*end of list\s*(?=<|$)/gi, '$1')                // the list's closing label, left as bare text
    .replace(/(<li>)\s*list \d+ of \d+\s*/gi, '$1');
  // heading that names a promo block, plus the list / link-only paragraphs right after it
  out = out.replace(/<(h[2-4])>([\s\S]*?)<\/\1>((?:\s*(?:<(ul|ol)>[\s\S]*?<\/\4>|<p>\s*<a\b[^>]*>[\s\S]*?<\/a>\s*<\/p>))*)/gi,
    (all, tag, inner, after) => (PROMO_HEAD.test(plain(inner)) ? '' : all));
  // text-to-speech / audio player placeholders ("Loading the Elevenlabs Text to Speech AudioNative Player...",
  // "Listen to this article", "Your browser does not support the audio element") — a short line, with or without <p>
  out = out.replace(/(?:<p>\s*)?Loading the\s*(?:<a\b[^>]*>)?[^<]{0,80}?(?:<\/a>)?\s*(?:AudioNative|audio|text[- ]to[- ]speech)[^<]{0,30}?player\.*\s*(?:<\/p>)?/gi, '')
    .replace(/<p>\s*(?:<[^>]+>\s*)*(?:listen to (?:this|the) (?:article|story)(?: here)?|your browser does not support the audio(?: element)?)[^<]{0,40}(?:<\/[^>]+>\s*)*<\/p>/gi, '');
  // teaser cards: a link to another page wrapped around a headline (and usually a thumbnail and a timestamp) —
  // "more stories" grids at the end of an article. A heading linking to a spot on a page (#…) is the article's own
  // section heading (a table of contents), so it stays.
  out = out.replace(/<a\b([^>]*)>(?:(?!<\/a>)[\s\S])*?<h[1-6]>[\s\S]*?<\/a>/gi, (all, at) => (/href="[^"]*#/.test(at) ? all : ''));
  // "Read more: <a>…</a>" lines (mostly a link)
  out = out.replace(/<p>([\s\S]*?)<\/p>/gi, (all, inner) => {
    const t = plain(inner);
    if (!PROMO_LINE.test(t) || t.length > 220) return all;
    const linked = plain((inner.match(/<a\b[\s\S]*?<\/a>/gi) || []).join(' ')).length;
    return linked >= t.length * 0.5 ? '' : all;
  });
  return out;
}

function extract(html, finalUrl) {
  const root = parseHTML(html);
  const m = meta(root);
  const ld = jsonLd(html);
  const titleEl = [...walk(root)].find((n) => n.tag === 'h1');
  const res = {
    url: finalUrl,
    title: clean(m['og:title'] || ld?.headline || (titleEl ? textOf(titleEl) : '') || ''),
    site: clean(m['og:site_name'] || ld?.publisher?.name || new URL(finalUrl).hostname.replace(/^www\./, '')),
    byline: clean(authorName(ld?.author) || m.author || m['article:author'] || ''),
    published: m['article:published_time'] || ld?.datePublished || null,
    image: absUrl(m['og:image'] || '', finalUrl),
    excerpt: clean(m['og:description'] || m.description || ''),
    content: '',
    words: 0,
    ok: false,
  };
  if (/^https?:\/\//.test(res.byline)) res.byline = '';

  prune(root);
  const nodes = bestContainer(root);
  if (nodes) res.content = declutter(serialize(nodes, finalUrl));
  const textLen = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
  // JSON-LD articleBody is often the complete text on sites whose markup is hard to read (or paywalled)
  const body = typeof ld?.articleBody === 'string' ? ld.articleBody.trim() : '';
  if (body.length > Math.max(400, textLen(res.content) * 1.3)) {
    res.content = body.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escHtml(decodeEntities(p))}</p>`).join('');
  }
  const len = textLen(res.content);
  res.words = Math.round(len / 5.7);
  res.ok = len >= 700;                                  // ~120 words; less is usually a bio, teaser or paywall stub
  if (!res.ok) res.reason = len ? 'only a fragment of the article could be extracted (paywall or script-rendered page?)' : 'no article text found on the page (paywall or script-rendered page?)';
  return res;
}
