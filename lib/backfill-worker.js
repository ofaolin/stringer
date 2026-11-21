// Runs the historical backfill in a worker thread with its own SQLite connection, so sitemap parsing,
// bulk inserts and archive statistics never block the web server's event loop. A crash in here (e.g. the
// undici fetch assertion) only takes down this worker; the main thread restarts it.
import { parentPort, workerData, isMainThread, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Archive } from './archive.js';
import { Backfill, slugTitle, urlDate } from './backfill.js';
import { unwrapFeedLink } from './feeds.js';

if (!isMainThread && workerData?.role === 'backfill') {
  let sources = workerData.sources;
  const archive = new Archive(workerData.dbFile);
  const backfill = new Backfill({ archive, getSources: () => sources, log: (m) => parentPort.postMessage({ type: 'log', msg: m }) });

  const report = () => parentPort.postMessage({ type: 'status', status: backfill.status() });
  const reportStats = () => {
    try { archive._statsAt = 0; parentPort.postMessage({ type: 'stats', stats: archive.stats() }); }
    catch (e) { parentPort.postMessage({ type: 'log', msg: `[backfill] stats failed: ${e.message}` }); }
  };

  parentPort.on('message', (m) => {
    if (m.type === 'sources') sources = m.sources;
    else if (m.type === 'start') { backfill.start(m.since); report(); }
    else if (m.type === 'pause') { backfill.pause(); report(); }
    else if (m.type === 'stats') reportStats();
  });

  // one-time: decode old Feedsportal redirect links to the real article URLs (full scan, so here, off the server)
  setTimeout(() => {
    try {
      const t0 = Date.now(), r = archive.migrateFeedLinks(unwrapFeedLink);
      if (r) parentPort.postMessage({ type: 'log', msg: `[archive] feed links repaired: ${r.moved} rewritten, ${r.merged} merged into existing rows (${r.scanned} scanned, ${Date.now() - t0}ms)` });
    } catch (e) { parentPort.postMessage({ type: 'log', msg: `[archive] feed link repair failed: ${e.message}` }); }
    // one-time: URL-derived headlines that picked up ID fragments (washingtonpost …/<uuid>_story.html → "730c 11e3 8b3f")
    try {
      const t0 = Date.now(), r = archive.migrateSlugTitles(slugTitle);
      if (r) parentPort.postMessage({ type: 'log', msg: `[archive] rebuilt ${r.fixed} URL-derived headlines (${r.scanned} scanned, ${Math.round((Date.now() - t0) / 1000)}s)` });
    } catch (e) { parentPort.postMessage({ type: 'log', msg: `[archive] headline repair failed: ${e.message}` }); }
    // one-time: re-date sitemap rows whose URL carries an (older) date than the sitemap's lastmod
    try {
      const t0 = Date.now(), r = archive.migrateUrlDates(urlDate, { log: (msg) => parentPort.postMessage({ type: 'log', msg }) });
      if (r) parentPort.postMessage({ type: 'log', msg: `[archive] re-dated ${r.fixed.toLocaleString()} archive pages from the dates in their URLs (${r.scanned.toLocaleString()} checked, ${Math.round((Date.now() - t0) / 1000)}s)` });
    } catch (e) { parentPort.postMessage({ type: 'log', msg: `[archive] URL re-dating failed: ${e.message}` }); }
    // …then drop the pages that turned out older than the backfill goes back (once per backfill date)
    try {
      const t0 = Date.now(), r = archive.migrateUrlDates ? archive.pruneBefore(backfill.since, { log: (msg) => parentPort.postMessage({ type: 'log', msg }) }) : null;
      if (r) { parentPort.postMessage({ type: 'log', msg: `[archive] removed ${r.deleted.toLocaleString()} pages older than the backfill date (${Math.round((Date.now() - t0) / 1000)}s)` }); reportStats(); }
    } catch (e) { parentPort.postMessage({ type: 'log', msg: `[archive] removing old pages failed: ${e.message}` }); }
  }, 8000);
  setInterval(report, 2000);
  setInterval(reportStats, 60e3);
  report();
  setTimeout(reportStats, 1000);
  if (workerData.autostart && backfill.running) setTimeout(() => backfill.start(), 15e3);
}

// main-thread handle with the same surface the server uses (start / pause / status / stats)
export class BackfillWorker {
  constructor({ dbFile, getSources, autostart = true, log = console.log }) {
    this.dbFile = dbFile;
    this.getSources = getSources;
    this.log = log;
    this.autostart = autostart;
    this._status = { running: false, since: null, active: [], errors: {} };
    this._stats = null;
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { role: 'backfill', dbFile: this.dbFile, sources: this.getSources(), autostart: this.autostart },
    });
    this.worker.on('message', (m) => {
      if (m.type === 'status') this._status = m.status;
      else if (m.type === 'stats') this._stats = m.stats;
      else if (m.type === 'log') this.log(m.msg);
    });
    this.worker.on('error', (e) => this.log(`[backfill] worker error: ${e.message}`));
    this.worker.on('exit', (code) => {
      if (this.stopping) return;
      this.log(`[backfill] worker exited (${code}); restarting in 10s`);
      this.autostart = true;
      setTimeout(() => this.spawn(), 10e3);
    });
  }

  syncSources() { this.worker?.postMessage({ type: 'sources', sources: this.getSources() }); }
  start(since) { this.worker.postMessage({ type: 'start', since }); this._status.running = true; }
  pause() { this.worker.postMessage({ type: 'pause' }); this._status.running = false; }
  status() { return this._status; }
  stats() { return this._stats; }
  refreshStats() { this.worker.postMessage({ type: 'stats' }); }
}
