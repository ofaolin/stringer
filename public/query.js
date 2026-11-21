// STRINGER query language — a Lucene-style syntax shared by the server (filtering) and the client
// (validation, highlighting, autocomplete).
//
//   nvidia huang                 implicit AND
//   title:"house speaker"        field + phrase
//   source:(dailywire OR npr)    field applied to a group
//   bias:[l TO ll]  votes:>0     ranges and comparisons
//   -source:breitbart  !foo      negation (also NOT)
//   trump*  te?t  huang~1        wildcards, fuzzy
//   title:/gta ?(6|vi)/          regex
//   age:<6h  date:today  sources:>=5  blindspot:any

export const FIELDS = {
  title:     { kind: 'text', scope: 'article', desc: 'headline words', examples: ['nvidia', '"house speaker"', 'trump*'] },
  summary:   { kind: 'text', scope: 'article', aliases: ['desc'], desc: 'summary text', examples: ['"supreme court"'] },
  text:      { kind: 'text', scope: 'article', aliases: ['all'], desc: 'anywhere: headline, summary and the full article text', examples: ['ukraine', '"supply chain"'] },
  body:      { kind: 'text', scope: 'article', aliases: ['fulltext', 'content'], desc: 'full article text (harvested from the live feeds)', examples: ['"according to court documents"', 'tariff*', '/\\$\\d+ billion/'] },
  author:    { kind: 'text', scope: 'article', aliases: ['byline', 'by'], desc: 'article byline (harvested articles)', examples: ['"jane doe"', 'smith'] },
  words:     { kind: 'num', scope: 'article', aliases: ['length'], desc: 'article length in words (0 = no full text)', examples: ['>0', '>1500', '<300', '[500 TO 1000]'] },
  comment:   { kind: 'text', scope: 'article', aliases: ['discussion'], desc: 'text of the comments on an article (stories: on any of its articles)', examples: ['"good point"', 'source*'] },
  comments:  { kind: 'num', scope: 'article', aliases: ['ncomments'], desc: '# of comments — per article; in STORIES mode the whole discussion', examples: ['>0', '>=5', '0'] },
  read:      { kind: 'enum', scope: 'article', aliases: ['seen'], desc: "whether you've read it (signed in): articles in STREAM / the archive, stories in STORIES mode", values: ['yes', 'no'] },
  saved:     { kind: 'enum', scope: 'article', aliases: ['binder', 'bookmarked'], desc: 'in your research binder (signed in): articles saved or quoted; in STORIES mode, saved stories', values: ['yes', 'no'] },
  story:     { kind: 'text', scope: 'article', aliases: ['sid'], desc: 'story number (6 characters) — a story, or the articles in it', examples: ['3fa91c'] },
  topic:     { kind: 'enum', scope: 'article', aliases: ['section', 'category', 'cat'], desc: 'subject — from the link\'s section, else headline keywords (stories: their articles\' most common)', values: ['politics', 'world', 'business', 'tech', 'science', 'health', 'crime', 'sports', 'culture', 'other'] },
  morgue:    { kind: 'text', scope: 'article', aliases: ['uuid', 'nid', 'id'], desc: 'morgue no. of an article in the STRINGER morgue (8 hex characters; * = any)', examples: ['fa5ee277', '*'] },
  source:    { kind: 'keyword', scope: 'article', aliases: ['src', 'outlet'], desc: 'outlet id or name', dynamic: 'sources' },
  domain:    { kind: 'domain', scope: 'article', aliases: ['site', 'host', 'url'], desc: 'article link domain', examples: ['nytimes.com', '*.co.uk'] },
  bias:      { kind: 'bias', scope: 'article', desc: 'outlet bias  l ll c lr r  or −2…2', examples: ['>0', '<0', '[l TO ll]', '[lr TO r]'] },
  side:      { kind: 'enum', scope: 'article', desc: 'outlet side', values: ['left', 'center', 'right'] },
  type:      { kind: 'enum', scope: 'article', aliases: ['media'], desc: 'legacy or new media', values: ['legacy', 'new'] },
  votes:     { kind: 'num', scope: 'article', desc: 'your votes on the outlet', examples: ['>0', '<0', '>=3', '0'] },
  age:       { kind: 'duration', scope: 'article', desc: 'article age (m/h/d); bare = at most', examples: ['<1h', '<6h', '12h', '[2h TO 12h]', '>1d'] },
  date:      { kind: 'date', scope: 'article', desc: 'published  YYYY · YYYY-MM · YYYY-MM-DD · today (searches the archive)', examples: ['*', 'today', 'yesterday', '2016', '2020-03', '[2015 TO 2018]', '<2010'] },
  sources:   { kind: 'num', scope: 'story', desc: '# outlets covering the story', examples: ['>=5', '>=10', '1', '[2 TO 4]'] },
  articles:  { kind: 'num', scope: 'story', desc: '# articles in the story', examples: ['>=3', '>=10'] },
  left:      { kind: 'num', scope: 'story', desc: '# left-leaning outlets in story', examples: ['0', '>=3'] },
  center:    { kind: 'num', scope: 'story', desc: '# center outlets in story', examples: ['0', '>=2'] },
  right:     { kind: 'num', scope: 'story', desc: '# right-leaning outlets in story', examples: ['0', '>=3'] },
  blindspot: { kind: 'enum', scope: 'story', desc: 'side ignoring the story', values: ['left', 'right', 'any', 'none'] },
  lean:      { kind: 'enum', scope: 'story', desc: 'overall coverage lean', values: ['left', 'balanced', 'right'] },
};

