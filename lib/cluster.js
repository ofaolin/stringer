// Groups articles from different outlets into "stories", then scores them by source weight (votes) and recency.
//
// Approach:
//   1. normalize text (aliases like GTA→grand theft auto, U.S.→us), tokenize, light stemming
//   2. TF-IDF vectors from headline (full weight) + opening of the summary (reduced weight), so
//      distinctive words ("peltola", "anthropic") matter far more than common ones ("trump", "says")
//   3. candidate pairs = articles sharing a reasonably rare token, published within 48h of each other
//   4. agglomerative merge over pairs with cosine ≥ EDGE, most similar first, but two groups only merge
//      if their centroids are also similar (≥ MERGE) — prevents loosely related headlines chaining together
//   5. reined in: where both sides have their full text in the morgue, the texts must agree (links and merges);
//      a story spans at most MAX_SPAN (72h) from first to last article, so a long-running topic splits into
//      stories; and members that barely resemble the finished story (reached it through a chain) are set loose.
//      Calibrated on two weeks of live feeds: biggest story 405 → 255 articles, stories spanning > 5 days 17 → 0,
//      headline stragglers in big stories 5.9% → 1.2%, with known events (a summit, a game launch) not fragmented

const EDGE = 0.22;                   // min article↔article similarity to consider merging
const MERGE = 0.24;                 // min group-centroid similarity to actually merge
const TITLE_MERGE = 0.5;    // pass-2 headline-centroid similarity
const STRONG = 0.45;        // similarity at which one shared headline word is enough
const SUMMARY_W = 0.35;     // weight of summary tokens relative to headline tokens
const SUMMARY_WORDS = 40;
const MAX_GAP = 48 * 3600e3;
// Full text (the morgue) where both sides have it: articles about the same event share far more vocabulary in their
// bodies than ones that merely share a name or topic. Vetoes links/merges whose texts disagree.
const env = (k, d) => (process?.env?.[k] != null ? Number(process.env[k]) : d);
let BODY_EDGE = env('BODY_EDGE', 0.12);    // min article↔article full-text similarity (when both have text)
let BODY_MERGE = env('BODY_MERGE', 0.16);  // min group↔group full-text centroid similarity (when both have text)
let MAX_SPAN = env('MAX_SPAN', 72) * 3600e3;   // a story spans at most this long (first → last article)
const BODY_CHARS = 4000;                   // opening of the text that's compared
// Bigger groups have broader centroids that loosely match any article on the same topic, so merging into a big
// group needs more similarity: MERGE + GROW·log2(size/8) (capped). Keeps stories from drifting into topics.
let GROW = env('GROW', 0);
// After grouping, a member of a bigger story that barely resembles the story as a whole is set loose (it reached
// the group through a chain of neighbours, not on its own merit): headline+summary vs the group's centroid, and —
// where both have it — full text vs the group's full-text centroid.
let EJECT = env('EJECT', 0.20), BODY_EJECT = env('BODY_EJECT', 0.14);
const EJECT_MIN_SIZE = 6;

const STOP = new Set(`a an the and or but if of to in on at by for with from into onto over under about after before
as is are was were be been being has have had do does did will would could should may might can must not no nor
so than then that this these those it its he she they them his her their our we you your i me my mine us who
whom whose which what when where why how all any both each few more most other some such only own same too very
just also new says said say report reports amid says over vs via up out off now here there get gets got
one two three first last year years day days week weeks time times make makes made back still per live update
updates news video watch opinion analysis exclusive breaking latest inside behind what's how's here's
according told tells while during against amid among around across because being without within whether
like just even many much people way take takes want wants going know see look looks come comes go goes
monday tuesday wednesday thursday friday saturday sunday today tonight yesterday tomorrow
podcast newsletter episode subscribe click read full story continue reading appeared post`.split(/\s+/));

const KEEP_SHORT = new Set(['ai', 'us', 'uk', 'eu', 'un', 'gop', 'fbi', 'cia', 'doj', 'dhs', 'ice', 'irs', 'sec', 'ftc', 'fda', 'cdc', 'nfl', 'nba', 'ipo', 'ceo', 'tsa', 'faa', 'nyc']);

