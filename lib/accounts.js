// Accounts, permissions, sessions, server settings, votes, saved queries and comments — everything that belongs to
// the people using a STRINGER server. Kept in its own small SQLite file (data/app.db), separate from the archive.
// No dependencies: passwords use scrypt, sessions are random tokens stored hashed.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

// ── permissions ──
// Every API action checks one of these. Roles are named sets of them; admins can edit roles or add new ones.
export const PERMISSIONS = {
  'news.read':         'view the feeds, stories, archive, stats and stored articles',
  'reader.fetch':      'open articles that are not in the morgue yet (the server fetches the page)',
  'vote.personal':     'vote on outlets for your own personal ranking',
  'vote.community':    'spend daily community votes on outlets',
  'queries.save':      'save queries as your own tabs',
  'binder.use':        'keep a research binder: save stories, articles and quotes',
  'comments.read':     'read comments',
  'comments.post':     'post, edit and delete your own comments',
  'comments.moderate': "delete anyone's comments",
  'sources.manage':    'add, edit, enable/disable and remove outlets; trigger a feed sync',
  'archive.manage':    'start/pause the archive backfill and full-text harvesting',
  'users.manage':      'manage users and roles',
  'settings.manage':   'change server settings (sign-in, OIDC, ranking, guest access)',
};
const ALL = Object.keys(PERMISSIONS);
const MEMBER = ['news.read', 'reader.fetch', 'vote.personal', 'vote.community', 'queries.save', 'binder.use', 'comments.read', 'comments.post'];
export const BUILTIN_ROLES = [
  { id: 'admin', name: 'Admin', perms: ALL },
  { id: 'moderator', name: 'Moderator', perms: [...MEMBER, 'comments.moderate'] },
  { id: 'member', name: 'Member', perms: MEMBER },
  { id: 'viewer', name: 'Viewer', perms: ['news.read', 'vote.personal', 'queries.save', 'binder.use', 'comments.read'] },
  { id: 'guest', name: 'Guest (not signed in)', perms: ['news.read', 'comments.read'] },
];