const FIELD_ALIAS = new Map();
for (const [name, f] of Object.entries(FIELDS)) {
  FIELD_ALIAS.set(name, name);
  for (const a of f.aliases || []) FIELD_ALIAS.set(a, name);
}
export const canonField = (f) => FIELD_ALIAS.get(String(f).toLowerCase()) || null;

export const BIAS_VALUES = {
  l: -2, left: -2, ll: -1, leanleft: -1, 'lean-left': -1, c: 0, center: 0, centre: 0,
  lr: 1, leanright: 1, 'lean-right': 1, r: 2, right: 2,
};
export const BIAS_HINT = { l: 'left (−2)', ll: 'lean left (−1)', c: 'center (0)', lr: 'lean right (+1)', r: 'right (+2)' };

const ENUM_ALIAS = {
  type: { newmedia: 'new', 'new-media': 'new', digital: 'new', traditional: 'legacy', old: 'legacy' },
  side: { l: 'left', c: 'center', centre: 'center', r: 'right' },
  lean: { l: 'left', r: 'right', c: 'balanced', center: 'balanced', centre: 'balanced', neutral: 'balanced' },
  blindspot: { yes: 'any', true: 'any', no: 'none', false: 'none', l: 'left', r: 'right' },
  topic: { political: 'politics', gov: 'politics', government: 'politics', elections: 'politics', international: 'world', foreign: 'world',
    economy: 'business', money: 'business', markets: 'business', finance: 'business', technology: 'tech', ai: 'tech', sci: 'science',
    climate: 'science', space: 'science', medicine: 'health', sport: 'sports', entertainment: 'culture', arts: 'culture', art: 'culture',
    lifestyle: 'culture', police: 'crime', justice: 'crime', none: 'other', misc: 'other', general: 'other' },
};

export class QueryError extends Error {
  constructor(message, pos = 0, len = 1) { super(message); this.pos = pos; this.len = len; }
}

// ───────────────────────── lexer (lenient: never throws) ─────────────────────────
const isWS = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

export function lex(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (isWS(c)) { i++; continue; }
    const s = i;
    const prev = out[out.length - 1];
    const glued = prev && prev.t === 'FIELD' && prev.e === i;      // value directly after "field:"

    if (c === '(' || c === ')') { out.push({ t: c, s, e: ++i }); continue; }
    if (c === '&' && src[i + 1] === '&') { out.push({ t: 'AND', s, e: (i += 2), sym: true }); continue; }
    if (c === '|' && src[i + 1] === '|') { out.push({ t: 'OR', s, e: (i += 2), sym: true }); continue; }
    if ((c === '-' || c === '!' || c === '+') && !glued && i + 1 < n && !isWS(src[i + 1]) && src[i + 1] !== ')') {
      out.push({ t: c === '+' ? '+' : 'NOT', s, e: ++i, sym: true });
      continue;
    }
    if (c === '"') {
      let j = i + 1, v = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) { v += src[j + 1]; j += 2; } else v += src[j++];
      }
      const closed = j < n;
      i = closed ? j + 1 : n;
      const suf = src.slice(i).match(/^(~\d+|\^[\d.]+)+/);
      if (suf) i += suf[0].length;
      out.push({ t: 'PHRASE', v, s, e: i, closed });
      continue;
    }
    if (c === '[' || c === '{') {
      let j = i + 1;
      while (j < n && src[j] !== ']' && src[j] !== '}') j++;
      const closed = j < n;
      const inner = src.slice(i + 1, j);
      const m = inner.match(/^\s*(\S+)\s+TO\s+(\S+)\s*$/);
      i = closed ? j + 1 : n;
      out.push({ t: 'RANGE', s, e: i, closed, lo: m?.[1], hi: m?.[2], incLo: c === '[', incHi: src[j] === ']', inner });
      continue;
    }
    if (c === '/' && (glued || !prev || prev.e < i)) {
      let j = i + 1, v = '';
      while (j < n && src[j] !== '/') {
        if (src[j] === '\\' && j + 1 < n) { v += src[j] + src[j + 1]; j += 2; } else v += src[j++];
      }
      const closed = j < n;
      i = closed ? j + 1 : n;
      out.push({ t: 'REGEX', v, s, e: i, closed });
      continue;
    }
    let j = i, v = '';
    while (j < n && !isWS(src[j]) && src[j] !== '(' && src[j] !== ')' && src[j] !== '"') {
      if (src[j] === '\\' && j + 1 < n) { v += src[j + 1]; j += 2; continue; }
      if (src[j] === ':' && v && !/^[<>]=?$/.test(v)) break;
      v += src[j++];
    }
    if (src[j] === ':' && v) { out.push({ t: 'FIELD', v, s, e: j + 1 }); i = j + 1; continue; }
    if (j === i) { out.push({ t: 'TERM', v: src[i], s, e: i + 1 }); i++; continue; }
    // AND / OR / NOT; lowercase "or" / "and" too when they sit between terms (nobody searches for the word "or" —
    // but a field's value (title:or), the very start of a query, or right after "(" stays a word)
    const prevT = out[out.length - 1]?.t;
    const lowOp = /^(or|and)$/i.test(v) && v !== 'OR' && v !== 'AND' && prevT && !['FIELD', '(', 'AND', 'OR', 'NOT', '+'].includes(prevT);
    out.push({ t: v === 'AND' || v === 'OR' || v === 'NOT' ? v : lowOp ? v.toUpperCase() : 'TERM', v, s, e: j });
    i = j;
  }
  return out;
}

