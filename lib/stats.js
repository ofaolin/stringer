// Aggregate statistics for a query's result set: totals, bias/side split, outlets, coverage over time,
// story coverage/lean/blindspots, and the headline words each side uses disproportionately.

import { topicOf, topicOfMany } from '../public/topics.js';

const BUCKET = { '-2': 'L', '-1': 'LL', 0: 'C', 1: 'LR', 2: 'R' };
const SIDE = (b) => (b < 0 ? 'left' : b > 0 ? 'right' : 'center');

const STOP = new Set(`a an the and or but if of to in on at by for with from into onto over under about after before as is are
was were be been being has have had do does did will would could should may might can must not no nor so than then that this
these those it its he she they them his her their our we you your i me my us who whom whose which what when where why how all
any both each few more most other some such only own same too very just also new says said say amid via up out off now here
there get gets got one two first last year years day days week time make makes made back still per live update updates news
video watch opinion analysis exclusive breaking latest inside behind why what's how's here's says after could would says
report reports told tells while during against among around across because without within like even many much people way
take takes want wants going know see look come goes into than them they're it's don't can't won't isn't us
podcast newsletter episode subscribe read full story`.split(/\s+/));

const words = (title) => [...new Set(title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/['’]s\b/g, '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/[\s-]+/)
  .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)))];

// time buckets: pick the finest step that yields <= ~90 columns
const STEPS = [
  ['hour', 3600e3], ['6 hours', 6 * 3600e3], ['day', 86400e3], ['week', 7 * 86400e3],
  ['month', 30.44 * 86400e3], ['quarter', 91.31 * 86400e3], ['year', 365.25 * 86400e3],
];
function bucketStart(ts, unit) {
  const d = new Date(ts);
  switch (unit) {
    case 'hour': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
    case '6 hours': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() - (d.getUTCHours() % 6));
    case 'day': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case 'week': { const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); return day - ((d.getUTCDay() + 6) % 7) * 86400e3; }
    case 'month': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case 'quarter': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (d.getUTCMonth() % 3), 1);
    default: return Date.UTC(d.getUTCFullYear(), 0, 1);
  }
}
function nextBucket(t, unit) {
  const d = new Date(t);
  switch (unit) {
    case 'hour': return t + 3600e3;
    case '6 hours': return t + 6 * 3600e3;
    case 'day': return t + 86400e3;
    case 'week': return t + 7 * 86400e3;
    case 'month': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    case 'quarter': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1);
    default: return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  }
}

