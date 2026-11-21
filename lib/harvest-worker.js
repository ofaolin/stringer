// Full-text harvester (the auto-filer). The morgue has three modes: auto — every article that shows up in the live
// feeds is filed; ad-hoc and manual — only what people file (opening an article in the reader, in ad-hoc; saving it to
// a binder or "File in the morgue", in both), which comes here as priority jobs; fragment — nothing is fetched (filings
// are headline + summary only). Either way it fetches the page, runs the reader-view
// extraction on it (lib/reader.js) and stores the text in the archive (bodies + body_fts), so queries can
// search what articles actually say — and the reader keeps working after a page is paywalled or deleted.
// Runs in its own worker thread (HTML parsing is CPU work) with its own SQLite connection.
//
// Politeness: a few pages at a time overall, one at a time per site with a gap between requests, and a
// site that keeps refusing us (401/403) is left alone for a while. Blocked pages are never retried at the site.
//
// Wayback fallback: some sites refuse every automated request. Their articles (and any page that's gone) are filed
// from the Wayback Machine's copy instead, once it has one. archive.org captures news pages a day to a few days after
// they're published, so a sweep looks for blocked articles from the last 30 days 1, 2, 4 and 7 days after the last
// attempt (about two weeks in all). archive.org gets one article at a time (up to 3 requests), 10s apart; when it's
// unavailable (5xx / timeouts) lookups wait 3 min, when it asks us to slow down (429) an hour — neither counts
// against the article.
import { parentPort, workerData, isMainThread, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Archive } from './archive.js';
import { readArticle, readWayback } from './reader.js';

const CONCURRENCY = 4;
const HOST_GAP_MS = 2500;             // between two requests to the same site
const HOST_COOLDOWN_MS = 6 * 3600e3;  // after repeated refusals
const MAX_TRIES = 3;                  // network errors / timeouts / 5xx
const RETRY_AFTER_MS = 2 * 3600e3;
const WAYBACK_HOST = 'web.archive.org';
const WAYBACK_GAP_MS = 10e3;          // between two Wayback lookups
const WAYBACK_WAIT_MS = [0, 1, 2, 4, 7].map((d) => d * 864e5);   // by attempts so far (tries): how long after the last
const WAYBACK_DAYS = 30;              // only articles published this recently
const WAYBACK_SWEEP_MS = 30 * 60e3;

