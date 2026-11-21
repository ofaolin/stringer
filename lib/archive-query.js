// Turn a parsed query into a cheap SQL prefilter for the archive (date bounds, outlet set, FTS terms).
// Only constraints that are *necessary* for a match are used (top-level AND chain, plus OR groups made
// purely of outlet or text terms); the full query is then evaluated exactly on the candidates in JS.
import { matchLeaf } from '../public/query.js';

const SRC_FIELDS = new Set(['source', 'bias', 'side', 'type', 'votes']);
const TEXT_FIELDS = new Set([null, 'text', 'title', 'summary']);
const BODY_FIELDS = new Set(['body', 'author', 'words', 'morgue']);   // only known for harvested articles
const STORY_FIELDS = new Set(['sources', 'articles', 'left', 'center', 'right', 'blindspot', 'lean']);

const srcValue = (field, s) =>
  field === 'source' ? [s.id.toLowerCase(), s.name.toLowerCase()]
    : field === 'bias' ? s.bias
      : field === 'side' ? (s.bias < 0 ? 'left' : s.bias > 0 ? 'right' : 'center')
        : field === 'type' ? s.type
          : s.votes || 0;

const q = (v) => `"${v.replace(/"/g, '""')}"`;

export function usesStoryFields(ast) {
  if (ast.type === 'term') return STORY_FIELDS.has(ast.field);
  if (ast.type === 'not') return usesStoryFields(ast.item);
  return (ast.items || []).some(usesStoryFields);
}

export function usesBodyFields(ast) {
  if (ast.type === 'term') return BODY_FIELDS.has(ast.field);
  if (ast.type === 'not') return usesBodyFields(ast.item);
  return (ast.items || []).some(usesBodyFields);
}

export function hasDateConstraint(ast) {
  if (ast.type === 'term') return ast.field === 'date';
  if (ast.type === 'not') return hasDateConstraint(ast.item);
  return (ast.items || []).some(hasDateConstraint);
}

export function prefilter(ast, { sources, now = Date.now() }) {
  let from = null, to = null, sourceIds = null, needBody = false;
  const fts = [], bodyFts = [];
  const narrow = (ids) => { sourceIds = sourceIds ? sourceIds.filter((x) => ids.includes(x)) : ids; };
  const tighten = (f, t) => {
    if (f != null) from = from == null ? f : Math.max(from, f);
    if (t != null) to = to == null ? t : Math.min(to, t);
  };
  const looksLikeSource = (v) => sources.some((s) => s.id.startsWith(v) || s.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(v)));

  const ftsTerm = (n) => {
    const v = String(n.value ?? '');
    if (!/[\p{L}\p{N}]/u.test(v)) return null;
    let expr;
    if (n.kind === 'word') {
      if (n.field === null && looksLikeSource(v)) return null;     // bare word may match an outlet name instead
      expr = `${q(v)} *`;
    } else if (n.kind === 'phrase') expr = q(v);
    else if (n.kind === 'wild' && /^[\p{L}\p{N}]+\*$/u.test(v)) expr = `${q(v.slice(0, -1))} *`;
    else return null;
    return n.field === 'title' || n.field === 'summary' ? `${n.field} : (${expr})` : expr;
  };
  // a term no article without full text can match
  const requiresBody = (n) => n.type === 'term' && BODY_FIELDS.has(n.field) && n.kind !== 'any' &&
    (n.field !== 'words' || !matchLeaf(n, 0));

  const bound = (n) => {
    const H = 3600e3;
    if (n.field === 'date') {
      const v = n.value;
      if (n.kind === 'word') tighten(v.start, v.end);
      else if (n.kind === 'cmp') {
        if (n.op === '>') tighten(v.end, null);
        else if (n.op === '>=') tighten(v.start, null);
        else if (n.op === '<') tighten(null, v.start);
        else tighten(null, v.end);
      } else if (n.kind === 'range') {
        tighten(n.lo ? (n.incLo ? n.lo.start : n.lo.end) : null, n.hi ? (n.incHi ? n.hi.end : n.hi.start) : null);
      }
    } else if (n.field === 'age') {
      if (n.kind === 'word') tighten(now - n.value * H, null);
      else if (n.kind === 'cmp') { if (n.op[0] === '<') tighten(now - n.value * H, null); else tighten(null, now - n.value * H); }
      else if (n.kind === 'range') tighten(n.hi != null ? now - n.hi * H : null, n.lo != null ? now - n.lo * H : null);
    }
  };

  const visit = (node) => {
    if (node.type === 'and') return node.items.forEach(visit);
    if (node.type === 'term') {
      if (SRC_FIELDS.has(node.field)) return narrow(sources.filter((s) => matchLeaf(node, srcValue(node.field, s))).map((s) => s.id));
      if (node.field === 'date' || node.field === 'age') return bound(node);
      if (requiresBody(node)) needBody = true;
      if (node.field === 'body') { const t = ftsTerm(node); if (t) bodyFts.push(t); }
      else if (TEXT_FIELDS.has(node.field)) { const t = ftsTerm(node); if (t) fts.push(t); }
      return;
    }
    if (node.type === 'or') {
      if (node.items.every((i) => i.type === 'term' && SRC_FIELDS.has(i.field))) {
        const ids = new Set();
        for (const i of node.items) for (const s of sources) if (matchLeaf(i, srcValue(i.field, s))) ids.add(s.id);
        return narrow([...ids]);
      }
      if (node.items.every(requiresBody)) needBody = true;
      const bodyTerms = node.items.map((i) => (i.type === 'term' && i.field === 'body' ? ftsTerm(i) : null));
      if (bodyTerms.length && bodyTerms.every(Boolean)) return bodyFts.push(`(${bodyTerms.join(' OR ')})`);
      const terms = node.items.map((i) => (i.type === 'term' && TEXT_FIELDS.has(i.field) ? ftsTerm(i) : null));
      if (terms.length && terms.every(Boolean)) fts.push(`(${terms.join(' OR ')})`);
    }
  };
  visit(ast);
  return { from, to, sourceIds, fts: fts.length ? fts.join(' AND ') : null,
    bodyFts: bodyFts.length ? bodyFts.join(' AND ') : null, needBody, withBody: usesBodyFields(ast) };
}

