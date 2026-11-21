// Story grouping off the main thread. Clustering two weeks of articles takes seconds; on the server's main thread
// every request would wait for it. The worker gets only what clustering reads — each article's title, summary, date
// and morgue text — and sends back each group as article indices (newest first), which the caller maps back onto
// its own article objects. Same result as clusterArticles(articles, { bodyOf }) run in place.
import { parentPort, workerData, isMainThread, Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { clusterArticles } from './cluster.js';

if (!isMainThread && workerData?.role === 'cluster') {
  parentPort.on('message', ({ id, items, bodies }) => {
    try {
      const arts = items.map(([title, summary, date], i) => ({ title, summary, date, i }));
      const clusters = clusterArticles(arts, { bodyOf: (a) => bodies[a.i] ?? undefined });
      parentPort.postMessage({ id, groups: clusters.map((c) => c.members.map((m) => m.i)) });
    } catch (e) { parentPort.postMessage({ id, error: e.message || String(e) }); }
  });
}

// main-thread handle: cluster(articles, bodyOf) → Promise of [{ members, newest }] (members = the given objects)
export class ClusterWorker {
  constructor({ log = console.log } = {}) { this.log = log; this.seq = 0; this.pending = new Map(); this.spawn(); }
  spawn() {
    this.worker = new Worker(fileURLToPath(import.meta.url), { workerData: { role: 'cluster' } });
    this.worker.unref();                                              // never keeps the process alive on its own
    this.worker.on('message', ({ id, groups, error }) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) return p.reject(new Error(error));
      p.resolve(groups.map((idx) => { const members = idx.map((i) => p.articles[i]); return { members, newest: members[0].date }; }));
    });
    const fail = (why) => { for (const p of this.pending.values()) p.reject(new Error(why)); this.pending.clear(); };
    this.worker.on('error', (e) => { this.log(`[stories] grouping worker error: ${e.message}`); fail(e.message); });
    this.worker.on('exit', (code) => { fail(`grouping worker exited (${code})`); setTimeout(() => this.spawn(), 2000).unref(); });
  }
  cluster(articles, bodyOf) {
    const id = ++this.seq;
    const items = articles.map((a) => [a.title || '', a.summary || '', a.date]);
    const bodies = articles.map((a) => bodyOf(a) ?? null);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, articles });
      this.worker.postMessage({ id, items, bodies });
    });
  }
}