if (!isMainThread && workerData?.role === 'harvest') {
  const archive = new Archive(workerData.dbFile);
  const log = (msg) => parentPort.postMessage({ type: 'log', msg });
  const queue = new Map();              // link -> { link, sourceId }   (insertion order = priority)
  const busyHosts = new Set();
  const hostNext = new Map();           // host -> earliest next request (ms)
  const refusals = new Map();           // host -> consecutive refusals
  const coolUntil = new Map();          // host -> ms
  let running = true, active = 0;
  const MODES = ['auto', 'adhoc', 'manual', 'fragment'];
  let mode = MODES.includes(workerData.mode) ? workerData.mode : 'auto';
  let fragmentAll = !!workerData.fragmentAll;                 // file every incoming headline + summary as a fragment
  const counts = { ok: 0, partial: 0, blocked: 0, failed: 0, wayback: 0 };
  const recent = [];                    // last few results, for the status panel

  const hostOf = (link) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } };

  // is this article still worth fetching?
  const wanted = (id) => {
    const st = archive.bodyState(id);
    if (!st) return true;
    if (st.status === 'fragment') {                           // filed without text: worth fetching — unless the site refused
      if (!st.tries) return true;                             // (refused fragments are the Wayback sweep's)
      return !Archive.refused(st.reason) && st.tries < MAX_TRIES && Date.now() - st.fetched > RETRY_AFTER_MS;
    }
    if (st.status !== 'failed') return false;                 // ok / partial / blocked are final
    return st.tries < MAX_TRIES && Date.now() - st.fetched > RETRY_AFTER_MS;
  };

  // every incoming headline + summary filed as a fragment (any mode, when that's on): a morgue no. for each, so the
  // morgue keeps good headlines and summaries even for articles whose text is never fetched
  function fragmentItems(items) {
    if (!fragmentAll || !items.length) return 0;
    let n = 0;
    archive.db.exec('BEGIN');
    try {
      for (const it of items) {
        const id = it.id ?? archive.articleId(it.link);
        if (id == null || archive.morgueOf(id)) continue;      // (already filed; a refused / failed one becomes a fragment)
        const row = archive.st.byId.get(id);
        if (!row) continue;
        archive.fileFragment(id, { title: row.title, summary: row.summary || '', link: row.link, site: it.site || '' }, 'harvester');
        n++;
      }
      archive.db.exec('COMMIT');
    } catch (e) { try { archive.db.exec('ROLLBACK'); } catch {} log(`[harvest] filing fragments failed: ${e.message}`); return 0; }
    return n;
  }
  function backlogFragments() {
    if (!fragmentAll) return;
    try {
      const since = Date.now() - workerData.backlogDays * 864e5;
      const rows = archive.db.prepare(`SELECT a.id, a.link FROM articles a INDEXED BY ix_pub LEFT JOIN bodies b ON b.id = a.id
        WHERE a.published >= ? AND a.origin = 'live' AND (b.id IS NULL OR b.morgue IS NULL)`).all(since);
      const n = fragmentItems(rows);
      if (n) log(`[harvest] filed ${n} recent headlines as fragments`);
    } catch (e) { log(`[harvest] fragment backlog failed: ${e.message}`); }
  }
  // live-feed articles (auto mode only) — or, explicit, ones someone filed (any mode, ahead of the feed backlog)
  function enqueue(items, explicit = false) {
    if (!explicit && mode !== 'auto') return 0;
    let n = 0;
    for (const it of items) {
      if (!it.link) continue;
      const have = queue.get(it.link);                            // (direct jobs are keyed by link, Wayback ones by wb|link)
      if (have) { if (explicit) have.explicit = true; continue; }
      const id = archive.articleId(it.link);
      if (id == null || !wanted(id)) continue;
      queue.set(it.link, { ...it, id, explicit });
      n++;
    }
    if (n || explicit) pump();
    return n;
  }

  function nextJob() {
    const now = Date.now();
    // explicit filings first, then the rest in order
    const order = [...queue].sort((a, b) => (b[1].explicit ? 1 : 0) - (a[1].explicit ? 1 : 0));
    for (const [key, job] of order) {
      const host = job.wayback ? WAYBACK_HOST : hostOf(job.link);
      if (busyHosts.has(host) || (hostNext.get(host) || 0) > now) continue;
      if ((coolUntil.get(host) || 0) > now) {
        if (job.wayback) continue;                      // archive.org resting: the lookups wait for it in the queue
        queue.delete(key);
        // a site that's refusing everything: don't ask it again now, file the article as refused so the Wayback
        // sweep picks it up
        if (!job.wayback) try { if (wanted(job.id)) archive.saveBody(job.id, { error: `the site refuses automated requests (HTTP 403 on its recent pages; paused)` }); } catch {}
        continue;
      }
      queue.delete(key);
      return { ...job, host };
    }
    return null;
  }

  let timer = null;
  function pump() {
    if (!running) return;
    while (active < CONCURRENCY) {
      const job = nextJob();
      if (!job) break;
      active++;
      busyHosts.add(job.host);
      (job.wayback ? runWayback(job) : run(job)).finally(() => {
        active--;
        busyHosts.delete(job.host);
        hostNext.set(job.host, Date.now() + (job.wayback ? WAYBACK_GAP_MS : HOST_GAP_MS));
        pump();
      });
    }
    // jobs waiting on a per-site gap: look again shortly
    if (queue.size && !timer) timer = setTimeout(() => { timer = null; pump(); }, 1000);
  }

  async function run(job) {
    let r;
    try { r = await readArticle(job.link); }
    catch (e) { r = { error: e.message }; }
    try {
      if (!wanted(job.id)) return;          // the reader view stored it meanwhile
      archive.saveBody(job.id, r, 'harvester');
    } catch (e) { log(`[harvest] save failed: ${e.message}`); return; }
    const status = r.error ? (/HTTP (401|403|404|410|451)|no longer exists|only public web addresses/.test(r.error) ? 'blocked' : 'failed') : r.ok ? 'ok' : 'partial';
    counts[status]++;
    recent.unshift({ source: job.sourceId, status, words: r.words || 0, at: Date.now() });
    recent.length = Math.min(recent.length, 8);
    if (r.error && /HTTP (401|403)/.test(r.error)) {
      const n = (refusals.get(job.host) || 0) + 1;
      refusals.set(job.host, n);
      if (n >= 3) {
        coolUntil.set(job.host, Date.now() + HOST_COOLDOWN_MS);
        refusals.delete(job.host);
        log(`[harvest] ${job.host} refuses requests — pausing it for ${HOST_COOLDOWN_MS / 3600e3}h`);
      }
    } else refusals.delete(job.host);
  }

  // ── Wayback fallback ──
  const flakyFor = new Map();           // article id -> lookups that hit an archive.org outage (in this run)
  async function runWayback(job) {
    const st = archive.bodyState(job.id);
    const waiting = (x) => x && (x.status === 'blocked' || (x.status === 'fragment' && x.tries > 0 && Archive.refused(x.reason)));
    if (!waiting(st)) return;                                // filed some other way meanwhile
    let r;
    try { r = await readWayback(job.link, { date: job.published, reason: job.reason || 'the site refused the request', cdxTimeout: 60e3 }); }
    catch (e) { r = { error: e.message, refused: !!e.waybackRefused, transient: !!e.waybackTransient }; }
    // archive.org rate-limiting us, or down / overloaded: leave it alone for a while, and don't count it against the
    // article (the next sweep tries again)
    // (but an article whose lookup fails like that three times does use an attempt — or it would be retried forever)
    if (r.refused || r.transient) {
      const mins = r.refused ? 60 : 3;                       // (its outages are mostly brief 503s)
      if (!((coolUntil.get(WAYBACK_HOST) || 0) > Date.now())) log(`[harvest] the Wayback Machine ${r.refused ? 'asks us to slow down' : 'is unavailable right now'} — pausing lookups for ${mins} min`);
      coolUntil.set(WAYBACK_HOST, Date.now() + mins * 60e3);
      const n = r.transient ? (flakyFor.get(job.id) || 0) + 1 : 0;
      if (n < 3) { if (n) flakyFor.set(job.id, n); return; }
      flakyFor.delete(job.id);
      r = { error: 'the Wayback Machine lookup kept failing' };
    } else flakyFor.delete(job.id);
    try {
      if (!waiting(archive.bodyState(job.id))) return;
      // a failed lookup stays 'blocked' (the original refusal is kept in the reason) with one more attempt counted
      archive.saveBody(job.id, r.error ? { error: `${job.reason || 'HTTP 403'} · ${r.error.replace(/^.*— and /, '')}` } : r, 'wayback');
    } catch (e) { log(`[harvest] save failed: ${e.message}`); return; }
    if (r.error) return;
    const status = r.ok ? 'ok' : 'partial';
    counts[status]++; counts.wayback++;
    recent.unshift({ source: job.sourceId, status, words: r.words || 0, at: Date.now(), wayback: true });
    recent.length = Math.min(recent.length, 8);
  }
  function waybackSweep() {
    if (!running) return;
    try {
      const now = Date.now();
      const rows = archive.db.prepare(`SELECT b.id, b.tries, b.fetched, b.reason, a.link, a.published, a.source_id FROM bodies b JOIN articles a ON a.id = b.id
        WHERE (b.status = 'blocked' OR (b.status = 'fragment' AND b.tries > 0)) AND b.tries < ? AND a.published >= ? ORDER BY a.published DESC LIMIT 2000`).all(WAYBACK_WAIT_MS.length, now - WAYBACK_DAYS * 864e5);
      let n = 0;
      for (const r of rows) {
        if (now - r.fetched < WAYBACK_WAIT_MS[r.tries]) continue;
        if (/only public web addresses/.test(r.reason || '')) continue;            // never look up refused private addresses
        if (!Archive.refused(r.reason)) continue;                                   // (a fragment that failed some other way: retried at the site)
        const key = `wb|${r.link}`;
        if (queue.has(key)) continue;
        queue.set(key, { wayback: true, id: r.id, link: r.link, published: r.published, sourceId: r.source_id, reason: (r.reason || '').split(' · ')[0] });
        if (++n >= 300) break;
      }
      if (n) { log(`[harvest] Wayback: looking up ${n} article${n === 1 ? '' : 's'} the sites refused`); pump(); }
    } catch (e) { log(`[harvest] Wayback sweep failed: ${e.message}`); }
  }
  setTimeout(waybackSweep, 60e3);
  setInterval(waybackSweep, WAYBACK_SWEEP_MS);

  function setMode(m) {
    if (!MODES.includes(m) || m === mode) return;
    mode = m;
    if (mode === 'auto') backlog();
    else for (const [k, j] of queue) if (!j.explicit && !j.wayback) queue.delete(k);   // feed articles no longer wanted
    log(`[harvest] morgue mode: ${mode}`);
  }
  const status = () => ({
    running, mode, fragmentAll, queued: queue.size, active, session: counts, recent,
    cooling: [...coolUntil].filter(([, t]) => t > Date.now()).map(([host, until]) => ({ host, until })),
  });

  parentPort.on('message', (m) => {
    if (m.type === 'queue') { fragmentItems(m.items); enqueue(m.items); }
    else if (m.type === 'fragment-all') { fragmentAll = !!m.on; log(`[harvest] fragments for every headline: ${fragmentAll ? 'on' : 'off'}`); backlogFragments(); }
    else if (m.type === 'file') enqueue(m.items, true);
    else if (m.type === 'mode') setMode(m.mode);
    else if (m.type === 'stats') {
      try { parentPort.postMessage({ type: 'stats', stats: archive.bodyStats() }); }
      catch (e) { log(`[harvest] stats failed: ${e.message}`); }
    }
  });
  setInterval(() => parentPort.postMessage({ type: 'status', status: status() }), 2000);

  // catch up on recent live-feed articles that were seen before the harvester existed / while it wasn't in auto mode
  function backlog() {
    if (mode !== 'auto') return;
    try {
      const since = Date.now() - workerData.backlogDays * 864e5;
      // (not filed at all, or filed only as a fragment that hasn't been tried yet)
      const rows = archive.db.prepare(`SELECT a.link, a.source_id FROM articles a INDEXED BY ix_pub LEFT JOIN bodies b ON b.id = a.id
        WHERE a.published >= ? AND a.origin = 'live' AND (b.id IS NULL OR (b.status = 'fragment' AND b.tries = 0)) ORDER BY a.published DESC`).all(since);
      const n = enqueue(rows.map((r) => ({ link: r.link, sourceId: r.source_id })));
      if (n) log(`[harvest] backlog: ${n} live-feed articles from the last ${workerData.backlogDays}d`);
    } catch (e) { log(`[harvest] backlog failed: ${e.message}`); }
  }
  setTimeout(() => { backlogFragments(); backlog(); }, 5000);
}