// ───────────────────────── parser ─────────────────────────
function lev(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let row = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let x = 1; x <= a.length; x++) {
    const next = [x];
    for (let y = 1; y <= b.length; y++)
      next[y] = Math.min(row[y] + 1, next[y - 1] + 1, row[y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

function closestField(name) {
  let best = null, bd = 3;
  for (const k of FIELD_ALIAS.keys()) { const d = lev(name.toLowerCase(), k); if (d < bd) { bd = d; best = FIELD_ALIAS.get(k); } }
  return best;
}

const parseDuration = (v) => {
  const m = String(v).toLowerCase().match(/^(\d+(?:\.\d+)?)(m|min|mins|h|hr|hrs|d|day|days|w|wk)?$/);
  if (!m) return null;
  const k = { m: 1 / 60, min: 1 / 60, mins: 1 / 60, h: 1, hr: 1, hrs: 1, d: 24, day: 24, days: 24, w: 168, wk: 168 }[m[2] || 'h'];
  return Number(m[1]) * k;
};

// date values → a [start, end) span in local time: 2016 · 2016-05 · 2016-05-12 · today · yesterday
export const parseDay = (v, now = Date.now()) => {
  const s = String(v).toLowerCase();
  let m;
  if (s === 'today' || s === 'now' || s === 'yesterday') {
    const d = new Date(s === 'yesterday' ? now - 86400e3 : now);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { start, end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const [y, mo, da] = [+m[1], +m[2], +m[3]];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    return { start: new Date(y, mo - 1, da).getTime(), end: new Date(y, mo - 1, da + 1).getTime() };
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) {
    const [y, mo] = [+m[1], +m[2]];
    if (mo < 1 || mo > 12) return null;
    return { start: new Date(y, mo - 1, 1).getTime(), end: new Date(y, mo, 1).getTime() };
  }
  if ((m = s.match(/^(\d{4})$/)) && +m[1] >= 1900 && +m[1] <= 2100) {
    return { start: new Date(+m[1], 0, 1).getTime(), end: new Date(+m[1] + 1, 0, 1).getTime() };
  }
  return null;
};

function typed(field, raw, node, which) {
  const f = FIELDS[field];
  const bad = (expect) => { throw new QueryError(`${field}: expects ${expect}, got "${raw}"`, node.s, node.e - node.s); };
  if (raw === '*' && which) return null;                       // open-ended range bound
  switch (f.kind) {
    case 'num': { const x = Number(raw); if (!Number.isFinite(x)) bad('a number'); return x; }
    case 'bias': {
      const k = String(raw).toLowerCase();
      if (k in BIAS_VALUES) return BIAS_VALUES[k];
      const x = Number(raw); if (Number.isInteger(x) && x >= -2 && x <= 2) return x;
      return bad('l, ll, c, lr, r (or −2…2)');
    }
    case 'duration': { const x = parseDuration(raw); if (x == null) bad('a duration like 30m, 6h, 2d'); return x; }
    case 'date': { const x = parseDay(raw); if (!x) bad('YYYY, YYYY-MM, YYYY-MM-DD, today or yesterday'); return x; }
    case 'enum': {
      const k = String(raw).toLowerCase();
      const v = ENUM_ALIAS[field]?.[k] || k;
      if (!f.values.includes(v)) bad(f.values.join(' | '));
      return v;
    }
    default: return String(raw).toLowerCase();
  }
}

function makeLeaf(field, t) {
  const node = { type: 'term', field, s: t.s, e: t.e };
  const f = field && FIELDS[field];
  if (t.t === 'PHRASE') {
    if (!t.closed) throw new QueryError('unterminated "quote"', t.s, t.e - t.s);
    node.kind = 'phrase';
    node.value = t.v.toLowerCase().replace(/\s+/g, ' ').trim();
    if (f && f.kind !== 'text' && f.kind !== 'keyword' && f.kind !== 'domain') node.value = typed(field, node.value, node);
  } else if (t.t === 'REGEX') {
    if (!t.closed) throw new QueryError('unterminated /regex/', t.s, t.e - t.s);
    node.re = compileRegex(t.v, t);
    node.kind = 'regex';
  } else if (t.t === 'RANGE') {
    if (!t.closed) throw new QueryError('unterminated range — use [a TO b]', t.s, t.e - t.s);
    if (!t.lo) throw new QueryError('range must look like [a TO b]', t.s, t.e - t.s);
    node.kind = 'range';
    node.incLo = t.incLo; node.incHi = t.incHi;
    node.lo = f ? typed(field, t.lo, node, 'lo') : t.lo.toLowerCase();
    node.hi = f ? typed(field, t.hi, node, 'hi') : t.hi.toLowerCase();
  } else {
    let v = t.v.replace(/\^[\d.]+$/, '');                      // boosts are accepted and ignored
    if (f && (f.kind === 'date' || f.kind === 'duration') && v === '*') { node.kind = 'any'; return node; }   // date:* = any time
    const cmp = v.match(/^(>=|<=|>|<)(.*)$/);
    if (cmp) {
      if (!cmp[2]) throw new QueryError(`missing value after ${cmp[1]}`, t.s, t.e - t.s);
      node.kind = 'cmp'; node.op = cmp[1];
      node.value = f ? typed(field, cmp[2], node) : cmp[2].toLowerCase();
    } else {
      const fz = v.match(/^(.+?)~(\d)?$/);
      if (fz) { node.kind = 'fuzzy'; node.value = fz[1].toLowerCase(); node.dist = fz[2] != null ? Number(fz[2]) : (fz[1].length <= 4 ? 1 : 2); }
      else if (/[*?]/.test(v)) { node.kind = 'wild'; node.value = v.toLowerCase(); }
      else { node.kind = 'word'; node.value = f ? typed(field, v, node) : v.toLowerCase(); }
    }
  }
  if (f && ['num', 'bias', 'duration', 'date'].includes(f.kind) && ['wild', 'fuzzy', 'regex'].includes(node.kind))
    throw new QueryError(`${field}: wildcards/regex not supported on this field`, t.s, t.e - t.s);
  return node;
}

// ── regex terms ──
// The server runs queries one at a time, so a regex that backtracks exponentially (/^(\w+\s?)*$/) would freeze it.
// On the server they're compiled for V8's linear-time engine (node --enable-experimental-regexp-engine, flag 'l'),
// which can't blow up. That engine has no case-insensitive mode, so the pattern is lowercased (escapes kept as
// written) and matched against the lowercased text the server already compares with. Without the engine the server
// refuses regex terms rather than guess which are safe. In the browser (validation, highlighting) the normal engine
// is fine: a bad pattern there could only slow your own tab.
const IS_SERVER = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';
let LINEAR = false;
if (IS_SERVER) { try { new RegExp('a', 'l'); LINEAR = true; } catch { /* started without the flag */ } }
export const REGEX_MODE = IS_SERVER ? (LINEAR ? 'linear' : 'off') : 'browser';
function compileRegex(src, t) {
  const err = (msg) => new QueryError(msg, t.s, t.e - t.s);
  if (!IS_SERVER) { try { return new RegExp(src, 'iu'); } catch (e) { throw err(`bad regex: ${e.message}`); } }
  if (!LINEAR) throw err("regex terms are off on this server (start it with node --enable-experimental-regexp-engine, as npm start does)");
  // lowercase the pattern's own letters; an escape (\W, \S, \B, \D…) is kept exactly as written
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== '\\') { out += c.toLowerCase(); continue; }
    const n = src[i + 1] ?? '';
    if (/[1-9]/.test(n) || n === 'k') throw err('backreferences (\\1, \\k<name>) aren\'t supported in regex terms');
    if ((n === 'p' || n === 'P' || n === 'u') && src[i + 2] === '{') throw err('\\p{…} / \\u{…} escapes aren\'t supported in regex terms');
    if (n === 'c') { out += c + n + (src[i + 2] ?? ''); i += 2; continue; }      // \cX: a control character
    out += c + n; i++;
  }
  try { return new RegExp(out, 'l'); } catch (e) {
    throw err(/linear time/i.test(e.message) ? "that regex can't be run in guaranteed linear time — simplify it" : `bad regex: ${e.message.replace(/^Invalid regular expression: /, '')}`);
  }
}
// limits that keep a single query from being expensive however it's written
const MAX_QUERY = 1000, MAX_REGEX_TERMS = 5, MAX_WILD_TERMS = 12;

export function parseQuery(src) {
  if (String(src).length > MAX_QUERY) throw new QueryError(`the query is too long (over ${MAX_QUERY} characters)`, MAX_QUERY, 0);
  const ast = parseQueryInner(src);
  let rx = 0, wild = 0;
  const count = (n) => { if (!n) return; if (n.type === 'term') { if (n.kind === 'regex') rx++; else if (n.kind === 'wild' || n.kind === 'fuzzy') wild++; return; } if (n.item) count(n.item); for (const i of n.items || []) count(i); };
  count(ast);
  if (rx > MAX_REGEX_TERMS) throw new QueryError(`too many /regex/ terms (${rx}; at most ${MAX_REGEX_TERMS})`, 0, String(src).length);
  if (wild > MAX_WILD_TERMS) throw new QueryError(`too many wildcard / fuzzy terms (${wild}; at most ${MAX_WILD_TERMS})`, 0, String(src).length);
  return ast;
}
function parseQueryInner(src) {
  const toks = lex(src);
  if (!toks.length) return { type: 'all' };
  let p = 0;
  const peek = () => toks[p];
  const endPos = src.length;

  function orExpr(field) {
    const items = [andExpr(field)];
    while (peek()?.t === 'OR') {
      const op = toks[p++];
      if (!peek() || peek().t === ')' || peek().t === 'OR' || peek().t === 'AND') throw new QueryError('OR needs a term on its right', op.s, op.e - op.s);
      items.push(andExpr(field));
    }
    return items.length === 1 ? items[0] : { type: 'or', items };
  }
  function andExpr(field) {
    const items = [unary(field)];
    while (peek() && peek().t !== ')' && peek().t !== 'OR') {
      if (peek().t === 'AND') {
        const op = toks[p++];
        if (!peek() || peek().t === ')' || peek().t === 'OR' || peek().t === 'AND') throw new QueryError('AND needs a term on its right', op.s, op.e - op.s);
      }
      items.push(unary(field));
    }
    return items.length === 1 ? items[0] : { type: 'and', items };
  }
  function unary(field) {
    const t = peek();
    if (!t) throw new QueryError('unexpected end of query', endPos);
    if (t.t === 'NOT') { p++; if (!peek()) throw new QueryError('NOT needs a term', t.s, t.e - t.s); return { type: 'not', item: unary(field) }; }
    if (t.t === '+') { p++; return unary(field); }
    return primary(field);
  }
  function primary(field) {
    const t = toks[p++];
    if (t.t === '(') {
      if (peek()?.t === ')') throw new QueryError('empty ( )', t.s, 2);
      const e = orExpr(field);
      const c = toks[p++];
      if (!c || c.t !== ')') throw new QueryError('missing closing )', t.s, 1);
      return e;
    }
    if (t.t === ')') throw new QueryError('unexpected )', t.s, 1);
    if (t.t === 'AND' || t.t === 'OR') throw new QueryError(`${t.t} needs a term on its left`, t.s, t.e - t.s);
    if (t.t === 'FIELD') {
      const f = canonField(t.v);
      if (!f) {
        const guess = closestField(t.v);
        throw new QueryError(`unknown field "${t.v}"${guess ? ` — did you mean ${guess}:?` : ''}`, t.s, t.e - t.s - 1);
      }
      const nx = peek();
      if (!nx || nx.s !== t.e) throw new QueryError(`missing value after ${t.v}:`, t.s, t.e - t.s);
      if (nx.t === 'FIELD') throw new QueryError(`unexpected field ${nx.v}: inside ${t.v}:`, nx.s, nx.e - nx.s);
      return primary(f);
    }
    return makeLeaf(field, t);
  }

  const ast = orExpr(null);
  if (p < toks.length) {
    const t = toks[p];
    throw new QueryError(t.t === ')' ? 'unexpected ) — no matching (' : `unexpected "${src.slice(t.s, t.e)}"`, t.s, t.e - t.s);
  }
  return ast;
}

// ───────────────────────── evaluation ─────────────────────────
// leaf(node) → boolean is supplied by the caller (it knows the data shape and story/article scope)
export function evaluate(ast, leaf) {
  switch (ast.type) {
    case 'all': return true;
    case 'and': return ast.items.every((x) => evaluate(x, leaf));
    case 'or': return ast.items.some((x) => evaluate(x, leaf));
    case 'not': return !evaluate(ast.item, leaf);
    default: return leaf(ast);
  }
}

export const scopeOf = (node) => (node.field ? FIELDS[node.field].scope : 'article');

const W = '[\\p{L}\\p{N}]';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wildRe = (v, anchored) => new RegExp(
  (anchored ? '^' : `(?<!${W})`) + v.split('').map((ch) => (ch === '*' ? `${W}*` : ch === '?' ? W : escRe(ch))).join('') + (anchored ? '$' : `(?!${W})`), 'iu');

function re(node) {
  if (!node._re) {
    if (node.kind === 'word') node._re = new RegExp(`(?<!${W})${escRe(node.value)}`, 'iu');
    else if (node.kind === 'phrase') node._re = new RegExp(`(?<!${W})${escRe(node.value).replace(/ /g, '\\s+')}(?!${W})`, 'iu');
    else if (node.kind === 'wild') node._re = wildRe(node.value, false);
  }
  return node._re;
}

const words = (s) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function cmpNum(op, x, v) {
  return op === '>' ? x > v : op === '>=' ? x >= v : op === '<' ? x < v : x <= v;
}
function inRange(node, x) {
  const { lo, hi, incLo, incHi } = node;
  if (lo != null && (incLo ? x < lo : x <= lo)) return false;
  if (hi != null && (incHi ? x > hi : x >= hi)) return false;
  return true;
}

function matchText(node, s) {
  switch (node.kind) {
    case 'word': case 'phrase': case 'wild': return re(node).test(s);
    case 'regex': return node.re.test(s);
    case 'fuzzy': return words(s).some((w) => lev(w, node.value, node.dist) <= node.dist);
    case 'range': return words(s).some((w) => inRange(node, w));
    case 'cmp': return words(s).some((w) => cmpNum(node.op, w, node.value));
  }
  return false;
}

// value shapes by field kind:
//   text → lowercase string · keyword → [id, name] lowercase · domain → host
//   num/bias/duration → number · date → ms timestamp · enum → string
export function matchLeaf(node, value) {
  const kind = node.field ? FIELDS[node.field].kind : 'text';
  if (value == null) return false;
  if (node.kind === 'any') return true;
  switch (kind) {
    case 'text': return matchText(node, value);
    case 'keyword': {
      const [id, name] = value;
      if (node.kind === 'word') return id === node.value || id.startsWith(node.value) || re(node).test(name);
      if (node.kind === 'wild') return wildRe(node.value, true).test(id) || wildRe(node.value, true).test(name) || re(node).test(name);
      if (node.kind === 'regex') return node.re.test(id) || node.re.test(name);
      return matchText(node, id) || matchText(node, name);
    }
    case 'domain': {
      if (node.kind === 'word' || node.kind === 'phrase') return value === node.value || value.endsWith('.' + node.value) || value.includes(node.value);
      if (node.kind === 'wild') return wildRe(node.value, true).test(value);
      if (node.kind === 'regex') return node.re.test(value);
      return false;
    }
    case 'enum': {
      if (node.kind === 'wild') return wildRe(node.value, true).test(value);
      if (node.kind === 'regex') return node.re.test(value);
      if (node.field === 'blindspot' && node.value === 'any') return value !== 'none';
      return value === node.value;
    }
    case 'num': case 'bias': case 'duration': {
      if (node.kind === 'cmp') return cmpNum(node.op, value, node.value);
      if (node.kind === 'range') return inRange(node, value);
      return kind === 'duration' ? value <= node.value : value === node.value;
    }
    case 'date': {
      if (node.kind === 'cmp') {
        const d = node.value;
        return node.op === '>' ? value >= d.end : node.op === '>=' ? value >= d.start : node.op === '<' ? value < d.start : value < d.end;
      }
      if (node.kind === 'range') {
        if (node.lo && (node.incLo ? value < node.lo.start : value < node.lo.end)) return false;
        if (node.hi && (node.incHi ? value >= node.hi.end : value >= node.hi.start)) return false;
        return true;
      }
      return value >= node.value.start && value < node.value.end;
    }
  }
  return false;
}

// ───────────────────────── autocomplete ─────────────────────────
function groupField(toks, caret) {
  const stack = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.s >= caret) break;
    if (t.t === '(') {
      const prev = toks[k - 1];
      stack.push(prev && prev.t === 'FIELD' && prev.e === t.s ? canonField(prev.v) : stack[stack.length - 1] ?? null);
    } else if (t.t === ')' && t.e <= caret) stack.pop();
  }
  return stack[stack.length - 1] ?? null;
}

