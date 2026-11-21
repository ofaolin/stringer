import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchFeed, discoverFeed } from './lib/feeds.js';
import { DEFAULT_SOURCES } from './lib/default-sources.js';
import { clusterArticles, storiesFromClusters, sourceWeight, tokenize } from './lib/cluster.js';
import { Accounts, PERMISSIONS } from './lib/accounts.js';
import * as oidc from './lib/oidc.js';
import { StoryRegistry } from './lib/stories.js';
import fsSync from 'node:fs';
import zlib from 'node:zlib';
import { parseQuery, expandText, evaluate, matchLeaf, scopeOf, QueryError } from './public/query.js';
import { topicOf, topicOfMany } from './public/topics.js';
import { Archive, BODY, normalizeUrl } from './lib/archive.js';
import { BackfillWorker } from './lib/backfill-worker.js';
import { HarvestWorker } from './lib/harvest-worker.js';
import { prefilter, plans as archivePlans, usesStoryFields, usesBodyFields, hasDateConstraint } from './lib/archive-query.js';
import { computeStats } from './lib/stats.js';
import { readArticle } from './lib/reader.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'sources.json');
const PORT = Number(process.env.PORT) || 1337;
const HOST = process.env.HOST || '127.0.0.1';
const REFRESH_MS = (Number(process.env.REFRESH_MIN) || 10) * 60e3;
const STATS_SAMPLE = Number(process.env.STATS_SAMPLE) || 20000;    // target sample size for archive-wide stats
const CONCURRENCY = 10;

// ───────────────────────── accounts ─────────────────────────
fsSync.mkdirSync(DATA_DIR, { recursive: true });
const accounts = new Accounts(path.join(DATA_DIR, 'app.db'));
const storyReg = new StoryRegistry(accounts.db);        // lasting story numbers + who read which story
// container-friendly config: these environment variables override the stored settings at startup
{
  const env = process.env, patch = {};
  if (env.SITE_NAME) patch.siteName = env.SITE_NAME;
  if (env.BASE_URL) patch.baseUrl = env.BASE_URL.replace(/\/+$/, '');
  if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID) {
    patch.oidc = { enabled: true, issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID,
      ...(env.OIDC_CLIENT_SECRET ? { clientSecret: env.OIDC_CLIENT_SECRET } : {}),
      ...(env.OIDC_LABEL ? { label: env.OIDC_LABEL } : {}), ...(env.OIDC_SCOPES ? { scopes: env.OIDC_SCOPES } : {}),
      ...(env.OIDC_ADMIN_GROUP ? { roleMap: { ...accounts.settings().oidc.roleMap, [env.OIDC_ADMIN_GROUP]: 'admin' } } : {}) };
  }
  if (env.LOCAL_LOGIN) patch.localLogin = env.LOCAL_LOGIN !== '0' && env.LOCAL_LOGIN !== 'false';
  if (Object.keys(patch).length) accounts.setSettings(patch);
}
// tabs every new account starts with (and what visitors who aren't signed in see)
const EXAMPLE_TABS = [
  { id: 'ex-big', name: 'Big stories', query: 'sources:>=8', pinned: true, view: null },
  { id: 'ex-lblind', name: 'Left ignoring', query: 'blindspot:left', pinned: true, view: null },
  { id: 'ex-rblind', name: 'Right ignoring', query: 'blindspot:right', pinned: true, view: null },
  { id: 'ex-new', name: 'New media, last 6h', query: 'type:new AND age:<6h', pinned: false, view: { mode: 'stream', sort: 'latest' } },
];
const seedTabs = (userId) => { for (const t of EXAMPLE_TABS) accounts.addSavedQuery(userId, { ...t, id: undefined }); };

// ───────────────────────── state ─────────────────────────
let db = { sources: [], removedDefaults: [] };
const cache = new Map();      // sourceId -> { items, fetchedAt, error, ms }   (items = the latest fetch only)
// The live window: every article seen in the last LIVE_DAYS, per outlet, keyed by normalized URL. Feeds only
// carry their newest items, so each sync is merged in rather than replacing what we had; on startup the
// window is reloaded from the archive (real headlines only), which also fills days before we were running.
const LIVE_DAYS = 14;
const held = new Map();       // sourceId -> Map(normUrl -> item)
const firstSeen = new Map();  // link -> ts (for items with no date)
let lastRefresh = 0;
let archive = null, backfill = null;   // historical archive + backfill worker (set up after loadDb)
let harvest = null;                    // full-text harvester worker (lib/harvest-worker.js)
let refreshing = null;

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

async function loadDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let existed = true;
  try {
    db = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
    db.removedDefaults ??= [];
  } catch {
    db = { sources: [], removedDefaults: [] };
    existed = false;
  }
  // from a single-user install (before accounts): saved tabs and outlet votes, handed to the first admin at setup
  for (const q of db.savedQueries || []) if (q.view) delete q.view.hours;   // window moved into the query
  // add any defaults the user hasn't explicitly removed. A brand-new server starts with every outlet off:
  // the admin picks which ones to enable during onboarding.
  const have = new Set(db.sources.map((s) => s.id));
  const on = existed || accounts.settings().setupDone;
  for (const d of DEFAULT_SOURCES)
    if (!have.has(d.id) && !db.removedDefaults.includes(d.id))
      db.sources.push({ ...d, enabled: on, custom: false });
  await saveDb();
}

let saveChain = Promise.resolve();
function saveDb() {
  saveChain = saveChain.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.rename(tmp, DB_FILE);
    backfill?.syncSources();                       // keep the worker's outlet list current
  }).catch((e) => console.error('save failed', e));
  return saveChain;
}

const byId = (id) => db.sources.find((s) => s.id === id);

// ───────────────────────── fetching ─────────────────────────
async function refreshOne(s) {
  const t0 = Date.now();
  try {
    const feed = await fetchFeed(s.feed);
    const now = Date.now();
    const items = feed.items.slice(0, 60).map((it) => {
      let date = it.date;
      if (!date) {
        if (!firstSeen.has(it.link)) firstSeen.set(it.link, now);
        date = firstSeen.get(it.link);
      }
      return { ...it, date: Math.min(date, now), id: hash(it.link), sourceId: s.id };
    });
    cache.set(s.id, { items, fetchedAt: now, error: null, ms: now - t0 });
    hold(s.id, items, true);
    try {
      archive?.insertMany(items.map((it) => ({ ...it, quality: 2, origin: 'live' })));
      harvest?.queue(items.map((it) => ({ link: it.link, sourceId: s.id })));     // fetch full text in the background
    } catch (e) { console.error('[archive] insert failed', e.message); }
  } catch (e) {
    const prev = cache.get(s.id);
    cache.set(s.id, { items: prev?.items || [], fetchedAt: Date.now(), error: e.message, ms: Date.now() - t0 });
  }
}

// merge items into an outlet's live window; feed items (fresh) replace what we held for the same URL
function hold(sourceId, items, fresh = false) {
  let m = held.get(sourceId);
  if (!m) held.set(sourceId, (m = new Map()));
  for (const it of items) {
    const k = normalizeUrl(it.link);
    if (fresh || !m.has(k)) m.set(k, fresh && m.has(k) ? { ...it, date: Math.min(it.date, m.get(k).date) } : it);
  }
}
function pruneHeld() {
  const cutoff = Date.now() - LIVE_DAYS * 864e5;
  for (const [id, m] of held) {
    if (!byId(id)) { held.delete(id); continue; }
    for (const [k, it] of m) if (it.date < cutoff) m.delete(k);
  }
}
// startup: the last LIVE_DAYS of real-headline articles from the archive (live feeds, Wayback feed snapshots, HN)
function seedLive() {
  if (!archive) return;
  const t0 = Date.now();
  try {
    const ids = new Set(db.sources.map((s) => s.id));
    let n = 0;
    const per = new Map();
    for (const r of archive.recentReal(Date.now() - LIVE_DAYS * 864e5)) {
      if (!ids.has(r.source_id)) continue;
      let list = per.get(r.source_id);
      if (!list) per.set(r.source_id, (list = []));
      list.push({ title: r.title, link: r.link, summary: r.summary, image: r.image, date: Math.min(r.published, Date.now()), id: hash(r.link), sourceId: r.source_id });
      n++;
    }
    for (const [id, list] of per) hold(id, list);
    console.log(`[live] window seeded from the archive: ${n} articles over ${LIVE_DAYS} days in ${Date.now() - t0}ms`);
  } catch (e) { console.error('[live] seeding failed', e.message); }
}

async function pool(list, n, fn) {
  const q = [...list];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  }));
}