export const DEFAULT_SETTINGS = {
  siteName: 'STRINGER',
  setupDone: false,
  localLogin: true,          // username + password accounts
  signup: false,             // anyone may create a local account (gets defaultRole)
  defaultRole: 'member',     // for sign-ups and first-time OIDC users
  ranking: { defaultMode: 'community', upPerDay: 3, downPerDay: 3 },
  oidc: { enabled: false, issuer: '', clientId: '', clientSecret: '', scopes: 'openid profile email', label: 'Sign in with SSO',
    autoCreate: true, defaultRole: 'member', roleClaim: 'groups', roleMap: {} },
  baseUrl: '',               // public URL of the server (for the OIDC redirect URI); empty = derive from the request
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, perms TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display TEXT NOT NULL, email TEXT,
  role TEXT NOT NULL, pw TEXT, oidc TEXT UNIQUE, created INTEGER NOT NULL, last_login INTEGER, disabled INTEGER NOT NULL DEFAULT 0,
  prefs TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS oidc_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, return_to TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS personal_votes (user_id INTEGER NOT NULL, source_id TEXT NOT NULL, votes INTEGER NOT NULL, PRIMARY KEY (user_id, source_id));
CREATE TABLE IF NOT EXISTS community_votes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source_id TEXT NOT NULL, delta INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_cv_user_at ON community_votes(user_id, at);
CREATE INDEX IF NOT EXISTS ix_cv_source ON community_votes(source_id);
CREATE TABLE IF NOT EXISTS saved_queries (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, query TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 1,
  view TEXT, position INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_sq_user ON saved_queries(user_id, position);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, target TEXT NOT NULL, scope TEXT NOT NULL, parent_id INTEGER,
  body TEXT NOT NULL, created INTEGER NOT NULL, edited INTEGER, deleted INTEGER NOT NULL DEFAULT 0, deleted_by INTEGER);
CREATE INDEX IF NOT EXISTS ix_comments_target ON comments(target, scope);
CREATE TABLE IF NOT EXISTS reads (user_id INTEGER NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, target));
-- research binder: saved stories / articles / quotes (a quote cites its article by link and morgue no.)
CREATE TABLE IF NOT EXISTS binder (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
  link TEXT, sid TEXT, title TEXT, source_id TEXT, published INTEGER, morgue TEXT, quote TEXT, note TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_binder_user ON binder(user_id, created);
CREATE TABLE IF NOT EXISTS binders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS migrations (k TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

const SESSION_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 864e5;
export const utcDayStart = (t = Date.now()) => Math.floor(t / DAY) * DAY;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function checkPassword(pw, stored) {
  const [kind, salt, key] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

export class Accounts {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    const insRole = this.db.prepare('INSERT OR IGNORE INTO roles (id, name, perms, builtin) VALUES (?, ?, ?, 1)');
    for (const r of BUILTIN_ROLES) insRole.run(r.id, r.name, JSON.stringify(r.perms));
    // binder entries belong to one of the user's binders (older entries: the user's first binder, made on demand)
    if (!this.db.prepare('PRAGMA table_info(binder)').all().some((c) => c.name === 'book')) this.db.exec('ALTER TABLE binder ADD COLUMN book INTEGER');
    // permissions added after a server was set up: grant them once to the built-in roles that have them by default
    for (const perm of ['binder.use']) {
      if (this.db.prepare('SELECT 1 FROM migrations WHERE k = ?').get(`perm:${perm}`)) continue;
      for (const r of BUILTIN_ROLES.filter((x) => x.perms.includes(perm))) {
        const row = this.db.prepare('SELECT perms FROM roles WHERE id = ?').get(r.id);
        const cur = row ? JSON.parse(row.perms) : null;
        if (cur && !cur.includes(perm)) this.db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify([...cur, perm]), r.id);
      }
      this.db.prepare('INSERT INTO migrations (k, at) VALUES (?, ?)').run(`perm:${perm}`, Date.now());
    }
    this._settings = null;
    this.q = {
      userById: this.db.prepare('SELECT * FROM users WHERE id = ?'),
      userByName: this.db.prepare('SELECT * FROM users WHERE username = ?'),
      userByOidc: this.db.prepare('SELECT * FROM users WHERE oidc = ?'),
      session: this.db.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?'),
      role: this.db.prepare('SELECT * FROM roles WHERE id = ?'),
    };
  }

  // ── settings ──
  settings() {
    if (!this._settings) {
      const s = structuredClone(DEFAULT_SETTINGS);
      for (const r of this.db.prepare('SELECT k, v FROM settings').all()) {
        const v = JSON.parse(r.v);
        s[r.k] = v && typeof v === 'object' && !Array.isArray(v) && s[r.k] && typeof s[r.k] === 'object' ? { ...s[r.k], ...v } : v;
      }
      this._settings = s;
    }
    return this._settings;
  }
  setSettings(patch) {
    const st = this.db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      const cur = this.settings()[k];
      st.run(k, JSON.stringify(v && typeof v === 'object' && !Array.isArray(v) ? { ...cur, ...v } : v));
    }
    this._settings = null;
    return this.settings();
  }

  // ── roles & permissions ──
  roles() { return this.db.prepare(`SELECT * FROM roles ORDER BY builtin DESC,
      CASE id WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 WHEN 'member' THEN 2 WHEN 'viewer' THEN 3 WHEN 'guest' THEN 4 ELSE 5 END, name`).all().map((r) => ({ ...r, perms: JSON.parse(r.perms), builtin: !!r.builtin })); }
  rolePerms(id) { const r = this.q.role.get(id); return new Set(r ? JSON.parse(r.perms) : []); }
  saveRole({ id, name, perms }) {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(id || '')) throw new Error('role id: 2–31 lowercase letters, digits or dashes');
    const clean = [...new Set((perms || []).filter((p) => p in PERMISSIONS))];
    if (id === 'admin' && !(clean.includes('users.manage') && clean.includes('settings.manage'))) throw new Error('the admin role must keep users.manage and settings.manage');
    this.db.prepare(`INSERT INTO roles (id, name, perms, builtin) VALUES (?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, perms = excluded.perms`).run(id, String(name || id).slice(0, 40), JSON.stringify(clean));
    return this.roles().find((r) => r.id === id);
  }
  deleteRole(id) {
    const r = this.q.role.get(id);
    if (!r) throw new Error('no such role');
    if (r.builtin) throw new Error('built-in roles can be edited but not deleted');
    if (this.db.prepare('SELECT 1 FROM users WHERE role = ?').get(id)) throw new Error('move the users in this role to another role first');
    this.db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  }

  // ── users ──
  userCount() { return this.db.prepare('SELECT COUNT(*) n FROM users').get().n; }
  user(id) { return this.q.userById.get(id) || null; }
  publicUser(u) { return u && { id: u.id, username: u.username, display: u.display, email: u.email || null, role: u.role, created: u.created, lastLogin: u.last_login, disabled: !!u.disabled, oidc: !!u.oidc, password: !!u.pw, prefs: JSON.parse(u.prefs || '{}') }; }
  users() { return this.db.prepare('SELECT * FROM users ORDER BY created').all().map((u) => this.publicUser(u)); }
  createUser({ username, display, email = null, role, password = null, oidc = null }) {
    username = String(username || '').trim();
    if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(username)) throw new Error('username: 2–32 letters, digits, dots, dashes or underscores');
    if (this.q.userByName.get(username)) throw new Error('that username is taken');
    if (!this.q.role.get(role)) throw new Error(`no such role: ${role}`);
    if (password != null && String(password).length < 8) throw new Error('password: at least 8 characters');
    const r = this.db.prepare('INSERT INTO users (username, display, email, role, pw, oidc, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(username, String(display || username).slice(0, 60), email, role, password != null ? hashPassword(password) : null, oidc, Date.now());
    return this.user(Number(r.lastInsertRowid));
  }
  updateUser(id, patch, { actorId } = {}) {
    const u = this.user(id);
    if (!u) throw new Error('no such user');
    if (patch.role !== undefined) {
      if (!this.q.role.get(patch.role)) throw new Error(`no such role: ${patch.role}`);
      if (u.role === 'admin' && patch.role !== 'admin' && this.adminCount() <= 1) throw new Error('this is the last admin — make someone else admin first');
      this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(patch.role, id);
    }
    if (patch.display !== undefined) this.db.prepare('UPDATE users SET display = ? WHERE id = ?').run(String(patch.display).trim().slice(0, 60) || u.username, id);
    if (patch.email !== undefined) this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(patch.email || null, id);
    if (patch.disabled !== undefined) {
      if (patch.disabled && id === actorId) throw new Error("you can't disable your own account");
      if (patch.disabled && u.role === 'admin' && this.adminCount() <= 1) throw new Error('this is the last admin');
      this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(patch.disabled ? 1 : 0, id);
      if (patch.disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (patch.password !== undefined) {
      if (patch.password !== null && String(patch.password).length < 8) throw new Error('password: at least 8 characters');
      this.db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(patch.password ? hashPassword(patch.password) : null, id);
    }
    if (patch.prefs !== undefined) this.db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(u.prefs || '{}'), ...patch.prefs }), id);
    return this.user(id);
  }
  deleteUser(id, { actorId } = {}) {
    const u = this.user(id);
    if (!u) throw new Error('no such user');
    if (id === actorId) throw new Error("you can't delete your own account here");
    if (u.role === 'admin' && this.adminCount() <= 1) throw new Error('this is the last admin');
    for (const t of ['sessions', 'personal_votes', 'community_votes', 'saved_queries', 'reads', 'binder', 'binders']) this.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
    this.db.prepare('UPDATE comments SET deleted = 1, deleted_by = ? WHERE user_id = ?').run(actorId ?? null, id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
  adminCount() { return this.db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0").get().n; }
  login(username, password) {
    const u = this.q.userByName.get(String(username || '').trim());
    // run scrypt even for unknown users so response time doesn't reveal which usernames exist
    const ok = checkPassword(password, u?.pw || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    if (!u || !u.pw || !ok) throw new Error('wrong username or password');
    if (u.disabled) throw new Error('this account is disabled');
    return u;
  }

  // ── sessions ── (the cookie holds a random token; only its hash is stored)
  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('INSERT INTO sessions (id, user_id, created, expires) VALUES (?, ?, ?, ?)').run(sha(token), userId, now, now + SESSION_DAYS * DAY);
    this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now, userId);
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
    return { token, maxAge: SESSION_DAYS * 86400 };
  }
  sessionUser(token) {
    if (!token) return null;
    const s = this.q.session.get(sha(token), Date.now());
    if (!s) return null;
    const u = this.user(s.user_id);
    return u && !u.disabled ? u : null;
  }
  endSession(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(token)); }

  // ── OIDC login state (state → PKCE verifier + nonce), short-lived ──
  putOidcState(state, verifier, nonce, returnTo) {
    this.db.prepare('DELETE FROM oidc_states WHERE created < ?').run(Date.now() - 15 * 60e3);
    this.db.prepare('INSERT INTO oidc_states (state, verifier, nonce, return_to, created) VALUES (?, ?, ?, ?, ?)').run(state, verifier, nonce, returnTo || '/', Date.now());
  }
  takeOidcState(state) {
    const r = this.db.prepare('SELECT * FROM oidc_states WHERE state = ? AND created > ?').get(String(state || ''), Date.now() - 15 * 60e3);
    if (r) this.db.prepare('DELETE FROM oidc_states WHERE state = ?').run(r.state);
    return r || null;
  }
  userByOidc(key) { return this.q.userByOidc.get(key) || null; }

  // ── ranking votes ──
  // personal: a user's own standing votes per outlet (−30…+30), only shape their own ranking.
  personalVotes(userId) { return new Map(this.db.prepare('SELECT source_id, votes FROM personal_votes WHERE user_id = ?').all(userId).map((r) => [r.source_id, r.votes])); }
  personalVote(userId, sourceId, delta) {
    const cur = this.personalVotes(userId).get(sourceId) || 0;
    const v = Math.max(-30, Math.min(30, cur + Math.sign(delta)));
    this.db.prepare(`INSERT INTO personal_votes (user_id, source_id, votes) VALUES (?, ?, ?)
      ON CONFLICT(user_id, source_id) DO UPDATE SET votes = excluded.votes`).run(userId, sourceId, v);
    return v;
  }
  setPersonalVotes(userId, map) {
    const st = this.db.prepare(`INSERT INTO personal_votes (user_id, source_id, votes) VALUES (?, ?, ?) ON CONFLICT(user_id, source_id) DO UPDATE SET votes = excluded.votes`);
    for (const [k, v] of Object.entries(map)) if (v) st.run(userId, k, Math.max(-30, Math.min(30, v)));
  }
  // community: every vote is a ledger entry; each user has a daily budget (UTC day) of up and down votes.
  // The community standing of an outlet is the net of all entries.
  communityVotes() { return new Map(this.db.prepare('SELECT source_id, SUM(delta) n FROM community_votes GROUP BY source_id').all().map((r) => [r.source_id, r.n])); }
  communityVoters() { return this.db.prepare('SELECT COUNT(DISTINCT user_id) n FROM community_votes').get().n; }
  budget(userId) {
    const { upPerDay, downPerDay } = this.settings().ranking;
    const day = utcDayStart();
    const rows = this.db.prepare('SELECT source_id, delta FROM community_votes WHERE user_id = ? AND at >= ?').all(userId, day);
    const up = rows.filter((r) => r.delta > 0).length, down = rows.filter((r) => r.delta < 0).length;
    const today = {};
    for (const r of rows) today[r.source_id] = (today[r.source_id] || 0) + r.delta;
    return { upLeft: Math.max(0, upPerDay - up), downLeft: Math.max(0, downPerDay - down), upPerDay, downPerDay, resetsAt: day + DAY, today };
  }
  // a vote opposite to one cast today on the same outlet takes that vote back (and refunds it) instead
  communityVote(userId, sourceId, delta) {
    const d = Math.sign(delta);
    if (!d) throw new Error('delta must be +1 or −1');
    const day = utcDayStart();
    const undo = this.db.prepare('SELECT id FROM community_votes WHERE user_id = ? AND source_id = ? AND at >= ? AND delta = ? ORDER BY at DESC LIMIT 1').get(userId, sourceId, day, -d);
    if (undo) { this.db.prepare('DELETE FROM community_votes WHERE id = ?').run(undo.id); return { undone: true, ...this.budget(userId) }; }
    const b = this.budget(userId);
    if (d > 0 && !b.upLeft) throw Object.assign(new Error(`no community upvotes left today (${b.upPerDay} a day) — they reset at 00:00 UTC`), { status: 429 });
    if (d < 0 && !b.downLeft) throw Object.assign(new Error(`no community downvotes left today (${b.downPerDay} a day) — they reset at 00:00 UTC`), { status: 429 });
    this.db.prepare('INSERT INTO community_votes (user_id, source_id, delta, at) VALUES (?, ?, ?, ?)').run(userId, sourceId, d, Date.now());
    return { undone: false, ...this.budget(userId) };
  }

  // ── saved queries (tabs), per user ──
  savedQueries(userId) {
    return this.db.prepare('SELECT * FROM saved_queries WHERE user_id = ? ORDER BY position, created').all(userId)
      .map((r) => ({ id: r.id, name: r.name, query: r.query, pinned: !!r.pinned, view: r.view ? JSON.parse(r.view) : null, created: r.created }));
  }
  addSavedQuery(userId, q) {
    const id = q.id || crypto.randomBytes(4).toString('hex');
    const pos = (this.db.prepare('SELECT MAX(position) p FROM saved_queries WHERE user_id = ?').get(userId).p ?? -1) + 1;
    this.db.prepare('INSERT INTO saved_queries (id, user_id, name, query, pinned, view, position, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, q.name, q.query, q.pinned ? 1 : 0, q.view ? JSON.stringify(q.view) : null, pos, q.created || Date.now());
    return this.savedQueries(userId).find((x) => x.id === id);
  }
  updateSavedQuery(userId, id, q) {
    const r = this.db.prepare('UPDATE saved_queries SET name = ?, query = ?, pinned = ?, view = ? WHERE id = ? AND user_id = ?')
      .run(q.name, q.query, q.pinned ? 1 : 0, q.view ? JSON.stringify(q.view) : null, id, userId);
    return Number(r.changes) ? this.savedQueries(userId).find((x) => x.id === id) : null;
  }
  deleteSavedQuery(userId, id) { return Number(this.db.prepare('DELETE FROM saved_queries WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0; }
  orderSavedQueries(userId, ids) {
    const st = this.db.prepare('UPDATE saved_queries SET position = ? WHERE id = ? AND user_id = ?');
    ids.forEach((id, k) => st.run(k, id, userId));
    return this.savedQueries(userId);
  }

  // ── read / unread, per user (target = normalized article URL) ──
  readSet(userId) { return new Set(this.db.prepare('SELECT target FROM reads WHERE user_id = ?').all(userId).map((r) => r.target)); }
  // ── research binders (each user has one or more; entries belong to one) ──
  books(userId) {
    let list = this.db.prepare('SELECT id, name, created FROM binders WHERE user_id = ? ORDER BY created, id').all(userId);
    if (!list.length) {
      this.db.prepare('INSERT INTO binders (user_id, name, created) VALUES (?, ?, ?)').run(userId, 'Main', Date.now());
      list = this.db.prepare('SELECT id, name, created FROM binders WHERE user_id = ? ORDER BY created, id').all(userId);
    }
    // entries from before binders existed join the first one (a write only when there are any)
    if (this.db.prepare('SELECT 1 FROM binder WHERE user_id = ? AND book IS NULL LIMIT 1').get(userId)) this.db.prepare('UPDATE binder SET book = ? WHERE user_id = ? AND book IS NULL').run(list[0].id, userId);
    return list;
  }
  book(userId, id) { return this.books(userId).find((b) => b.id === Number(id)) || null; }
  bookCreate(userId, name) {
    const r = this.db.prepare('INSERT INTO binders (user_id, name, created) VALUES (?, ?, ?)').run(userId, name, Date.now());
    return this.db.prepare('SELECT id, name, created FROM binders WHERE id = ?').get(Number(r.lastInsertRowid));
  }
  bookRename(userId, id, name) { return Number(this.db.prepare('UPDATE binders SET name = ? WHERE id = ? AND user_id = ?').run(name, id, userId).changes) > 0; }
  bookDelete(userId, id) {
    if (this.books(userId).length < 2) return false;                 // always keep one
    this.db.prepare('DELETE FROM binder WHERE user_id = ? AND book = ?').run(userId, id);
    return Number(this.db.prepare('DELETE FROM binders WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0;
  }
  binder(userId) { this.books(userId); return this.db.prepare('SELECT * FROM binder WHERE user_id = ? ORDER BY created DESC').all(userId); }
  binderAdd(userId, e) {
    const book = this.book(userId, e.book)?.id ?? this.books(userId)[0].id;
    // saving the same story / article twice into one binder is a no-op (quotes can repeat)
    if (e.kind !== 'quote') {
      const dup = this.db.prepare('SELECT * FROM binder WHERE user_id = ? AND book = ? AND kind = ? AND target = ?').get(userId, book, e.kind, e.target);
      if (dup) return dup;
    }
    const r = this.db.prepare(`INSERT INTO binder (user_id, book, kind, target, link, sid, title, source_id, published, morgue, quote, note, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, book, e.kind, e.target, e.link || null, e.sid || null, e.title || null, e.sourceId || null,
      e.published || null, e.morgue || null, e.quote || null, e.note || null, Date.now());
    return this.db.prepare('SELECT * FROM binder WHERE id = ?').get(Number(r.lastInsertRowid));
  }
  binderNote(userId, id, note) { return Number(this.db.prepare('UPDATE binder SET note = ? WHERE id = ? AND user_id = ?').run(note || null, id, userId).changes) > 0; }
  binderMove(userId, id, book) { return !!this.book(userId, book) && Number(this.db.prepare('UPDATE binder SET book = ? WHERE id = ? AND user_id = ?').run(Number(book), id, userId).changes) > 0; }
  binderDelete(userId, id) { return Number(this.db.prepare('DELETE FROM binder WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0; }
  binderRemove(userId, kind, target, book) {
    return Number(this.db.prepare(`DELETE FROM binder WHERE user_id = ? AND kind = ? AND target = ?${book ? ' AND book = ?' : ''}`).run(userId, kind, target, ...(book ? [Number(book)] : [])).changes) > 0;
  }

  setRead(userId, target, read = true) {
    if (read) this.db.prepare('INSERT INTO reads (user_id, target, at) VALUES (?, ?, ?) ON CONFLICT(user_id, target) DO UPDATE SET at = excluded.at').run(userId, target, Date.now());
    else this.db.prepare('DELETE FROM reads WHERE user_id = ? AND target = ?').run(userId, target);
  }

  // ── comments ── (target = normalized article URL; scope 'article' or 'story' — a story's discussion is every
  // story-scope comment on any of its articles, so it survives stories being regrouped)
  comments(targets, scope) {
    if (!targets.length) return [];
    return this.db.prepare(`SELECT c.*, u.username, u.display FROM comments c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.scope = ? AND c.target IN (${targets.map(() => '?').join(',')}) ORDER BY c.created`).all(scope, ...targets)
      .map((c) => ({ id: c.id, userId: c.user_id, author: c.deleted ? null : (c.display || c.username || 'deleted user'), username: c.deleted ? null : c.username,
        target: c.target, scope: c.scope, parent: c.parent_id, body: c.deleted ? '' : c.body, created: c.created, edited: c.edited, deleted: !!c.deleted }));
  }
  commentCounts(targets, scope) {
    if (!targets.length) return new Map();
    return new Map(this.db.prepare(`SELECT target, COUNT(*) n FROM comments WHERE scope = ? AND deleted = 0 AND target IN (${targets.map(() => '?').join(',')}) GROUP BY target`)
      .all(scope, ...targets).map((r) => [r.target, r.n]));
  }
  comment(id) { return this.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) || null; }
  addComment(userId, { target, scope, parent = null, body }) {
    body = String(body || '').replace(/\r\n?/g, '\n').trim();
    if (!body) throw new Error('the comment is empty');
    if (body.length > 4000) throw new Error('comments are limited to 4,000 characters');
    if (!['article', 'story'].includes(scope)) throw new Error('scope must be article or story');
    if (parent != null) {
      const p = this.comment(parent);
      if (!p || p.target !== target || p.scope !== scope) throw new Error('can only reply within the same discussion');
      if (p.parent_id) parent = p.parent_id;                  // one level of replies
    }
    const r = this.db.prepare('INSERT INTO comments (user_id, target, scope, parent_id, body, created) VALUES (?, ?, ?, ?, ?, ?)').run(userId, target, scope, parent, body, Date.now());
    return Number(r.lastInsertRowid);
  }
  editComment(id, body) {
    body = String(body || '').replace(/\r\n?/g, '\n').trim();
    if (!body) throw new Error('the comment is empty');
    if (body.length > 4000) throw new Error('comments are limited to 4,000 characters');
    this.db.prepare('UPDATE comments SET body = ?, edited = ? WHERE id = ? AND deleted = 0').run(body, Date.now(), id);
  }
  deleteComment(id, actorId) { this.db.prepare('UPDATE comments SET deleted = 1, deleted_by = ? WHERE id = ?').run(actorId, id); }
}