function valueItems(field, prefix, ctx) {
  const f = FIELDS[field];
  const p = prefix.replace(/^"/, '').toLowerCase();
  const items = [];
  if (f.dynamic === 'sources') {
    for (const s of ctx.sources || []) {
      if (!p || s.id.startsWith(p) || s.name.toLowerCase().includes(p))
        items.push({ label: s.id, insert: s.id, hint: s.name, bias: s.bias, kind: 'value' });
    }
    items.sort((a, b) => (b.label.startsWith(p) - a.label.startsWith(p)) || a.label.localeCompare(b.label));
  }
  if (f.kind === 'bias') {
    for (const [k, h] of Object.entries(BIAS_HINT)) if (k.startsWith(p)) items.push({ label: k, insert: k, hint: h, bias: BIAS_VALUES[k], kind: 'value' });
  }
  for (const v of f.values || []) if (v.startsWith(p)) items.push({ label: v, insert: v, hint: f.desc, kind: 'value' });
  let ex = [...(f.examples || [])];
  if (f.kind === 'date') {
    const d = new Date();
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    ex.push(`>=${iso(new Date(d - 2 * 86400e3))}`, `[${iso(new Date(d - 86400e3))} TO ${iso(d)}]`);
  }
  for (const e of ex) if (!p || e.toLowerCase().startsWith(p)) items.push({ label: e, insert: e, hint: 'example', kind: 'example' });
  return items;
}

function fieldItems(prefix, ctx) {
  const p = prefix.toLowerCase();
  const items = [];
  for (const [name, f] of Object.entries(FIELDS)) {
    const alias = (f.aliases || []).find((a) => a.startsWith(p));
    if (!p || name.startsWith(p) || alias)
      items.push({ label: `${name}:`, insert: `${name}:`, hint: f.desc + (f.scope === 'story' ? '  [story]' : ''), kind: 'field', keepOpen: true });
  }
  if (p.length >= 2) {
    for (const s of ctx.sources || []) {
      if (s.id.startsWith(p) || s.name.toLowerCase().startsWith(p))
        items.push({ label: `source:${s.id}`, insert: `source:${s.id}`, hint: s.name, bias: s.bias, kind: 'value' });
    }
  }
  return items;
}

export function suggest(src, caret, ctx = {}) {
  const toks = lex(src);
  let cur = null, prev = null;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.s < caret && caret <= t.e && !(t.t === '(' || t.t === ')') && !(t.sym && caret === t.e)) { cur = t; prev = toks[k - 1]; break; }
    if (t.e <= caret) prev = t;
  }
  let items, from = caret, to = caret;

  if (cur && cur.t === 'FIELD' && caret === cur.e) {
    const f = canonField(cur.v);
    if (!f) return { from: cur.s, to: cur.e, items: fieldItems(cur.v, ctx) };
    items = valueItems(f, '', ctx);
  } else if (cur && cur.t === 'FIELD') {
    from = cur.s; to = cur.e;
    items = fieldItems(src.slice(cur.s, caret), ctx);
  } else if (cur && (cur.t === 'TERM' || cur.t === 'PHRASE' || cur.t === 'AND' || cur.t === 'OR' || cur.t === 'NOT')) {
    from = cur.s; to = cur.e;
    const prefix = src.slice(cur.s, caret);
    const f = prev && prev.t === 'FIELD' && prev.e === cur.s ? canonField(prev.v) : groupField(toks, caret);
    if (f) items = valueItems(f, prefix, ctx);
    else {
      items = fieldItems(prefix, ctx);
      const afterTerm = prev && !['(', 'AND', 'OR', 'NOT', '+', 'FIELD'].includes(prev.t);
      for (const op of ['AND', 'OR', 'NOT'])
        if (prefix.length && op.startsWith(prefix) && (afterTerm || op === 'NOT')) items.unshift({ label: op, insert: op, hint: 'operator', kind: 'op' });
    }
  } else if (cur) {
    return { from, to, items: [] };
  } else {
    const f = groupField(toks, caret);
    items = f ? valueItems(f, '', ctx) : fieldItems('', ctx);
    const afterTerm = prev && !['(', 'AND', 'OR', 'NOT', '+', 'FIELD'].includes(prev.t);
    if (!f && afterTerm) items.unshift(...['AND', 'OR', 'NOT'].map((op) => ({ label: op, insert: op, hint: 'operator', kind: 'op' })));
  }
  return { from, to, items: items.slice(0, 14) };
}