function refreshAll() {
  if (refreshing) return refreshing;
  const t0 = Date.now();
  refreshing = pool(db.sources.filter((s) => s.enabled), CONCURRENCY, refreshOne)
    .then(() => {
      pruneHeld();
      lastRefresh = Date.now();
      // group the new window now (~1s for two weeks of articles) rather than on the next visitor's request
      // (before the sync counts as done, so the status line can report the regroup with it)
      try { cachedStories(collectArticles({ hours: LIVE_DAYS * 24 }), rankedSources('community').sMap, { hours: LIVE_DAYS * 24, sourceId: null, minSources: 3 }); } catch (e) { console.error('[stories] regroup failed', e.message); }
      const ok = db.sources.filter((s) => s.enabled && !cache.get(s.id)?.error).length;
      console.log(`[sync] ${ok}/${db.sources.filter((s) => s.enabled).length} feeds ok in ${Date.now() - t0}ms`);
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

// ───────────────────────── ranking weights ─────────────────────────
// Two modes. community: every user's daily-budgeted votes, summed per outlet (net, capped at ±30 like personal
// votes). personal: the signed-in user's own standing votes. A request's ctx carries the votes in effect and a
// source map with .votes set accordingly — everything downstream (story scores, leads, the votes: field) uses it.
let communityCache = null;
const communityVotes = () => (communityCache ??= accounts.communityVotes());
const clampVotes = (n) => Math.max(-30, Math.min(30, n || 0));
function rankMode(user, perms, requested) {
  const def = accounts.settings().ranking.defaultMode;
  let mode = requested || (user && JSON.parse(user.prefs || '{}').rankMode) || def;
  if (mode === 'personal' && (!user || !perms.has('vote.personal'))) mode = 'community';
  return mode === 'personal' ? 'personal' : 'community';
}
function rankedSources(mode, user) {
  const votes = mode === 'personal' ? accounts.personalVotes(user.id) : communityVotes();
  return { votes, sMap: new Map(db.sources.map((s) => [s.id, { ...s, votes: clampVotes(votes.get(s.id)) }])) };
}

// ───────────────────────── api helpers ─────────────────────────
function sourceView(s, ctx) {
  const c = cache.get(s.id);
  const votes = clampVotes(ctx?.votes?.get(s.id));
  return {
    ...s,
    votes,
    weight: +sourceWeight(votes).toFixed(3),
    status: !s.enabled ? 'off' : !c ? 'pending' : c.error ? 'error' : 'ok',
    error: c?.error || null,
    count: held.get(s.id)?.size || 0,     // articles in the live window
    fetchedAt: c?.fetchedAt || null,
    ms: c?.ms || null,
  };
}

function collectArticles({ hours, sourceId }) {
  const cutoff = Date.now() - hours * 3600e3;
  const seen = new Set();
  const out = [];
  for (const s of db.sources) {
    if (!s.enabled) continue;
    if (sourceId && s.id !== sourceId) continue;
    for (const it of held.get(s.id)?.values() || []) {
      if (it.date < cutoff || seen.has(it.link)) continue;
      seen.add(it.link);
      out.push({ ...it });
    }
  }
  return out;
}

// ── query language glue: field values for an article / a story (see public/query.js) ──
const lowered = new WeakMap(); // article -> { def, title, summary, text, host } (kept off the objects so it never hits JSON)
function lc(a, src) {
  let v = lowered.get(a);
  if (!v) {
    const title = a.title.toLowerCase(), summary = (a.summary || '').toLowerCase();
    let host = '';
    try { host = new URL(a.link).hostname.replace(/^www\./, '').toLowerCase(); } catch {}
    v = { title, summary, text: `${title} ${summary}`, def: `${title} ${summary} ${src.name.toLowerCase()} ${src.id}`, host };
    lowered.set(a, v);
  }
  return v;
}

// Full text of the live-feed articles (harvested into the archive by the worker), keyed by normalized URL.
// Synced incrementally from the bodies table and pruned to what's still in the feeds.
const liveBodies = new Map();
let liveBodiesAt = 0, liveBodiesSync = 0;
function syncLiveBodies() {
  if (!archive || Date.now() - liveBodiesSync < 5000) return;
  liveBodiesSync = Date.now();
  try {
    for (const r of archive.bodiesSince(liveBodiesAt, Date.now() - 15 * 864e5)) {     // live window is ≤ 14 days
      liveBodies.set(r.url, { text: r.text, byline: r.byline || '', words: r.words, morgue: r.morgue || '' });
      liveBodiesAt = Math.max(liveBodiesAt, r.fetched);
    }
    if (liveBodies.size > 60000) {
      const live = new Set();
      for (const m of held.values()) for (const k of m.keys()) live.add(k);
      for (const k of liveBodies.keys()) if (!live.has(k)) liveBodies.delete(k);
    }
  } catch (e) { console.error('[fulltext] sync failed', e.message); }
}
const NO_BODY = { text: '', byline: '', words: 0, morgue: '' };
const lowBody = new WeakMap();       // body record -> lowercased text / byline
function bodyOf(a) {
  let b = BODY.get(a);
  if (!b) {
    const v = lowered.get(a);
    const key = v?.norm ?? normalizeUrl(a.link);
    if (v) v.norm = key;
    b = liveBodies.get(key) || NO_BODY;
  }
  let l = lowBody.get(b);
  if (!l) { l = { text: b.text.toLowerCase(), byline: b.byline.toLowerCase(), words: b.words || 0, morgue: (b.morgue || '').toLowerCase() || null }; lowBody.set(b, l); }
  return l;
}

// What the signed-in user has read (normalized URLs), cached per user; `reads` is set for the request being evaluated
// (getNews is synchronous, so it can't leak between requests).
const readCache = new Map();
const readsOf = (uid) => { let s = readCache.get(uid); if (!s) { s = accounts.readSet(uid); readCache.set(uid, s); if (readCache.size > 200) readCache.delete(readCache.keys().next().value); } return s; };
let reads = null;
const isRead = (a) => !!reads?.has(normOf(a));
const storyReadCache = new Map();
const storyReadsOf = (uid) => { let m = storyReadCache.get(uid); if (!m) { m = storyReg.reads(uid); storyReadCache.set(uid, m); if (storyReadCache.size > 200) storyReadCache.delete(storyReadCache.keys().next().value); } return m; };
let storyReads = null;                     // the user's story read state (sid → when), set per request like `reads`
let binderSets = null;                     // the user's binder: { links: Set(normalized url), sids: Set } (saved: field)
const binderSetCache = new Map();          // user id → their binder sets (cleared when their binder changes)
function binderSetsOf(uid) {
  const hit = binderSetCache.get(uid);
  if (hit) return hit;
  const links = new Set(), sids = new Set();
  for (const e of accounts.binder(uid)) { if (e.kind === 'story') sids.add(e.sid); else links.add(e.target); }
  const sets = { links, sids };
  binderSetCache.set(uid, sets);
  return sets;
}

// Comment counts and text per article (normalized URL), for the comment: / comments: query fields. Small;
// rebuilt after any comment is added, edited or deleted.
let cmIdx = null;
function commentIndex() {
  if (!cmIdx) {
    cmIdx = new Map();
    for (const r of accounts.db.prepare('SELECT target, body FROM comments WHERE deleted = 0').all()) {
      const e = cmIdx.get(r.target) || { n: 0, text: '' };
      e.n++; e.text += ' ' + r.body.toLowerCase();
      cmIdx.set(r.target, e);
    }
  }
  return cmIdx;
}
const normOf = (a) => { const v = lowered.get(a); if (v) return (v.norm ??= normalizeUrl(a.link)); return normalizeUrl(a.link); };
// a story's discussion = every comment on any of its articles
const storyComments = (st) => [...new Set(st.articles.map(normOf))].reduce((t, u) => t + (commentIndex().get(u)?.n || 0), 0);

function articleValue(a, src, field, now) {
  switch (field) {
    case 'read': return isRead(a) ? 'yes' : 'no';
    case 'story': return storyReg.current.get(normOf(a)) || '';
    case 'topic': return topicOf(a);
    case 'saved': return binderSets?.links.has(normOf(a)) ? 'yes' : 'no';
    case 'comment': return commentIndex().get(normOf(a))?.text || '';
    case 'comments': return commentIndex().get(normOf(a))?.n || 0;
    case 'body': return bodyOf(a).text;
    case 'author': return bodyOf(a).byline;
    case 'words': return bodyOf(a).words;
    case 'morgue': return bodyOf(a).morgue;          // morgue no. of STRINGER's saved copy
    case null: return lc(a, src).def;
    case 'title': return lc(a, src).title;
    case 'summary': return lc(a, src).summary;
    case 'text': return lc(a, src).text;
    case 'source': return [src.id.toLowerCase(), src.name.toLowerCase()];
    case 'domain': return lc(a, src).host;
    case 'bias': return src.bias;
    case 'side': return src.bias < 0 ? 'left' : src.bias > 0 ? 'right' : 'center';
    case 'type': return src.type;
    case 'votes': return src.votes || 0;
    case 'age': return (now - a.date) / 3600e3;
    case 'date': return a.date;
  }
  return null;
}

function storyValue(st, field) {
  const d = st.dist;
  switch (field) {
    case 'comments': return storyComments(st);
    case 'read': return storyReads?.has(st.sid) ? 'yes' : 'no';          // the story's own read state
    case 'story': return st.sid || '';
    case 'topic': return (st.topic ??= topicOfMany(st.articles));        // the story's topic: its articles' most common
    case 'saved': return binderSets?.sids.has(st.sid) ? 'yes' : 'no';     // the story itself is in your binder
    case 'sources': return st.sourceCount;
    case 'articles': return st.articles.length;
    case 'left': return d.L + d.LL;
    case 'center': return d.C;
    case 'right': return d.R + d.LR;
    case 'blindspot': return st.blindspot || 'none';
    case 'lean': {
      const n = d.L + d.LL + d.C + d.LR + d.R || 1;
      const avg = (-2 * d.L - d.LL + d.LR + 2 * d.R) / n;
      return avg < -0.35 ? 'left' : avg > 0.35 ? 'right' : 'balanced';
    }
  }
  return null;
}

const singleStory = (a, sMap) => {
  const dist = { L: 0, LL: 0, C: 0, LR: 0, R: 0 };
  const b = sMap.get(a.sourceId)?.bias;
  if (b != null) dist[{ '-2': 'L', '-1': 'LL', 0: 'C', 1: 'LR', 2: 'R' }[b]] = 1;
  return { sourceCount: 1, articles: [a], dist, blindspot: null };
};

// grouping is the expensive step (~100ms); reuse it until feeds, sources or votes change
let storyCache = { key: null, stories: null };
// Grouping (~1s) is cached until the feeds or the outlet list change; scoring by a set of ranking weights is cheap
// and cached per weight set (community + each recently active personal ranking).
const scoredCache = new Map();
let lastGrouping = null;                  // the last full-window regroup (for the status line)
function cachedStories(articles, sMap, { hours, sourceId, minSources }) {
  const sig = db.sources.map((s) => `${s.id}:${s.enabled ? 1 : 0}:${s.bias}`).join(',');
  const key = `${lastRefresh}|${hours}|${sourceId}|${articles.length}|${sig}`;
  if (storyCache.key !== key) {
    const t0 = Date.now();
    syncLiveBodies();
    // morgue text (where we have it) confirms or vetoes articles belonging together
    storyCache = { key, clusters: clusterArticles(articles, { bodyOf: (a) => liveBodies.get(normOf(a))?.text }) };
    // lasting story numbers (only the full window rewrites the registry; partial views just look them up)
    try { storyReg.assign(storyCache.clusters, normOf, { write: !sourceId && hours === LIVE_DAYS * 24 }); } catch (e) { console.error('[stories] numbering failed', e.message); }
    scoredCache.clear();
    const ms = Date.now() - t0;
    if (!sourceId && hours === LIVE_DAYS * 24) lastGrouping = { at: Date.now(), ms, articles: articles.length, stories: storyCache.clusters.length };
    if (ms > 300) console.log(`[stories] regrouped ${articles.length} articles in ${ms}ms (${key.split('|').slice(0, 4).join('|')})`);
  }
  const wkey = `${minSources}|${[...sMap.values()].map((s) => s.votes || 0).join(',')}`;
  let stories = scoredCache.get(wkey);
  if (!stories) {
    stories = storiesFromClusters(storyCache.clusters, sMap, { minSources });
    scoredCache.set(wkey, stories);
    // remember each story's lead headline (once per regroup, from the first scoring of the full window)
    if (!sourceId && hours === LIVE_DAYS * 24 && storyCache.titled !== storyCache.key) {
      storyCache.titled = storyCache.key;
      try { storyReg.setTitles(stories); } catch (e) { console.error('[stories] titles failed', e.message); }
    }
    if (scoredCache.size > 16) scoredCache.delete(scoredCache.keys().next().value);
  }
  return stories;
}

const firstStoryField = (n) => (n.type === 'term' ? (STORY_FIELDS.has(n.field) ? n : null)
  : n.type === 'not' ? firstStoryField(n.item) : (n.items || []).map(firstStoryField).find(Boolean) || null);
const STORY_FIELDS = new Set(['sources', 'articles', 'left', 'center', 'right', 'blindspot', 'lean']);

// Walk the archive's candidates in date order, evaluating the full query on each, and return one page.
// Small candidate sets are counted exactly; big ones stop once the page is filled (or the time budget is
// spent) and extrapolate the total from the match rate so far.
const ARCHIVE_EXACT = 30000, ARCHIVE_BUDGET_MS = 3000;
// plans (one per OR side) → search bases limited to the allowed outlets
// binder helpers
const cleanNote = (v) => (v == null ? null : String(v).trim().slice(0, 4000) || null);
function liveStoryIndex(ctx) {
  const H = LIVE_DAYS * 24;
  return new Map(cachedStories(collectArticles({ hours: H }), ctx.sMap, { hours: H, sourceId: null, minSources: 3 }).filter((st) => st.sid).map((st) => [st.sid, st]));
}
// an article the server knows (live feeds or archive), with a morgue no. — filed as a fragment when it has no text.
// Only server-known articles: a client can't add arbitrary rows to the shared archive.
function resolveArticle(link) {
  const n = normalizeUrl(link);
  const live = collectArticles({ hours: LIVE_DAYS * 24 }).find((a) => normOf(a) === n);
  if (!archive) return live ? { ...live, morgue: null } : null;
  let row = archive.articleRow(link);
  if (!row && live) { archive.insertMany([{ link: live.link, sourceId: live.sourceId, title: live.title, summary: live.summary || '', image: live.image || null, date: live.date, quality: 2, origin: 'live' }]); row = archive.articleRow(link); }
  if (!row) return null;
  const a = live || Archive.toArticle(archive.st.byId.get(row.id));
  const site = db.sources.find((s) => s.id === a.sourceId)?.name || '';
  const morgue = archive.fileFragment(row.id, { title: a.title, summary: a.summary || '', link: a.link, site });
  return { link: a.link, title: a.title, sourceId: a.sourceId, date: a.date, summary: a.summary || '', morgue };
}
function planBases(plans, ids) {
  return plans.map((p) => ({ ...p, sourceIds: p.sourceIds ? p.sourceIds.filter((x) => ids.includes(x)) : ids }));
}
// k-way merge of date-ordered row streams, without duplicates (an article can match several sides)
function* mergeRows(iters, asc) {
  const heads = iters.map((it) => ({ it, cur: it.next() }));
  const seen = new Set();
  const before = (a, b) => (asc ? a.published < b.published || (a.published === b.published && a.id < b.id) : a.published > b.published || (a.published === b.published && a.id > b.id));
  for (;;) {
    let best = null;
    for (const h of heads) if (!h.cur.done && (!best || before(h.cur.value, best.cur.value))) best = h;
    if (!best) return;
    const row = best.cur.value;
    best.cur = best.it.next();
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    yield row;
  }
}
function archivePage({ ast, pf, ids, sMap, now, offset, limit, asc, full, passes }) {
  const t0 = Date.now();
  const base = { from: pf.from, to: pf.to, sourceIds: ids, fts: pf.fts, bodyFts: pf.bodyFts, needBody: pf.needBody, withBody: pf.withBody };
  // a comment query only needs the (few) articles that have a discussion
  const cmRows = pf.commentUrls ? archive.rowsByUrls(pf.commentUrls, base).sort((x, y) => (asc ? x.published - y.published : y.published - x.published) || (asc ? x.id - y.id : y.id - x.id)) : null;
  // an OR whose sides constrain different things: search each side with its own index, merge (see archive-query)
  const multi = !cmRows && pf.plans ? planBases(pf.plans, ids) : null;
  const candidates = cmRows ? cmRows.length : multi ? multi.reduce((t, b) => t + archive.count(b), 0) : archive.count(base);
  // stats over a big match set use an evenly spread sample instead (see sampleArchive)
  if (full && candidates > STATS_SAMPLE) return { items: [], total: candidates, candidates, scanned: 0, approx: true, partial: false, first: null, last: null, ms: Date.now() - t0 };
  const exact = full || candidates <= ARCHIVE_EXACT;
  const want = full ? Infinity : offset + limit;
  const items = [];
  let matched = 0, scanned = 0, first = null, last = null, done = true, partial = false;
  for (const row of cmRows || (multi ? mergeRows(multi.map((b) => archive.iterate({ ...b, asc })), asc) : archive.iterate({ ...base, asc }))) {
    scanned++;
    if ((scanned & 1023) === 0 && Date.now() - t0 > ARCHIVE_BUDGET_MS && !full) { done = false; partial = matched < want; break; }
    const a = Archive.toArticle(row);
    const src = sMap.get(a.sourceId);
    if (!src || !passes(a) || !evaluate(ast, (n) => matchLeaf(n, articleValue(a, src, n.field, now)))) continue;
    if (first == null) first = a.date;
    last = a.date;
    if (matched >= offset && matched < want) items.push({ ...a, score: 0 });
    matched++;
    if (matched >= want && !exact) { done = false; break; }
  }
  const total = done ? matched : Math.max(matched, Math.round((matched / Math.max(1, scanned)) * candidates));
  return { items, total, candidates, scanned, approx: !done, partial, first, last, ms: Date.now() - t0 };
}

// comment fields: comment: (text) and comments: (count)
const CM_FIELDS = new Set(['comment', 'comments']);
const firstField = (n, set) => (n.type === 'term' ? (set.has(n.field) ? n : null)
  : n.type === 'not' ? firstField(n.item, set) : (n.items || []).map((i) => firstField(i, set)).find(Boolean) || null);
const usesCommentFields = (n) => !!firstField(n, CM_FIELDS);
const READ_FIELDS = new Set(['read', 'saved']);
const needsSaved = (n) => n.type === 'term' && n.field === 'saved' && n.kind !== 'any' && matchLeaf(n, 'yes') && !matchLeaf(n, 'no');
const requiresSaved = (n) => (n.type === 'term' ? needsSaved(n) : n.type === 'and' ? n.items.some(requiresSaved) : n.type === 'or' ? n.items.every(requiresSaved) : false);
const needsRead = (n) => n.type === 'term' && n.field === 'read' && n.kind !== 'any' && matchLeaf(n, 'yes') && !matchLeaf(n, 'no');
const requiresRead = (n) => (n.type === 'term' ? needsRead(n) : n.type === 'and' ? n.items.some(requiresRead) : n.type === 'or' ? n.items.every(requiresRead) : false);
// a comment term every match must satisfy — then only articles with a discussion can match
const needsCm = (n) => n.type === 'term' && n.kind !== 'any' && (n.field === 'comment' || (n.field === 'comments' && !matchLeaf(n, 0)));
const requiresComments = (n) => (n.type === 'term' ? needsCm(n) : n.type === 'and' ? n.items.some(requiresComments) : n.type === 'or' ? n.items.every(requiresComments) : false);

// a morgue: term every match must satisfy (top-level AND chain, not negated)
const requiresMorgue = (n) => (n.type === 'term' ? n.field === 'morgue' && n.kind !== 'any'
  : n.type === 'and' ? n.items.some(requiresMorgue) : n.type === 'or' ? n.items.every(requiresMorgue) : false);
const hasTimeClause = (n) => (n.type === 'term' ? n.field === 'date' || n.field === 'age'
  : n.type === 'not' ? hasTimeClause(n.item) : (n.items || []).some(hasTimeClause));

function getNews(params, full = false, ctx) {   // full: return every match (for /api/stats) instead of a page
  const mode = params.get('mode') || 'stories';
  // the time window lives in the query (age:/date:); with no time clause, everything in the live feeds.
  // `hours` is still accepted for API callers.
  const allTime = params.get('hours') === '0';
  const hours = Math.min(24 * 14, Math.max(1, Number(params.get('hours')) || 24 * 14));
  const biases = new Set((params.get('bias') || '-2,-1,0,1,2').split(',').filter(Boolean).map(Number));
  const type = params.get('type') || 'all';
  const q = (params.get('q') || '').trim();
  const sourceId = params.get('source') || null;
  const limit = Math.min(500, Number(params.get('limit')) || 150);
  const offset = Math.max(0, Math.floor(Number(params.get('offset')) || 0));
  const minSources = blindspotMin(params);
  const sMap = ctx.sMap;
  const passes = (a) => {
    const s = sMap.get(a.sourceId);
    return s && biases.has(s.bias) && (type === 'all' || s.type === type);
  };

  let ast;
  try { ast = expandText(parseQuery(q)); }
  catch (e) {
    if (e instanceof QueryError) return { error: e.message, pos: e.pos, len: e.len };
    throw e;
  }
  // a bare 8-hex query that is a morgue no. is read as morgue:<no.> (anything else stays a word search)
  if (ast.type === 'term' && ast.field === null && ast.kind === 'word' && /^[0-9a-f]{8}$/.test(ast.value) && archive?.linkByMorgue(ast.value)) {
    ast = { ...ast, field: 'morgue' };
  }
  const now = Date.now();
  const wantsBody = usesBodyFields(ast);
  syncLiveBodies();
  const articleLeaf = (a) => (node) => {
    const src = sMap.get(a.sourceId);
    return !!src && matchLeaf(node, articleValue(a, src, node.field, now));
  };
  const storyMatches = (st) => evaluate(ast, (node) =>
    scopeOf(node) === 'story' || node.field === 'comments' || node.field === 'read' || node.field === 'story' || node.field === 'topic' || node.field === 'saved' ? matchLeaf(node, storyValue(st, node.field)) : st.articles.some((a) => articleLeaf(a)(node)));
  reads = ctx.user ? readsOf(ctx.user.id) : null;
  storyReads = ctx.user ? storyReadsOf(ctx.user.id) : null;
  binderSets = ctx.user ? binderSetsOf(ctx.user.id) : null;
  if (!ctx.user && firstField(ast, READ_FIELDS)) {
    const n = firstField(ast, READ_FIELDS);
    return { error: n.field === 'saved' ? 'saved: sign in to filter by your research binder' : `${n.field}: sign in to filter by what you've read`, pos: n.s, len: n.e - n.s };
  }
  // comment fields need permission to read comments (they'd reveal what's in them)
  if (usesCommentFields(ast) && !ctx.perms.has('comments.read')) {
    const n = firstField(ast, CM_FIELDS);
    return { error: `${n.field}: needs permission to read comments`, pos: n.s, len: n.e - n.s };
  }

  // ── live (in-memory feeds) or historical archive? ──
  const allowed = db.sources.filter((s) => s.enabled && biases.has(s.bias) && (type === 'all' || s.type === type) && (!sourceId || s.id === sourceId));
  const pf = prefilter(ast, { sources: allowed, now });
  const liveStart = now - hours * 3600e3;
  // looking an article up by its morgue no. is almost always about an older one: search all time unless the query
  // has its own date:/age: clause
  const morgueLookup = !!archive && requiresMorgue(ast) && !hasTimeClause(ast);
  const useArchive = !!archive && (allTime || morgueLookup || params.get('archive') === '1' ||
    (hasDateConstraint(ast) && (pf.from == null || pf.from < liveStart)) || (pf.to != null && pf.to < liveStart));

  // ── archive: articles only (story grouping is a live-feed feature), paged through the whole match set ──
  if (useArchive) {
    if (usesStoryFields(ast)) {
      const n = firstStoryField(ast);
      return { error: `${n?.field ?? 'story'}: is a story field — stories are only grouped for the live feeds, not the archive`, pos: n?.s ?? -1, len: n ? n.e - n.s : 0 };
    }
    const ids = (pf.sourceIds || allowed.map((s) => s.id)).filter((id) => allowed.some((s) => s.id === id));
    pf.plans = archivePlans(ast, { sources: allowed, now });
    const sort = params.get('sort') === 'oldest' ? 'oldest' : 'latest';
    let pg;
    if (requiresComments(ast)) pf.commentUrls = [...commentIndex().keys()];
    // read:yes in the archive: only what you've read can match
    if (requiresRead(ast) && reads) pf.commentUrls = pf.commentUrls ? pf.commentUrls.filter((u) => reads.has(u)) : [...reads];
    if (requiresSaved(ast) && binderSets) pf.commentUrls = pf.commentUrls ? pf.commentUrls.filter((u) => binderSets.links.has(u)) : [...binderSets.links];
    try { pg = archivePage({ ast, pf, ids, sMap, now, offset, limit, asc: sort === 'oldest', full, passes }); }
    catch (e) { return { error: `archive search failed: ${e.message}` }; }
    const extent = { source: 'archive', from: pf.from, to: pf.to, allTime: pf.from == null, morgueLookup };
    const archiveMeta = { candidates: pg.candidates, scanned: pg.scanned, approx: pg.approx, partial: pg.partial, indexed: archive.approxTotal(), ms: pg.ms };
    if (full) return { mode: 'stream', articles: pg.items, stories: null, archive: archiveMeta, sMap };
    for (const it of pg.items) { const sid = storyReg.current.get(normOf(it)); const s = sid && storyReg.story(sid); if (s) it.story = { sid, sources: s.sources, articles: s.articles }; }
    return { mode: 'stream', storiesUnavailable: mode !== 'stream', sort, total: pg.total, offset, limit, items: pg.items, ...withText(pg.items, ast, wantsBody), archive: archiveMeta,
      extent: { ...extent, results: pg.first != null ? { first: Math.min(pg.first, pg.last), last: Math.max(pg.first, pg.last) } : null } };
  }

  let articles, stories, scoreNow = now, archiveMeta = null;
  {
    articles = collectArticles({ hours, sourceId });
    stories = cachedStories(articles, sMap, { hours, sourceId, minSources });
  }
  // what the query actually searched: the source of data and the effective date bounds
  const extent = { source: 'live', from: Math.max(liveStart, pf.from ?? -Infinity), to: pf.to ?? null, windowHours: hours,
        defaulted: !hasTimeClause(ast),
        oldest: articles.reduce((m, a) => Math.min(m, a.date), Infinity) };
  if (!Number.isFinite(extent.oldest)) delete extent.oldest;
  const span = (list, lo, hi) => {
    let a = Infinity, b = -Infinity;
    for (const x of list) { a = Math.min(a, x[lo]); b = Math.max(b, x[hi]); }
    return Number.isFinite(a) ? { first: a, last: b } : null;
  };
  const page = (list) => ({ total: list.length, offset, limit, items: list.slice(offset, offset + limit) });

  if (mode === 'stream') {
    const storyOf = new Map();
    for (const st of stories) for (const a of st.articles) storyOf.set(a.id, st);
    const leafFor = (a) => {
      const al = articleLeaf(a);
      return (node) => scopeOf(node) === 'story' ? matchLeaf(node, storyValue(storyOf.get(a.id) || singleStory(a, sMap), node.field)) : al(node);
    };
    const list = articles
      .filter((a) => passes(a) && evaluate(ast, leafFor(a)))
      .map((a) => { const st = storyOf.get(a.id); return { ...a, story: st ? { sid: st.sid, sources: st.sourceCount, articles: st.articles.length } : null,
        score: sourceWeight(sMap.get(a.sourceId).votes) / Math.pow(Math.max(0, scoreNow - a.date) / 3600e3 + 2, 1.35) }; });
    const sort = params.get('sort') || 'top';
    list.sort(sort === 'latest' ? (a, b) => b.date - a.date : sort === 'oldest' ? (a, b) => a.date - b.date : (a, b) => b.score - a.score);
    if (full) return { mode, articles: list, stories: null, archive: archiveMeta, sMap };
    const pg = page(list);
    return { mode, ...pg, ...withText(pg.items, ast, wantsBody), archive: archiveMeta, extent: { ...extent, results: span(list, 'date', 'date') } };
  }

  let out = stories.filter((st) => st.articles.some(passes) && storyMatches(st));
  if (mode === 'blindspot') out = out.filter((s) => s.blindspot);
  const sort = params.get('sort') || 'top';
  out.sort(sort === 'latest' ? (a, b) => b.newest - a.newest
    : sort === 'oldest' ? (a, b) => a.oldest - b.oldest
    : sort === 'coverage' ? (a, b) => b.sourceCount - a.sourceCount || b.score - a.score
    : (a, b) => b.score - a.score);
  if (full) return { mode, articles: out.flatMap((st) => st.articles), stories: out, archive: archiveMeta, sMap };
  const pg = page(out);
  const text = withText(pg.items, ast, wantsBody);
  // the list never shows a story's other articles' images (a story opened on its own is fetched whole), and the
  // ticker (lite=1) only needs each article's link, headline, outlet and date
  const lite = params.get('lite') === '1';
  pg.items = pg.items.map((st) => ({ ...st, articles: st.articles.map((a) => (lite
    ? { id: a.id, link: a.link, title: a.title, date: a.date, sourceId: a.sourceId }
    : { id: a.id, link: a.link, title: a.title, summary: a.summary, date: a.date, sourceId: a.sourceId, ...(a.approx ? { approx: a.approx } : {}) })) }));
  return { mode, ...pg, ...(lite ? {} : text), archive: archiveMeta, extent: { ...extent, results: span(out, 'oldest', 'newest') } };
}

// For one page of results: which articles have full text (link -> words), and when the query searches the
// body, a short excerpt around the first match (id -> { pre, hit, post }) to show in place of the summary.
function withText(items, ast, wantsBody) {
  if (!archive) return {};
  const arts = items.flatMap((x) => x.articles || [x]);
  const fulltext = {};                // article id -> { words, morgue, saved, partial } for STRINGER-archived articles
  try {
    const norm = new Map(arts.map((a) => [a, normalizeUrl(a.link)]));
    const info = new Map(archive.bodyInfo([...new Set(norm.values())]).map((r) => [r.url, { words: r.words, morgue: r.morgue, saved: r.fetched, partial: r.status === 'partial',
      ...(r.status === 'ok' || r.status === 'partial' ? {} : { fragment: true }) }]));
    for (const [a, u] of norm) if (info.has(u)) fulltext[a.id] = info.get(u);
  } catch (e) { console.error('[fulltext] lookup failed', e.message); }
  const out = { fulltext };
  if (!wantsBody) return out;
  const res = bodyRegexes(ast);
  if (!res.length) return out;
  out.snippets = {};
  for (const a of arts) {
    const b = BODY.get(a) || liveBodies.get(normalizeUrl(a.link));
    const sn = b?.text && snippet(b.text, res);
    if (sn) out.snippets[a.id] = sn;
  }
  return out;
}

// regexes for the positive body: terms of a query (NOT branches don't produce a highlight)
function bodyRegexes(ast, neg = false, out = []) {
  if (ast.type === 'not') return bodyRegexes(ast.item, !neg, out);
  if (ast.type !== 'term') { for (const i of ast.items || []) bodyRegexes(i, neg, out); return out; }
  if (neg || ast.field !== 'body') return out;
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const W = '[\\p{L}\\p{N}]';
  try {
    if (ast.kind === 'regex') out.push(new RegExp(ast.re.source, [...new Set(ast.re.flags + 'i')].filter((f) => f !== 'g' && f !== 'y').join('')));
    else if (ast.kind === 'word') out.push(new RegExp(`(?<!${W})${esc(ast.value)}${W}*`, 'iu'));
    else if (ast.kind === 'phrase') out.push(new RegExp(`(?<!${W})${esc(ast.value).replace(/ /g, '\\s+')}(?!${W})`, 'iu'));
    else if (ast.kind === 'wild') out.push(new RegExp(`(?<!${W})${ast.value.split('*').map((p) => p.split('?').map(esc).join(`${W}`)).join(`${W}*`)}${W}*`, 'iu'));
  } catch {}
  return out;
}

function snippet(text, res, before = 110, after = 190) {
  let m = null;
  for (const r of res) { const x = r.exec(text); if (x && x[0] && (!m || x.index < m.index)) m = x; }
  if (!m) return null;
  let s = Math.max(0, m.index - before), e = Math.min(text.length, m.index + m[0].length + after);
  if (s > 0) s = text.indexOf(' ', s) + 1 || s;
  if (e < text.length) e = text.lastIndexOf(' ', e) > m.index + m[0].length ? text.lastIndexOf(' ', e) : e;
  const flat = (t) => t.replace(/\s+/g, ' ');
  return { pre: (s > 0 ? '…' : '') + flat(text.slice(s, m.index)), hit: flat(m[0]), post: flat(text.slice(m.index + m[0].length, e)) + (e < text.length ? '…' : '') };
}

// evenly spread 1-in-k sample of an archive query's whole match set, evaluated per article (no grouping)
function sampleArchive(params, ctx) {
  let ast;
  try { ast = expandText(parseQuery((params.get('q') || '').trim())); } catch { return null; }
  if (usesStoryFields(ast)) return null;                         // story fields need grouping → can't sample
  const biases = new Set((params.get('bias') || '-2,-1,0,1,2').split(',').filter(Boolean).map(Number));
  const type = params.get('type') || 'all';
  const sourceId = params.get('source') || null;
  const allowed = db.sources.filter((s) => s.enabled && biases.has(s.bias) && (type === 'all' || s.type === type) && (!sourceId || s.id === sourceId));
  const now = Date.now();
  const pf = prefilter(ast, { sources: allowed, now });
  const ids = (pf.sourceIds || allowed.map((s) => s.id)).filter((id) => allowed.some((s) => s.id === id));
  const base = { from: pf.from, to: pf.to, sourceIds: ids, fts: pf.fts, bodyFts: pf.bodyFts, needBody: pf.needBody, withBody: pf.withBody };
  const pl = archivePlans(ast, { sources: allowed, now });
  const bases = pl ? planBases(pl, ids) : [base];
  const matched = bases.reduce((t, b) => t + archive.count(b), 0);
  const k = Math.max(1, Math.ceil(matched / STATS_SAMPLE));
  const seen = new Set();
  const rows = bases.flatMap((b) => archive.search({ ...b, sample: k, limit: STATS_SAMPLE * 2 }).rows).filter((r) => !seen.has(r.id) && seen.add(r.id));
  const sMap = ctx.sMap;
  const articles = rows.map(Archive.toArticle).filter((a) => {
    const src = sMap.get(a.sourceId);
    return src && evaluate(ast, (node) => matchLeaf(node, articleValue(a, src, node.field, now)));
  });
  return { articles, k, matched, scanned: rows.length };
}

const VIEW_MODES = ['stories', 'stream', 'blindspot'];
const VIEW_SORTS = ['top', 'latest', 'coverage'];
function cleanSaved(b, prev = {}) {
  const out = {};
  if (b.query !== undefined || !prev.id) {
    const query = String(b.query ?? '').trim().slice(0, 500);
    if (!query) return { error: 'query is required' };
    try { parseQuery(query); } catch (e) { return { error: `invalid query: ${e.message}` }; }
    out.query = query;
  }
  if (b.name !== undefined || !prev.id) out.name = String(b.name ?? '').trim().slice(0, 60) || (out.query || prev.query).slice(0, 40);
  if (b.pinned !== undefined || !prev.id) out.pinned = b.pinned === undefined ? true : !!b.pinned;
  if (b.view !== undefined) {
    const v = b.view;
    out.view = v && VIEW_MODES.includes(v.mode) && VIEW_SORTS.includes(v.sort) ? { mode: v.mode, sort: v.sort } : null;   // time window is part of the query
  } else if (!prev.id) out.view = null;
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'src';

const blindspotMin = (params) => Math.min(20, Math.max(2, Number(params.get('bmin')) || 3));

function validBias(b) { return Number.isInteger(b) && b >= -2 && b <= 2; }

// ───────────────────────── http ─────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.json': 'application/json' };

// JSON responses are compressed when the client accepts it (brotli, else gzip), off the event loop: a page of
// stories is ~1.5 MB of JSON and ~0.4 MB compressed
const encodingFor = (req) => { const ae = String(req?.headers['accept-encoding'] || ''); return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null; };
function send(res, code, body) {
  const data = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  const enc = data.length > 1400 ? encodingFor(res.req) : null;
  if (!enc) { res.writeHead(code, headers); return res.end(data); }
  const done = (err, out) => {
    if (res.headersSent || res.destroyed) return;
    if (err) { res.writeHead(code, headers); return res.end(data); }
    res.writeHead(code, { ...headers, 'Content-Encoding': enc });
    res.end(out);
  };
  if (enc === 'br') zlib.brotliCompress(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }, done);
  else zlib.gzip(data, { level: 5 }, done);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

// Static files: kept in memory with their compressed forms and an ETag (rebuilt when the file changes). Browsers
// revalidate every load (no-cache), so an update shows up at once — but an unchanged file costs a 304, not a download.
const staticCache = new Map();
async function staticEntry(file) {
  const st = await fs.stat(file);
  if (!st.isFile()) throw new Error('not a file');
  const hit = staticCache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
  const raw = await fs.readFile(file);
  const ent = { mtime: st.mtimeMs, size: st.size, raw, etag: `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`, type: MIME[path.extname(file)] || 'application/octet-stream' };
  if (/^(text\/|application\/json|image\/svg)/.test(ent.type) && raw.length > 1024) {
    const zp = (await import('node:util')).promisify;
    ent.br = await zp(zlib.brotliCompress)(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
    ent.gz = await zp(zlib.gzip)(raw, { level: 9 });
  }
  staticCache.set(file, ent);
  return ent;
}
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const ent = await staticEntry(file);
    const headers = { 'Content-Type': ent.type, 'Cache-Control': 'no-cache', ETag: ent.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === ent.etag) { res.writeHead(304, headers); return res.end(); }
    const enc = encodingFor(req);
    if (enc === 'br' && ent.br) { res.writeHead(200, { ...headers, 'Content-Encoding': 'br' }); return res.end(ent.br); }
    if (enc && ent.gz) { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }); return res.end(ent.gz); }
    res.writeHead(200, headers);
    res.end(ent.raw);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 // not found');
  }
}

// ───────────────────────── auth & permissions ─────────────────────────
const COOKIE = 'stringer_sid';
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1] || null;
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || /^https:/.test(accounts.settings().baseUrl);
function setSessionCookie(req, res, sess) {
  res.setHeader('Set-Cookie', `${COOKIE}=${sess.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sess.maxAge}${isHttps(req) ? '; Secure' : ''}`);
}
const clearSessionCookie = (req, res) => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);
const baseUrl = (req) => accounts.settings().baseUrl || `${isHttps(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

// who is asking, what they may do, and which ranking weights apply
function requestCtx(req, url) {
  const user = accounts.sessionUser(cookieOf(req, COOKIE));
  const perms = accounts.rolePerms(user ? user.role : 'guest');
  const mode = rankMode(user, perms, url.searchParams.get('rank'));
  return { user, perms, mode, ...rankedSources(mode, user) };
}
const httpError = (status, error, extra = {}) => Object.assign(new Error(error), { status, extra });
function need(ctx, perm) {
  if (ctx.perms.has(perm)) return;
  throw httpError(ctx.user ? 403 : 401, ctx.user ? `your role doesn't allow this (${perm})` : 'sign in to do this', { perm });
}
const publicSettings = () => {
  const st = accounts.settings();
  return { siteName: st.siteName, localLogin: st.localLogin, signup: st.signup && st.localLogin,
    oidc: { enabled: !!(st.oidc.enabled && st.oidc.issuer && st.oidc.clientId), label: st.oidc.label }, ranking: st.ranking };
};
function meView(ctx) {
  const st = accounts.settings();
  return { setupNeeded: !st.setupDone, user: accounts.publicUser(ctx.user), perms: [...ctx.perms], site: publicSettings(),
    rank: { mode: ctx.mode, budget: ctx.user && ctx.perms.has('vote.community') ? accounts.budget(ctx.user.id) : null } };
}
function newOidcUsername(claims) {
  const base = String(claims.preferred_username || (claims.email || '').split('@')[0] || claims.name || 'user')
    .normalize('NFKD').replace(/[^\p{L}\p{N}._-]+/gu, '').slice(0, 24) || 'user';
  let name = base.length >= 2 ? base : `user-${base}`, k = 1;
  while (accounts.q.userByName.get(name)) name = `${base}${++k}`;
  return name;
}
const roleFromClaims = (cfg, claims) => {
  const v = claims[cfg.roleClaim || 'groups'];
  const groups = Array.isArray(v) ? v : v != null ? [v] : [];
  for (const [g, role] of Object.entries(cfg.roleMap || {})) if (groups.map(String).includes(g)) return role;
  return null;
};