const ALIASES = [
  // idioms/boilerplate that make unrelated headlines look alike
  [/\bsilver linings?\b|\bgo(?:es)? pop\b|\bwhat (?:we|you) (?:know|need to know)\b|\bwhat to (?:know|expect)\b|\bhere'?s (?:why|what|how)\b|\bopen thread\b|\bperfect storm\b|\bin the wake of\b/g, ' '],
  // name particles glue to the following word: "van gogh" ≠ "van hollen"
  [/\b(van|von|der|den|ter|bin|ibn|al|el|abu)\s+(?=[a-z])/g, '$1'],
  [/\bu\.\s?s\.(?:\s?a\.)?/g, ' us '],
  [/\bu\.\s?k\./g, ' uk '],
  [/\bunited states\b/g, ' us '],
  [/\bgta\s*(?:vi|6)\b/g, ' grand theft auto 6 '],
  [/\bgta\b/g, ' grand theft auto '],
  [/\bgrand theft auto (?:vi|six)\b/g, ' grand theft auto 6 '],
  [/\bartificial intelligence\b/g, ' ai '],
  [/\bwhite house\b/g, ' whitehouse '],
  [/\bsupreme court\b/g, ' scotus '],
  [/\bscotus\b/g, ' scotus '],
  [/\brepublicans?\b/g, ' gop '],
  [/\bdemocrats?\b|\bdems?\b/g, ' democrat '],
  [/\bpresident[- ]elect\b/g, ' presidentelect '],
  [/\$\s?(\d+(?:\.\d+)?)\s?(?:bn|billion)\b/g, ' $1billion '],
  [/\$\s?(\d+(?:\.\d+)?)\s?(?:m|mn|million)\b/g, ' $1million '],
  [/\$\s?(\d+(?:\.\d+)?)\s?(?:t|tn|trillion)\b/g, ' $1trillion '],
];

const BOILERPLATE = [
  /the post .{0,200}? appeared first on .*$/i,
  /continue reading.*$/i,
  /read more.*$/i,
  /\(?click here.*$/i,
  /sign up for .{0,80}newsletter.*$/i,
];

function stem(w) {
  if (/\d/.test(w)) return w;
  if (w.length > 5 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && /(sh|ch|x|ss|zz)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  let t = ' ' + text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '') + ' ';
  t = t.replace(/[‘’]/g, "'").replace(/'s\b/g, '');
  for (const [re, rep] of ALIASES) t = t.replace(re, rep);
  return t
    .replace(/[^\p{L}\p{N}$\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && (w.length > 2 || KEEP_SHORT.has(w) || /^\d{2,}$/.test(w)))
    .map(stem)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function cleanSummary(s) {
  if (!s) return '';
  for (const re of BOILERPLATE) s = s.replace(re, '');
  return s.split(/\s+/).slice(0, SUMMARY_WORDS).join(' ');
}

function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let dot = 0;
  for (const [t, w] of a) { const v = b.get(t); if (v) dot += w * v; }
  return dot;
}

function normalize(vec) {
  let n = 0;
  for (const w of vec.values()) n += w * w;
  n = Math.sqrt(n) || 1;
  for (const [t, w] of vec) vec.set(t, w / n);
  return vec;
}

// opts.bodyOf(article) → its morgue text, if any (kept off the article objects, which are sent to clients)
export function clusterArticles(articles, opts = {}) {
  const bodyText = opts.bodyOf || ((a) => a.body);
  const N = articles.length;
  if (!N) return [];
  const titleSets = [];
  const docs = articles.map((a) => {
    const tf = new Map();
    const tt = new Set(tokenize(a.title));
    titleSets.push(tt);
    for (const t of tt) tf.set(t, 1);                                      // binary in headline
    for (const t of tokenize(cleanSummary(a.summary))) if (!tf.has(t)) tf.set(t, Math.max(tf.get(t) || 0, SUMMARY_W));
    return tf;
  });
  const df = new Map();
  for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 0.5));
  const vecs = docs.map((d) => {
    const v = new Map();
    for (const [t, w] of d) v.set(t, w * idf(t));
    return normalize(v);
  });
  // full-text vectors for articles in the morgue (log-tf × idf over the articles that have text)
  const btf = articles.map((a) => {
    const text = bodyText(a);
    if (!text) return null;
    const tf = new Map();
    for (const t of tokenize(String(text).slice(0, BODY_CHARS))) tf.set(t, (tf.get(t) || 0) + 1);
    return tf.size >= 20 ? tf : null;
  });
  const bN = btf.filter(Boolean).length;
  const bdf = new Map();
  for (const tf of btf) if (tf) for (const t of tf.keys()) bdf.set(t, (bdf.get(t) || 0) + 1);
  const bvecs = btf.map((tf) => {
    if (!tf) return null;
    const v = new Map();
    for (const [t, c] of tf) { const f = bdf.get(t); if (f > 1 && f < bN * 0.5) v.set(t, (1 + Math.log(c)) * Math.log((bN + 1) / f)); }
    return v.size ? normalize(v) : null;
  });
  const bodySim = (i, j) => (bvecs[i] && bvecs[j] ? cosine(bvecs[i], bvecs[j]) : null);

  // candidate pairs via rare-ish shared tokens
  const maxDf = Math.max(8, N * 0.04);
  const postings = new Map();
  docs.forEach((d, i) => {
    for (const t of d.keys()) {
      const f = df.get(t);
      if (f < 2 || f > maxDf) continue;
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push(i);
    }
  });
  // a single shared word ("gap", "border") is not enough: need ≥2 shared informative tokens in both
  // headlines, or 1 shared headline token plus very high overall similarity
  const enoughEvidence = (i, j, sim) => {
    let shared = 0, sharedTitle = 0;
    const [a, b] = docs[i].size <= docs[j].size ? [i, j] : [j, i];
    for (const t of docs[a].keys()) {
      if (!docs[b].has(t) || df.get(t) > N * 0.15) continue;
      shared++;
      if (titleSets[a].has(t) && titleSets[b].has(t)) sharedTitle++;
    }
    return shared >= 2 && (sharedTitle >= 2 || (sharedTitle === 1 && sim >= STRONG));
  };
  const seen = new Set();
  const edges = [];
  // each posting list in date order, so the pair scan stops once articles are more than MAX_GAP apart
  // (the window can hold two weeks of articles; without this the pairs grow quadratically with it)
  for (const list of postings.values()) {
    list.sort((p, q) => articles[p].date - articles[q].date);
    for (let x = 0; x < list.length; x++) {
      const tx = articles[list[x]].date;
      for (let y = x + 1; y < list.length; y++) {
        if (articles[list[y]].date - tx > MAX_GAP) break;
        const i = Math.min(list[x], list[y]), j = Math.max(list[x], list[y]);
        const key = i * N + j;
        if (seen.has(key)) continue;
        seen.add(key);
        const sim = cosine(vecs[i], vecs[j]);
        if (sim < EDGE || !enoughEvidence(i, j, sim)) continue;
        const bs = bodySim(i, j);
        if (bs != null && bs < BODY_EDGE) continue;        // their full texts are about different things
        edges.push([sim, i, j]);
      }
    }
  }
  edges.sort((a, b) => b[0] - a[0]);

  // agglomerative merge with centroid check
  const parent = articles.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const groups = new Map(articles.map((a, i) => [i, { members: [i], centroid: new Map(vecs[i]), body: bvecs[i] ? new Map(bvecs[i]) : null, lo: a.date, hi: a.date }]));
  const bodyCos = (A, B) => {
    if (!A.body || !B.body) return null;
    let na = 0, nb = 0;
    for (const w of A.body.values()) na += w * w;
    for (const w of B.body.values()) nb += w * w;
    return cosine(A.body, B.body) / (Math.sqrt(na * nb) || 1);
  };
  // can these two groups become one story? (centroids, full text, and how long it would span)
  const compatible = (A, B) => {
    if (Math.max(A.hi, B.hi) - Math.min(A.lo, B.lo) > MAX_SPAN) return false;
    const bc = bodyCos(A, B);
    return bc == null || bc >= BODY_MERGE;
  };
  const absorb = (big, small) => {
    for (const [t, w] of small.centroid) big.centroid.set(t, (big.centroid.get(t) || 0) + w);
    if (small.body) { big.body ??= new Map(); for (const [t, w] of small.body) big.body.set(t, (big.body.get(t) || 0) + w); }
    big.members.push(...small.members);
    big.lo = Math.min(big.lo, small.lo); big.hi = Math.max(big.hi, small.hi);
  };

  const centroidCos = (A, B) => {
    const a = A.centroid, b = B.centroid;
    let na = 0, nb = 0;
    for (const w of a.values()) na += w * w;
    for (const w of b.values()) nb += w * w;
    return cosine(a, b) / (Math.sqrt(na * nb) || 1);
  };
  for (const [, i, j] of edges) {
    const ri = find(i), rj = find(j);
    if (ri === rj) continue;
    const A = groups.get(ri), B = groups.get(rj);
    const size = A.members.length + B.members.length;
    if (size > 2 && centroidCos(A, B) < Math.min(0.5, MERGE + GROW * Math.max(0, Math.log2(size / 8)))) continue;
    if (!compatible(A, B)) continue;
    const [big, small, rb, rs] = A.members.length >= B.members.length ? [A, B, ri, rj] : [B, A, rj, ri];
    absorb(big, small);
    parent[rs] = rb;
    groups.delete(rs);
  }

  // pass 2: merge groups whose combined *headlines* are strongly similar (summaries can pull
  // same-story groups apart, e.g. "Voyager 1 reaches milestone" vs "Voyager 1 one light-day away")
  const titleVec = (members) => {
    const v = new Map();
    for (const i of members) for (const t of titleSets[i]) if (df.get(t) <= maxDf) v.set(t, (v.get(t) || 0) + idf(t));
    return normalize(v);
  };
  const list = [...groups.values()];
  const tv = new Map(list.map((g) => [g, titleVec(g.members)]));
  const tIndex = new Map();
  for (const g of list) for (const t of tv.get(g).keys()) {
    if (!tIndex.has(t)) tIndex.set(t, []);
    tIndex.get(t).push(g);
  }
  // anchor: a rare token present in ≥75% of the headlines of *both* groups and (nearly) exclusive to
  // them — e.g. "voyager". A merely uncommon word (a first name like "chris") is used by other stories too.
  const anchorDf = Math.max(6, N * 0.012);
  // share of a group's headlines containing t — cached per group (reset when the group grows), since the
  // same group is compared with many candidates
  const shareCache = new Map();
  const titleShare = (g, t) => {
    let c = shareCache.get(g);
    if (!c || c.n !== g.members.length) shareCache.set(g, (c = { n: g.members.length, m: new Map() }));
    let v = c.m.get(t);
    if (v === undefined) {
      let k = 0;
      for (const i of g.members) if (titleSets[i].has(t)) k++;
      c.m.set(t, (v = k / g.members.length));
    }
    return v;
  };
  const sharesAnchor = (g, h) => {
    for (const t of tv.get(g).keys())
      if (t.length >= 4 && df.get(t) <= Math.min(anchorDf, g.members.length + h.members.length + 2) &&
          titleShare(g, t) >= 0.75 && titleShare(h, t) >= 0.75) return true;
    return false;
  };
  const spanCache = new Map();
  const span = (g) => {
    const c = spanCache.get(g);
    if (c && c.n === g.members.length) return c.v;
    let lo = Infinity, hi = -Infinity;
    for (const i of g.members) { const d = articles[i].date; if (d < lo) lo = d; if (d > hi) hi = d; }
    spanCache.set(g, { n: g.members.length, v: [lo, hi] });
    return [lo, hi];
  };
  list.sort((a, b) => b.members.length - a.members.length);
  const dead = new Set();
  for (const g of list) {
    if (dead.has(g) || g.members.length < 2) continue;
    const cands = new Set();
    for (const t of tv.get(g).keys()) for (const h of tIndex.get(t) || []) if (h !== g && !dead.has(h)) cands.add(h);
    for (const h of cands) {
      const [g0, g1] = span(g), [h0, h1] = span(h);
      if (h0 - g1 > MAX_GAP || g0 - h1 > MAX_GAP) continue;
      if (cosine(tv.get(g), tv.get(h)) < TITLE_MERGE && !sharesAnchor(g, h)) continue;
      if (h.members.length === 1) {
        const j = h.members[0];
        if (!g.members.some((i) => enoughEvidence(i, j, cosine(vecs[i], vecs[j])))) continue;
      }
      if (!compatible(g, h)) continue;
      absorb(g, h);
      dead.add(h);
    }
    tv.set(g, titleVec(g.members));
  }

  // set stragglers loose (each becomes its own group)
  const final = [];
  const unit = (m) => { const v = new Map(m); return normalize(v); };
  for (const g of list) {
    if (dead.has(g)) continue;
    if (g.members.length < EJECT_MIN_SIZE) { final.push(g); continue; }
    const c = unit(g.centroid), bc = g.body ? unit(g.body) : null;
    const keep = [], loose = [];
    for (const i of g.members) {
      const fit = cosine(vecs[i], c);
      const bfit = bc && bvecs[i] ? cosine(bvecs[i], bc) : null;
      (fit < EJECT || (bfit != null && bfit < BODY_EJECT) ? loose : keep).push(i);
    }
    if (keep.length < 2) { final.push(g); continue; }                 // nothing coherent to keep: leave it be
    final.push({ ...g, members: keep });
    for (const i of loose) final.push({ members: [i] });
  }
  return final.map((g) => {
    const members = g.members.map((i) => articles[i]).sort((a, b) => b.date - a.date);
    return { members, newest: members[0].date };
  });
}

export const sourceWeight = (votes = 0) => Math.min(25, Math.max(0.04, Math.pow(1.25, votes)));

const BUCKET = { '-2': 'L', '-1': 'LL', 0: 'C', 1: 'LR', 2: 'R' };

export function buildStories(articles, sourcesById, opts = {}) {
  return storiesFromClusters(clusterArticles(articles), sourcesById, opts);
}

// Scoring is separate from grouping: grouping is the expensive part (~1s for two weeks of articles) and doesn't
// depend on votes, so it's cached once while stories are re-scored cheaply for each set of ranking weights
// (community or a user's personal votes). sourcesById: id -> source with .votes set for the chosen ranking.
export function storiesFromClusters(clusters, sourcesById, { now = Date.now(), minSources = 3 } = {}) {
  return clusters.map((cl) => {
    const bySource = new Map();
    for (const m of cl.members) if (!bySource.has(m.sourceId)) bySource.set(m.sourceId, m);
    const dist = { L: 0, LL: 0, C: 0, LR: 0, R: 0 };
    let weight = 0;
    let lead = null;
    let leadW = -1;
    for (const [sid, m] of bySource) {
      const s = sourcesById.get(sid);
      if (!s) continue;
      dist[BUCKET[s.bias]]++;
      const w = sourceWeight(s.votes);
      weight += w;
      if (w > leadW || (w === leadW && m.summary && !lead.summary)) { lead = m; leadW = w; }
    }
    const n = bySource.size;
    const left = dist.L + dist.LL;
    const right = dist.R + dist.LR;
    const partisan = left + right;
    // blindspot = one side ignored (zero coverage) or nearly ignored (≥85% of partisan coverage from the other side).
    // Value names the side that is NOT covering it. Center-only stories aren't partisan blindspots.
    let blindspot = null;
    if (n >= minSources && partisan > 0) {
      if (left / partisan >= 0.85) blindspot = 'right';
      else if (right / partisan >= 0.85) blindspot = 'left';
    }
    const ageH = Math.max(0, (now - cl.newest) / 3600e3);
    // multi-source coverage boosts; votes scale every source's contribution
    const score = (weight * (1 + Math.log2(n))) / Math.pow(ageH + 2, 1.35);
    const articlesOut = cl.members
      
      .sort((a, b) => sourceWeight(sourcesById.get(b.sourceId)?.votes) - sourceWeight(sourcesById.get(a.sourceId)?.votes) || b.date - a.date);
    return {
      id: lead.id,
      sid: cl.sid || null,          // the story's lasting number (lib/stories.js)
      title: lead.title,
      summary: lead.summary || cl.members.find((m) => m.summary)?.summary || '',
      image: lead.image || cl.members.find((m) => m.image)?.image || null,
      link: lead.link,
      leadSource: lead.sourceId,
      newest: cl.newest,
      oldest: Math.min(...cl.members.map((m) => m.date)),
      sourceCount: n,
      dist,
      blindspot,
      score,
      articles: articlesOut,
    };
  });
}
