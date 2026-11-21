// Full-text harvester: fetches every article that shows up in the live feeds, runs the reader-view
// extraction on it (lib/reader.js) and stores the text in the archive (bodies + body_fts), so queries can
// search what articles actually say — and the reader keeps working after a page is paywalled or deleted.
// Runs in its own worker thread (HTML parsing is CPU work) with its own SQLite connection.
//
// Politeness: a few pages at a time overall, one at a time per site with a gap between requests, and a
// site that keeps refusing us (401/403) is left alone for a while. Blocked pages are never retried.
import { parentPort, workerData, isMainThread, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Archive } from './archive.js';
import { readArticle } from './reader.js';

const CONCURRENCY = 4;
const HOST_GAP_MS = 2500;             // between two requests to the same site
const HOST_COOLDOWN_MS = 6 * 3600e3;  // after repeated refusals
const MAX_TRIES = 3;                  // network errors / timeouts / 5xx
const RETRY_AFTER_MS = 2 * 3600e3;

if (!isMainThread && workerData?.role === 'harvest') {
  const archive = new Archive(workerData.dbFile);
  const log = (msg) => parentPort.postMessage({ type: 'log', msg });
  const queue = new Map();              // link -> { link, sourceId }   (insertion order = priority)
  const busyHosts = new Set();
  const hostNext = new Map();           // host -> earliest next request (ms)
  const refusals = new Map();           // host -> consecutive refusals
  const coolUntil = new Map();          // host -> ms
  let running = workerData.enabled, active = 0;
  const counts = { ok: 0, partial: 0, blocked: 0, failed: 0 };
  const recent = [];                    // last few results, for the status panel

  const hostOf = (link) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } };

  // is this article still worth fetching?
  const wanted = (id) => {
    const st = archive.bodyState(id);
    if (!st) return true;
    if (st.status === 'fragment') return true;                // filed for a binder without text: still worth fetching
    if (st.status !== 'failed') return false;                 // ok / partial / blocked are final
    return st.tries < MAX_TRIES && Date.now() - st.fetched > RETRY_AFTER_MS;
  };

  function enqueue(items) {
    let n = 0;
    for (const it of items) {
      if (!it.link || queue.has(it.link)) continue;
      const id = archive.articleId(it.link);
      if (id == null || !wanted(id)) continue;
      queue.set(it.link, { ...it, id });
      n++;
    }
    if (n) pump();
    return n;
  }

  function nextJob() {
    const now = Date.now();
    for (const [link, job] of queue) {
      const host = hostOf(link);
      if (busyHosts.has(host) || (hostNext.get(host) || 0) > now) continue;
      if ((coolUntil.get(host) || 0) > now) { queue.delete(link); continue; }   // requeued by a later refresh
      queue.delete(link);
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
      run(job).finally(() => {
        active--;
        busyHosts.delete(job.host);
        hostNext.set(job.host, Date.now() + HOST_GAP_MS);
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
      archive.saveBody(job.id, r);
    } catch (e) { log(`[harvest] save failed: ${e.message}`); return; }
    const status = r.error ? (/HTTP (401|403|404|410|451)|no longer exists/.test(r.error) ? 'blocked' : 'failed') : r.ok ? 'ok' : 'partial';
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

  const status = () => ({
    running, queued: queue.size, active, session: counts, recent,
    cooling: [...coolUntil].filter(([, t]) => t > Date.now()).map(([host, until]) => ({ host, until })),
  });

  parentPort.on('message', (m) => {
    if (m.type === 'queue') enqueue(m.items);
    else if (m.type === 'start') { running = true; pump(); }
    else if (m.type === 'pause') running = false;
    else if (m.type === 'stats') {
      try { parentPort.postMessage({ type: 'stats', stats: archive.bodyStats() }); }
      catch (e) { log(`[harvest] stats failed: ${e.message}`); }
    }
  });
  setInterval(() => parentPort.postMessage({ type: 'status', status: status() }), 2000);

  // catch up on recent live-feed articles that were seen before the harvester existed / while it was off
  setTimeout(() => {
    try {
      const since = Date.now() - workerData.backlogDays * 864e5;
      const rows = archive.db.prepare(`SELECT a.link, a.source_id FROM articles a INDEXED BY ix_pub LEFT JOIN bodies b ON b.id = a.id
        WHERE a.published >= ? AND a.origin = 'live' AND b.id IS NULL ORDER BY a.published DESC`).all(since);
      const n = enqueue(rows.map((r) => ({ link: r.link, sourceId: r.source_id })));
      if (n) log(`[harvest] backlog: ${n} live-feed articles from the last ${workerData.backlogDays}d`);
    } catch (e) { log(`[harvest] backlog failed: ${e.message}`); }
  }, 5000);
}

// main-thread handle
export class HarvestWorker {
  constructor({ dbFile, enabled = true, backlogDays = 7, log = console.log }) {
    Object.assign(this, { dbFile, enabled, backlogDays, log });
    this._status = { running: enabled, queued: 0, active: 0, session: {}, recent: [], cooling: [] };
    this._stats = null;
    this.spawn();
  }
  spawn() {
    this.worker = new Worker(fileURLToPath(import.meta.url), { workerData: { role: 'harvest', dbFile: this.dbFile, enabled: this.enabled, backlogDays: this.backlogDays } });
    this.worker.on('message', (m) => {
      if (m.type === 'status') this._status = m.status;
      else if (m.type === 'stats') this._stats = m.stats;
      else if (m.type === 'log') this.log(m.msg);
    });
    this.worker.on('error', (e) => this.log(`[harvest] worker error: ${e.message}`));
    this.worker.on('exit', (code) => { this.log(`[harvest] worker exited (${code}); restarting in 10s`); setTimeout(() => this.spawn(), 10e3); });
  }
  queue(items) { this.worker.postMessage({ type: 'queue', items }); }
  start() { this.enabled = true; this.worker.postMessage({ type: 'start' }); this._status.running = true; }
  pause() { this.enabled = false; this.worker.postMessage({ type: 'pause' }); this._status.running = false; }
  status() { return this._status; }
  stats() { return this._stats; }
  refreshStats() { this.worker.postMessage({ type: 'stats' }); }
}
