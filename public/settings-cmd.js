// Terminal commands for every setting: this browser's (reader, discussion sidebar…), your account's (ranking,
// name, password, sign-in), and the server's (settings, single sign-on, users, roles, morgue) — each checked
// against your role before anything is sent; the server enforces the same permissions regardless.
// Secrets never reach the console log or history: passwords are asked for in a prompt, `sso secret` is masked.
export function createSettingsCommands(ctx) {
  const { api, esc, auth, reader, store } = ctx;
  // messages are HTML; usage placeholders like <role> or <perm…> must show, not be parsed as tags
  // …and colour: section titles, usage labels, placeholders
  const log = (m, c) => ctx.log(String(m)
    .replace(/<(?!\/?(?:b|span|button)\b)([^<>]+)>/g, '<span class="c-ph">&lt;$1&gt;</span>')
    .replace(/^([a-z][\w ()&/-]*:)(?=\n)/gim, '<span class="c-h">$1</span>')
    .replace(/(^|\n)(usage:|change one:|manage:|permissions:)/g, '$1<span class="c-dim">$2</span>'), c);
  const sign = (n) => `${n > 0 ? '+' : ''}${n}`;
  const onOff = (v) => (/^(on|yes|true|1|enable|enabled)$/i.test(v) ? true : /^(off|no|false|0|disable|disabled)$/i.test(v) ? false : null);
  const yes = (b) => (b ? '<span class="ok">on</span>' : '<span class="warn">off</span>');

  // role check: say what's missing instead of sending a request that will be refused
  function denied(perm) {
    if (auth.can(perm)) return false;
    if (!auth.me?.user) log(`this needs the ${esc(perm)} permission — <button type="button" class="link" data-signin>[sign in]</button>`, 'warn');
    else log(`your role (${esc(auth.me.user.role)}) doesn't have the ${esc(perm)} permission`, 'err');
    return true;
  }
  const needUser = () => { if (auth.me?.user) return false; log('sign in first — type <b>login</b>', 'warn'); return true; };
  document.addEventListener('click', (e) => { if (e.target.closest('#log [data-signin]')) auth.openLogin(); });
  const fail = (e) => log(esc(e.message), 'err');
  const kv = (rows) => rows.map(([k, v]) => `  <span class="c-key">${esc(k.padEnd(18))}</span> ${v}`).join('\n');

  async function serverSettings() { return api('admin/settings'); }
  async function patchServer(body, what) {
    try { await api('admin/settings', { method: 'PATCH', body }); await auth.refresh(); log(`server: ${what}`, 'ok'); }
    catch (e) { fail(e); }
  }
  async function findUser(name) {
    const { users, roles } = await api('admin/users');
    const u = users.find((x) => x.username.toLowerCase() === String(name || '').toLowerCase());
    if (!u) throw new Error(`no user "${name}" — type 'users' for the list`);
    return { u, roles };
  }

  // ── the commands ── (cmd → async (args[]) ⇒ void)
  const H = {
    async whoami() {
      const m = auth.me;
      if (!m?.user) return log(`not signed in — browsing as a guest (${m?.perms?.length ? esc(m.perms.join(', ')) : 'no permissions'}). type <b>login</b>`);
      const u = m.user;
      log(`${esc(u.display)} <span class="dim">@${esc(u.username)}</span> · role <b>${esc(u.role)}</b> · sign-in: ${[u.password && 'password', u.oidc && 'SSO'].filter(Boolean).join(' + ')}\npermissions: ${esc(m.perms.join(' '))}`);
    },
    async login() { if (auth.me?.user) return log(`already signed in as ${esc(auth.me.user.display)} — 'logout' first`); auth.openLogin(); },
    async logout() { if (needUser()) return; await api('auth/logout', { method: 'POST' }); location.reload(); },
    async passwd() { if (needUser()) return; if (!auth.me.user.password) return log('your account signs in with SSO only — there is no password to change', 'warn'); auth.openPassword(); },
    async name(a) {
      if (needUser()) return;
      const v = a.join(' ').trim();
      if (!v) return log(`your display name is "${esc(auth.me.user.display)}" — usage: name <new display name>`);
      try { await api('me/prefs', { method: 'PATCH', body: { display: v } }); await auth.refresh(); log(`display name → ${esc(auth.me.user.display)}`, 'ok'); } catch (e) { fail(e); }
    },
    async rank(a) {
      const to = (a[0] || '').toLowerCase();
      if (!to) {
        const r = auth.me.rank, b = r.budget;
        return log(`ranking: <b>${r.mode.toUpperCase()}</b>${b ? ` · community votes left today ▲${b.upLeft}/${b.upPerDay} ▼${b.downLeft}/${b.downPerDay} (reset 00:00 UTC)` : ''}\nusage: rank community|personal`);
      }
      if (!['community', 'personal'].includes(to)) return log('usage: rank community|personal', 'err');
      if (to === 'personal' && (needUser() || denied('vote.personal'))) return;
      if (to === auth.me.rank.mode) return log(`already ranking by ${to} votes`);
      return auth.switchRank(to);
    },
    async discussion(a) {
      const v = (a[0] || '').toLowerCase();
      const open = v === 'open' || v === 'on' ? true : v === 'closed' || v === 'close' || v === 'off' ? false : null;
      if (open === null) return log(`discussion sidebar: <b>${store.get('cmOpen', false) ? 'open' : 'closed'}</b> by default · usage: discussion open|closed  (c toggles it in a popover)`);
      if (open !== store.get('cmOpen', false)) ctx.toggleComments();
      log(`discussion sidebar → ${open ? 'open' : 'closed'}`, 'ok');
    },
    async reader(a) {
      const [k, v] = [String(a[0] || '').toLowerCase(), a[1]];
      if (!k) { const p = reader.prefs(); return log(`reader: font <b>${p.font}</b> · size <b>${p.size}px</b>\nusage: reader font mono|serif|sans · reader size 13–24`); }
      if (!['font', 'size'].includes(k)) return log('usage: reader font mono|serif|sans · reader size 13–24', 'err');
      try { const p = reader.setPref(k, String(v || '').toLowerCase()); log(`reader → font ${p.font}, size ${p.size}px`, 'ok'); } catch (e) { fail(e); }
    },
    async morgue(a) {
      // auto | adhoc | manual | fragment (on → auto, off → ad-hoc, as before modes existed)
      const w = String(a[0] || '').toLowerCase().replace('ad-hoc', 'adhoc');
      if (w === 'fragments' || w === 'headlines') {
        const on = onOff(a[1] || '');
        if (on === null) return log('usage: morgue fragments on|off — file every incoming headline + summary as a fragment (in any mode)');
        if (denied('archive.manage')) return;
        try { await api('archive', { method: 'POST', body: { action: 'fragment-all', on } }); log(`morgue: incoming headlines ${on ? 'filed as fragments' : 'not filed on arrival'}`, 'ok'); } catch (e) { fail(e); }
        return;
      }
      const mode = ['auto', 'adhoc', 'manual', 'fragment'].includes(w) ? w : onOff(w) === true ? 'auto' : onOff(w) === false ? 'adhoc' : null;
      if (!mode) return log('usage: morgue auto|adhoc|manual|fragment — auto: every live-feed article · adhoc: what\'s opened in the reader or saved to a binder · manual: only binder saves and right-click → File in the morgue · fragment: like manual, headline + summary only (archive shows the status)');
      if (denied('archive.manage')) return;
      try { await api('archive', { method: 'POST', body: { action: 'morgue-mode', mode } }); log(`morgue mode → ${mode}`, 'ok'); } catch (e) { fail(e); }
    },
    async admin(a) {
      if (!auth.can('users.manage') && !auth.can('settings.manage')) return denied('settings.manage');
      const tab = { users: 'users', roles: 'roles', settings: 'settings', sso: 'sso', oidc: 'sso' }[(a[0] || '').toLowerCase()];
      auth.openAdmin(tab);
    },

    // ── server settings ──
    async server(a) {
      if (denied('settings.manage')) return;
      const [k, ...r] = a, v = r.join(' ');
      const key = (k || '').toLowerCase();
      if (!key) {
        const s = await serverSettings();
        return log(`server settings:\n${kv([
          ['name', esc(s.siteName)], ['url', s.baseUrl ? esc(s.baseUrl) : '<span class="dim">(from the request)</span>'],
          ['password-login', yes(s.localLogin)], ['signup', yes(s.signup)], ['default-role', esc(s.defaultRole)],
          ['rank-default', esc(s.ranking.defaultMode)], ['upvotes', `${s.ranking.upPerDay} a day`], ['downvotes', `${s.ranking.downPerDay} a day`],
          ['sso', `${yes(s.oidc.enabled)} — type 'sso' for details`],
        ])}\nchange one: server <setting> <value>`);
      }
      const bool = onOff(v);
      switch (key) {
        case 'name': if (!v) return log('usage: server name <site name>', 'err'); return patchServer({ siteName: v }, `site name → ${esc(v)}`);
        case 'url': return patchServer({ baseUrl: /^(off|none|-)$/i.test(v) ? '' : v }, `public URL → ${esc(v || '(from the request)')}`);
        case 'password-login': case 'local-login': if (bool === null) return log('usage: server password-login on|off', 'err'); return patchServer({ localLogin: bool }, `password sign-in ${bool ? 'on' : 'off'}`);
        case 'signup': case 'signups': if (bool === null) return log('usage: server signup on|off', 'err'); return patchServer({ signup: bool }, `open sign-ups ${bool ? 'on' : 'off'}`);
        case 'default-role': if (!v) return log('usage: server default-role <role>', 'err'); return patchServer({ defaultRole: v }, `new accounts get the role ${esc(v)}`);
        case 'rank-default': case 'ranking': if (!['community', 'personal'].includes(v)) return log('usage: server rank-default community|personal', 'err'); return patchServer({ ranking: { defaultMode: v } }, `default ranking → ${v}`);
        case 'upvotes': case 'downvotes': {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0 || n > 100) return log(`usage: server ${key} <0–100>  (community votes per user per day)`, 'err');
          return patchServer({ ranking: { [key === 'upvotes' ? 'upPerDay' : 'downPerDay']: n } }, `${n} community ${key} per user per day`);
        }
        default: return log(`unknown server setting "${esc(k)}" — type 'server' for the list`, 'err');
      }
    },

    // ── single sign-on ──
    async sso(a) {
      if (denied('settings.manage')) return;
      const [k, ...r] = a, v = r.join(' ');
      const key = (k || '').toLowerCase();
      const set = (oidc, what) => patchServer({ oidc }, `SSO ${what}`);
      if (!key) {
        const s = await serverSettings(), o = s.oidc;
        return log(`single sign-on (OIDC):\n${kv([
          ['enabled', yes(o.enabled)], ['issuer', esc(o.issuer) || '<span class="dim">—</span>'], ['client', esc(o.clientId) || '<span class="dim">—</span>'],
          ['secret', o.hasSecret ? 'set' : '<span class="warn">not set</span>'], ['scopes', esc(o.scopes)], ['label', esc(o.label)],
          ['autocreate', yes(o.autoCreate)], ['default-role', esc(o.defaultRole)], ['claim', esc(o.roleClaim)],
          ['map', Object.entries(o.roleMap || {}).map(([g, r2]) => `${esc(g)} → ${esc(r2)}`).join(', ') || '<span class="dim">—</span>'],
          ['redirect URI', esc(s.redirectUri)],
        ])}\nchange one: sso <setting> <value> · sso map <group> <role> · sso unmap <group> · sso test`);
      }
      const bool = onOff(key) ?? onOff(v);
      switch (key) {
        case 'on': case 'off': return set({ enabled: key === 'on' }, key === 'on' ? 'enabled' : 'disabled');
        case 'enabled': if (bool === null) return log('usage: sso on|off', 'err'); return set({ enabled: bool }, bool ? 'enabled' : 'disabled');
        case 'issuer': if (!v) return log('usage: sso issuer <https://…>', 'err'); return set({ issuer: v }, `issuer → ${esc(v)}`);
        case 'client': case 'client-id': if (!v) return log('usage: sso client <client id>', 'err'); return set({ clientId: v }, `client ID → ${esc(v)}`);
        case 'secret': if (!v) return log('usage: sso secret <client secret>  (it is not echoed or kept in history)', 'err'); return set({ clientSecret: v }, 'client secret updated');
        case 'scopes': if (!v) return log('usage: sso scopes openid profile email …', 'err'); return set({ scopes: v }, `scopes → ${esc(v)}`);
        case 'label': if (!v) return log('usage: sso label <button text>', 'err'); return set({ label: v }, `button label → ${esc(v)}`);
        case 'autocreate': if (onOff(v) === null) return log('usage: sso autocreate on|off', 'err'); return set({ autoCreate: onOff(v) }, `account auto-creation ${onOff(v) ? 'on' : 'off'}`);
        case 'default-role': if (!v) return log('usage: sso default-role <role>', 'err'); return set({ defaultRole: v }, `first-time SSO users get ${esc(v)}`);
        case 'claim': if (!v) return log('usage: sso claim <claim name>  (default: groups)', 'err'); return set({ roleClaim: v }, `role claim → ${esc(v)}`);
        case 'map': case 'unmap': {
          const s = await serverSettings();
          const map = { ...(s.oidc.roleMap || {}) };
          const [g, role] = r;
          if (!g || (key === 'map' && !role)) return log(`usage: sso ${key} <group>${key === 'map' ? ' <role>' : ''}`, 'err');
          if (key === 'map') map[g] = role; else delete map[g];
          return set({ roleMap: map }, key === 'map' ? `group ${esc(g)} → role ${esc(role)}` : `group ${esc(g)} unmapped`);
        }
        case 'test': {
          const s = await serverSettings();
          try { const t = await api('admin/oidc-test', { method: 'POST', body: { issuer: v || s.oidc.issuer } }); log(`✓ found the provider: ${esc(t.issuer)}`, 'ok'); } catch (e) { fail(e); }
          return;
        }
        default: return log(`unknown SSO setting "${esc(k)}" — type 'sso' for the list`, 'err');
      }
    },

    // ── users ──
    async users() {
      if (denied('users.manage')) return;
      const { users } = await api('admin/users');
      log(`${users.length} user${users.length === 1 ? '' : 's'}:\n${users.map((u) => `  ${esc(u.username.padEnd(18))} ${esc(u.role.padEnd(10))} ${[u.password && 'password', u.oidc && 'SSO'].filter(Boolean).join('+').padEnd(13)} ${u.disabled ? '<span class="warn">disabled</span>' : ''}${u.display !== u.username ? ` <span class="dim">${esc(u.display)}</span>` : ''}`).join('\n')}\nmanage: user add <name> [role] · user role <name> <role> · user disable|enable <name> · user passwd <name> · user delete <name>`);
    },
    async user(a) {
      if (denied('users.manage')) return;
      const [sub, name, ...r] = a;
      try {
        switch ((sub || '').toLowerCase()) {
          case 'add': {
            if (!name) return log('usage: user add <username> [role]  (asks for a password; blank = SSO only)', 'err');
            const pw = prompt(`password for ${name} (8+ characters; leave blank for an SSO-only account):`);
            if (pw === null) return log('cancelled');
            const u = await api('admin/users', { method: 'POST', body: { username: name, role: r[0] || undefined, password: pw || undefined } });
            return log(`added ${esc(u.username)} (${esc(u.role)})`, 'ok');
          }
          case 'role': { if (!name || !r[0]) return log('usage: user role <username> <role>', 'err'); const { u } = await findUser(name); await api(`admin/users/${u.id}`, { method: 'PATCH', body: { role: r[0] } }); return log(`${esc(u.username)} → ${esc(r[0])}`, 'ok'); }
          case 'disable': case 'enable': { if (!name) return log(`usage: user ${sub} <username>`, 'err'); const { u } = await findUser(name); await api(`admin/users/${u.id}`, { method: 'PATCH', body: { disabled: sub === 'disable' } }); return log(`${esc(u.username)} ${sub}d`, sub === 'disable' ? 'warn' : 'ok'); }
          case 'passwd': case 'password': {
            if (!name) return log('usage: user passwd <username>', 'err');
            const { u } = await findUser(name);
            const pw = prompt(`new password for ${u.username} (8+ characters; blank removes password sign-in):`);
            if (pw === null) return log('cancelled');
            await api(`admin/users/${u.id}`, { method: 'PATCH', body: { password: pw || null } });
            return log(`password ${pw ? 'set' : 'removed'} for ${esc(u.username)}`, 'ok');
          }
          case 'delete': case 'rm': {
            if (!name) return log('usage: user delete <username>', 'err');
            const { u } = await findUser(name);
            if (!confirm(`delete ${u.username}? Their votes and tabs are removed and their comments show as deleted.`)) return log('cancelled');
            await api(`admin/users/${u.id}`, { method: 'DELETE' });
            return log(`deleted ${esc(u.username)}`, 'warn');
          }
          default: return log('usage: user add|role|disable|enable|passwd|delete <username> …  ·  users lists them', 'err');
        }
      } catch (e) { fail(e); }
    },

    // ── roles & permissions ──
    async roles() {
      if (denied('users.manage')) return;
      const { roles } = await api('admin/roles');
      log(`roles:\n${roles.map((r) => `  ${esc(r.id.padEnd(11))} ${esc(r.name.padEnd(24))} ${r.perms.length ? esc(r.perms.join(' ')) : '<span class="dim">(no permissions)</span>'}`).join('\n')}\nmanage: role add <id> [name] [from <role>] · role grant|revoke <role> <perm…> · role delete <id> · perms`);
    },
    async perms() {
      if (denied('users.manage')) return;
      const { permissions } = await api('admin/roles');
      log(`permissions:\n${Object.entries(permissions).map(([p, d]) => `  ${esc(p.padEnd(18))} <span class="dim">${esc(d)}</span>`).join('\n')}`);
    },
    async role(a) {
      if (denied('users.manage')) return;
      const [sub, id, ...r] = a;
      try {
        const { roles, permissions } = await api('admin/roles');
        const role = roles.find((x) => x.id === id);
        switch ((sub || '').toLowerCase()) {
          case 'add': {
            if (!id) return log('usage: role add <id> [name…] [from <role>]', 'err');
            const fromAt = r.indexOf('from');
            const base = fromAt >= 0 ? roles.find((x) => x.id === r[fromAt + 1]) : null;
            if (fromAt >= 0 && !base) return log(`no role "${esc(r[fromAt + 1] || '')}" to copy from`, 'err');
            const name = (fromAt >= 0 ? r.slice(0, fromAt) : r).join(' ') || id;
            await api('admin/roles', { method: 'PUT', body: { id, name, perms: base?.perms || [] } });
            return log(`role ${esc(id)} added${base ? ` (copied from ${esc(base.id)})` : ' with no permissions — role grant to add some'}`, 'ok');
          }
          case 'grant': case 'revoke': {
            if (!role || !r.length) return log(`usage: role ${sub} <role> <permission…>  ·  perms lists them`, 'err');
            const bad = r.filter((p) => !(p in permissions));
            if (bad.length) return log(`unknown permission${bad.length > 1 ? 's' : ''}: ${esc(bad.join(' '))} — type 'perms'`, 'err');
            const perms = sub === 'grant' ? [...new Set([...role.perms, ...r])] : role.perms.filter((p) => !r.includes(p));
            await api('admin/roles', { method: 'PUT', body: { ...role, perms } });
            await auth.refresh();
            return log(`${esc(role.name)}: ${sub === 'grant' ? '+' : '−'}${esc(r.join(` ${sub === 'grant' ? '+' : '−'}`))}`, 'ok');
          }
          case 'delete': case 'rm': {
            if (!role) return log('usage: role delete <id>', 'err');
            if (!confirm(`delete the ${role.id} role?`)) return log('cancelled');
            await api(`admin/roles/${role.id}`, { method: 'DELETE' });
            return log(`role ${esc(role.id)} deleted`, 'warn');
          }
          default: return log('usage: role add|grant|revoke|delete …  ·  roles lists them', 'err');
        }
      } catch (e) { fail(e); }
    },

    // everything at a glance (sections you can't see are left out)
    async settings() {
      const m = auth.me, p = reader.prefs();
      const out = [`this browser:\n${kv([
        ['theme', esc(ctx.state.theme)], ['img', yes(ctx.state.img)], ['crt', yes(ctx.state.crt)],
        ['ticker', `${yes(ctx.state.ticker)} · ${esc(ctx.state.tickerSpeed)}`], ['side', esc(ctx.state.pane)], ['srcsort', esc(ctx.state.srcSort)],
        ['blindspot min', String(ctx.state.bmin)], ['discussion', store.get('cmOpen', false) ? 'open' : 'closed'], ['reader', `${p.font} · ${p.size}px`],
      ])}`];
      out.push(m.user ? `your account:\n${kv([['user', `${esc(m.user.display)} @${esc(m.user.username)} (${esc(m.user.role)})`], ['rank', m.rank.mode + (m.rank.budget ? ` · ▲${m.rank.budget.upLeft} ▼${m.rank.budget.downLeft} left today` : '')]])}` : 'your account: not signed in — type login');
      if (auth.can('settings.manage')) out.push("server: type 'server' and 'sso'");
      if (auth.can('users.manage')) out.push("users & roles: type 'users' and 'roles'");
      log(out.join('\n'));
    },
  };
  const ALIAS = { signin: 'login', signout: 'logout', password: 'passwd', ranking: 'rank', comments: 'discussion', oidc: 'sso', permissions: 'perms', config: 'settings', prefs: 'settings' };

  return {
    // → true when the command was one of these
    async handle(cmd, args) {
      const f = H[ALIAS[cmd] || cmd];
      if (!f) return false;
      try { await f(args); } catch (e) { fail(e); }
      return true;
    },
    // what the console echoes / keeps in history (secrets masked)
    redact: (line) => line.replace(/^(\s*(?:sso|oidc)\s+secret\s+).+$/i, '$1••••••••'),
    help: `settings (type one with no value to see the current setting):
  settings             everything at a glance       whoami             your account and permissions
  login | logout       sign in / out                passwd             change your password
  name <display name>  your display name            rank community|personal   ranking mode (+ votes left today)
  discussion open|closed   comment sidebar default  reader font mono|serif|sans · reader size 13–24
  morgue on|off        file live-feed articles in the morgue           [archive.manage]
  server [<setting> <value>]   name url password-login signup default-role rank-default upvotes downvotes  [settings.manage]
  sso [<setting> <value>]      on|off issuer client secret scopes label autocreate default-role claim
                       sso map <group> <role> · sso unmap <group> · sso test                     [settings.manage]
  users · user add|role|disable|enable|passwd|delete <name> …                                     [users.manage]
  roles · perms · role add <id> [name] [from <role>] · role grant|revoke <role> <perm…> · role delete <id>  [users.manage]
  admin [users|roles|settings|sso]   open the admin panel`,
    commands: [
      ['settings', '', 'all settings at a glance'], ['whoami', '', 'your account & permissions'], ['login', '', 'sign in'], ['logout', '', 'sign out'],
      ['passwd', '', 'change your password'], ['name', '<display name>', 'your display name'], ['rank', 'community|personal', 'ranking mode'],
      ['discussion', 'open|closed', 'comment sidebar default'], ['reader', 'font|size <value>', 'reader typeface / size'], ['morgue', 'auto|adhoc|manual|fragment', 'what gets filed in the morgue'],
      ['server', '[setting value]', 'server settings (admin)'], ['sso', '[setting value]', 'single sign-on (admin)'],
      ['users', '', 'list users (admin)'], ['user', 'add|role|disable|enable|passwd|delete', 'manage a user (admin)'],
      ['roles', '', 'list roles (admin)'], ['perms', '', 'list permissions (admin)'], ['role', 'add|grant|revoke|delete', 'manage a role (admin)'],
      ['admin', '[tab]', 'open the admin panel'],
    ],
    // argument completion: (cmd, words before the current one) → [[value, hint]] or null
    complete(cmd, words) {
      const c = ALIAS[cmd] || cmd, n = words.length;
      const bools = [['on', ''], ['off', '']];
      if (c === 'rank') return n ? null : [['community', "everyone's votes"], ['personal', 'your votes']];
      if (c === 'discussion') return n ? null : [['open', ''], ['closed', '']];
      if (c === 'morgue') return n ? null : [['auto', 'every live-feed article'], ['adhoc', 'opened in the reader or saved to a binder'], ['manual', 'binder saves and right-click → File in the morgue'], ['fragment', 'like manual: headline + summary only'], ['fragments', 'on|off: every incoming headline as a fragment']];
      if (c === 'reader') return !n ? [['font', 'mono|serif|sans'], ['size', '13–24']] : n === 1 && words[0] === 'font' ? [['mono', ''], ['serif', ''], ['sans', '']] : null;
      if (c === 'admin') return n ? null : [['users', ''], ['roles', ''], ['settings', ''], ['sso', '']];
      if (c === 'server') {
        if (!n) return [['name', 'site name'], ['url', 'public URL'], ['password-login', 'on|off'], ['signup', 'on|off'], ['default-role', 'role'], ['rank-default', 'community|personal'], ['upvotes', 'per day'], ['downvotes', 'per day']];
        if (n === 1 && ['password-login', 'signup'].includes(words[0])) return bools;
        if (n === 1 && words[0] === 'rank-default') return [['community', ''], ['personal', '']];
        if (n === 1 && words[0] === 'default-role') return ctx.roleIds().map((r) => [r, 'role']);
        return null;
      }
      if (c === 'sso') {
        if (!n) return [['on', ''], ['off', ''], ['issuer', 'URL'], ['client', 'client ID'], ['secret', 'client secret'], ['scopes', ''], ['label', 'button text'], ['autocreate', 'on|off'], ['default-role', 'role'], ['claim', 'groups claim'], ['map', '<group> <role>'], ['unmap', '<group>'], ['test', 'check the issuer']];
        if (n === 1 && words[0] === 'autocreate') return bools;
        if ((n === 1 && words[0] === 'default-role') || (n === 2 && words[0] === 'map')) return ctx.roleIds().map((r) => [r, 'role']);
        return null;
      }
      if (c === 'user') return !n ? [['add', '<name> [role]'], ['role', '<name> <role>'], ['disable', '<name>'], ['enable', '<name>'], ['passwd', '<name>'], ['delete', '<name>']]
        : n === 1 ? ctx.userNames().map((u) => [u, 'user']) : n === 2 && words[0] === 'role' ? ctx.roleIds().map((r) => [r, 'role']) : null;
      if (c === 'role') return !n ? [['add', '<id> [name] [from <role>]'], ['grant', '<role> <perm…>'], ['revoke', '<role> <perm…>'], ['delete', '<id>']]
        : n === 1 && words[0] !== 'add' ? ctx.roleIds().map((r) => [r, 'role'])
          : n >= 2 && ['grant', 'revoke'].includes(words[0]) ? ctx.permNames().map((p) => [p, 'permission']) : null;
      return null;
    },
  };
}