export const QUERY_HELP = `query syntax (Lucene-style; terms are ANDed by default):
  nvidia huang                 both words (word-prefix match: nvidia → nvidia's)
  "house speaker"              exact phrase
  title:nvidia                 field search — fields: ${Object.keys(FIELDS).join(' ')}
  source:(dailywire OR npr)    field applied to a group
  a OR b   a AND b   NOT a     boolean ops (also || && ! and -a / +a), use ( ) to group
  trump*  te?t  huang~1        wildcards, fuzzy match (edit distance)
  title:/gta ?(6|vi)/          regular expression
  bias:[l TO ll]  bias:>0      ranges [inclusive] {exclusive}, * = open; comparisons > >= < <=
  age:<6h  date:today          time filters (m/h/d/w; date: YYYY, YYYY-MM, YYYY-MM-DD, today)
  date:[2015 TO 2018]          dates outside the live window search the historical archive; date:* = all time
  body:"court filing"          full article text (harvested from the live feeds); author: byline; words: length
  morgue:fa5ee277              an article in the STRINGER morgue by its morgue no.; morgue:* = all of them
  sources:>=5  blindspot:any   story fields: sources articles left center right blindspot lean
examples:
  source:(dailywire OR breitbart) AND title:nvidia
  sources:>=5 AND right:0              big stories the right isn't covering
  bias:[lr TO r] age:<12h -source:fox
  title:"speaker" AND lean:balanced
  body:"according to court documents" AND words:>800   long reads quoting court records`;

