// Historical backfill crawler. Three strategies, all resumable (progress lives in the archive DB):
//   sitemap  — robots.txt → sitemap indexes → dated child sitemaps → article URLs (+ date, + headline
//              from news:title or rebuilt from the URL slug). Deep (often 10–40 years) but lossy titles.
//   wayback  — the Internet Archive's snapshots of each outlet's RSS feed (real headlines + summaries),
//              sampled coarse-to-fine: one per month first, then weekly, then daily.
//   hn       — Hacker News stories via the public Algolia search API.
// Politeness: one request at a time per host with a delay; a single global queue for archive.org.
import zlib from 'node:zlib';
import { parseFeed, decodeEntities } from './feeds.js';
import { hintsFor } from './archive-hints.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yieldLoop = () => new Promise((r) => setImmediate(r));   // let queued HTTP requests run
const CHUNK = 500;                                                // rows parsed/inserted between yields
const DAY = 86400e3;
const SITEMAP_DELAY = 900;        // ms between requests to the same outlet
const WAYBACK_DELAY = 1300;       // ms between requests to archive.org
const SITEMAP_WORKERS = 6;        // outlets crawled in parallel

async function fetchRaw(url, { timeout = 30000, ua = UA } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': ua, Accept: '*/*' } });
    if (!r.ok) return { status: r.status };
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = zlib.gunzipSync(buf); } catch {} }
    return { status: 200, text: buf.toString('utf8') };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
  } finally { clearTimeout(t); }
}

// ───────────────────────── sitemap helpers ─────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const utc = (y, m = 1, d = 1) => Date.UTC(y, m - 1, d);
const validYMD = (y, m, d = 1) => y >= 1980 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
// article URLs can carry much older dates (NYT's archive goes back to 1851); 1969-12-31 / 1970-01-01 is the Unix
// epoch, a CMS placeholder rather than a date
const validArticleYMD = (y, m, d = 1) => y >= 1851 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 &&
  !((y === 1969 && m === 12 && d === 31) || (y === 1970 && m === 1 && d === 1));

// What time span does a sitemap file (or URL) cover, judging by its name?
export function inferPeriod(url) {
  const u = decodeEntities(url);
  let m = u.match(/yyyy=(\d{4})(?:&(?:amp;)?mm=(\d{1,2}))?(?:&(?:amp;)?dd=(\d{1,2}))?/i);
  if (m) {
    const y = +m[1], mo = m[2] ? +m[2] : null, d = m[3] ? +m[3] : null;
    if (d && validYMD(y, mo, d)) return { start: utc(y, mo, d), end: utc(y, mo, d) + DAY };
    if (mo && validYMD(y, mo)) return { start: utc(y, mo), end: utc(y, mo + 1) };
    return { start: utc(y), end: utc(y + 1) };
  }
  m = u.match(/(?<!\d)(\d{4})\.xml\?(?:[^#]*?&(?:amp;)?)?mm=(\d{1,2})(?:&(?:amp;)?dd=(\d{1,2}))?/i);   // sitemap-2016.xml?mm=05&dd=12
  if (m && validYMD(+m[1], +m[2], m[3] ? +m[3] : 1)) {
    return m[3] ? { start: utc(+m[1], +m[2], +m[3]), end: utc(+m[1], +m[2], +m[3]) + DAY } : { start: utc(+m[1], +m[2]), end: utc(+m[1], +m[2] + 1) };
  }
  m = u.match(/(?<!\d)(\d{4})[-_/](\d{1,2})[-_/](\d{1,2})(?!\d)/);
  if (m && validYMD(+m[1], +m[2], +m[3])) return { start: utc(+m[1], +m[2], +m[3]), end: utc(+m[1], +m[2], +m[3]) + DAY };
  m = u.match(/_m(\d{2})_(\d{4})/);
  if (m && validYMD(+m[2], +m[1])) return { start: utc(+m[2], +m[1]), end: utc(+m[2], +m[1] + 1) };
  m = u.match(/(?<![a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_](\d{4})(?!\d)/i);
  if (m) { const mo = MONTHS[m[1].toLowerCase()]; return { start: utc(+m[2], mo), end: utc(+m[2], mo + 1) }; }
  m = u.match(/(?<!\d)(\d{4})[-_/](\d{1,2})(?![\d])/);
  if (m && validYMD(+m[1], +m[2])) return { start: utc(+m[1], +m[2]), end: utc(+m[1], +m[2] + 1) };
  m = u.match(/(?<!\d)(19[89]\d|20\d\d)(?!\d)/);
  if (m) return { start: utc(+m[1]), end: utc(+m[1] + 1) };
  return null;
}

// date embedded in an article URL path, e.g. /2016/05/24/ or /2016-05-24/
export function urlDate(url) {
  const Y = '(18[5-9]\\d|19\\d\\d|20\\d\\d)';
  let m = url.match(new RegExp(`/${Y}/(\\d{1,2})/(\\d{1,2})(?:/|$)`));
  if (m && validArticleYMD(+m[1], +m[2], +m[3])) return utc(+m[1], +m[2], +m[3]) + 12 * 3600e3;
  m = url.match(new RegExp(`[/_-]${Y}-(\\d{2})-(\\d{2})(?:[/_-]|$)`));
  if (m && validArticleYMD(+m[1], +m[2], +m[3])) return utc(+m[1], +m[2], +m[3]) + 12 * 3600e3;
  m = url.match(new RegExp(`/${Y}/(\\d{2})(\\d{2})/`));                       // /2024/0603/
  if (m && validArticleYMD(+m[1], +m[2], +m[3])) return utc(+m[1], +m[2], +m[3]) + 12 * 3600e3;
  m = url.match(new RegExp(`/${Y}/(\\d{1,2})/(?!\\d{1,2}(?:/|$))`));            // /2005/04/slug (slug may start with a digit)
  if (m && validArticleYMD(+m[1], +m[2])) return utc(+m[1], +m[2], 15);
  return null;
}

const UUID_SEG = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_ID = /^(?=(?:.*\d){6})[a-z0-9]{8,}$/i;        // flna1C9478920: an ID glued to the slug's end
const ID_TOKEN = /^(?:\d{3,}|[0-9a-f]{8,}|[a-z]{0,5}\d{4,}[a-z0-9]*|n\d+|ar-[a-z0-9]+|amp|html?|php|index|story|article|id)$/i;
const SMALL = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'vs', 'as', 'is']);

// Rebuild a readable headline from a URL slug: /2016/05/24/opinion/the-shampoo-summit.html → "The shampoo summit"
export function slugTitle(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  const segs = path.split('/').filter(Boolean).reverse();
  for (const seg0 of segs) {
    let seg;
    try { seg = decodeURIComponent(seg0); } catch { seg = seg0; }
    seg = seg.replace(/\.(s?html?|php|aspx?|amp)$/i, '');
    if (!/[a-z]/i.test(seg) || !/[-_]/.test(seg)) continue;
    // an ID segment, not a slug: washingtonpost.com/…/<slug>/2014/01/01/94c16ce2-730c-11e3-8b3f-b1666705ca3b_story.html
    if (UUID_SEG.test(seg)) continue;
    const words = seg.split(/[-_]+/).filter((w) => w && !ID_TOKEN.test(w) && !LONG_ID.test(w));
    const alpha = words.filter((w) => /[a-z]/i.test(w));
    if (alpha.length < 3) continue;
    const t = words.join(' ').replace(/\s+/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return null;
}

const CHILD_EXCLUDE = /video|image|(?:^|[^a-z])(?:img|tags?|misc|puzzles?|crosswords?)(?:[^a-z]|$)|author|categor|topic|person|people|section|page-sitemap|sitemap-pages|gallery|galler|photo|podcast|newsletter|static|landing|collection|episode|product|recipe|shop|coupon|deals|events?\b|programs?\b|shows?\b|weather|horoscope|obituar|classified|jobs|careers/i;
const CHILD_LANG = /[/_-](fr|es|ar|de|pt|ru|zh|ja|ko|it|tr|fa|ur|hi|sw|afrique|mundo|portuguese|arabic|persian|russian|turkce|ukrainian|vietnamese|hindi|urdu|bengali|chinese|espanol|french)(?:[/_.-]|$)/i;
const URL_EXCLUDE_2 = /sponsored|brand-?studio|creativegroup|paid-?post|partner-?content|\/shopping\/|buyside|underscored|coupons?|\/\/cooking\.|\/recipes?\/|wirecutter|\/crosswords?\/|\/puzzles?\/|\/games\//i;
const URL_EXCLUDE = /\/(tags?|authors?|category|categories|topics?|section|people|person|series|videos?|watch|galler(y|ies)|photos?|slideshows?|podcasts?|newsletters?|search|events|contributors?|staff|about|contact|privacy|terms|subscribe|shop|deals|coupons?|horoscopes?|weather|obituaries|crossword|games|puzzles)(\/|$)/i;

function parseSitemap(xml) {
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const kids = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)].map((m) => {
      const loc = m[1].match(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i)?.[1];
      return loc && decodeEntities(loc.trim());
    }).filter(Boolean);
    return { index: true, children: kids };
  }
  const entries = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const b = m[1];
    const loc = b.match(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i)?.[1];
    if (!loc) continue;
    const pick = (tag) => {
      const x = b.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i'))?.[1];
      return x ? decodeEntities(x.trim()) : null;
    };
    entries.push({ loc: decodeEntities(loc.trim()), lastmod: pick('lastmod'), pub: pick('news:publication_date'), title: pick('news:title') });
  }
  return { index: false, entries };
}

// ───────────────────────── crawler ─────────────────────────
export class Backfill {
  constructor({ archive, getSources, log = console.log }) {
    this.archive = archive;
    this.getSources = getSources;
    this.log = log;
    const saved = archive.kv('backfill') || {};
    this.running = saved.running ?? false;            // a new server starts paused: onboarding decides
    this.since = saved.since ?? Date.UTC(2000, 0, 1);
    this.active = new Map();         // sourceId:kind -> description of current work
    this.lastError = new Map();
    this.loops = null;
  }

  persist() { this.archive.kv('backfill', { running: this.running, since: this.since }); }

  start(since) {
    if (since != null && Number.isFinite(since)) this.since = since;
    this.running = true;
    this.persist();
    // each loop is independent; an unexpected error is logged and never takes the server down
    const guard = (name, fn) => fn().catch((e) => this.log(`[backfill] ${name} loop stopped: ${e.message}`));
    if (!this.loops) this.loops = Promise.all([guard('sitemap', () => this.sitemapLoop()), guard('wayback', () => this.waybackLoop()), guard('hn', () => this.hnLoop())]).finally(() => { this.loops = null; });
  }

  pause() { this.running = false; this.persist(); }

  status() {
    return {
      running: this.running, since: this.since,
      active: [...this.active.entries()].map(([k, v]) => ({ key: k, ...v })),
      errors: Object.fromEntries(this.lastError),
    };
  }

  enabledSources() { return this.getSources().filter((s) => s.enabled); }

  // ── sitemaps ──
  async discoverSitemaps(s) {
    const h = hintsFor(s.id);
    const origin = new URL(s.site).origin;
    const roots = new Set(h.seeds || []);
    const robots = await fetchRaw(origin + '/robots.txt', { timeout: 15000 });
    for (const m of (robots.text || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.add(m[1]);
    if (!roots.size) { roots.add(origin + '/sitemap.xml'); roots.add(origin + '/sitemap_index.xml'); }
    const rows = [];
    for (const url of roots) {
      const p = inferPeriod(url);
      if (p && p.end < this.since) continue;
      rows.push({ url, sourceId: s.id, kind: 'sitemap', period: p?.start ?? null, level: 0 });
    }
    this.archive.addFiles(rows);
    this.archive.kv(`discovered:sitemap:${s.id}`, Date.now());
  }

  childAllowed(s, url) {
    const h = hintsFor(s.id);
    if (h.sitemapInclude && !h.sitemapInclude.test(url)) return false;
    if (h.sitemapExclude && h.sitemapExclude.test(url)) return false;
    let path = url;
    try { path = new URL(url).pathname + new URL(url).search; } catch {}
    if (CHILD_EXCLUDE.test(path) && !/post|article|news|story|content|entries/i.test(path)) return false;
    if (CHILD_LANG.test(path)) return false;
    return true;
  }

  async processSitemapFile(s, f) {
    const r = await fetchRaw(f.url);
    if (r.status !== 200) {
      if (r.status === 0 || r.status === 429 || r.status >= 500) this.archive.retryFile(f.url);
      else this.archive.finishFile(f.url, 'error', 0);
      this.lastError.set(s.id, `${r.status || r.error} ${f.url.slice(0, 120)}`);
      return;
    }
    const parsed = parseSitemap(r.text);
    if (parsed.index) {
      const kids = [];
      for (const c of parsed.children) {
        if (!this.childAllowed(s, c)) continue;
        const p = inferPeriod(c);
        if (p && p.end < this.since) continue;
        if (p && p.start > Date.now() + DAY) continue;
        const articleish = /post|article|news|story|stories|content|entries|archive|sitemap[-_]?\d|\d{4}/i.test(c);
        kids.push({ url: c, sourceId: s.id, kind: 'sitemap', period: p?.start ?? null, level: f.level + (articleish ? 1 : 3) });
      }
      this.archive.addFiles(kids);
      this.archive.finishFile(f.url, 'done', kids.length);
      return;
    }
    const h = hintsFor(s.id);
    const period = inferPeriod(f.url);
    const site = new URL(s.site);
    const baseDomain = site.hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    const items = [];
    for (const e of parsed.entries) {
      let link = e.loc;
      try {
        const u = new URL(link);
        if (!u.hostname.endsWith(baseDomain)) { u.protocol = site.protocol; u.host = site.host; link = u.href; }
      } catch { continue; }
      if (URL_EXCLUDE.test(link) || URL_EXCLUDE_2.test(link) || (h.urlExclude && h.urlExclude.test(link))) continue;
      let date = e.pub ? Date.parse(e.pub) : NaN;
      if (!Number.isFinite(date)) date = urlDate(link) ?? NaN;
      if (!Number.isFinite(date)) {
        const lm = e.lastmod ? Date.parse(e.lastmod) : NaN;
        if (period && period.end - period.start <= 32 * DAY) {
          // date-partitioned file: trust lastmod only when it falls inside the file's own period
          date = Number.isFinite(lm) && lm >= period.start - 2 * DAY && lm <= period.end + 2 * DAY ? lm : period.start + 12 * 3600e3;
        } else date = lm;
      }
      if (!Number.isFinite(date) || date < this.since || date > Date.now() + DAY) continue;
      const title = e.title || slugTitle(link);
      if (!title) continue;
      items.push({ link, sourceId: s.id, title, summary: '', image: null, date, quality: e.title ? 2 : 1, origin: 'sitemap' });
    }
    // insert in small transactions, yielding in between, so a 50k-URL sitemap never stalls the web server
    let n = 0;
    for (let k = 0; k < items.length; k += CHUNK) {
      n += this.archive.insertMany(items.slice(k, k + CHUNK));
      await yieldLoop();
    }
    this.archive.finishFile(f.url, 'done', items.length);
    return n;
  }

  async crawlSitemapsFor(s) {
    if (hintsFor(s.id).sitemap === false) return;
    const last = this.archive.kv(`discovered:sitemap:${s.id}`);
    if (!last || Date.now() - last > 7 * DAY) await this.discoverSitemaps(s);
    let f;
    while (this.running && (f = this.archive.nextFile('sitemap', s.id))) {
      if (f.level > 6) { this.archive.finishFile(f.url, 'skip', 0); continue; }
      this.active.set(`${s.id}:sitemap`, { source: s.id, kind: 'sitemap', file: f.url, since: Date.now() });
      try { await this.processSitemapFile(s, f); }
      catch (e) { this.lastError.set(s.id, e.message); try { this.archive.finishFile(f.url, 'error', 0); } catch {} }
      await sleep(SITEMAP_DELAY);
    }
    this.active.delete(`${s.id}:sitemap`);
  }

  async sitemapLoop() {
    while (this.running) {
      const queue = this.enabledSources().filter((s) => hintsFor(s.id).sitemap !== false);
      await Promise.all(Array.from({ length: SITEMAP_WORKERS }, async () => {
        while (this.running && queue.length) {
          const s = queue.shift();
          await this.crawlSitemapsFor(s).catch((e) => { this.lastError.set(s.id, e.message); this.log(`[backfill] sitemap ${s.id}: ${e.message}`); });
        }
      }));
      for (let i = 0; i < 360 && this.running; i++) await sleep(10e3);   // re-check every hour
    }
  }

  // ── wayback machine feed snapshots ──
  async discoverWayback(s) {
    const feeds = [s.feed, ...(hintsFor(s.id).legacyFeeds || [])];
    const rows = [];
    const fromYear = new Date(this.since).getUTCFullYear();
    for (const feed of feeds) {
      const q = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(feed)}&output=json&fl=timestamp,original&filter=statuscode:200&collapse=timestamp:8&from=${fromYear}`;
      let r;
      for (let a = 0; a < 4; a++) {
        r = await fetchRaw(q, { timeout: 90000, ua: 'stringer-archive/1.0' });
        if (r.status === 200) break;
        await sleep(10000 * (a + 1));
      }
      if (r.status !== 200) { this.lastError.set(s.id, `wayback cdx ${r.status || r.error}`); continue; }
      let list = [];
      try { list = JSON.parse(r.text).slice(1); } catch {}
      const seenMonth = new Set(), seenWeek = new Set();
      for (const [ts, original] of list) {
        const t = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8));
        const mk = ts.slice(0, 6), wk = Math.floor(t / (7 * DAY));
        const level = !seenMonth.has(mk) ? 0 : !seenWeek.has(wk) ? 1 : 2;
        seenMonth.add(mk); seenWeek.add(wk);
        rows.push({ url: `wb:${ts}:${original}`, sourceId: s.id, kind: 'wayback', period: t, level });
      }
      await sleep(WAYBACK_DELAY);
    }
    this.archive.addFiles(rows);
    this.archive.kv(`discovered:wayback:${s.id}`, Date.now());
    return rows.length;
  }

  async processWaybackFile(s, f) {
    const [, ts, ...rest] = f.url.split(':');
    const original = rest.join(':');
    const r = await fetchRaw(`https://web.archive.org/web/${ts}id_/${original}`, { timeout: 60000, ua: 'stringer-archive/1.0' });
    if (r.status === 429 || r.status === 503) { this.archive.retryFile(f.url); return 'throttled'; }
    if (r.status !== 200) { if (r.status === 0) this.archive.retryFile(f.url); else this.archive.finishFile(f.url, 'error', 0); return; }
    let feed;
    try { feed = parseFeed(r.text); } catch { feed = { items: [] }; }
    const snap = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10) || 0, +ts.slice(10, 12) || 0);
    const items = feed.items
      .map((it) => ({ link: it.link, sourceId: s.id, title: it.title, summary: it.summary, image: it.image,
        date: it.date && it.date <= snap + DAY ? it.date : snap, quality: 2, origin: 'wayback' }))
      .filter((it) => it.date >= this.since);
    this.archive.insertMany(items);
    this.archive.finishFile(f.url, 'done', items.length);
  }

  async waybackLoop() {
    let backoff = 0;
    while (this.running) {
      const sources = this.enabledSources().filter((s) => hintsFor(s.id).wayback !== false);
      let didWork = false;
      for (const s of sources) {
        if (!this.running) break;
        const last = this.archive.kv(`discovered:wayback:${s.id}`);
        if (!last || Date.now() - last > 30 * DAY) {
          this.active.set('wayback', { source: s.id, kind: 'wayback', file: 'listing snapshots', since: Date.now() });
          await this.discoverWayback(s).catch((e) => this.lastError.set(s.id, `wayback cdx: ${e.message}`));
          didWork = true;
        }
        // a few snapshots per source per round, so every outlet fills in evenly
        for (let k = 0; k < 3 && this.running; k++) {
          let f;
          try { f = this.archive.nextFile('wayback', s.id); } catch (e) { this.log(`[backfill] ${e.message}`); await sleep(5000); break; }
          if (!f) break;
          didWork = true;
          this.active.set('wayback', { source: s.id, kind: 'wayback', file: f.url.slice(3, 17), since: Date.now() });
          const res = await this.processWaybackFile(s, f).catch((e) => { this.lastError.set(s.id, e.message); try { this.archive.finishFile(f.url, 'error', 0); } catch {} });
          if (res === 'throttled') { backoff = Math.min(300e3, (backoff || 15e3) * 2); this.log(`[backfill] archive.org throttling — pausing ${backoff / 1000}s`); await sleep(backoff); }
          else backoff = 0;
          await sleep(WAYBACK_DELAY);
        }
      }
      this.active.delete('wayback');
      if (!didWork) for (let i = 0; i < 360 && this.running; i++) await sleep(10e3);
    }
  }

  // ── hacker news ──
  async hnLoop() {
    const s = this.enabledSources().find((x) => hintsFor(x.id).hn);
    if (!s) return;
    if (!this.archive.kv('discovered:hn')) {
      const rows = [];
      const start = new Date(Math.max(this.since, Date.UTC(2007, 1, 1)));
      for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); Date.UTC(y, m) < Date.now(); m++) {
        if (m > 11) { m = 0; y++; }
        rows.push({ url: `hn:${y}-${String(m + 1).padStart(2, '0')}`, sourceId: s.id, kind: 'hn', period: Date.UTC(y, m), level: 0 });
      }
      this.archive.addFiles(rows);
      this.archive.kv('discovered:hn', Date.now());
    }
    let f;
    while (this.running && (f = this.archive.nextFile('hn', s.id))) {
      this.active.set('hn', { source: s.id, kind: 'hn', file: f.url, since: Date.now() });
      const [y, m] = f.url.slice(3).split('-').map(Number);
      const items = [];
      // split the month into 4 windows to stay under Algolia's 1000-hit cap
      for (let q = 0; q < 4; q++) {
        const a = Date.UTC(y, m - 1) + q * ((Date.UTC(y, m) - Date.UTC(y, m - 1)) / 4);
        const b = Date.UTC(y, m - 1) + (q + 1) * ((Date.UTC(y, m) - Date.UTC(y, m - 1)) / 4);
        const r = await fetchRaw(`https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=1000&numericFilters=points%3E%3D100,created_at_i%3E%3D${Math.floor(a / 1000)},created_at_i%3C${Math.floor(b / 1000)}`, { ua: 'stringer-archive/1.0' });
        if (r.status !== 200) continue;
        for (const h of JSON.parse(r.text).hits || []) {
          items.push({ link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, sourceId: s.id, title: h.title,
            summary: `${h.points} points · ${h.num_comments ?? 0} comments`, image: null, date: h.created_at_i * 1000, quality: 2, origin: 'hn' });
        }
        await sleep(400);
      }
      try { this.archive.insertMany(items); this.archive.finishFile(f.url, 'done', items.length); }
      catch (e) { this.log(`[backfill] hn: ${e.message}`); await sleep(5000); }
    }
    this.active.delete('hn');
  }
}

// exported for the discovery dry-run / tests
export const _internal = { fetchRaw, parseSitemap, urlDate };
