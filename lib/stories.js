// Story numbers: stories are regrouped from scratch at every feed sync, so on their own they have no identity.
// The registry gives each one a lasting number (6 hex characters) by matching every new grouping to the previous
// one through the articles they share: the new story with the most articles from an old one inherits its number
// (one inheritor per number — when a story splits, the bigger part keeps it; when two merge, the larger share wins).
// It also remembers every story an article has belonged to, and who has read which story (and when, so a story
// that gained coverage since can say so).
import crypto from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stories (
  sid TEXT PRIMARY KEY, created INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  title TEXT NOT NULL, link TEXT, articles INTEGER NOT NULL DEFAULT 1, sources INTEGER NOT NULL DEFAULT 1,
  first INTEGER, newest INTEGER);
CREATE TABLE IF NOT EXISTS story_members (sid TEXT NOT NULL, target TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (sid, target));
CREATE INDEX IF NOT EXISTS ix_story_members_target ON story_members(target);
CREATE TABLE IF NOT EXISTS story_reads (user_id INTEGER NOT NULL, sid TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, sid));
`;

export class StoryRegistry {
  constructor(db) {
    this.db = db;
    db.exec(SCHEMA);
    this.current = new Map();                      // article (normalized URL) → its story number now
    for (const r of db.prepare('SELECT target, sid FROM story_members ORDER BY added').all()) this.current.set(r.target, r.sid);
    this.q = {
      up: db.prepare(`INSERT INTO stories (sid, created, last_seen, title, link, articles, sources, first, newest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET last_seen = excluded.last_seen, title = excluded.title, link = excluded.link, articles = excluded.articles,
          sources = excluded.sources, first = MIN(COALESCE(stories.first, excluded.first), excluded.first), newest = MAX(COALESCE(stories.newest, 0), excluded.newest)`),
      member: db.prepare('INSERT OR IGNORE INTO story_members (sid, target, added) VALUES (?, ?, ?)'),
      story: db.prepare('SELECT * FROM stories WHERE sid = ?'),
      of: db.prepare('SELECT s.*, m.added FROM story_members m JOIN stories s ON s.sid = m.sid WHERE m.target = ? ORDER BY s.last_seen DESC, m.added DESC LIMIT 20'),
    };
  }

  newId() {
    for (;;) { const id = crypto.randomBytes(3).toString('hex'); if (!this.q.story.get(id)) return id; }
  }

  // clusters: [{ members: [article] }] → sets cl.sid on each. write=false only looks numbers up (for partial
  // groupings, e.g. one outlet's view, which mustn't rewrite the canonical membership).
  assign(clusters, normOf, { write = true } = {}) {
    const cand = [];
    clusters.forEach((cl, ci) => {
      const counts = new Map();
      for (const a of cl.members) { const sid = this.current.get(normOf(a)); if (sid) counts.set(sid, (counts.get(sid) || 0) + 1); }
      for (const [sid, n] of counts) cand.push([n, ci, sid]);
    });
    cand.sort((x, y) => y[0] - x[0]);
    const taken = new Set();
    for (const [, ci, sid] of cand) { if (clusters[ci].sid || taken.has(sid)) continue; clusters[ci].sid = sid; taken.add(sid); }
    if (!write) return clusters;
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const cl of clusters) {
        cl.sid ??= this.newId();
        const ms = cl.members;
        const dates = ms.map((m) => m.date);
        this.q.up.run(cl.sid, now, now, String(ms[0].title || '').slice(0, 300), ms[0].link || null, ms.length, new Set(ms.map((m) => m.sourceId)).size,
          Math.min(...dates), Math.max(...dates));
        for (const a of ms) { const t = normOf(a); if (this.current.get(t) !== cl.sid) { this.q.member.run(cl.sid, t, now); this.current.set(t, cl.sid); } }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return clusters;
  }

  // a story's title is its lead headline (the lead depends on outlet weights, so it's set after scoring)
  setTitles(stories) {
    const st = this.db.prepare('UPDATE stories SET title = ?, link = ? WHERE sid = ?');
    this.db.exec('BEGIN');
    try { for (const s of stories) if (s.sid) st.run(String(s.title || '').slice(0, 300), s.link || null, s.sid); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  story(sid) { return this.q.story.get(String(sid || '').toLowerCase()) || null; }
  // every story an article has been part of, most recent first (current = the one it's in now)
  storiesOf(target) { const cur = this.current.get(target); return this.q.of.all(target).map((s) => ({ ...s, current: s.sid === cur })); }

  // ── read state for stories, per user ──
  reads(userId) { return new Map(this.db.prepare('SELECT sid, at FROM story_reads WHERE user_id = ?').all(userId).map((r) => [r.sid, r.at])); }
  setRead(userId, sid, read = true) {
    if (read) this.db.prepare('INSERT INTO story_reads (user_id, sid, at) VALUES (?, ?, ?) ON CONFLICT(user_id, sid) DO UPDATE SET at = excluded.at').run(userId, sid, Date.now());
    else this.db.prepare('DELETE FROM story_reads WHERE user_id = ? AND sid = ?').run(userId, sid);
  }
  forgetUser(userId) { this.db.prepare('DELETE FROM story_reads WHERE user_id = ?').run(userId); }
}