// ───────────────────────── time-window clause helpers ─────────────────────────
// The toolbar's time-window buttons edit the query itself: they set/replace one top-level time clause.
export const WINDOW_CLAUSES = { '12h': 'age:<12h', '24h': 'age:<24h', '48h': 'age:<48h', '7d': 'age:<7d', all: 'date:*' };
const TIME_FIELDS = new Set(['age', 'date']);

// Top-level clauses on the given fields that are ANDed with the rest of the query (not negated, not
// part of an OR). A clause spans `field:` through its value — a term/range/phrase/regex or a ( group ).
export function fieldClauses(src, fields) {
  const toks = lex(src);
  const out = [];
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === '(') { depth++; continue; }
    if (t.t === ')') { depth--; continue; }
    if (depth !== 0 || t.t !== 'FIELD' || !fields.has(canonField(t.v))) continue;
    const v = toks[i + 1];
    if (!v || v.s !== t.e) continue;
    let j = i + 1;
    if (v.t === '(') {
      let d = 0;
      for (; j < toks.length; j++) { if (toks[j].t === '(') d++; else if (toks[j].t === ')' && --d === 0) break; }
      if (j >= toks.length) continue;                          // unbalanced: leave it alone
    } else if (!['TERM', 'RANGE', 'PHRASE', 'REGEX'].includes(v.t)) continue;
    const prev = toks[i - 1], next = toks[j + 1];
    const standalone = !(prev && ['NOT', 'OR', '+'].includes(prev.t)) && !(next && next.t === 'OR');
    if (standalone) out.push({ i, j, s: t.s, e: toks[j].e, field: canonField(t.v), text: src.slice(t.s, toks[j].e) });
    i = j;
  }
  return out;
}