// An OR the single prefilter can't use (its sides constrain different things, e.g. a headline word OR a body word
// within dates) would otherwise mean walking the whole archive. Instead expand it into a few independent plans,
// one per side (each using its own index: headline FTS, body FTS, dates, outlets), searched separately and merged.
// Returns null when one plan is as good (or the expansion wouldn't be selective, or would be too big).
const MAX_PLANS = 8;
const selective = (p) => !!(p.fts || p.bodyFts || p.needBody || p.from != null || p.to != null);
function mergePlan(a, b) {
  const ids = a.sourceIds && b.sourceIds ? a.sourceIds.filter((x) => b.sourceIds.includes(x)) : a.sourceIds || b.sourceIds;
  const join = (x, y) => [x, y].filter(Boolean).join(' AND ') || null;
  return {
    from: a.from == null ? b.from : b.from == null ? a.from : Math.max(a.from, b.from),
    to: a.to == null ? b.to : b.to == null ? a.to : Math.min(a.to, b.to),
    sourceIds: ids, fts: join(a.fts, b.fts), bodyFts: join(a.bodyFts, b.bodyFts), needBody: a.needBody || b.needBody,
  };
}
export function plans(ast, opts) {
  const one = (n) => { const p = prefilter(n, opts); return [{ from: p.from, to: p.to, sourceIds: p.sourceIds, fts: p.fts, bodyFts: p.bodyFts, needBody: p.needBody }]; };
  const expand = (n) => {
    if (n.type === 'or') {
      const p = one(n);
      if (selective(p[0]) || p[0].sourceIds) return p;                  // the OR was usable as a whole
      const out = n.items.flatMap(expand);
      return out.length > MAX_PLANS ? one(n) : out;
    }
    if (n.type === 'and') {
      let acc = [{ from: null, to: null, sourceIds: null, fts: null, bodyFts: null, needBody: false }];
      for (const i of n.items) {
        const sub = expand(i);
        if (acc.length * sub.length > MAX_PLANS) return one(n);
        acc = acc.flatMap((a) => sub.map((b) => mergePlan(a, b)));
      }
      return acc;
    }
    return one(n);
  };
  const out = expand(ast);
  if (out.length < 2 || !out.every(selective)) return null;
  const withBody = usesBodyFields(ast);
  return out.map((p) => ({ ...p, withBody }));
}