// GET /auth/oidc/login → provider → GET /auth/oidc/callback
async function handleOidc(req, res, url) {
  const st = accounts.settings();
  const cfg = st.oidc;
  const fail = (msg) => { res.writeHead(302, { Location: `/?login_error=${encodeURIComponent(msg)}` }); res.end(); };
  if (!cfg.enabled || !cfg.issuer || !cfg.clientId) return fail('single sign-on is not configured on this server');
  const redirectUri = `${baseUrl(req)}/auth/oidc/callback`;
  try {
    if (url.pathname === '/auth/oidc/login') {
      const { url: go, state, verifier, nonce } = await oidc.authorizeUrl(cfg, redirectUri);
      const back = url.searchParams.get('return') || '/';
      accounts.putOidcState(state, verifier, nonce, back.startsWith('/') && !back.startsWith('//') ? back : '/');
      res.writeHead(302, { Location: go });
      return res.end();
    }
    if (url.pathname === '/auth/oidc/callback') {
      if (url.searchParams.get('error')) return fail(url.searchParams.get('error_description') || url.searchParams.get('error'));
      const saved = accounts.takeOidcState(url.searchParams.get('state'));
      if (!saved) return fail('that sign-in link expired — try again');
      const { claims, issuer } = await oidc.finishLogin(cfg, { code: url.searchParams.get('code'), verifier: saved.verifier, nonce: saved.nonce, redirectUri });
      const key = `${String(issuer).replace(/\/+$/, '')}|${claims.sub}`;
      let user = accounts.userByOidc(key);
      const mapped = roleFromClaims(cfg, claims);
      if (!user && claims.email && claims.email_verified === true) {
        // an existing account with the same verified email (e.g. the admin created at setup) is linked once
        const byEmail = accounts.db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND oidc IS NULL').get(claims.email);
        if (byEmail) { accounts.db.prepare('UPDATE users SET oidc = ? WHERE id = ?').run(key, byEmail.id); user = accounts.user(byEmail.id); }
      }
      if (!user) {
        if (!cfg.autoCreate) return fail('there is no account for you on this server — ask an admin to create one');
        user = accounts.createUser({ username: newOidcUsername(claims), display: claims.name || claims.preferred_username, email: claims.email || null,
          role: mapped || cfg.defaultRole || st.defaultRole, oidc: key });
        seedTabs(user.id);
        console.log(`[auth] new account via SSO: ${user.username} (${user.role})`);
      } else if (mapped && mapped !== user.role) {
        try { accounts.updateUser(user.id, { role: mapped }); user = accounts.user(user.id); } catch { /* e.g. would remove the last admin */ }
      }
      if (user.disabled) return fail('this account is disabled');
      setSessionCookie(req, res, accounts.createSession(user.id));
      res.writeHead(302, { Location: saved.return_to || '/' });
      return res.end();
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.error('[auth] OIDC sign-in failed:', e.message);
    return fail(`sign-in failed: ${e.message}`);
  }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop 'api'
  const m = req.method;
  // writes must come from our own page (a cross-site form can't set this header)
  if (m !== 'GET' && req.headers['x-requested-with'] !== 'stringer') return send(res, 403, { error: 'missing X-Requested-With header' });
  if (parts[0] === 'health') return send(res, 200, { ok: true, articles: [...held.values()].reduce((n, x) => n + x.size, 0), lastRefresh });
  const ctx = requestCtx(req, url);
  const st = accounts.settings();

  if (parts[0] === 'me' && !parts[1] && m === 'GET') return send(res, 200, meView(ctx));

  // ── first run: create the admin, pick the outlets, archive settings ──
  if (parts[0] === 'setup') {
    if (st.setupDone) return send(res, 409, { error: 'this server is already set up' });
    if (m === 'GET') {
      return send(res, 200, { sources: db.sources.map((s) => ({ id: s.id, name: s.name, bias: s.bias, type: s.type, site: s.site, enabled: s.enabled })),
        migrate: { tabs: (db.savedQueries || []).length, votes: db.sources.filter((s) => s.votes).length },
        archive: archive ? { total: archive.approxTotal(), backfill: backfill?.status(), fulltext: archive.kv('fulltextEnabled') !== false } : null });
    }
    // find the feed of an outlet that isn't in the default list (only while the server is being set up)
    if (m === 'POST' && parts[1] === 'discover') {
      const { url: u } = await readBody(req);
      if (!u || typeof u !== 'string') return send(res, 400, { error: 'a site or feed URL is required' });
      try { return send(res, 200, await discoverFeed(u)); } catch (e) { return send(res, 422, { error: e.message }); }
    }
    if (m === 'POST' && !parts[1]) {
      const b = await readBody(req);
      const a = b.admin || {};
      const ids = new Set(Array.isArray(b.sources) ? b.sources : []);
      // outlets the admin added that aren't in the default list
      const custom = [];
      for (const c of Array.isArray(b.custom) ? b.custom.slice(0, 100) : []) {
        const name = String(c.name || '').trim().slice(0, 80), feed = String(c.feed || '').trim(), bias = Number(c.bias);
        if (!name || !/^https?:\/\//i.test(feed) || !validBias(bias)) return send(res, 400, { error: `custom outlet "${name || feed}": needs a name, an http(s) feed URL and a bias rating` });
        if (db.sources.some((s) => s.feed === feed) || custom.some((x) => x.feed === feed)) continue;
        let sid = slug(name);
        while (byId(sid) || custom.some((x) => x.id === sid)) sid = `${slug(name)}-${crypto.randomBytes(2).toString('hex')}`;
        let site = String(c.site || '');
        if (!/^https?:\/\//i.test(site)) site = new URL(feed).origin;
        custom.push({ id: sid, name, bias, type: c.type === 'legacy' ? 'legacy' : 'new', site, feed, enabled: true, custom: true });
      }
      if (!ids.size && !custom.length) return send(res, 400, { error: 'enable at least one outlet' });
      let admin;
      try { admin = accounts.createUser({ username: a.username, display: a.display || a.username, email: a.email || null, role: 'admin', password: String(a.password || '') }); }
      catch (e) { return send(res, 400, { error: e.message }); }
      // carry a single-user install's tabs and outlet votes over to the admin
      if (db.savedQueries?.length) for (const q of db.savedQueries) accounts.addSavedQuery(admin.id, q);
      else seedTabs(admin.id);
      accounts.setPersonalVotes(admin.id, Object.fromEntries(db.sources.filter((s) => s.votes).map((s) => [s.id, s.votes])));
      delete db.savedQueries;
      for (const s of db.sources) { s.enabled = ids.has(s.id); delete s.votes; }
      db.sources.push(...custom);
      await saveDb();
      const guest = accounts.roles().find((r) => r.id === 'guest');
      accounts.saveRole({ ...guest, perms: b.guestAccess === false ? [] : guest.perms.length ? guest.perms : ['news.read', 'comments.read'] });
      accounts.setSettings({ setupDone: true, siteName: String(b.siteName || st.siteName).slice(0, 40) || 'STRINGER',
        ranking: { defaultMode: b.rankMode === 'personal' ? 'personal' : 'community' } });
      if (backfill) {
        if (b.backfill?.enabled) backfill.start(b.backfill.since ? Date.parse(b.backfill.since) : undefined);
        else backfill.pause();
      }
      if (harvest && archive) { if (b.fulltext === false) { harvest.pause(); archive.kv('fulltextEnabled', false); } else { harvest.start(); archive.kv('fulltextEnabled', true); } }
      refreshAll();
      setSessionCookie(req, res, accounts.createSession(admin.id));
      console.log(`[setup] done: admin ${admin.username}, ${ids.size} outlets${custom.length ? ` + ${custom.length} added` : ''}`);
      return send(res, 200, meView({ ...requestCtx({ headers: {} }, url), user: admin, perms: accounts.rolePerms('admin') }));
    }
  }
  if (!st.setupDone) return send(res, 503, { error: 'this server is not set up yet', setupNeeded: true });

  // ── sign-in ──
  if (parts[0] === 'auth') {
    if (parts[1] === 'login' && m === 'POST') {
      if (!st.localLogin) return send(res, 403, { error: 'password sign-in is turned off on this server' });
      const b = await readBody(req);
      try {
        const u = accounts.login(b.username, b.password);
        setSessionCookie(req, res, accounts.createSession(u.id));
        return send(res, 200, meView({ ...ctx, ...requestCtxFor(u, url) }));
      } catch (e) { await new Promise((r) => setTimeout(r, 400)); return send(res, 401, { error: e.message }); }
    }
    if (parts[1] === 'signup' && m === 'POST') {
      if (!st.localLogin || !st.signup) return send(res, 403, { error: 'sign-ups are closed on this server' });
      const b = await readBody(req);
      try {
        const u = accounts.createUser({ username: b.username, display: b.display, email: b.email || null, role: st.defaultRole, password: String(b.password || '') });
        seedTabs(u.id);
        setSessionCookie(req, res, accounts.createSession(u.id));
        return send(res, 201, meView({ ...ctx, ...requestCtxFor(u, url) }));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (parts[1] === 'logout' && m === 'POST') {
      accounts.endSession(cookieOf(req, COOKIE));
      clearSessionCookie(req, res);
      return send(res, 200, { ok: true });
    }
  }

  // ── your own account ──
  if (parts[0] === 'me' && parts[1] === 'prefs' && m === 'PATCH') {
    if (!ctx.user) return send(res, 401, { error: 'sign in first' });
    const b = await readBody(req);
    const prefs = {};
    if (b.rankMode !== undefined) prefs.rankMode = b.rankMode === 'personal' ? 'personal' : 'community';
    accounts.updateUser(ctx.user.id, { prefs, ...(b.display !== undefined ? { display: b.display } : {}) });
    return send(res, 200, meView(requestCtx(req, new URL(url.pathname, 'http://x'))));
  }
  if (parts[0] === 'me' && parts[1] === 'password' && m === 'POST') {
    if (!ctx.user) return send(res, 401, { error: 'sign in first' });
    const b = await readBody(req);
    if (ctx.user.pw) { try { accounts.login(ctx.user.username, b.current); } catch { return send(res, 400, { error: 'your current password is wrong' }); } }
    try { accounts.updateUser(ctx.user.id, { password: String(b.password || '') }); } catch (e) { return send(res, 400, { error: e.message }); }
    return send(res, 200, { ok: true });
  }

  // ── administration ──
  if (parts[0] === 'admin') {
    if (parts[1] === 'users') {
      need(ctx, 'users.manage');
      if (!parts[2] && m === 'GET') return send(res, 200, { users: accounts.users(), roles: accounts.roles() });
      if (!parts[2] && m === 'POST') {
        const b = await readBody(req);
        try { const u = accounts.createUser({ username: b.username, display: b.display, email: b.email || null, role: b.role || st.defaultRole, password: b.password ? String(b.password) : null }); seedTabs(u.id); return send(res, 201, accounts.publicUser(u)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      const uid = Number(parts[2]);
      if (m === 'PATCH') {
        const b = await readBody(req);
        try { return send(res, 200, accounts.publicUser(accounts.updateUser(uid, b, { actorId: ctx.user.id }))); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (m === 'DELETE') { try { accounts.deleteUser(uid, { actorId: ctx.user.id }); storyReg.forgetUser(uid); binderSetCache.delete(uid); communityCache = null; cmIdx = null; return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); } }
    }
    if (parts[1] === 'roles') {
      need(ctx, 'users.manage');
      if (m === 'GET') return send(res, 200, { roles: accounts.roles(), permissions: PERMISSIONS });
      if (m === 'PUT') { const b = await readBody(req); try { return send(res, 200, accounts.saveRole(b)); } catch (e) { return send(res, 400, { error: e.message }); } }
      if (m === 'DELETE' && parts[2]) { try { accounts.deleteRole(parts[2]); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); } }
    }
    if (parts[1] === 'settings') {
      need(ctx, 'settings.manage');
      const view = () => { const v = structuredClone(accounts.settings()); v.oidc.hasSecret = !!v.oidc.clientSecret; delete v.oidc.clientSecret; v.redirectUri = `${baseUrl(req)}/auth/oidc/callback`; return v; };
      if (m === 'GET') return send(res, 200, view());
      if (m === 'PATCH') {
        const b = await readBody(req), patch = {};
        if (b.siteName !== undefined) patch.siteName = String(b.siteName).trim().slice(0, 40) || 'STRINGER';
        if (b.localLogin !== undefined) patch.localLogin = !!b.localLogin;
        if (b.signup !== undefined) patch.signup = !!b.signup;
        if (b.defaultRole !== undefined) { if (!accounts.q.role.get(b.defaultRole)) return send(res, 400, { error: 'no such role' }); patch.defaultRole = b.defaultRole; }
        if (b.baseUrl !== undefined) { const u = String(b.baseUrl).trim().replace(/\/+$/, ''); if (u && !/^https?:\/\/[^/]+/.test(u)) return send(res, 400, { error: 'public URL must start with http(s)://' }); patch.baseUrl = u; }
        if (b.ranking) {
          const r = {};
          if (b.ranking.defaultMode !== undefined) r.defaultMode = b.ranking.defaultMode === 'personal' ? 'personal' : 'community';
          for (const k of ['upPerDay', 'downPerDay']) if (b.ranking[k] !== undefined) r[k] = Math.max(0, Math.min(100, Math.trunc(Number(b.ranking[k])) || 0));
          patch.ranking = r;
        }
        if (b.oidc) {
          const o = {};
          for (const k of ['issuer', 'clientId', 'scopes', 'label', 'roleClaim']) if (b.oidc[k] !== undefined) o[k] = String(b.oidc[k]).trim();
          if (b.oidc.clientSecret) o.clientSecret = String(b.oidc.clientSecret);
          for (const k of ['enabled', 'autoCreate']) if (b.oidc[k] !== undefined) o[k] = !!b.oidc[k];
          if (b.oidc.defaultRole !== undefined) { if (!accounts.q.role.get(b.oidc.defaultRole)) return send(res, 400, { error: 'no such role' }); o.defaultRole = b.oidc.defaultRole; }
          if (b.oidc.roleMap !== undefined) o.roleMap = Object.fromEntries(Object.entries(b.oidc.roleMap || {}).filter(([g, r]) => g && accounts.q.role.get(r)));
          if (o.issuer) o.issuer = o.issuer.replace(/\/+$/, '');
          patch.oidc = o;
        }
        const next = { ...accounts.settings(), ...patch };
        if (!next.localLogin && !(next.oidc.enabled ?? accounts.settings().oidc.enabled)) return send(res, 400, { error: 'keep at least one way to sign in (password or SSO)' });
        accounts.setSettings(patch);
        return send(res, 200, view());
      }
    }
    if (parts[1] === 'oidc-test' && m === 'POST') {
      need(ctx, 'settings.manage');
      const b = await readBody(req);
      try { const meta = await oidc.discover(b.issuer || st.oidc.issuer); return send(res, 200, { ok: true, issuer: meta.issuer, authorization: meta.authorization_endpoint }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
  }

  // ── reading ──
  if (parts[0] === 'news' && m === 'GET') {
    need(ctx, 'news.read');
    const r = getNews(url.searchParams, false, ctx);
    if (!r.error && ctx.perms.has('comments.read')) Object.assign(r, commentCounts(r.items));
    if (!r.error && ctx.user) {
      r.reads = readFlags(r.items, ctx.user.id);
      r.readLinks = readLinksFor(r.items.flatMap((x) => x.articles || [x]), ctx.user.id);
      const sr = storyReadsOf(ctx.user.id);
      r.storyReads = Object.fromEntries(r.items.map((x) => x.sid || x.story?.sid).filter((sid) => sid && sr.has(sid)).map((sid) => [sid, sr.get(sid)]));
    }
    return send(res, r.error ? 400 : 200, { ...r, rank: ctx.mode, lastRefresh, refreshing: !!refreshing });
  }

  // reader view: the article's main text, extracted server-side (see lib/reader.js)
  if (parts[0] === 'read' && m === 'GET') {
    need(ctx, 'news.read');
    const morgueNo = url.searchParams.get('morgue') || url.searchParams.get('uuid');   // open by morgue no.
    const link = url.searchParams.get('url') || (morgueNo && archive?.linkByMorgue(morgueNo)) || '';
    if (morgueNo && !link) return send(res, 404, { error: 'no STRINGER-archived article with that morgue no.' });
    let stored = null, row = null;
    try { stored = archive?.readerFor(link) || null; row = archive?.articleRow(link) || null; } catch {}
    const id = row?.id ?? null;
    // a headline rebuilt from the URL (≈) is replaced by the page's real one once its text is archived
    const finish = (r) => {
      if (id != null && row.quality < 2 && r.ok) {
        try { const t = archive.upgradeHeadline(id, r, byId(row.source_id)?.name); if (t) { r = { ...r, retitled: t }; row.quality = 2; } }
        catch (e) { console.error('[archive] retitle failed', e.message); }
      }
      return r;
    };
    if (ctx.user && link) { try { accounts.setRead(ctx.user.id, normalizeUrl(link), true); readCache.delete(ctx.user.id); } catch {} }   // reading it = read
    if (stored?.ok) return send(res, 200, finish(stored));         // archived copy (also survives paywalls / deleted pages)
    if (!ctx.perms.has('reader.fetch')) {
      if (stored) return send(res, 200, stored);
      return send(res, 403, { error: ctx.user ? 'your role cannot open articles that are not in the morgue yet' : 'sign in to open articles that are not in the morgue yet', perm: 'reader.fetch' });
    }
    try {
      // dead links (404 / redirected to the front page) fall back to the Wayback Machine copy nearest the publish date
      // archive articles (older than the live window, or indexed from the archive's sources) fall back to the
      // Wayback copy whenever the original can't be read; live ones only when the page is gone
      const archived = !!row && (row.published < Date.now() - LIVE_DAYS * 864e5 || row.origin !== 'live');
      let r = await readArticle(link, { wayback: true, anyFailure: archived, date: row?.published ?? (Number(url.searchParams.get('date')) || null) });
      if (id != null && (r.ok || !stored)) {
        try {
          archive.saveBody(id, r);
          const no = archive.morgueOf(id), st = archive.bodyState(id)?.status;
          // (a fragment that still couldn't be read keeps its number: say so, so the reader shows its fragment tag)
          if (no) r = { ...r, morgue: no, archived: Date.now(), ...(st === 'ok' || st === 'partial' ? {} : { fragment: true }) };
        }
        catch (e) { console.error('[fulltext] save failed', e.message); }
      }
      return send(res, 200, finish(r.ok || !stored ? r : stored));
    } catch (e) {
      if (stored) return send(res, 200, stored);
      // the page couldn't be read, but the article may be filed (as a fragment): say so, so the reader shows its tag
      const no = id != null ? archive?.morgueOf(id) : null;
      return send(res, 502, { error: e.message, ...(no ? { morgue: no, fragment: true, archived: archive.bodyState(id)?.fetched || null } : {}) });
    }
  }

  // archive result details: the article, how it got into the archive, stored full text, related coverage
  if (parts[0] === 'article' && m === 'GET') {
    need(ctx, 'news.read');
    if (!archive) return send(res, 503, { error: 'archive unavailable' });
    const id = Number(String(url.searchParams.get('id') || '').replace(/^a/, ''));
    if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: 'id must be an archive article id (a123)' });
    const t0 = Date.now();
    const r = archive.related(id, tokenize, { days: Math.min(7, Math.max(1, Number(url.searchParams.get('days')) || 2)) });
    if (!r) return send(res, 404, { error: 'no such article' });
    const b = archive.bodyState(id);
    const body = b ? archive.db.prepare('SELECT status, words, byline, fetched, morgue FROM bodies WHERE id = ?').get(id) : null;
    const art = Archive.toArticle(r.article);
    return send(res, 200, { article: { ...art, quality: r.article.quality }, body, tokens: r.tokens,
      related: r.related, matches: r.matches, scanned: r.scanned, ms: Date.now() - t0,
      readLinks: ctx.user ? readLinksFor([art, ...r.related], ctx.user.id) : [] });
  }

  if (parts[0] === 'story' && m === 'GET') {
    need(ctx, 'news.read');
    // by an article in it (?id=) or by the story's number (?sid=)
    const aid = url.searchParams.get('id'), sid = (url.searchParams.get('sid') || '').toLowerCase();
    const hours = Math.min(24 * 14, Math.max(1, Number(url.searchParams.get('hours')) || 24 * 14));
    const minSources = blindspotMin(url.searchParams);
    const all = cachedStories(collectArticles({ hours }), ctx.sMap, { hours, sourceId: null, minSources });
    const story = sid ? all.find((st) => st.sid === sid) : all.find((st) => st.articles.some((a) => a.id === aid));
    return story ? send(res, 200, { ...story, fulltext: withText([story], null, false).fulltext || {}, readLinks: ctx.user ? readLinksFor(story.articles, ctx.user.id) : [],
      storyRead: ctx.user && story.sid ? storyReadsOf(ctx.user.id).get(story.sid) ?? null : null }) : send(res, 404, { error: 'story not found' });
  }

  // saved queries (pinnable tabs) — your own; visitors see the example tabs
  if (parts[0] === 'queries') {
    const id = parts[1];
    if (!id && m === 'GET') return send(res, 200, ctx.user && ctx.perms.has('queries.save') ? accounts.savedQueries(ctx.user.id) : EXAMPLE_TABS.map((t) => ({ ...t, readonly: true })));
    need(ctx, 'queries.save');
    if (!id && m === 'POST') {
      const v = cleanSaved(await readBody(req));
      if (v.error) return send(res, 400, v);
      return send(res, 201, accounts.addSavedQuery(ctx.user.id, v));
    }
    if (id === 'order' && m === 'POST') {
      const { ids } = await readBody(req);
      if (!Array.isArray(ids)) return send(res, 400, { error: 'ids[] required' });
      return send(res, 200, accounts.orderSavedQueries(ctx.user.id, ids));
    }
    const q = accounts.savedQueries(ctx.user.id).find((x) => x.id === id);
    if (!q) return send(res, 404, { error: 'no such saved query' });
    if (m === 'PATCH') {
      const v = cleanSaved(await readBody(req), q);
      if (v.error) return send(res, 400, v);
      return send(res, 200, accounts.updateSavedQuery(ctx.user.id, id, { ...q, ...v }));
    }
    if (m === 'DELETE') { accounts.deleteSavedQuery(ctx.user.id, id); return send(res, 200, { ok: true }); }
  }

  // hit counts for every saved query under the caller's current filters
  if (parts[0] === 'counts' && m === 'POST') {
    need(ctx, 'news.read');
    const b = await readBody(req);
    const base = new URLSearchParams(Object.entries(b.params || {}).map(([k, v]) => [k, String(v)]));
    const tabs = ctx.user && ctx.perms.has('queries.save') ? accounts.savedQueries(ctx.user.id) : EXAMPLE_TABS;
    const out = {};
    for (const sq of tabs) {
      const p = new URLSearchParams(base);
      p.set('q', sq.query);
      if (sq.view) p.set('mode', sq.view.mode);
      p.set('limit', '1');
      const r = getNews(p, false, ctx);
      out[sq.id] = r.error ? null : r.total;
    }
    return send(res, 200, out);
  }

  // ── stories: read / unread (POST { sid, read }) — opening a story's popover marks it read ──
  if (parts[0] === 'story-reads' && m === 'POST') {
    if (!ctx.user) return send(res, 401, { error: 'sign in to keep track of what you have read' });
    const b = await readBody(req);
    const sid = String(b.sid || '').toLowerCase();
    if (!storyReg.story(sid)) return send(res, 404, { error: 'no such story' });
    storyReg.setRead(ctx.user.id, sid, b.read !== false);
    storyReadCache.delete(ctx.user.id);
    return send(res, 200, { ok: true, sid, read: b.read !== false, at: b.read !== false ? Date.now() : null });
  }

  // ── an article's details (the reader's DETAILS tab): archive record, morgue, read state, stories it's been in ──
  if (parts[0] === 'details' && m === 'GET') {
    need(ctx, 'news.read');
    const link = url.searchParams.get('url') || '';
    if (!/^https?:\/\//.test(link)) return send(res, 400, { error: 'url required' });
    const t = normalizeUrl(link);
    const row = archive?.articleRow(link) || null;
    const full = row ? archive.db.prepare('SELECT * FROM articles WHERE id = ?').get(row.id) : null;
    const body = row ? archive.db.prepare('SELECT status, words, byline, fetched, morgue FROM bodies WHERE id = ?').get(row.id) || null : null;
    const sr = ctx.user ? storyReadsOf(ctx.user.id) : null;
    // stories still in the live window show their current lead headline (in your ranking); older ones the last one
    const live = new Map(cachedStories(collectArticles({ hours: LIVE_DAYS * 24 }), ctx.sMap, { hours: LIVE_DAYS * 24, sourceId: null, minSources: 3 }).map((st) => [st.sid, st]));
    const stories = storyReg.storiesOf(t).map((s) => ({ sid: s.sid, title: live.get(s.sid)?.title || s.title, articles: s.articles, sources: s.sources, first: s.first, newest: s.newest,
      lastSeen: s.last_seen, current: s.current, joined: s.added, read: sr ? sr.get(s.sid) ?? null : null }));
    const cm = ctx.perms.has('comments.read') ? { article: accounts.commentCounts([t], 'article').get(t) || 0, story: accounts.commentCounts([t], 'story').get(t) || 0 } : null;
    return send(res, 200, { link, archived: full ? { id: 'a' + full.id, origin: full.origin, quality: full.quality, published: full.published, sourceId: full.source_id, title: full.title } : null,
      body, stories, comments: cm, read: ctx.user ? readsOf(ctx.user.id).has(t) : null });
  }

  // ── read / unread ── (POST { link | links[], read: true|false }) — your own, signed in
  // ── research binder: saved stories, articles and quotes (per user) ──
  if (parts[0] === 'binder') {
    if (!ctx.user) return send(res, 401, { error: 'sign in to keep a research binder' });
    need(ctx, 'binder.use');
    const uid = ctx.user.id;
    if (m !== 'GET') binderSetCache.delete(uid);          // saved: reflects the change on the next query
    // binders: list / create / rename / delete
    if (parts[1] === 'books') {
      const bid = Number(parts[2]);
      const name = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (m === 'POST' && !parts[2]) { const b = await readBody(req); return send(res, 200, { book: accounts.bookCreate(uid, name(b.name) || 'Untitled binder') }); }
      if (m === 'PATCH' && bid) { const b = await readBody(req); if (!name(b.name)) return send(res, 400, { error: 'name required' }); return send(res, accounts.bookRename(uid, bid, name(b.name)) ? 200 : 404, { ok: true }); }
      if (m === 'DELETE' && bid) return accounts.bookDelete(uid, bid) ? send(res, 200, { ok: true }) : send(res, 400, { error: "can't delete your only binder" });
      return send(res, 405, { error: 'method not allowed' });
    }
    if (m === 'GET' && !parts[1]) {
      const live = liveStoryIndex(ctx);
      const entries = accounts.binder(uid);
      const books = accounts.books(uid).map((b) => ({ id: b.id, name: b.name, count: entries.filter((e) => e.book === b.id).length }));
      const items = entries.map((e) => {
        const out = { id: e.id, book: e.book, kind: e.kind, link: e.link, sid: e.sid, title: e.title, sourceId: e.source_id, published: e.published, morgue: e.morgue, quote: e.quote, note: e.note, created: e.created };
        if (e.kind === 'story') {
          const st = live.get(e.sid);
          const reg = storyReg.story(e.sid);
          out.live = !!st;
          out.title = st?.title || reg?.title || e.title;
          out.link = st?.link || reg?.link || e.link;
          out.sources = st?.sourceCount ?? reg?.sources ?? null;
          out.articles = st?.articles.length ?? reg?.articles ?? null;
          out.newest = st?.newest ?? reg?.newest ?? null;
          out.sourceId = st?.leadSource || e.source_id;
        } else if (archive && e.morgue) {
          const fr = archive.db.prepare('SELECT status, words FROM bodies WHERE morgue = ?').get(e.morgue);
          out.fragment = !fr || fr.status === 'fragment' || !fr.words;
          out.words = fr?.words || 0;
        }
        return out;
      });
      return send(res, 200, { books, items });
    }
    if (m === 'POST' && !parts[1]) {
      const b = await readBody(req);
      const kind = ['story', 'article', 'quote'].includes(b.kind) ? b.kind : null;
      if (!kind) return send(res, 400, { error: 'kind must be story, article or quote' });
      if (kind === 'story') {
        const sid = String(b.sid || '').toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(sid)) return send(res, 400, { error: 'story number required' });
        const st = liveStoryIndex(ctx).get(sid), reg = storyReg.story(sid);
        if (!st && !reg) return send(res, 404, { error: 'no such story' });
        if (b.remove) return send(res, 200, { removed: accounts.binderRemove(uid, 'story', sid, b.book) });
        const e = accounts.binderAdd(uid, { book: b.book, kind, target: sid, sid, link: st?.link || reg?.link, title: st?.title || reg?.title,
          sourceId: st?.leadSource || null, published: st?.newest || reg?.newest || null, note: cleanNote(b.note) });
        return send(res, 200, { item: e });
      }
      const link = String(b.link || '');
      if (!/^https?:\/\//.test(link)) return send(res, 400, { error: 'article link required' });
      if (kind === 'article' && b.remove) return send(res, 200, { removed: accounts.binderRemove(uid, 'article', normalizeUrl(link), b.book) });
      const art = resolveArticle(link);
      if (!art) return send(res, 404, { error: "that article isn't in the live feeds or the archive" });
      const quote = kind === 'quote' ? String(b.quote || '').replace(/\s+/g, ' ').trim().slice(0, 3000) : null;
      if (kind === 'quote' && quote.length < 2) return send(res, 400, { error: 'select some text to quote' });
      const e = accounts.binderAdd(uid, { book: b.book, kind, target: normalizeUrl(art.link), link: art.link, title: art.title, sourceId: art.sourceId,
        published: art.date, morgue: art.morgue, quote, note: cleanNote(b.note) });
      return send(res, 200, { item: e });
    }
    const id = Number(parts[1]);
    if (!Number.isInteger(id)) return send(res, 400, { error: 'bad id' });
    if (m === 'PATCH') {
      const b = await readBody(req);
      if (b.book != null) return send(res, accounts.binderMove(uid, id, b.book) ? 200 : 404, { ok: true });
      return send(res, accounts.binderNote(uid, id, cleanNote(b.note)) ? 200 : 404, { ok: true });
    }
    if (m === 'DELETE') return send(res, accounts.binderDelete(uid, id) ? 200 : 404, { ok: true });
    return send(res, 405, { error: 'method not allowed' });
  }

  if (parts[0] === 'reads' && m === 'POST') {
    if (!ctx.user) return send(res, 401, { error: 'sign in to keep track of what you have read' });
    const b = await readBody(req);
    const links = (Array.isArray(b.links) ? b.links : [b.link]).filter(Boolean).slice(0, 500);
    if (!links.length) return send(res, 400, { error: 'link required' });
    for (const l of links) accounts.setRead(ctx.user.id, normalizeUrl(String(l)), b.read !== false);
    readCache.delete(ctx.user.id);
    return send(res, 200, { ok: true, read: b.read !== false, count: links.length });
  }

  // ── comments ── (on an article, or on a story = every story-scope comment on any of its articles)
  if (parts[0] === 'comments') {
    if (parts[1] === 'find' && m === 'POST') {
      need(ctx, 'comments.read');
      const b = await readBody(req);
      const norm = (l) => normalizeUrl(String(l));
      const out = {};
      if (b.article) out.article = accounts.comments([norm(b.article)], 'article');
      if (Array.isArray(b.story)) out.story = accounts.comments([...new Set(b.story.slice(0, 1000).map(norm))], 'story');
      return send(res, 200, { ...out, me: ctx.user?.id ?? null, canPost: ctx.perms.has('comments.post'), canModerate: ctx.perms.has('comments.moderate') });
    }
    if (!parts[1] && m === 'POST') {
      need(ctx, 'comments.post');
      const b = await readBody(req);
      if (!b.link) return send(res, 400, { error: 'link required' });
      cmIdx = null;
      try { const id = accounts.addComment(ctx.user.id, { target: normalizeUrl(String(b.link)), scope: b.scope, parent: b.parent ?? null, body: b.body }); return send(res, 201, { id }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    const c = parts[1] && accounts.comment(Number(parts[1]));
    if (!c || c.deleted) return send(res, 404, { error: 'no such comment' });
    const own = ctx.user && c.user_id === ctx.user.id;
    if (m === 'PATCH') {
      if (!own || !ctx.perms.has('comments.post')) return send(res, 403, { error: 'you can only edit your own comments' });
      cmIdx = null;
      try { accounts.editComment(c.id, (await readBody(req)).body); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (m === 'DELETE') {
      if (!(own && ctx.perms.has('comments.post')) && !ctx.perms.has('comments.moderate')) return send(res, 403, { error: "you can't delete this comment" });
      accounts.deleteComment(c.id, ctx.user.id);
      cmIdx = null;
      return send(res, 200, { ok: true });
    }
  }

  if (parts[0] === 'archive') {
    if (!archive) return send(res, 503, { error: 'archive unavailable' });
    if (m === 'GET') {
      need(ctx, 'news.read');
      // per-outlet stats are computed in the backfill worker (a GROUP BY over millions of rows would block us)
      const st = backfill.stats() || { total: archive.approxTotal(), sources: {} };
      harvest?.refreshStats();
      let disk = null;
      try { disk = archive.diskUsage(); } catch {}
      return send(res, 200, { ...st, total: Math.max(st.total, archive.approxTotal()), backfill: backfill.status(), disk,
        fulltext: harvest ? { ...(harvest.stats() || {}), harvester: harvest.status() } : null, sources: Object.fromEntries(db.sources.map((s) => [s.id, { name: s.name, bias: s.bias, ...(st.sources[s.id] || { count: 0, files: {} }) }])) });
    }
    if (m === 'POST') {
      need(ctx, 'archive.manage');
      const b = await readBody(req);
      if (b.action === 'start') {
        const since = b.since ? Date.parse(b.since) : undefined;
        if (b.since && !Number.isFinite(since)) return send(res, 400, { error: 'since must be a date like 2010-01-01' });
        backfill.start(since);
      } else if (b.action === 'pause') backfill.pause();
      else if (b.action === 'fulltext-start' && harvest) { harvest.start(); archive.kv('fulltextEnabled', true); }
      else if (b.action === 'fulltext-pause' && harvest) { harvest.pause(); archive.kv('fulltextEnabled', false); }
      else return send(res, 400, { error: 'action must be start, pause, fulltext-start or fulltext-pause' });
      return send(res, 200, backfill.status());
    }
  }

  if (parts[0] === 'stats' && m === 'GET') {
    need(ctx, 'news.read');
    const t0 = Date.now();
    const r = getNews(url.searchParams, true, ctx);
    if (r.error) return send(res, 400, r);
    let articles = r.articles, sample = null;
    // big archive result: article-level stats from an evenly spread 1-in-k sample of the whole match set
    if (r.archive && r.archive.candidates > STATS_SAMPLE) {
      const sp = sampleArchive(url.searchParams, ctx);
      if (sp) { articles = sp.articles; sample = { k: sp.k, matched: sp.matched, scanned: sp.scanned }; }
    }
    const stats = computeStats({ articles, stories: r.stories, sMap: r.sMap });
    if (sample) stats.totals.estimated = Math.round(stats.totals.articles * sample.k);
    return send(res, 200, { mode: r.mode, archive: r.archive, sample, ms: Date.now() - t0, ...stats });
  }

  if (parts[0] === 'status' && m === 'GET') {
    need(ctx, 'news.read');
    const views = db.sources.map((s) => sourceView(s, ctx));
    return send(res, 200, {
      lastRefresh, refreshing: !!refreshing, refreshMs: REFRESH_MS, grouping: lastGrouping,
      sources: views.length, enabled: views.filter((v) => v.enabled).length,
      ok: views.filter((v) => v.status === 'ok').length,
      articles: views.reduce((n, v) => n + (v.enabled ? v.count : 0), 0),
    });
  }

  if (parts[0] === 'refresh' && m === 'POST') {
    need(ctx, 'sources.manage');
    await refreshAll();
    return send(res, 200, { ok: true, lastRefresh });
  }

  if (parts[0] === 'discover' && m === 'POST') {
    need(ctx, 'sources.manage');
    const { url: u } = await readBody(req);
    if (!u || typeof u !== 'string') return send(res, 400, { error: 'url required' });
    try { return send(res, 200, await discoverFeed(u)); }
    catch (e) { return send(res, 422, { error: e.message }); }
  }

  if (parts[0] === 'sources') {
    const id = parts[1];
    if (!id && m === 'GET') {
      need(ctx, 'news.read');
      // ranking info for the sidebar: the votes in effect (this mode), plus community / your personal standing
      const com = communityVotes(), mine = ctx.user ? accounts.personalVotes(ctx.user.id) : new Map();
      const today = ctx.user && ctx.perms.has('vote.community') ? accounts.budget(ctx.user.id).today : {};
      return send(res, 200, db.sources.map((s) => ({ ...sourceView(s, ctx), community: com.get(s.id) || 0, personal: mine.get(s.id) || 0, today: today[s.id] || 0 })));
    }
    if (!id && m === 'POST') need(ctx, 'sources.manage');
    if (!id && m === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 80);
      const feed = String(b.feed || '').trim();
      const bias = Number(b.bias);
      if (!name) return send(res, 400, { error: 'name required' });
      if (!/^https?:\/\//i.test(feed)) return send(res, 400, { error: 'feed must be an http(s) URL' });
      if (!validBias(bias)) return send(res, 400, { error: 'bias must be -2..2' });
      if (db.sources.some((s) => s.feed === feed)) return send(res, 409, { error: 'that feed is already a source' });
      try { await fetchFeed(feed); } catch (e) { return send(res, 422, { error: `feed check failed: ${e.message}` }); }
      let sid = slug(name);
      while (byId(sid)) sid = `${slug(name)}-${crypto.randomBytes(2).toString('hex')}`;
      let site = String(b.site || '');
      if (!/^https?:\/\//i.test(site)) site = new URL(feed).origin;
      const s = { id: sid, name, bias, type: b.type === 'legacy' ? 'legacy' : 'new', site, feed, enabled: true, custom: true };
      db.sources.push(s);
      db.removedDefaults = db.removedDefaults.filter((x) => x !== sid);
      await saveDb();
      await refreshOne(s);
      return send(res, 201, sourceView(s, ctx));
    }

    const s = id && byId(id);
    if (!s) return send(res, 404, { error: 'no such source' });

    // ▲▼: personal votes are standing (−30…+30); community votes spend the daily budget
    if (parts[2] === 'vote' && m === 'POST') {
      const b = await readBody(req);
      const mode = b.mode === 'personal' ? 'personal' : b.mode === 'community' ? 'community' : ctx.mode;
      need(ctx, mode === 'personal' ? 'vote.personal' : 'vote.community');
      let result;
      try {
        if (mode === 'personal') result = { personal: accounts.personalVote(ctx.user.id, s.id, Number(b.delta)) };
        else { result = { budget: accounts.communityVote(ctx.user.id, s.id, Number(b.delta)) }; communityCache = null; }
      } catch (e) { return send(res, e.status || 400, { error: e.message }); }
      const c2 = requestCtxFor(ctx.user, url, mode);
      return send(res, 200, { ...sourceView(s, c2), community: communityVotes().get(s.id) || 0, personal: accounts.personalVotes(ctx.user.id).get(s.id) || 0,
        today: accounts.budget(ctx.user.id).today[s.id] || 0, mode, ...result });
    }
    need(ctx, 'sources.manage');

    if (!parts[2] && m === 'PATCH') {
      const b = await readBody(req);
      if (b.name !== undefined) s.name = String(b.name).trim().slice(0, 80) || s.name;
      if (b.bias !== undefined) { if (!validBias(Number(b.bias))) return send(res, 400, { error: 'bias must be -2..2' }); s.bias = Number(b.bias); }
      if (b.type !== undefined) s.type = b.type === 'legacy' ? 'legacy' : 'new';
      if (b.enabled !== undefined) {
        s.enabled = !!b.enabled;
        if (s.enabled && !cache.has(s.id)) refreshOne(s);
      }
      await saveDb();
      return send(res, 200, sourceView(s, ctx));
    }

    if (!parts[2] && m === 'DELETE') {
      db.sources = db.sources.filter((x) => x.id !== s.id);
      if (!s.custom) db.removedDefaults.push(s.id);
      cache.delete(s.id);
      held.delete(s.id);
      await saveDb();
      return send(res, 200, { ok: true });
    }
  }

  if (parts[0] === 'reset-defaults' && m === 'POST') {
    need(ctx, 'sources.manage');
    db.removedDefaults = [];
    await saveDb();
    await loadDb();
    refreshAll();
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'unknown endpoint' });
}

// a ctx for a given user (after sign-in, or to report a vote in the mode it was cast in)
function requestCtxFor(user, url, mode) {
  const perms = accounts.rolePerms(user.role);
  const m = mode || rankMode(user, perms, url.searchParams.get('rank'));
  return { user, perms, mode: m, ...rankedSources(m, user) };
}

// links (of the given articles) that you've read — the client tracks read state by link, since one article can
// carry different ids in different views (live, story lead, archive)
const readLinksFor = (arts, uid) => { const set = readsOf(uid); return [...new Set(arts.filter((a) => a?.link && set.has(normOf(a))).map((a) => a.link))]; };
// which articles on a page of results you've read (article id → true)
function readFlags(items, uid) {
  const set = readsOf(uid), out = {};
  for (const a of items.flatMap((x) => x.articles || [x])) if (set.has(normOf(a))) out[a.id] = true;
  return out;
}

// comment counts for a page of results: per article (article scope) and per story (story scope over its articles)
function commentCounts(items) {
  const arts = items.flatMap((x) => x.articles || [x]);
  const urls = [...new Set(arts.map((a) => normalizeUrl(a.link)))];
  const ac = accounts.commentCounts(urls, 'article'), sc = accounts.commentCounts(urls, 'story');
  const comments = {};
  for (const it of items) {
    if (it.articles) {
      const n = [...new Set(it.articles.map((a) => normalizeUrl(a.link)))].reduce((t, u) => t + (sc.get(u) || 0), 0);
      if (n) comments[it.id] = n;
    } else {
      const u = normalizeUrl(it.link), n = (ac.get(u) || 0) + (sc.get(u) || 0);
      if (n) comments[it.id] = n;
    }
  }
  return { comments };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (url.pathname.startsWith('/auth/oidc/') && req.method === 'GET') await handleOidc(req, res, url);
    else if (req.method === 'GET') await serveStatic(req, res, url.pathname);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'server error', ...(e.extra || {}) });
  }
});

// background work (feeds, backfill) must never take the server down
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));
// Node's built-in fetch (undici) can throw an internal assertion from a socket event when a request
// is aborted mid-body (seen during the archive backfill). That only kills the one request: log it and
// carry on. Anything else is a real bug → exit, and the supervisor (bin/run.js) restarts us.
process.on('uncaughtException', (e) => {
  if (/undici/.test(e?.stack || '') ) { console.error('[undici] recovered from internal error:', e.message); return; }
  console.error('[fatal]', e);
  process.exit(1);
});

await loadDb();

// historical archive (SQLite) + background backfill
try {
  archive = new Archive(path.join(DATA_DIR, 'archive.db'));
  // crawling, parsing and bulk inserts run in a worker thread so they never stall web requests
  backfill = new BackfillWorker({ dbFile: path.join(DATA_DIR, 'archive.db'), getSources: () => db.sources, autostart: process.env.BACKFILL !== '0', log: (m) => console.log(m) });
  // full text of every live-feed article (off with FULLTEXT=0; pause/resume from the archive panel is remembered)
  if (process.env.FULLTEXT !== '0') {
    harvest = new HarvestWorker({ dbFile: path.join(DATA_DIR, 'archive.db'), enabled: archive.kv('fulltextEnabled') !== false,
      backlogDays: Number(process.env.FULLTEXT_BACKLOG_DAYS) || 7, log: (m) => console.log(m) });
  }
} catch (e) {
  console.error('[archive] disabled:', e.message);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  ▓▓ STRINGER online → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  seedLive();
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
});