// replace the top-level clauses on `fields` with `clause` (null = just remove them)
export function setFieldClause(src, fields, clause) {
  const toks = lex(src);
  let out = src;
  for (const sp of fieldClauses(src, fields).reverse()) {
    const before = toks[sp.i - 1], after = toks[sp.j + 1];
    let a = sp.s, b = sp.e;
    if (before && before.t === 'AND') a = before.s;
    else if (after && after.t === 'AND') b = after.e;
    out = out.slice(0, a) + out.slice(b);
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/^\s*AND\s+/, '').replace(/\s+AND\s*$/, '').trim();
  if (!clause) return out;
  if (!out) return clause;
  // AND binds tighter than OR: a query with a top-level OR must be grouped before narrowing it
  let depth = 0, topOr = false;
  for (const t of lex(out)) { if (t.t === '(') depth++; else if (t.t === ')') depth--; else if (depth === 0 && t.t === 'OR') topOr = true; }
  return `${topOr ? `(${out})` : out} AND ${clause}`;
}

export const timeClauses = (src) => fieldClauses(src, TIME_FIELDS);
export const setTimeClause = (src, clause) => setFieldClause(src, TIME_FIELDS, clause);

// which values of an outlet field the query's top-level clauses allow (null = no clause / unparseable)
function allowedValues(src, field, values) {
  const spans = fieldClauses(src, new Set([field]));
  if (!spans.length) return null;
  try {
    const asts = spans.map((sp) => parseQuery(sp.text));
    return values.filter((v) => asts.every((ast) => evaluate(ast, (node) => matchLeaf(node, v))));
  } catch { return null; }
}

const BIAS_ORDER = [[-2, 'l'], [-1, 'll'], [0, 'c'], [1, 'lr'], [2, 'r']];
// bias buttons: the set of bias values (-2..2) the query allows
export function biasOf(src) {
  const v = allowedValues(src, 'bias', BIAS_ORDER.map(([b]) => b));
  return new Set(v ?? BIAS_ORDER.map(([b]) => b));
}
export function biasClause(set) {
  if (set.size >= 5 || !set.size) return null;
  const keys = BIAS_ORDER.filter(([b]) => set.has(b)).map(([, k]) => k);
  return keys.length === 1 ? `bias:${keys[0]}` : `bias:(${keys.join(' OR ')})`;
}
// media buttons: 'all' | 'legacy' | 'new'
export function typeOf(src) {
  const v = allowedValues(src, 'type', ['legacy', 'new']);
  return !v || v.length !== 1 ? 'all' : v[0];
}
export const hasClause = (src, field) => fieldClauses(src, new Set([field])).length > 0;