// main-thread handle
export class HarvestWorker {
  constructor({ dbFile, mode = 'auto', fragmentAll = true, backlogDays = 7, log = console.log }) {
    Object.assign(this, { dbFile, mode, fragmentAll, backlogDays, log });
    this._status = { running: true, mode, queued: 0, active: 0, session: {}, recent: [], cooling: [] };
    this._stats = null;
    this.spawn();
  }
  spawn() {
    this.worker = new Worker(fileURLToPath(import.meta.url), { workerData: { role: 'harvest', dbFile: this.dbFile, mode: this.mode, fragmentAll: this.fragmentAll, backlogDays: this.backlogDays } });
    this.worker.on('message', (m) => {
      if (m.type === 'status') this._status = m.status;
      else if (m.type === 'stats') this._stats = m.stats;
      else if (m.type === 'log') this.log(m.msg);
    });
    this.worker.on('error', (e) => this.log(`[harvest] worker error: ${e.message}`));
    this.worker.on('exit', (code) => { this.log(`[harvest] worker exited (${code}); restarting in 10s`); setTimeout(() => this.spawn(), 10e3); });
  }
  queue(items) { this.worker.postMessage({ type: 'queue', items }); }              // live-feed articles (auto mode)
  file(items) { this.worker.postMessage({ type: 'file', items }); }                // someone filed these: fetch them first
  setMode(mode) { this.mode = mode; this.worker.postMessage({ type: 'mode', mode }); this._status.mode = mode; }
  setFragmentAll(on) { this.fragmentAll = !!on; this.worker.postMessage({ type: 'fragment-all', on: !!on }); this._status.fragmentAll = !!on; }
  status() { return this._status; }
  stats() { return this._stats; }
  refreshStats() { this.worker.postMessage({ type: 'stats' }); }
}
