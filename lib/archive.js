// Local historical archive: every article we ever see (live feeds, Wayback feed snapshots, sitemaps)
// in SQLite with an FTS5 full-text index. Uses Node's built-in node:sqlite — no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { declutter } from './reader.js';
import { randomBytes } from 'node:crypto';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 15000;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
CREATE TABLE IF NOT EXISTS articles (
  id        INTEGER PRIMARY KEY,
  url       TEXT NOT NULL UNIQUE,      -- normalized key (host without www + path, lowercase)
  link      TEXT NOT NULL,             -- original link
  source_id TEXT NOT NULL,
  title     TEXT NOT NULL,
  summary   TEXT NOT NULL DEFAULT '',
  image     TEXT,
  published INTEGER NOT NULL,          -- ms epoch
  quality   INTEGER NOT NULL,          -- 1 = headline rebuilt from URL slug, 2 = real headline
  origin    TEXT NOT NULL              -- live | wayback | sitemap | hn
);
CREATE INDEX IF NOT EXISTS ix_pub ON articles(published);
CREATE INDEX IF NOT EXISTS ix_src_pub ON articles(source_id, published);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  title, summary, content='articles', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO fts(fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE OF title, summary ON articles BEGIN
  INSERT INTO fts(fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
  INSERT INTO fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;
-- crawl bookkeeping (resumable backfill)
CREATE TABLE IF NOT EXISTS crawl_files (
  url       TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  kind      TEXT NOT NULL,             -- sitemap | wayback | hn
  period    INTEGER,                   -- ms epoch the file covers (null = unknown)
  level     INTEGER NOT NULL DEFAULT 0,-- crawl priority tier (0 first)
  status    TEXT NOT NULL DEFAULT 'pending', -- pending | done | error | skip
  items     INTEGER,
  tries     INTEGER NOT NULL DEFAULT 0,
  updated   INTEGER
);
CREATE INDEX IF NOT EXISTS ix_cf_pending ON crawl_files(kind, status, source_id, level, period);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
-- full article text harvested from the live feeds (the reader-view extraction), one row per article
CREATE TABLE IF NOT EXISTS bodies (
  id      INTEGER PRIMARY KEY,         -- = articles.id
  status  TEXT NOT NULL,               -- ok | partial (paywall fragment) | blocked (401/403/404) | failed
  text    TEXT NOT NULL DEFAULT '',    -- plain text, for search
  html    BLOB,                        -- gzipped, sanitized reader HTML
  meta    TEXT,                        -- reader metadata JSON (title, site, image, excerpt, published, url)
  byline  TEXT,
  words   INTEGER NOT NULL DEFAULT 0,
  reason  TEXT,
  fetched INTEGER NOT NULL,            -- ms epoch
  tries   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_bodies_fetched ON bodies(fetched);
CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(
  text, content='bodies', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS bodies_ai AFTER INSERT ON bodies BEGIN
  INSERT INTO body_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS bodies_ad AFTER DELETE ON bodies BEGIN
  INSERT INTO body_fts(body_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS bodies_au AFTER UPDATE OF text ON bodies BEGIN
  INSERT INTO body_fts(body_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO body_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

export function normalizeUrl(link) {
  try {
    const u = new URL(link);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '').toLowerCase();
    // keep the query only when the path alone doesn't identify the page
    const keepQuery = !path || path === '/' || /\.(php|aspx?|cfm)$/.test(path) || /^\/(article|story|news)$/.test(path);
    const q = keepQuery ? [...u.searchParams].filter(([k]) => !/^(utm_|cmp|ref|src|ftag|fbclid|gclid|mod)/i.test(k)).map(([k, v]) => `${k}=${v}`).join('&') : '';
    return host + (path || '/') + (q ? '?' + q : '');
  } catch { return link; }
}

// full text attached to an article object without putting it on the object (so it never reaches JSON)
export const BODY = new WeakMap();

const codePoint = (n) => { try { return String.fromCodePoint(n); } catch { return ''; } };
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function htmlToText(html) {
  return html.replace(/<\/(p|h\d|li|blockquote|pre|figcaption|tr)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => ENT[e.toLowerCase()] ?? (e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : m))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

const DENSE_FTS = 5000;            // a full-text term matching more headlines than this is "common" (see _from)
const newMorgueNo = () => randomBytes(4).toString('hex');      // morgue no.: 8 hex characters

export class Archive {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.migrateMorgue();
    this.st = {
      upsert: this.db.prepare(`
        INSERT INTO articles (url, link, source_id, title, summary, image, published, quality, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          title     = CASE WHEN excluded.quality > articles.quality THEN excluded.title ELSE articles.title END,
          summary   = CASE WHEN excluded.summary <> '' AND (articles.summary = '' OR excluded.quality > articles.quality) THEN excluded.summary ELSE articles.summary END,
          image     = COALESCE(articles.image, excluded.image),
          published = CASE WHEN excluded.quality > articles.quality THEN excluded.published ELSE articles.published END,
          origin    = CASE WHEN excluded.quality > articles.quality THEN excluded.origin ELSE articles.origin END,
          quality   = MAX(articles.quality, excluded.quality)
        WHERE excluded.quality > articles.quality OR (articles.summary = '' AND excluded.summary <> '') OR (articles.image IS NULL AND excluded.image IS NOT NULL)`),
      getKv: this.db.prepare('SELECT v FROM kv WHERE k = ?'),
      setKv: this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      byId: this.db.prepare('SELECT * FROM articles WHERE id = ?'),
      idByUrl: this.db.prepare('SELECT id, published, quality, source_id, origin FROM articles WHERE url = ?'),
      bodyByUrl: this.db.prepare('SELECT b.* FROM articles a JOIN bodies b ON b.id = a.id WHERE a.url = ?'),
      bodyState: this.db.prepare('SELECT status, tries, fetched, reason FROM bodies WHERE id = ?'),
      putBody: this.db.prepare(`
        INSERT INTO bodies (id, status, text, html, meta, byline, words, reason, fetched, tries, morgue, filed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CASE WHEN ?10 IS NULL THEN NULL ELSE ? END)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, text = excluded.text, html = excluded.html, meta = excluded.meta,
          byline = excluded.byline, words = excluded.words, reason = excluded.reason, fetched = excluded.fetched, tries = bodies.tries + 1,
          filed_by = CASE WHEN bodies.morgue IS NULL AND excluded.morgue IS NOT NULL THEN excluded.filed_by ELSE bodies.filed_by END,
          morgue = COALESCE(bodies.morgue, excluded.morgue)
        WHERE bodies.status NOT IN ('ok') OR excluded.status = 'ok'`),
      morgueOf: this.db.prepare('SELECT morgue FROM bodies WHERE id = ?'),
      byMorgue: this.db.prepare('SELECT a.link FROM bodies b JOIN articles a ON a.id = b.id WHERE b.morgue = ?'),
      retitle: this.db.prepare(`UPDATE articles SET title = ?, summary = CASE WHEN summary = '' THEN ? ELSE summary END,
        published = COALESCE(?, published), quality = 2 WHERE id = ? AND quality < 2`),
      bodiesSince: this.db.prepare(`SELECT a.url, b.text, b.byline, b.words, b.status, b.fetched, b.morgue FROM bodies b JOIN articles a ON a.id = b.id
        WHERE b.fetched > ? AND a.published > ? AND b.status IN ('ok', 'partial') ORDER BY b.fetched`),
    };
    this._stats = null;
    this._statsAt = 0;
  }

  // items: [{ link, sourceId, title, summary, image, date, quality, origin }]
  insertMany(items) {
    if (!items.length) return 0;
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const it of items) {
        if (!it.link || !it.title || !Number.isFinite(it.date)) continue;
        const r = this.st.upsert.run(normalizeUrl(it.link), it.link, it.sourceId, it.title.slice(0, 500),
          (it.summary || '').slice(0, 1000), it.image || null, Math.round(it.date), it.quality, it.origin);
        n += Number(r.changes) > 0 ? 1 : 0;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this._statsAt = 0;
    return n;
  }

  // ── full text (reader extraction) ──
  articleId(link) { return this.st.idByUrl.get(normalizeUrl(link))?.id ?? null; }
  articleRow(link) { return this.st.idByUrl.get(normalizeUrl(link)) || null; }     // { id, published }
  bodyState(id) { return this.st.bodyState.get(id) || null; }

  // r: a readArticle() result, or { error } for a failed fetch. Never replaces good text with a worse result.
  // by: who's filing it (see filed_by) — credited only if this is what gives it its morgue no.
  saveBody(id, r, by = null) {
    const now = Date.now();
    // a fragment keeps its headline + summary when fetching the full text fails: only the attempt is recorded (the
    // reason says why; the harvester and the Wayback sweep read it)
    const keepFragment = (why) => this.db.prepare("UPDATE bodies SET reason = ?, fetched = ?, tries = tries + 1 WHERE id = ? AND status = 'fragment'").run(why, now, id);
    if (this.st.bodyState.get(id)?.status === 'fragment' && (r.error || (!r.ok && !htmlToText(r.content || '')))) return keepFragment(r.error || r.reason || 'no article text found on the page');
    if (r.error) {
      const status = /HTTP (401|403|404|410|451)|no longer exists/.test(r.error) ? 'blocked' : 'failed';
      return this.st.putBody.run(id, status, '', null, null, null, 0, r.error, now, null, by);
    }
    const text = htmlToText(r.content || '');
    const meta = JSON.stringify({ url: r.url, title: r.title, site: r.site, published: r.published, image: r.image, excerpt: r.excerpt, wayback: r.wayback });
    const status = r.ok ? 'ok' : text ? 'partial' : 'failed';
    const args = [id, status, text, r.content ? gzipSync(r.content) : null, meta, r.byline || null, r.words || 0, r.reason || null, now];
    if (status === 'failed') return this.st.putBody.run(...args, null, by);
    // a fresh morgue no.; on the (rare) clash with an existing one, draw again
    for (let k = 0; ; k++) {
      try { return this.st.putBody.run(...args, newMorgueNo(), by); }
      catch (e) { if (k >= 8 || !/UNIQUE constraint failed: bodies\.morgue/.test(e.message)) throw e; }
    }
  }

  // the stored reader view for a link (null when we never extracted anything usable)
  readerFor(link) {
    const b = this.st.bodyByUrl.get(normalizeUrl(link));
    if (!b || !b.html) return null;
    const m = b.meta ? JSON.parse(b.meta) : {};
    return { ...m, byline: b.byline || '', words: b.words, content: declutter(gunzipSync(b.html).toString('utf8')),
      ok: b.status === 'ok', reason: b.reason || undefined, archived: b.fetched, morgue: b.morgue, filedBy: b.filed_by || null };
  }
  morgueOf(id) { return this.st.morgueOf.get(id)?.morgue || null; }
  filedByOf(id) { return this.db.prepare('SELECT filed_by FROM bodies WHERE id = ?').get(id)?.filed_by || null; }
  // A morgue no. for an article that has no saved text (when it goes into someone's binder, so quotes and saved
  // articles can always cite one): filed as a 'fragment' — headline and summary only, no body text. A later full-text
  // fetch replaces the fragment and keeps the number. Articles refused earlier (blocked/failed) become fragments, keeping their history.
  // has this fragment been refused by its site (or is the page gone)? then it's left to the Wayback sweep
  static refused(reason) { return /HTTP (401|403|404|410|451)|no longer exists|refuses automated|only public web addresses/.test(reason || ''); }
  fileFragment(id, { title = '', summary = '', link = '', site = '' } = {}, by = null) {
    const have = this.db.prepare('SELECT status, morgue FROM bodies WHERE id = ?').get(id);
    if (have?.morgue) return have.morgue;
    for (let k = 0; ; k++) {
      const no = newMorgueNo();
      try {
        // tried before and refused / failed (no text): it becomes a fragment — headline + summary — keeping its history
        // (tries, reason: a refused one is the Wayback sweep's)
        if (have && (have.status === 'blocked' || have.status === 'failed')) {
          this.db.prepare("UPDATE bodies SET status = 'fragment', meta = ?, morgue = ?, filed_by = ? WHERE id = ? AND morgue IS NULL")
            .run(JSON.stringify({ url: link, title, site, excerpt: summary }), no, by, id);
        } else if (have) this.db.prepare('UPDATE bodies SET morgue = ?, filed_by = ? WHERE id = ? AND morgue IS NULL').run(no, by, id);
        else this.db.prepare(`INSERT INTO bodies (id, status, text, html, meta, byline, words, reason, fetched, tries, morgue, filed_by)
          VALUES (?, 'fragment', '', NULL, ?, NULL, 0, 'headline and summary only — the full text has not been filed', ?, 0, ?, ?)`)
          .run(id, JSON.stringify({ url: link, title, site, excerpt: summary }), Date.now(), no, by);
        return this.morgueOf(id);
      } catch (e) { if (k >= 8 || !/UNIQUE constraint failed: bodies\.morgue/.test(e.message)) throw e; }
    }
  }
  linkByMorgue(no) { return this.st.byMorgue.get(String(no).toLowerCase().slice(0, 8))?.link || null; }

  // Every article whose text STRINGER saved is filed in the morgue under a morgue no.: 8 random hex characters
  // (4.3 billion possibilities; uniqueness is enforced, a clash just draws again). Older databases had full uuids in a
  // `uuid` column: renamed, shortened to their first 8 characters (re-drawn on a clash) and indexed here, once.
  migrateMorgue() {
    this.db.exec('BEGIN IMMEDIATE');                       // the server and both workers open the db at the same time
    try {
      const cols = this.db.prepare('PRAGMA table_info(bodies)').all().map((c) => c.name);
      if (cols.includes('uuid') && !cols.includes('morgue')) {
        this.db.exec('DROP INDEX IF EXISTS ix_bodies_uuid; ALTER TABLE bodies RENAME COLUMN uuid TO morgue');
      } else if (!cols.includes('morgue')) this.db.exec('ALTER TABLE bodies ADD COLUMN morgue TEXT');
      // who filed it: 'user:<id>' (they opened it in the reader, or saved it to a binder), 'harvester' (the auto-filer),
      // 'wayback' (the auto-filer, from the Wayback Machine's copy). Set when the morgue no. is first drawn; NULL = filed
      // before this was recorded.
      if (!cols.includes('filed_by')) this.db.exec('ALTER TABLE bodies ADD COLUMN filed_by TEXT');
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ix_bodies_morgue'").get()) {
        this.db.exec("UPDATE bodies SET morgue = substr(morgue, 1, 8) WHERE length(morgue) > 8");
        const seen = new Set();
        const redo = this.db.prepare('UPDATE bodies SET morgue = ? WHERE id = ?');
        for (const r of this.db.prepare("SELECT id, morgue FROM bodies WHERE status IN ('ok', 'partial') ORDER BY id").all()) {
          let m = r.morgue;
          if (!m || seen.has(m)) { do m = newMorgueNo(); while (seen.has(m)); redo.run(m, r.id); }
          seen.add(m);
        }
        this.db.exec('CREATE UNIQUE INDEX ix_bodies_morgue ON bodies(morgue)');
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // a headline rebuilt from the URL (≈) is replaced by the real one once the article's page has been read.
  // Returns the new headline, or null when nothing changed.
  upgradeHeadline(id, r, outletName = '') {
    let t = String(r.title || '').replace(/\s+/g, ' ').trim();
    // drop the site's name from the end: "… | Fox News", "… - The Washington Post"
    for (const n of [r.site, outletName].filter(Boolean)) {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`\\s*[|\\-–—:·]\\s*(?:the\\s+)?${esc.replace(/^the\s+/i, '')}\\s*$`, 'i'), '').trim();
    }
    if (t.length < 12 || /^(404|page not found|not found|access denied|just a moment)/i.test(t)) return null;
    const pub = Date.parse(r.published || '');
    const res = this.st.retitle.run(t.slice(0, 500), String(r.excerpt || '').slice(0, 1000), Number.isFinite(pub) ? pub : null, id);
    return Number(res.changes) ? t : null;
  }

  // one-time repair after the slug fix: rebuild URL-derived headlines that picked up ID fragments ("730c 11e3 8b3f")
  // one-time: sitemap rows dated by the sitemap's lastmod although their URL says otherwise. The old URL-date parser
  // stopped at 1980, so NYT's 1851–1979 archive (≈10M pages) was filed under the dates NYT last touched those pages.
  // Resumable: progress is kept in kv, so a restart picks up where it left off.
  migrateUrlDates(urlDate, { log = () => {} } = {}) {
    const st = this.kv('migr.urldates1');
    if (st?.done) return null;
    const sel = this.db.prepare(`SELECT id, link, published FROM articles WHERE id > ? AND origin = 'sitemap'
      AND (link GLOB '*/18[5-9][0-9]/*' OR link GLOB '*/19[0-7][0-9]/*') ORDER BY id LIMIT 20000`);
    const upd = this.db.prepare('UPDATE articles SET published = ? WHERE id = ?');
    let last = st?.last || 0, scanned = st?.scanned || 0, fixed = st?.fixed || 0, t = Date.now();
    for (;;) {
      const rows = sel.all(last);
      if (!rows.length) break;
      last = rows[rows.length - 1].id;
      scanned += rows.length;
      this.db.exec('BEGIN');
      try {
        for (const r of rows) {
          const d = urlDate(r.link);
          if (d != null && Math.abs(d - r.published) > 3 * 86400e3) { upd.run(d, r.id); fixed++; }
        }
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      this.kv('migr.urldates1', { last, scanned, fixed });
      if (Date.now() - t > 60e3) { t = Date.now(); log(`[archive] re-dating archive pages from their URLs: ${fixed.toLocaleString()} fixed so far (${scanned.toLocaleString()} checked)`); }
    }
    this.kv('migr.urldates1', { done: true, at: Date.now(), scanned, fixed });
    return { scanned, fixed };
  }

  // one-time cleanup (never repeats, so changing the backfill date later can't delete anything): sitemap pages
  // dated before the backfill start date — after re-dating from URLs, NYT's 1851–1999 archive pages turned out to
  // be older than the archive goes back. Articles with a morgue copy are kept.
  pruneBefore(since, { log = () => {} } = {}) {
    const key = 'migr.prune-predates1';
    if (this.kv(key)?.done) return null;
    const sel = this.db.prepare(`SELECT a.id FROM articles a INDEXED BY ix_pub WHERE a.published < ? AND a.origin = 'sitemap'
      AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.id = a.id) LIMIT 20000`);
    const del = this.db.prepare('DELETE FROM articles WHERE id = ?');
    let deleted = this.kv(key)?.deleted || 0, t = Date.now();
    for (;;) {
      const ids = sel.all(since).map((r) => r.id);
      if (!ids.length) break;
      this.db.exec('BEGIN');
      try { for (const id of ids) del.run(id); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      deleted += ids.length;
      this.kv(key, { deleted });
      if (Date.now() - t > 60e3) { t = Date.now(); log(`[archive] removing pages older than the backfill date: ${deleted.toLocaleString()} so far`); }
    }
    this.kv(key, { done: true, at: Date.now(), deleted });
    this._statsAt = 0;
    return { deleted };
  }

  // Re-clean every stored morgue copy with the current reader cleanup (declutter): the stored page and the text the
  // body: search runs on, so promo blocks / teaser cards removed from the reader stop matching searches too.
  // Only rows that actually change are rewritten. Run with the server stopped (it rewrites the body search index).
  recleanBodies(declutter, { log = () => {} } = {}) {
    const sel = this.db.prepare('SELECT id, html, text, words FROM bodies WHERE id > ? AND html IS NOT NULL ORDER BY id LIMIT 500');
    const upd = this.db.prepare('UPDATE bodies SET html = ?, text = ?, words = ? WHERE id = ?');
    let last = 0, scanned = 0, changed = 0;
    for (;;) {
      const rows = sel.all(last);
      if (!rows.length) break;
      last = rows[rows.length - 1].id;
      this.db.exec('BEGIN');
      try {
        for (const r of rows) {
          scanned++;
          const html = gunzipSync(r.html).toString('utf8');
          const clean = declutter(html);
          if (clean === html) continue;
          const text = htmlToText(clean);
          const words = Math.round(text.replace(/\s+/g, ' ').trim().length / 5.7);
          upd.run(gzipSync(clean), text, words, r.id);
          changed++;
        }
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    log(`[archive] morgue copies re-cleaned: ${changed} of ${scanned}`);
    return { scanned, changed };
  }

  migrateSlugTitles(slugTitle) {
    if (this.kv('migr.slugtitles2')) return null;
    const sel = this.db.prepare(`SELECT id, title, link FROM articles WHERE quality = 1 AND id > ? ORDER BY id LIMIT 50000`);
    const upd = this.db.prepare('UPDATE articles SET title = ? WHERE id = ?');
    const suspect = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{4}\b|\b(?=(?:\w*\d){6})\w{8,}\b/i;
    let last = 0, scanned = 0, fixed = 0;
    for (;;) {
      const rows = sel.all(last);
      if (!rows.length) break;
      last = rows[rows.length - 1].id;
      scanned += rows.length;
      this.db.exec('BEGIN');
      try {
        for (const r of rows) {
          if (!suspect.test(r.title)) continue;
          let t = slugTitle(r.link);
          // no slug in the URL at all (…/local/2012/12/31/<uuid>_story.html): say so instead of showing ID fragments;
          // reading the article replaces it with the real headline
          if (!t) { const sec = (() => { try { return new URL(r.link).pathname.split('/').filter((x) => /^[a-z][a-z-]{2,}$/i.test(x))[0]; } catch { return null; } })(); t = `Untitled article${sec ? ` (${sec.replace(/-/g, ' ')})` : ''}`; }
          if (t !== r.title) { upd.run(t.slice(0, 500), r.id); fixed++; }
        }
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    this.kv('migr.slugtitles2', { at: Date.now(), scanned, fixed });
    return { scanned, fixed };
  }

  bodiesSince(fetchedAfter, publishedAfter = 0) { return this.st.bodiesSince.all(fetchedAfter, publishedAfter); }

  // the morgue record per normalized URL: every article with a morgue no. — with usable text, or filed as a
  // fragment (headline + summary, e.g. saved to a binder) / refused by its site
  bodyInfo(urls) {
    if (!urls.length) return [];
    return this.db.prepare(`SELECT a.url, b.words, b.morgue, b.fetched, b.status FROM articles a JOIN bodies b ON b.id = a.id
      WHERE a.url IN (${urls.map(() => '?').join(',')}) AND (b.status IN ('ok', 'partial') OR b.morgue IS NOT NULL)`).all(...urls);
  }

  bodyStats() {
    const rows = this.db.prepare(`SELECT status, COUNT(*) n, SUM(words) w FROM bodies GROUP BY status`).all();
    const out = { ok: 0, partial: 0, blocked: 0, failed: 0, fragment: 0, words: 0 };
    for (const r of rows) { out[r.status] = r.n; if (r.status === 'ok' || r.status === 'partial') out.words += r.w || 0; }
    out.lastDay = this.db.prepare(`SELECT COUNT(*) n FROM bodies WHERE fetched > ? AND status IN ('ok', 'partial')`).get(Date.now() - 864e5).n;
    out.filedBy = Object.fromEntries(this.db.prepare(`SELECT COALESCE(filed_by, '') f, COUNT(*) n FROM bodies WHERE morgue IS NOT NULL GROUP BY f`).all().map((r) => [r.f, r.n]));
    out.bySource = Object.fromEntries(this.db.prepare(`SELECT a.source_id s, SUM(b.status = 'ok') ok, SUM(b.status = 'partial') partial,
      SUM(b.status IN ('blocked', 'failed')) bad FROM bodies b JOIN articles a ON a.id = b.id GROUP BY a.source_id`).all().map((r) => [r.s, { ok: r.ok, partial: r.partial, bad: r.bad }]));
    return out;
  }

  // one-time repair: rewrite Feedsportal-wrapped links (dead redirect service) to the real article URL. If the
  // real URL is already archived (e.g. from a sitemap), keep that row, upgrading it with the better headline.
  migrateFeedLinks(unwrap) {
    if (this.kv('migr.feedlinks')) return null;
    const rows = this.db.prepare(`SELECT * FROM articles WHERE link LIKE '%/l/0L%' OR link LIKE '%/l/0M%'`).all();
    const existing = this.db.prepare('SELECT id, quality FROM articles WHERE url = ?');
    const move = this.db.prepare('UPDATE articles SET link = ?, url = ? WHERE id = ?');
    const promote = this.db.prepare('UPDATE articles SET title = ?, summary = CASE WHEN summary = \'\' THEN ? ELSE summary END, published = ?, quality = ?, origin = ? WHERE id = ?');
    const drop = this.db.prepare('DELETE FROM articles WHERE id = ?');
    const dropBody = this.db.prepare('DELETE FROM bodies WHERE id = ?');
    let moved = 0, merged = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const link = unwrap(r.link);
        if (link === r.link) continue;
        const url = normalizeUrl(link);
        const ex = existing.get(url);
        if (!ex) { move.run(link, url, r.id); moved++; continue; }
        if (ex.id === r.id) continue;
        if (r.quality > ex.quality) promote.run(r.title, r.summary, r.published, r.quality, r.origin, ex.id);
        dropBody.run(r.id);
        drop.run(r.id);
        merged++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.kv('migr.feedlinks', { at: Date.now(), moved, merged });
    return { scanned: rows.length, moved, merged };
  }

  kv(k, v) {
    if (v === undefined) { const r = this.st.getKv.get(k); return r ? JSON.parse(r.v) : undefined; }
    this.st.setKv.run(k, JSON.stringify(v));
  }

  // pre-filtered candidate fetch; the caller evaluates the full query on the result
  // shared WHERE builder for search/count
  _where({ from, to, sourceIds, sample }) {
    const where = [], args = [];
    if (from != null) { where.push('a.published >= ?'); args.push(Math.floor(from)); }
    if (to != null) { where.push('a.published < ?'); args.push(Math.ceil(to)); }
    if (sourceIds) { where.push(`a.source_id IN (${sourceIds.map(() => '?').join(',') || 'NULL'})`); args.push(...sourceIds); }
    if (sample > 1) { where.push('(a.id % ?) = 0'); args.push(sample); }     // evenly spread 1-in-k sample
    return { where, args };
  }

  // Which index drives the candidate set: the body full-text index (query needs body words — that set is
  // small), any harvested body (query needs full text but no indexable word), the headline/summary index,
  // or the date index. Returns the FROM clause (alias a = articles, b = bodies when joined) and its args.
  _from({ fts = null, bodyFts = null, needBody = false, withBody = false }) {
    const cols = withBody || bodyFts || needBody ? 'a.*, b.text AS body_text, b.byline AS body_byline, b.words AS body_words, b.morgue AS body_morgue' : 'a.*';
    if (bodyFts) return { cols, from: `body_fts CROSS JOIN bodies b ON b.id = body_fts.rowid CROSS JOIN articles a ON a.id = b.id`, cond: ['body_fts MATCH ?'], args: [bodyFts], driver: 'body' };
    if (needBody) return { cols, from: `bodies b CROSS JOIN articles a ON a.id = b.id`, cond: [`b.status IN ('ok', 'partial')`], args: [], driver: 'body' };
    const join = withBody ? ' LEFT JOIN bodies b ON b.id = a.id' : '';
    // A common word (thousands of matches): walk the date index and test each row against the word's match set —
    // the first page is there after a few hundred rows, instead of SQLite gathering and sorting every match first
    // (~100 ms vs ~370 ms for "trump" in 2016). A rare word: start from its few matches.
    if (fts && this.ftsHits(fts) > DENSE_FTS) return { cols, from: `articles a INDEXED BY ix_pub${join}`, cond: ['a.id IN (SELECT rowid FROM fts WHERE fts MATCH ?)'], args: [fts], driver: null, dense: true };
    if (fts) return { cols, from: `fts CROSS JOIN articles a ON a.id = fts.rowid${join}`, cond: ['fts MATCH ?'], args: [fts], driver: 'fts' };
    return { cols, from: `articles a${join}`, cond: [], args: [], driver: null };
  }

  // how many headlines match a full-text expression (cached: it picks the query plan, so it needn't be exact)
  ftsHits(fts) {
    const hit = this._ftsHits?.get(fts);
    if (hit && Date.now() - hit.at < 5 * 60e3) return hit.n;
    const n = this.db.prepare('SELECT COUNT(*) n FROM fts WHERE fts MATCH ?').get(fts).n;
    (this._ftsHits ??= new Map()).set(fts, { n, at: Date.now() });
    if (this._ftsHits.size > 300) this._ftsHits.delete(this._ftsHits.keys().next().value);
    return n;
  }

  // Candidate counts are cached for a couple of minutes: paging through results and the stats sidebar ask for the
  // same count again (they're shown as totals / used for estimates; the results themselves are always exact)
  count(opts) {
    const key = JSON.stringify([opts.from, opts.to, opts.sourceIds, opts.fts, opts.bodyFts, opts.needBody, opts.sample]);
    const hit = this._counts?.get(key);
    if (hit && Date.now() - hit.at < 120e3) return hit.n;
    const { where, args } = this._where(opts);
    const f = this._from({ ...opts, withBody: false });
    let n;
    // a word alone, no dates or outlets: the full-text index already knows
    if (f.dense && !where.length) n = this.ftsHits(opts.fts);
    else {
      const all = [...f.cond, ...where];
      n = this.db.prepare(`SELECT COUNT(*) n FROM ${f.from} ${all.length ? 'WHERE ' + all.join(' AND ') : ''}`).get(...f.args, ...args).n;
    }
    (this._counts ??= new Map()).set(key, { n, at: Date.now() });
    if (this._counts.size > 200) this._counts.delete(this._counts.keys().next().value);
    return n;
  }

  // stream every candidate in date order (newest first unless asc), for paging through a whole match set.
  // With full-text terms the matches are collected and sorted by SQLite in one go; without, walk the date
  // index in keyset chunks — an unbounded ORDER BY makes the planner sort millions of rows up front.
  *iterate({ from = null, to = null, sourceIds = null, fts = null, bodyFts = null, needBody = false, withBody = false, asc = false, chunk = 2000 }) {
    if (sourceIds && !sourceIds.length) return;
    const dir = asc ? 'ASC' : 'DESC';
    const f = this._from({ fts, bodyFts, needBody, withBody });
    const { where, args } = this._where({ from, to, sourceIds });
    if (f.driver) {
      const all = [...f.cond, ...where];
      yield* this.db.prepare(`SELECT ${f.cols} FROM ${f.from} WHERE ${all.join(' AND ')} ORDER BY a.published ${dir}, a.id ${dir}`).iterate(...f.args, ...args);
      return;
    }
    if (f.dense) {
      // one streaming statement: the date index is already in (published, id) order, so nothing is sorted
      const all = [...f.cond, ...where];
      yield* this.db.prepare(`SELECT ${f.cols} FROM ${f.from} WHERE ${all.join(' AND ')} ORDER BY a.published ${dir}, a.id ${dir}`).iterate(...f.args, ...args);
      return;
    }
    const cmp = asc ? '>' : '<';
    const base = `SELECT ${f.cols} FROM articles a INDEXED BY ix_pub${withBody ? ' LEFT JOIN bodies b ON b.id = a.id' : ''} WHERE ${where.length ? where.join(' AND ') + ' AND ' : ''}`;
    const firstQ = this.db.prepare(`${base} 1 ORDER BY a.published ${dir}, a.id ${dir} LIMIT ?`);
    const nextQ = this.db.prepare(`${base} (a.published ${cmp} ? OR (a.published = ? AND a.id ${cmp} ?)) ORDER BY a.published ${dir}, a.id ${dir} LIMIT ?`);
    let rows = firstQ.all(...args, chunk);
    while (rows.length) {
      yield* rows;
      if (rows.length < chunk) return;
      const last = rows[rows.length - 1];
      rows = nextQ.all(...args, last.published, last.published, last.id, chunk);
    }
  }

  search({ from = null, to = null, sourceIds = null, fts = null, bodyFts = null, needBody = false, withBody = false, limit = 4000, sample = 0 }) {
    if (sample > 1 || bodyFts || needBody || withBody) {
      const { where, args } = this._where({ from, to, sourceIds, sample });
      const f = this._from({ fts, bodyFts, needBody, withBody });
      const all = [...f.cond, ...where];
      const rows = this.db.prepare(`SELECT ${f.cols} FROM ${f.from} ${all.length ? 'WHERE ' + all.join(' AND ') : ''} LIMIT ?`).all(...f.args, ...args, limit);
      return { rows, capped: false };
    }
    const where = [];
    const args = [];
    if (from != null) { where.push('a.published >= ?'); args.push(Math.floor(from)); }
    if (to != null) { where.push('a.published < ?'); args.push(Math.ceil(to)); }
    if (sourceIds) {
      if (!sourceIds.length) return { rows: [], capped: false };
      where.push(`a.source_id IN (${sourceIds.map(() => '?').join(',')})`);
      args.push(...sourceIds);
    }
    let sql;
    if (fts) {
      // CROSS JOIN pins the plan to "full-text index first": otherwise SQLite may walk the outlet/date
      // index and evaluate MATCH per row, which is ~300× slower (33 s vs 120 ms on 3.7M rows)
      sql = `SELECT a.* FROM fts CROSS JOIN articles a ON a.id = fts.rowid WHERE fts MATCH ? ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY a.published DESC LIMIT ?`;
      args.unshift(fts);
    } else {
      sql = `SELECT a.* FROM articles a ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.published DESC LIMIT ?`;
    }
    args.push(limit + 1);
    const rows = this.db.prepare(sql).all(...args);
    const capped = rows.length > limit;
    return { rows: capped ? rows.slice(0, limit) : rows, capped };
  }

  // articles by normalized URL (comment queries: only the articles that have a discussion are candidates)
  rowsByUrls(urls, { from = null, to = null, sourceIds = null } = {}) {
    const out = [];
    for (let i = 0; i < urls.length; i += 500) {
      const part = urls.slice(i, i + 500);
      out.push(...this.db.prepare(`SELECT * FROM articles WHERE url IN (${part.map(() => '?').join(',')})`).all(...part));
    }
    const ids = sourceIds && new Set(sourceIds);
    return out.filter((r) => (from == null || r.published >= from) && (to == null || r.published < to) && (!ids || ids.has(r.source_id)));
  }

  // real-headline articles published since t (for seeding the live window)
  recentReal(t) {
    return this.db.prepare(`SELECT link, source_id, title, summary, image, published FROM articles INDEXED BY ix_pub
      WHERE published >= ? AND quality = 2 ORDER BY published`).all(Math.floor(t));
  }

  // other archived headlines published within ±days of article `id` that share its distinctive words — an
  // on-demand stand-in for story grouping, which the archive doesn't do. tokenize: lib/cluster.js tokenizer.
  related(id, tokenize, { days = 2, limit = 24 } = {}) {
    const a = this.st.byId.get(id);
    if (!a) return null;
    const mine = [...new Set(tokenize(a.title))];
    if (!mine.length) return { article: a, tokens: [], related: [], scanned: 0 };
    const rows = this.db.prepare(`SELECT * FROM articles INDEXED BY ix_pub WHERE published BETWEEN ? AND ? LIMIT 120000`)
      .all(a.published - days * 864e5, a.published + days * 864e5);
    const toks = rows.map((r) => (r.id === id ? null : new Set(tokenize(r.title))));
    const df = new Map();
    for (const t of toks) if (t) for (const w of mine) if (t.has(w)) df.set(w, (df.get(w) || 0) + 1);
    const N = rows.length;
    const idf = (w) => Math.log((N + 1) / ((df.get(w) || 0) + 1));
    const minScore = 0.45 * mine.reduce((x, w) => x + idf(w), 0) / Math.max(1, Math.min(mine.length, 4)) * 2;  // ≈ two typical words
    const hits = [];
    rows.forEach((r, i) => {
      const t = toks[i];
      if (!t || r.link === a.link) return;
      const shared = mine.filter((w) => t.has(w));
      if (shared.length < 2) return;
      const score = shared.reduce((x, w) => x + idf(w), 0);
      if (score >= minScore) hits.push({ r, shared, score });
    });
    hits.sort((x, y) => y.score - x.score || Math.abs(x.r.published - a.published) - Math.abs(y.r.published - a.published));
    // the best match per outlet first, then the rest
    const seen = new Set(), first = [], rest = [];
    for (const h of hits) (seen.has(h.r.source_id) ? rest : (seen.add(h.r.source_id), first)).push(h);
    const top = [...first, ...rest].slice(0, limit);
    const key = mine.filter((w) => df.get(w)).sort((x, y) => idf(y) - idf(x)).slice(0, 6);
    return { article: a, tokens: key, scanned: N, matches: hits.length,
      related: top.map((h) => ({ ...Archive.toArticle(h.r), shared: h.shared, score: +h.score.toFixed(2) })) };
  }

  // disk use: the database file (+ its write-ahead log), and how much of it is the morgue (bodies + their search
  // index; a page count from dbstat — cheap for these tables). Cached 5 minutes.
  diskUsage() {
    if (this._du && Date.now() - this._du.at < 300000) return this._du;
    const file = this.db.prepare('PRAGMA database_list').get().file;
    const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
    const total = size(file) + size(file + '-wal');
    let morgue = null;
    try { morgue = this.db.prepare("SELECT SUM(pgsize) b FROM dbstat WHERE name IN ('bodies','body_fts_data','body_fts_idx','body_fts_docsize','body_fts_config')").get().b || 0; } catch {}
    let free = null, disk = null;
    try { const s = fs.statfsSync(path.dirname(file)); free = s.bavail * s.bsize; disk = s.blocks * s.bsize; } catch {}
    return (this._du = { at: Date.now(), total, morgue, free, disk });
  }
  approxTotal() { return this.db.prepare('SELECT MAX(id) n FROM articles').get().n || 0; }

  static toArticle(r) {
    const a = {
      id: 'a' + r.id, title: r.title, link: r.link, summary: r.summary, image: r.image,
      date: r.published, sourceId: r.source_id, approx: r.quality < 2, archived: true, origin: r.origin,
    };
    if (r.body_text !== undefined) BODY.set(a, { text: r.body_text || '', byline: r.body_byline || '', words: r.body_words || 0, morgue: r.body_morgue || '' });
    return a;
  }

  stats() {
    if (this._stats && Date.now() - this._statsAt < 30e3) return this._stats;
    const per = this.db.prepare(`SELECT source_id, COUNT(*) n, MIN(published) first, MAX(published) last,
      SUM(quality = 2) real FROM articles GROUP BY source_id`).all();
    const files = this.db.prepare(`SELECT source_id, kind, status, COUNT(*) n, SUM(items) items FROM crawl_files GROUP BY source_id, kind, status`).all();
    const bySrc = {};
    for (const p of per) bySrc[p.source_id] = { count: p.n, first: p.first, last: p.last, real: p.real, files: {} };
    for (const f of files) {
      const s = (bySrc[f.source_id] ??= { count: 0, first: null, last: null, real: 0, files: {} });
      const k = (s.files[f.kind] ??= { pending: 0, done: 0, error: 0, skip: 0 });
      k[f.status] = f.n;
    }
    const total = per.reduce((t, p) => t + p.n, 0);
    this._stats = { total, sources: bySrc };
    this._statsAt = Date.now();
    return this._stats;
  }

  // crawl bookkeeping
  addFiles(rows) {
    const st = this.db.prepare('INSERT OR IGNORE INTO crawl_files (url, source_id, kind, period, level) VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try { for (const r of rows) st.run(r.url, r.sourceId, r.kind, r.period ?? null, r.level ?? 0); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this._statsAt = 0;
  }
  nextFile(kind, sourceId) {
    return this.db.prepare(`SELECT * FROM crawl_files WHERE kind = ? AND source_id = ? AND status = 'pending'
      ORDER BY level, period IS NULL, period DESC LIMIT 1`).get(kind, sourceId);
  }
  finishFile(url, status, items = null) {
    this.db.prepare('UPDATE crawl_files SET status = ?, items = ?, tries = tries + 1, updated = ? WHERE url = ?').run(status, items, Date.now(), url);
    this._statsAt = 0;
  }
  retryFile(url) {
    this.db.prepare(`UPDATE crawl_files SET tries = tries + 1, updated = ?, status = CASE WHEN tries >= 2 THEN 'error' ELSE 'pending' END, level = level + 1 WHERE url = ?`).run(Date.now(), url);
  }
  pendingCount(kind, sourceId) {
    return this.db.prepare(`SELECT COUNT(*) n FROM crawl_files WHERE kind = ? AND source_id = ? AND status = 'pending'`).get(kind, sourceId).n;
  }
  resetSource(sourceId) {
    this.db.prepare(`DELETE FROM crawl_files WHERE source_id = ?`).run(sourceId);
  }
}