// which window button the query corresponds to: '12h' | … | 'all' | 'custom' (other time clause) | null
export function windowOf(src) {
  const spans = timeClauses(src);
  if (!spans.length) return null;
  if (spans.length > 1) return 'custom';
  const t = spans[0].text.toLowerCase().replace(/^age:<=?/, 'age:<');
  const hit = Object.entries(WINDOW_CLAUSES).find(([, c]) => c === t);
  return hit ? hit[0] : 'custom';
}

// Highlighting: regexes for the positive headline/summary terms of a query (NOT branches don't highlight).
// field null / text → headline and summary; title → headline; summary → summary. Words match as prefixes (like the
// search), so the whole word is marked.
export function highlightRegexes(ast) {
  const out = { title: [], summary: [], body: [] };
  const W = '[\\p{L}\\p{N}]';
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const walk = (n, neg) => {
    if (!n) return;
    if (n.type === 'not') return walk(n.item, !neg);
    if (n.type !== 'term') { for (const i of n.items || []) walk(i, neg); return; }
    if (neg || ![null, 'text', 'title', 'summary', 'body'].includes(n.field)) return;
    let r = null;
    try {
      if (n.kind === 'word') r = new RegExp(`(?<!${W})${esc(n.value)}${W}*`, 'giu');
      else if (n.kind === 'phrase') r = new RegExp(`(?<!${W})${esc(n.value).replace(/ /g, '\\s+')}(?!${W})`, 'giu');
      else if (n.kind === 'wild') r = new RegExp(`(?<!${W})${n.value.split('*').map((p) => p.split('?').map(esc).join(W)).join(`${W}*`)}${W}*`, 'giu');
      else if (n.kind === 'regex') {
        // the browser has no linear-time engine: a pattern that could backtrack badly isn't highlighted (the server
        // still matches it). Headlines are short; the reader's article text is long, so it gets a stricter limit.
        const src = n.re.source;
        if (!regexBrowserSafe(src, 3)) return;
        r = new RegExp(src, [...new Set(n.re.flags + 'gi')].filter((f) => f !== 'y').join(''));
        r.longSafe = regexBrowserSafe(src, 1);
      }
    } catch {}
    if (!r) return;
    const bodyOk = n.kind !== 'regex' || r.longSafe;
    if (n.field === 'body') { if (bodyOk) out.body.push(r); return; }   // the article's full text (the reader)
    if (n.field === 'text' && bodyOk) out.body.push(r);                  // text: also searches the full text
    if (n.field !== 'summary') out.title.push(r);
    if (n.field !== 'title') out.summary.push(r);
  };
  walk(ast, false);
  return out;
}

// Lowercase "or" / "and" that the lexer reads as operators (unfielded, between terms), once finished (followed by
// whitespace), written in capitals: what you see is what runs. Same length, so a caret position stays valid.
export function capitalizeOps(src) {
  let out = src;
  for (const t of lex(src)) {
    if ((t.t === 'OR' || t.t === 'AND') && !t.sym && t.v !== t.t && /\s/.test(src[t.e] || '')) out = out.slice(0, t.s) + t.t + out.slice(t.e);
  }
  return out;
}

// text: means "anywhere" — headline, summary and the full text. The server evaluates it as
// (text:X OR body:X), where the inner text: is the headline + summary; the archive then searches each half with its
// own index, and STORIES / snippets / highlighting work as for any OR.
export function expandText(ast) {
  if (!ast) return ast;
  if (ast.type === 'term') return ast.field === 'text' && !ast._inner ? { type: 'or', items: [{ ...ast, _inner: true }, { ...ast, field: 'body', _inner: true }] } : ast;
  if (ast.type === 'not') return { ...ast, item: expandText(ast.item) };
  return ast.items ? { ...ast, items: ast.items.map(expandText) } : ast;
}

// Can this regex run in the browser's (backtracking) engine without risk? No quantified group that itself contains
// a quantifier or an alternation (the exponential cases), and at most maxUnbounded open-ended repeats (* + {n,}),
// which bounds the polynomial cases on the text it runs against.
export function regexBrowserSafe(src, maxUnbounded = 3) {
  const stack = [];
  let unbounded = 0, inClass = false;
  const quantAt = (i) => {
    const c = src[i];
    if (c === '*' || c === '+') return { open: true };
    if (c === '?') return { open: false };
    if (c === '{') { const m = src.slice(i).match(/^\{(\d+)(,(\d*))?\}/); if (m) return { open: m[2] !== undefined && m[3] === '' , big: m[2] !== undefined }; }
    return null;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') {
      stack.push({ inner: false });
      // a group prefix — (?: (?= (?! (?<= (?<! (?<name> — isn't a quantifier
      const pre = src.slice(i + 1).match(/^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/);
      if (pre) i += pre[0].length;
      continue;
    }
    if (c === '|') { if (stack.length) stack[stack.length - 1].inner = true; continue; }
    if (c === ')') {
      const g = stack.pop() || { inner: false };
      const q = quantAt(i + 1);
      if (q && (q.open || q.big) && g.inner) return false;       // (…+)*, (a|b)+, (…){2,} with a repeat inside
      if (stack.length && (g.inner || q)) stack[stack.length - 1].inner = true;
      continue;
    }
    const q = quantAt(i);
    if (q) {
      if (q.open) unbounded++;
      if (stack.length) stack[stack.length - 1].inner = true;
    }
  }
  return unbounded <= maxUnbounded;
}