export function computeStats({ articles, stories, sMap }) {
  // unique articles (stories mode passes every article of every matched story)
  const seen = new Set();
  const arts = articles.filter((a) => sMap.has(a.sourceId) && !seen.has(a.link) && seen.add(a.link));
  const out = {
    totals: { stories: stories ? stories.length : null, articles: arts.length, outlets: 0, first: null, last: null, approx: 0 },
    byBias: { L: 0, LL: 0, C: 0, LR: 0, R: 0 },
    outletsByBias: { L: 0, LL: 0, C: 0, LR: 0, R: 0 },
    media: { legacy: 0, new: 0 },
    byTopic: {},                       // articles per topic (stories mode: stories per topic too)
    storiesByTopic: null,
    outlets: [],
    timeline: null,
    storyCoverage: null,
    lean: null,
    blindspots: null,
    terms: null,
  };
  if (!arts.length) return out;

  const perOutlet = new Map();
  let first = Infinity, last = -Infinity;
  for (const a of arts) {
    const s = sMap.get(a.sourceId);
    out.byBias[BUCKET[s.bias]]++;
    out.media[s.type === 'legacy' ? 'legacy' : 'new']++;
    const tp = topicOf(a);
    out.byTopic[tp] = (out.byTopic[tp] || 0) + 1;
    if (a.approx) out.totals.approx++;
    perOutlet.set(s.id, (perOutlet.get(s.id) || 0) + 1);
    first = Math.min(first, a.date); last = Math.max(last, a.date);
  }
  out.totals.first = first; out.totals.last = last;
  if (stories) { out.storiesByTopic = {}; for (const st of stories) { const t = (st.topic ??= topicOfMany(st.articles)); out.storiesByTopic[t] = (out.storiesByTopic[t] || 0) + 1; } }
  out.totals.outlets = perOutlet.size;
  for (const id of perOutlet.keys()) out.outletsByBias[BUCKET[sMap.get(id).bias]]++;
  out.outlets = [...perOutlet].map(([id, n]) => { const s = sMap.get(id); return { id, name: s.name, bias: s.bias, type: s.type, count: n }; })
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));

  // coverage over time, stacked by side
  const span = Math.max(1, last - first);
  const [unit] = STEPS.find(([, ms]) => span / ms <= 90) || STEPS[STEPS.length - 1];
  const buckets = new Map();
  for (let t = bucketStart(first, unit); t <= last; t = nextBucket(t, unit)) buckets.set(t, { t, end: nextBucket(t, unit), left: 0, center: 0, right: 0 });
  for (const a of arts) buckets.get(bucketStart(a.date, unit))[SIDE(sMap.get(a.sourceId).bias)]++;
  out.timeline = { unit, buckets: [...buckets.values()] };

  if (stories) {
    const cov = [['1', 1, 1], ['2–3', 2, 3], ['4–7', 4, 7], ['8–15', 8, 15], ['16+', 16, Infinity]].map(([label, lo, hi]) => ({ label, lo, hi, count: 0 }));
    const lean = { left: 0, balanced: 0, right: 0 };
    const blind = { left: 0, right: 0, none: 0 };
    for (const st of stories) {
      cov.find((c) => st.sourceCount >= c.lo && st.sourceCount <= c.hi).count++;
      const d = st.dist, n = d.L + d.LL + d.C + d.LR + d.R || 1;
      const avg = (-2 * d.L - d.LL + d.LR + 2 * d.R) / n;
      lean[avg < -0.35 ? 'left' : avg > 0.35 ? 'right' : 'balanced']++;
      blind[st.blindspot || 'none']++;
    }
    out.storyCoverage = cov.map(({ label, lo, hi, count }) => ({ label, lo, hi: Number.isFinite(hi) ? hi : null, count }));
    out.lean = lean;
    out.blindspots = blind;
  }

  // headline vocabulary: most common, and distinctive by side (log-odds ratio, smoothed)
  const cnt = { all: new Map(), left: new Map(), right: new Map() };
  const n = { left: 0, right: 0 };
  for (const a of arts) {
    const side = SIDE(sMap.get(a.sourceId).bias);
    for (const w of words(a.title)) {
      cnt.all.set(w, (cnt.all.get(w) || 0) + 1);
      if (side !== 'center') { cnt[side].set(w, (cnt[side].get(w) || 0) + 1); n[side]++; }
    }
  }
  const common = [...cnt.all].sort((x, y) => y[1] - x[1]).slice(0, 24).map(([w, c]) => ({ w, c }));
  let distinctive = { left: [], right: [] };
  if (n.left && n.right) {
    const V = cnt.all.size, alpha = 0.5;
    const scored = [];
    for (const [w, c] of cnt.all) {
      const l = cnt.left.get(w) || 0, r = cnt.right.get(w) || 0;
      if (l + r < 3) continue;
      const lo = Math.log((l + alpha) / (n.left + alpha * V)) - Math.log((r + alpha) / (n.right + alpha * V));
      const se = Math.sqrt(1 / (l + alpha) + 1 / (r + alpha));
      scored.push({ w, l, r, z: lo / se, c });
    }
    scored.sort((x, y) => y.z - x.z);
    // the 12 most lopsided words per side, listed most-used (by that side) first
    distinctive = {
      left: scored.filter((x) => x.z > 1.5).slice(0, 12).sort((x, y) => y.l - x.l || y.z - x.z),
      right: scored.filter((x) => x.z < -1.5).reverse().slice(0, 12).sort((x, y) => y.r - x.r || x.z - y.z),
    };
  }
  out.terms = { common, distinctive, words: { left: n.left, right: n.right } };
  return out;
}
