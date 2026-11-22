// Accounts UI: first-run onboarding, sign-in / sign-up, the header user menu (ranking mode + daily vote budget),
// and the admin panel (users, roles & permissions, server settings, single sign-on).
const BIAS_KEY = { '-2': 'L', '-1': 'LL', 0: 'C', 1: 'LR', 2: 'R' };
const BIAS_LABEL = { '-2': 'LEFT', '-1': 'LEAN LEFT', 0: 'CENTER', 1: 'LEAN RIGHT', 2: 'RIGHT' };

export function createAuth(ctx) {
  const { api, esc, log, chip, onChange } = ctx;
  let me = null;
  const can = (p) => !!me?.perms?.includes(p);

  function dialog(id, cls = '') {
    let d = document.getElementById(id);
    if (!d) { d = document.createElement('dialog'); d.id = id; d.className = cls; document.body.append(d); }
    return d;
  }
  // body classes no-<perm> hide controls a role can't use (css: .needs-<perm>)
  function applyPerms() {
    for (const c of [...document.body.classList]) if (c.startsWith('no-') && c.includes('-perm-')) document.body.classList.remove(c);
    for (const p of ALL_PERMS) if (!can(p)) document.body.classList.add(`no-perm-${p.replace('.', '-')}`);
    document.body.classList.toggle('signed-in', !!me?.user);
  }
  const ALL_PERMS = ['news.read', 'reader.fetch', 'vote.personal', 'vote.community', 'queries.save', 'binder.use', 'comments.read', 'comments.post',
    'comments.moderate', 'sources.manage', 'archive.manage', 'users.manage', 'settings.manage'];

  async function refresh() {
    me = await api('me');
    applyPerms();
    renderHeader();
    return me;
  }

  // ── header: who you are, ranking mode, community votes left today ──
  function renderHeader() {
    const el = document.getElementById('st-user');
    if (!el) return;
    const r = me.rank || {};
    const b = r.budget;
    const user = me.user
      ? `<span class="dim">user</span> <button type="button" class="link" id="user-menu-btn" title="account menu">${esc(me.user.display)} ▾</button>`
      : `<span class="dim">user</span> <button type="button" class="link" id="sign-in-btn" title="sign in to vote, comment and save your own tabs">[sign in]</button>`;
    const mode = `<span class="dim">rank</span> <button type="button" class="link rank-mode" id="rank-btn" title="${r.mode === 'community'
      ? `COMMUNITY ranking: outlets weighted by everyone's votes — each user gets ${me.site.ranking.upPerDay} upvotes and ${me.site.ranking.downPerDay} downvotes a day`
      : 'PERSONAL ranking: outlets weighted by your own votes only'}${me.user && can('vote.personal') ? ' — click to switch' : me.user ? '' : ' — sign in to use your own ranking'}">${r.mode === 'community' ? 'COMMUNITY' : 'PERSONAL'}</button>${
      r.mode === 'community' && b ? ` <span class="dim budget" title="community votes you have left today (they reset at 00:00 UTC)">▲${b.upLeft} ▼${b.downLeft}</span>` : ''}`;
    el.innerHTML = `${user} <span class="dim">·</span> ${mode}`;
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('#sign-in-btn')) return openLogin();
    if (e.target.closest('#user-menu-btn')) return toggleMenu(e.target.closest('#user-menu-btn'));
    if (e.target.closest('#rank-btn')) return switchRank();
    if (!e.target.closest('.user-menu')) closeMenu();
  });

  async function switchRank(to) {
    if (!me.user) return openLogin('sign in to rank outlets by your own votes');
    if (!can('vote.personal')) return log('your role ranks by community votes only', 'warn');
    const next = to || (me.rank.mode === 'community' ? 'personal' : 'community');
    me = await api('me/prefs', { method: 'PATCH', body: { rankMode: next } });
    renderHeader();
    log(`ranking → ${next === 'community' ? "COMMUNITY (everyone's votes)" : 'PERSONAL (your votes)'}`, 'ok');
    onChange?.('rank');
  }

  let menu = null;
  function closeMenu() { menu?.remove(); menu = null; }
  function toggleMenu(anchor) {
    if (menu) return closeMenu();
    menu = document.createElement('div');
    menu.className = 'user-menu';
    const u = me.user;
    menu.innerHTML = `
      <div class="um-head">${esc(u.display)} <span class="dim">@${esc(u.username)} · ${esc(u.role)}</span></div>
      ${can('vote.personal') ? `<button type="button" data-um="rank">ranking: ${me.rank.mode === 'community' ? '<b>community</b> / personal' : 'community / <b>personal</b>'}</button>` : ''}
      ${can('users.manage') || can('settings.manage') ? '<button type="button" data-um="admin">admin panel…</button>' : ''}
      ${can('reader.fetch') ? '<button type="button" data-um="extension">browser extension…</button>' : ''}
      ${u.password ? '<button type="button" data-um="password">change password…</button>' : ''}
      <button type="button" data-um="logout">sign out</button>`;
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
    document.body.append(menu);
    menu.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-um]')?.dataset.um;
      if (!a) return;
      closeMenu();
      if (a === 'rank') switchRank();
      else if (a === 'admin') openAdmin();
      else if (a === 'password') openPassword();
      else if (a === 'extension') openExtension();
      else if (a === 'logout') { await api('auth/logout', { method: 'POST' }); location.reload(); }
    });
  }

  // ── sign in / sign up ──
  function openLogin(why = '') {
    const d = dialog('dlg-login');
    const s = me.site;
    let signup = false;
    const render = (err = '') => {
      d.innerHTML = `<form class="dlg login-dlg" method="dialog">
        <div class="dlg-head"><span>// ${signup ? 'CREATE ACCOUNT' : 'SIGN IN'} <span class="dim">— ${esc(s.siteName)}</span></span><button type="button" class="link" data-act="close" title="close (esc)">[esc]</button></div>
        ${why ? `<div class="dim small">${esc(why)}</div>` : ''}
        ${s.oidc.enabled && !signup ? `<button type="button" class="primary sso-btn" data-act="sso">▶ ${esc(s.oidc.label || 'Sign in with SSO')}</button>${s.localLogin ? '<div class="or dim">— or —</div>' : ''}` : ''}
        ${s.localLogin ? `
          ${signup ? '<label class="field"><span>display name</span><input name="display" maxlength="60" autocomplete="name" /></label>' : ''}
          <label class="field"><span>username</span><input name="username" required autocomplete="username" spellcheck="false" /></label>
          <label class="field"><span>password${signup ? ' (8+ characters)' : ''}</span><input name="password" type="password" required autocomplete="${signup ? 'new-password' : 'current-password'}" /></label>
          ${signup ? '<label class="field"><span>email (optional — links your SSO sign-in later)</span><input name="email" type="email" autocomplete="email" /></label>' : ''}
          <div class="err small" id="login-err">${esc(err)}</div>
          <div class="dlg-foot">${s.signup ? `<button type="button" class="link" data-act="mode">${signup ? '[have an account? sign in]' : '[create an account]'}</button><span class="qb-sp"></span>` : ''}
            <button type="submit" class="primary">${signup ? 'CREATE ACCOUNT ⏎' : 'SIGN IN ⏎'}</button></div>` : `<div class="err small">${esc(err)}</div>`}
      </form>`;
      d.querySelector('input')?.focus();
    };
    render(new URLSearchParams(location.search).get('login_error') || '');
    d.onclick = (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (e.target === d || a === 'close') d.close();
      else if (a === 'sso') location.href = `/auth/oidc/login?return=${encodeURIComponent(location.pathname + location.hash)}`;
      else if (a === 'mode') { signup = !signup; render(); }
    };
    d.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        me = await api(signup ? 'auth/signup' : 'auth/login', { method: 'POST', body: f });
        d.close();
        applyPerms(); renderHeader();
        log(`signed in as ${esc(me.user.display)}`, 'ok');
        onChange?.('login');
      } catch (err) { render(err.message); }
    };
    if (!d.open) d.showModal();
  }

  function openPassword() {
    const d = dialog('dlg-password');
    d.innerHTML = `<form class="dlg" method="dialog">
      <div class="dlg-head"><span>// CHANGE PASSWORD</span><button type="button" class="link" data-act="close" title="close (esc)">[esc]</button></div>
      <label class="field"><span>current password</span><input name="current" type="password" required autocomplete="current-password" /></label>
      <label class="field"><span>new password (8+ characters)</span><input name="password" type="password" required autocomplete="new-password" /></label>
      <div class="err small" id="pw-err"></div>
      <div class="dlg-foot"><button type="submit" class="primary">SAVE ⏎</button></div></form>`;
    d.onclick = (e) => { if (e.target === d || e.target.closest('[data-act=close]')) d.close(); };
    d.onsubmit = async (e) => {
      e.preventDefault();
      try { await api('me/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); d.close(); log('password changed', 'ok'); }
      catch (err) { d.querySelector('#pw-err').textContent = err.message; }
    };
    d.showModal();
    d.querySelector('input').focus();
  }

  // ── the browser extension: file the page you're reading (subscriber pages too) with a filing key ──
  async function openExtension() {
    const d = dialog('dlg-extension');
    let made = null, msg = '';
    const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
    const render = async () => {
      let keys = [];
      try { keys = (await api('me/filing-keys')).keys; } catch (e) { msg = e.message; }
      d.innerHTML = `<div class="dlg ext-dlg">
        <div class="st-head"><div class="dlg-head"><span>// BROWSER EXTENSION</span><button type="button" class="link" data-act="close" title="close (esc)">[esc]</button></div></div>
        <p class="dim">File the article you're reading into the morgue, as your browser shows it — including pages from outlets that turn STRINGER away, and subscriber articles you're signed in to. It only reads the tab you file, when you click.</p>
        <div class="ext-step"><b>1 · install it</b> — <a href="/api/extension.zip" download>download the extension (.zip)</a>, unzip it, then:
          <div class="dim small">Chrome / Edge / Brave: <code>chrome://extensions</code> → turn on Developer mode → <b>Load unpacked</b> → pick the unzipped folder.<br>
          Firefox: <code>about:debugging#/runtime/this-firefox</code> → <b>Load Temporary Add-on</b> → pick <code>manifest.json</code> (Firefox forgets it on restart).</div></div>
        <div class="ext-step"><b>2 · server address</b> — paste into the extension's settings: <code class="ext-copy" data-copy="${esc(location.origin)}" title="click to copy">${esc(location.origin)}</code></div>
        <div class="ext-step"><b>3 · a filing key</b> — it can only file articles in your name; revoke it here any time.
          <div class="ext-make"><input data-key-name maxlength="40" placeholder="name it, e.g. laptop chrome" /> <button type="button" data-act="make">MAKE A KEY</button></div>
          ${made ? `<div class="ext-new">your new key — copy it now, it won't be shown again:<br><code class="ext-copy ext-key" data-copy="${esc(made.key)}" title="click to copy">${esc(made.key)}</code></div>` : ''}
          ${msg ? `<div class="err small">${esc(msg)}</div>` : ''}</div>
        <div class="ext-keys">${keys.length ? keys.map((k) => `<div class="ext-keyrow"><span>${esc(k.name)}</span><span class="dim small">made ${esc(ago(k.created))} · last used ${esc(ago(k.lastUsed))}</span><button type="button" class="link err" data-revoke="${k.id}">[revoke]</button></div>`).join('') : '<div class="dim small">no keys yet</div>'}</div>
        <div class="st-foot-bar"><span class="dim">esc close · in the browser: click the extension or press <b>Alt+Shift+F</b> to file the page</span><button type="button" data-act="close">CLOSE</button></div>
      </div>`;
    };
    d.onclick = async (e) => {
      if (e.target === d || e.target.closest('[data-act=close]')) return d.close();
      const cp = e.target.closest('[data-copy]');
      if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); log('⧉ copied', 'ok'); } catch { log("couldn't copy (clipboard blocked)", 'warn'); } return; }
      if (e.target.closest('[data-act=make]')) {
        try { made = await api('me/filing-keys', { method: 'POST', body: { name: d.querySelector('[data-key-name]').value } }); msg = ''; log('🔑 filing key made — paste it into the extension', 'ok'); }
        catch (err) { msg = err.message; }
        return render();
      }
      const rv = e.target.closest('[data-revoke]');
      if (rv && confirm('revoke this filing key? the extension using it stops working until you give it a new one')) {
        try { await api(`me/filing-keys/${rv.dataset.revoke}`, { method: 'DELETE' }); made = null; log('filing key revoked'); } catch (err) { msg = err.message; }
        return render();
      }
    };
    d.onkeydown = (e) => { if (e.target.matches?.('input')) e.stopPropagation(); if (e.key === 'Enter' && e.target.matches?.('[data-key-name]')) { e.preventDefault(); d.querySelector('[data-act=make]').click(); } };
    await render();
    d.showModal();
  }

  // ── first run ──
  async function onboarding() {
    const info = await api('setup');
    const d = dialog('dlg-setup', 'wide-dlg setup-dlg');
    const fresh = !info.sources.some((s) => s.enabled);
    const picked = new Set(info.sources.filter((s) => fresh || s.enabled).map((s) => s.id));
    const form = { token: '', siteName: me.site.siteName, username: 'admin', display: '', email: '', password: '', password2: '',
      // an upgraded server keeps its current archive settings; a new one suggests building the archive
      backfill: info.archive?.total > 0 ? !!info.archive.backfill?.running : true,
      since: info.archive?.backfill?.since ? new Date(info.archive.backfill.since).toISOString().slice(0, 10) : '2015-01-01',
      morgueMode: info.archive?.morgueMode || 'fragment', fragmentAll: info.archive ? info.archive.fragmentAll !== false : true, guestAccess: true, rankMode: 'community' };
    let step = 0, err = '';
    // outlets the admin adds that aren't in the default list: { id, name, feed, site, bias, type }
    const custom = [];
    let found = null, addMsg = '', addBusy = false;
    const steps = ['ADMIN ACCOUNT', 'OUTLETS', 'ARCHIVE & ACCESS'];
    const grab = () => {
      for (const el of d.querySelectorAll('[data-f]')) form[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
      for (const el of d.querySelectorAll('[data-src]')) el.checked ? picked.add(el.dataset.src) : picked.delete(el.dataset.src);
      const mm = d.querySelector('[data-morgue-mode]:checked');
      if (mm) form.morgueMode = mm.value;
    };
    const render = () => {
      const groups = [-2, -1, 0, 1, 2].map((b) => [b, info.sources.filter((s) => s.bias === b)]);
      const body = step === 0 ? `
          <p class="dim">Welcome. This server isn't set up yet — you're creating its first account, which will be the admin.</p>
          <label class="field"><span>setup code <span class="dim">— printed in the server's log when it started (also in data/setup-token.txt)</span></span><input data-f="token" value="${esc(form.token)}" autocomplete="off" spellcheck="false" /></label>
          <label class="field"><span>site name</span><input data-f="siteName" value="${esc(form.siteName)}" maxlength="40" /></label>
          <div class="row2">
            <label class="field"><span>admin username</span><input data-f="username" value="${esc(form.username)}" autocomplete="username" spellcheck="false" /></label>
            <label class="field"><span>display name</span><input data-f="display" value="${esc(form.display)}" placeholder="optional" /></label>
          </div>
          <label class="field"><span>email <span class="dim">— optional; lets you link single sign-on to this account later</span></span><input data-f="email" type="email" value="${esc(form.email)}" /></label>
          <div class="row2">
            <label class="field"><span>password (8+ characters)</span><input data-f="password" type="password" value="${esc(form.password)}" autocomplete="new-password" /></label>
            <label class="field"><span>repeat password</span><input data-f="password2" type="password" value="${esc(form.password2)}" autocomplete="new-password" /></label>
          </div>
          ${info.migrate.tabs || info.migrate.votes ? `<div class="setup-note">⟲ this server already has ${info.migrate.tabs} saved tab${info.migrate.tabs === 1 ? '' : 's'} and votes on ${info.migrate.votes} outlet${info.migrate.votes === 1 ? '' : 's'} from before accounts existed — they'll become this admin's own tabs and personal votes.</div>` : ''}`
        : step === 1 ? `
          <p class="dim">Pick the outlets this server follows${custom.length ? '' : ', and add any that aren\'t listed (below)'}. You can add, remove and re-rate outlets any time from the SOURCES tab. <b>${picked.size + custom.length}</b> selected.</p>
          <div class="setup-src">${groups.map(([b, list]) => {
            const mine = custom.filter((c) => c.bias === b);
            return list.length || mine.length ? `<div class="ss-group">
            <div class="ss-group-h">${chip(b)} ${BIAS_LABEL[b]} <span class="dim">${list.filter((s) => picked.has(s.id)).length + mine.length}/${list.length + mine.length}</span>
              <button type="button" class="link" data-grp="${b}" data-on="1">[all]</button><button type="button" class="link" data-grp="${b}" data-on="0">[none]</button></div>
            ${list.map((s) => `<label class="ss-src" title="${esc(s.site || '')}"><input type="checkbox" data-src="${esc(s.id)}" ${picked.has(s.id) ? 'checked' : ''} /> ${esc(s.name)} <span class="dim">${s.type === 'new' ? 'new' : ''}</span></label>`).join('')}
            ${mine.map((c) => `<div class="ss-src ss-custom" title="${esc(c.feed)}"><input type="checkbox" checked disabled /> ${esc(c.name)} <span class="dim">added${c.type === 'new' ? ' · new' : ''}</span> <button type="button" class="link err" data-rmc="${esc(c.id)}" title="remove">×</button></div>`).join('')}
          </div>` : '';
          }).join('')}</div>
          <div class="setup-add">
            <div class="ss-group-h">+ ADD AN OUTLET THAT ISN'T LISTED</div>
            <div class="row"><input data-add="url" placeholder="site or feed URL — e.g. https://example.com or https://example.com/feed" spellcheck="false" value="${esc(found?.query || '')}" />
              <button type="button" data-act="discover" ${addBusy ? 'disabled' : ''}>${addBusy ? 'LOOKING…' : 'FIND FEED'}</button></div>
            ${addMsg ? `<div class="small ${addMsg.startsWith('✗') ? 'err' : 'dim'}">${esc(addMsg)}</div>` : ''}
            ${found?.feed ? `
              <div class="dim small">found <code>${esc(found.feed)}</code> · ${found.count} items${found.sample?.length ? ` — e.g. “${esc(found.sample[0])}”` : ''}</div>
              <div class="row2">
                <label class="field"><span>name</span><input data-add="name" value="${esc(found.name || '')}" maxlength="80" /></label>
                <div class="field"><span>media type</span><div class="bias-pick">
                  <label><input type="radio" name="addtype" value="legacy" ${found.type === 'legacy' ? 'checked' : ''} />LEGACY</label>
                  <label><input type="radio" name="addtype" value="new" ${found.type !== 'legacy' ? 'checked' : ''} />NEW MEDIA</label></div></div>
              </div>
              <div class="field"><span>bias rating</span><div class="bias-pick">${[-2, -1, 0, 1, 2].map((b) => `<label class="b-${BIAS_KEY[b]}"><input type="radio" name="addbias" value="${b}" ${found.bias === b ? 'checked' : ''} />${BIAS_LABEL[b]}</label>`).join('')}</div></div>
              <div class="dlg-foot"><button type="button" class="link" data-act="add-cancel">[cancel]</button><button type="button" data-act="add-custom">ADD OUTLET</button></div>` : ''}
          </div>`
        : `
          <label class="chk"><input type="checkbox" data-f="backfill" ${form.backfill ? 'checked' : ''} /> build the historical archive in the background, back to
            <input data-f="since" type="date" value="${esc(form.since)}" min="1990-01-01" /></label>
          <div class="dim small indent">crawls outlet sitemaps, Wayback Machine snapshots of their feeds and Hacker News. It's polite, so it takes hours to days, and the archive can grow to 10+ GB.${info.archive?.total ? ` The archive already holds ${info.archive.total.toLocaleString()} articles.` : ''}</div>
          <div class="field"><span>the morgue — what gets filed</span><div class="row2 morgue-modes">${[['auto', 'AUTO', 'every live-feed article'], ['adhoc', 'AD-HOC', 'what people open in the reader or save to a binder'], ['manual', 'MANUAL', 'only binder saves and right-click → File in the morgue'], ['fragment', 'FRAGMENT', 'like manual, headline + summary only']].map(([k, l, d]) => `<label class="chk"><input type="radio" name="morgueMode" value="${k}" ${form.morgueMode === k ? 'checked' : ''} data-morgue-mode /> ${l} <span class="dim">— ${d}</span></label>`).join('')}</div>
            <label class="chk"><input type="checkbox" data-f="fragmentAll" ${form.fragmentAll ? 'checked' : ''} /> also file every incoming headline + summary as a fragment <span class="dim">(builds a record of headlines and summaries in any mode)</span></label></div>
          <label class="chk"><input type="checkbox" data-f="guestAccess" ${form.guestAccess ? 'checked' : ''} /> let visitors read without signing in <span class="dim">(they can't vote, comment or save tabs)</span></label>
          <div class="field"><span>default ranking</span><div class="bias-pick">
            <label><input type="radio" name="rm" data-rm="community" ${form.rankMode === 'community' ? 'checked' : ''} />COMMUNITY</label>
            <label><input type="radio" name="rm" data-rm="personal" ${form.rankMode === 'personal' ? 'checked' : ''} />PERSONAL</label></div>
            <div class="dim small">community: outlets weighted by everyone's votes (3 up / 3 down per user per day). personal: each user's own votes. Users can switch.</div></div>
          <div class="dim small">Sign-in with OIDC (Authentik, Keycloak, Authelia…), roles and permissions are in the admin panel after setup.</div>`;
      d.innerHTML = `<div class="dlg">
        <div class="dlg-head"><span>// SET UP ${esc(form.siteName || 'STRINGER')} <span class="dim">— step ${step + 1} of 3: ${steps[step]}</span></span></div>
        <div class="setup-steps">${steps.map((t, k) => `<span class="${k === step ? 'on' : k < step ? 'done' : ''}">${k + 1} ${t}</span>`).join('')}</div>
        ${body}
        <div class="err small">${esc(err)}</div>
        <div class="dlg-foot">${step ? '<button type="button" data-act="back">◂ BACK</button>' : ''}<span class="qb-sp"></span>
          <button type="button" class="primary" data-act="next">${step < 2 ? 'NEXT ▸' : 'FINISH SETUP ⏎'}</button></div></div>`;
      d.querySelector('input:not([type=checkbox])')?.focus();
    };
    d.addEventListener('cancel', (e) => e.preventDefault());           // can't be dismissed
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-add=url]')) { e.preventDefault(); d.querySelector('[data-act=discover]')?.click(); }
    });
    d.addEventListener('change', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) form.rankMode = rm.dataset.rm;
      if (found?.feed) {
        if (e.target.name === 'addbias') found.bias = Number(e.target.value);
        if (e.target.name === 'addtype') found.type = e.target.value;
        const n = d.querySelector('[data-add=name]'); if (n) found.name = n.value;
      }
      if (e.target.dataset.src) { grab(); render(); }
    });
    d.addEventListener('click', async (e) => {
      const g = e.target.closest('[data-grp]');
      if (g) { grab(); for (const s of info.sources) if (String(s.bias) === g.dataset.grp) g.dataset.on === '1' ? picked.add(s.id) : picked.delete(s.id); return render(); }
      const rmc = e.target.closest('[data-rmc]');
      if (rmc) { grab(); custom.splice(custom.findIndex((c) => c.id === rmc.dataset.rmc), 1); return render(); }
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (!a) return;
      grab();
      if (a === 'discover') {
        const q = d.querySelector('[data-add=url]').value.trim();
        if (!q) return;
        addBusy = true; addMsg = ''; found = { query: q }; render();
        try {
          const r = await api('setup/discover', { method: 'POST', body: { url: q, token: form.token } });
          if (custom.some((c) => c.feed === r.feed) || info.sources.some((s) => s.feed === r.feed)) { addMsg = '✗ that feed is already in the list'; found = { query: q }; }
          else found = { ...r, query: q, name: (r.title || '').split(/\s[|\-–—:]\s/)[0].slice(0, 80), bias: null, type: 'new' };
        } catch (ex) { addMsg = `✗ ${ex.message}`; found = { query: q }; }
        addBusy = false;
        return render();
      }
      if (a === 'add-cancel') { found = null; addMsg = ''; return render(); }
      if (a === 'add-custom') {
        const name = d.querySelector('[data-add=name]').value.trim();
        const bias = d.querySelector('[name=addbias]:checked')?.value;
        if (!name) { addMsg = '✗ give the outlet a name'; return render(); }
        if (bias == null) { addMsg = '✗ pick a bias rating'; return render(); }
        custom.push({ id: `c${Date.now()}`, name, feed: found.feed, site: found.site, bias: Number(bias), type: d.querySelector('[name=addtype]:checked')?.value || 'new' });
        addMsg = `added ${name}`; found = null;
        return render();
      }
      err = '';
      if (a === 'back') { step--; return render(); }
      if (step === 0) {
        if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(form.username)) err = 'username: 2–32 letters, digits, dots, dashes or underscores';
        else if (form.password.length < 8) err = 'the password needs at least 8 characters';
        else if (form.password !== form.password2) err = "the passwords don't match";
        if (err) return render();
        // the setup code first, so a wrong one is caught now rather than after the last step
        try { await api('setup/check', { method: 'POST', body: { token: form.token } }); }
        catch (ex) { err = ex.message; return render(); }
      }
      if (step === 1 && !picked.size && !custom.length) { err = 'pick at least one outlet'; return render(); }
      if (step < 2) { step++; return render(); }
      const btn = e.target.closest('button'); btn.disabled = true; btn.textContent = 'SETTING UP…';
      try {
        me = await api('setup', { method: 'POST', body: { token: form.token, siteName: form.siteName, admin: { username: form.username, display: form.display || form.username, email: form.email, password: form.password },
          sources: [...picked], custom: custom.map(({ id, ...c }) => c), backfill: { enabled: form.backfill, since: form.since }, morgueMode: form.morgueMode, fragmentAll: form.fragmentAll, guestAccess: form.guestAccess, rankMode: form.rankMode } });
        location.reload();
      } catch (ex) { err = ex.message; if (ex.data?.setupCode) step = 0; render(); }    // (the server restarted: a new code)
    });
    render();
    d.showModal();
    return new Promise(() => {});                                     // the page reloads when setup finishes
  }

  // ── admin panel ──
  async function openAdmin(tab) {
    const d = dialog('dlg-admin', 'wide-dlg admin-dlg');
    const tabs = [can('users.manage') && ['users', 'USERS'], can('users.manage') && ['roles', 'ROLES & PERMISSIONS'], can('settings.manage') && ['settings', 'SETTINGS'], can('settings.manage') && ['sso', 'SINGLE SIGN-ON']].filter(Boolean);
    let cur = tab || tabs[0][0], data = {}, msg = '';
    const load = async () => {
      if (cur === 'users') data = await api('admin/users');
      else if (cur === 'roles') data = await api('admin/roles');
      else { data = { settings: await api('admin/settings'), roles: (await api('admin/roles').catch(() => ({ roles: [] }))).roles }; }
    };
    const roleOpts = (roles, sel) => roles.map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    const fmt = (t) => (t ? new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
    const render = () => {
      let body = '';
      if (cur === 'users') {
        const roles = data.roles.filter((r) => r.id !== 'guest');
        body = `<table class="ad-table"><thead><tr><th>user</th><th>role</th><th>sign-in</th><th>joined</th><th>last seen</th><th></th></tr></thead><tbody>
          ${data.users.map((u) => `<tr class="${u.disabled ? 'off' : ''}" data-uid="${u.id}">
            <td><b>${esc(u.display)}</b> <span class="dim">@${esc(u.username)}</span>${u.email ? `<div class="dim small">${esc(u.email)}</div>` : ''}</td>
            <td><select data-urole>${roleOpts(roles, u.role)}</select></td>
            <td class="small">${[u.password && 'password', u.oidc && 'SSO'].filter(Boolean).join(' + ') || '<span class="warn">none</span>'}</td>
            <td class="small">${fmt(u.created)}</td><td class="small">${fmt(u.lastLogin)}</td>
            <td class="ad-acts"><button type="button" class="link" data-uact="pw">[set password]</button>
              <button type="button" class="link" data-uact="${u.disabled ? 'enable' : 'disable'}">[${u.disabled ? 'enable' : 'disable'}]</button>
              <button type="button" class="link err" data-uact="delete">[delete]</button></td></tr>`).join('')}
          </tbody></table>
          <form class="ad-add" data-form="adduser"><b>add user</b>
            <input name="username" placeholder="username" required spellcheck="false" /><input name="display" placeholder="display name" />
            <select name="role">${roleOpts(roles, me.site.defaultRole || 'member')}</select>
            <input name="password" type="password" placeholder="password (blank = SSO only)" autocomplete="new-password" />
            <button type="submit">ADD</button></form>`;
      } else if (cur === 'roles') {
        const perms = Object.entries(data.permissions);
        body = `<div class="dim small">Each user has one role; a role is a set of permissions. <b>Guest</b> applies to visitors who aren't signed in — clear it to make the server private. Built-in roles can be edited, not deleted.</div>
          <div class="ad-matrix-wrap"><table class="ad-table ad-matrix"><thead><tr><th>permission</th>${data.roles.map((r) => `<th title="${esc(r.id)}">${esc(r.name)}${r.builtin ? '' : ` <button type="button" class="link err" data-delrole="${esc(r.id)}" title="delete role">×</button>`}</th>`).join('')}</tr></thead><tbody>
          ${perms.map(([p, desc]) => `<tr><td><code>${esc(p)}</code><div class="dim small">${esc(desc)}</div></td>${data.roles.map((r) => `<td class="c"><input type="checkbox" data-role="${esc(r.id)}" data-perm="${esc(p)}" ${r.perms.includes(p) ? 'checked' : ''} /></td>`).join('')}</tr>`).join('')}
          </tbody></table></div>
          <form class="ad-add" data-form="addrole"><b>new role</b><input name="id" placeholder="id (e.g. editor)" required pattern="[a-z][a-z0-9-]{1,30}" /><input name="name" placeholder="name" required />
            <span class="dim small">copy from</span><select name="from">${roleOpts(data.roles, 'member')}</select><button type="submit">ADD ROLE</button></form>`;
      } else if (cur === 'settings') {
        const s = data.settings, r = s.ranking;
        body = `<form class="ad-form" data-form="settings">
          <label class="field"><span>site name</span><input name="siteName" value="${esc(s.siteName)}" maxlength="40" /></label>
          <label class="field"><span>public URL <span class="dim">— how people reach this server, e.g. https://news.example.org (used for the SSO redirect; blank = from the request)</span></span><input name="baseUrl" value="${esc(s.baseUrl)}" placeholder="https://…" spellcheck="false" /></label>
          <div class="field"><span>ranking</span><div class="row">
            <label>default <select name="defaultMode"><option value="community" ${r.defaultMode === 'community' ? 'selected' : ''}>community</option><option value="personal" ${r.defaultMode === 'personal' ? 'selected' : ''}>personal</option></select></label>
            <label>community upvotes / user / day <input name="upPerDay" type="number" min="0" max="100" value="${r.upPerDay}" class="num" /></label>
            <label>downvotes <input name="downPerDay" type="number" min="0" max="100" value="${r.downPerDay}" class="num" /></label></div></div>
          <div class="field"><span>accounts</span>
            <label class="chk"><input type="checkbox" name="localLogin" ${s.localLogin ? 'checked' : ''} /> allow username + password sign-in</label>
            <label class="chk"><input type="checkbox" name="signup" ${s.signup ? 'checked' : ''} /> anyone can create a password account</label>
            <label>new accounts get the role <select name="defaultRole">${roleOpts(data.roles.filter((x) => x.id !== 'guest'), s.defaultRole)}</select></label></div>
          <div class="dlg-foot"><button type="submit" class="primary">SAVE SETTINGS</button></div></form>`;
      } else {
        const o = data.settings.oidc;
        body = `<form class="ad-form" data-form="sso">
          <div class="dim small">Any OpenID Connect provider works (Authentik, Authelia, Keycloak, Zitadel, Google, Microsoft Entra…). Create a confidential client there with this redirect URI:</div>
          <div class="ad-redirect"><code>${esc(data.settings.redirectUri)}</code> <button type="button" class="link" data-copy="${esc(data.settings.redirectUri)}">[copy]</button></div>
          <label class="chk"><input type="checkbox" name="enabled" ${o.enabled ? 'checked' : ''} /> enable single sign-on</label>
          <label class="field"><span>issuer URL</span><div class="row"><input name="issuer" value="${esc(o.issuer)}" placeholder="https://auth.example.org/application/o/stringer" spellcheck="false" /><button type="button" data-act="test">TEST</button></div></label>
          <div class="row2"><label class="field"><span>client ID</span><input name="clientId" value="${esc(o.clientId)}" spellcheck="false" /></label>
            <label class="field"><span>client secret ${o.hasSecret ? '<span class="dim">(set — leave blank to keep)</span>' : ''}</span><input name="clientSecret" type="password" placeholder="${o.hasSecret ? '••••••••' : ''}" autocomplete="off" /></label></div>
          <div class="row2"><label class="field"><span>scopes</span><input name="scopes" value="${esc(o.scopes)}" /></label>
            <label class="field"><span>button label</span><input name="label" value="${esc(o.label)}" /></label></div>
          <label class="chk"><input type="checkbox" name="autoCreate" ${o.autoCreate ? 'checked' : ''} /> create an account the first time someone signs in</label>
          <label>first-time SSO users get the role <select name="defaultRole">${roleOpts(data.roles.filter((x) => x.id !== 'guest'), o.defaultRole)}</select></label>
          <label class="field"><span>group → role mapping <span class="dim">— one per line, "group = role", read from the <input name="roleClaim" value="${esc(o.roleClaim)}" class="claim" /> claim; applied at every sign-in</span></span>
            <textarea name="roleMap" rows="3" spellcheck="false" placeholder="stringer-admins = admin">${esc(Object.entries(o.roleMap || {}).map(([g, r]) => `${g} = ${r}`).join('\n'))}</textarea></label>
          <div class="dlg-foot"><button type="submit" class="primary">SAVE SSO SETTINGS</button></div></form>`;
      }
      d.innerHTML = `<div class="dlg">
        <div class="dlg-head"><span>// ADMIN</span><button type="button" class="link" data-act="close" title="close (esc)">[esc]</button></div>
        <div class="ad-tabs">${tabs.map(([k, t]) => `<button type="button" class="${k === cur ? 'on' : ''}" data-tab="${k}">${t}</button>`).join('')}</div>
        <div class="ad-msg ${msg.startsWith('✗') ? 'err' : 'ok'}">${esc(msg)}</div>
        ${body}</div>`;
    };
    const say = (m) => { msg = m; render(); };
    const act = async (fn, ok) => { try { await fn(); await load(); say(ok); } catch (e) { say(`✗ ${e.message}`); } };
    d.onclick = async (e) => {
      if (e.target === d || e.target.closest('[data-act=close]')) return d.close();
      const t = e.target.closest('[data-tab]');
      if (t) { cur = t.dataset.tab; msg = ''; await load(); return render(); }
      const c = e.target.closest('[data-copy]');
      if (c) return navigator.clipboard?.writeText(c.dataset.copy).then(() => say('copied the redirect URI'));
      if (e.target.closest('[data-act=test]')) {
        const issuer = d.querySelector('[name=issuer]').value;
        try { const r = await api('admin/oidc-test', { method: 'POST', body: { issuer } }); say(`✓ found the provider: ${r.issuer}`); } catch (ex) { say(`✗ ${ex.message}`); }
        return;
      }
      const ua = e.target.closest('[data-uact]');
      if (ua) {
        const id = Number(ua.closest('[data-uid]').dataset.uid), u = data.users.find((x) => x.id === id);
        if (ua.dataset.uact === 'pw') { const pw = prompt(`new password for ${u.username} (8+ characters, blank to remove password sign-in):`); if (pw === null) return; return act(() => api(`admin/users/${id}`, { method: 'PATCH', body: { password: pw || null } }), `password ${pw ? 'set' : 'removed'} for ${u.username}`); }
        if (ua.dataset.uact === 'delete') { if (!confirm(`delete ${u.username}? Their votes and tabs are removed and their comments show as deleted.`)) return; return act(() => api(`admin/users/${id}`, { method: 'DELETE' }), `deleted ${u.username}`); }
        return act(() => api(`admin/users/${id}`, { method: 'PATCH', body: { disabled: ua.dataset.uact === 'disable' } }), `${u.username} ${ua.dataset.uact}d`);
      }
      const dr = e.target.closest('[data-delrole]');
      if (dr && confirm(`delete the ${dr.dataset.delrole} role?`)) return act(() => api(`admin/roles/${dr.dataset.delrole}`, { method: 'DELETE' }), `role ${dr.dataset.delrole} deleted`);
    };
    d.onchange = async (e) => {
      const sel = e.target.closest('[data-urole]');
      if (sel) { const id = Number(sel.closest('[data-uid]').dataset.uid); return act(() => api(`admin/users/${id}`, { method: 'PATCH', body: { role: sel.value } }), 'role changed'); }
      const box = e.target.closest('[data-perm]');
      if (box) {
        const role = data.roles.find((r) => r.id === box.dataset.role);
        const perms = box.checked ? [...role.perms, box.dataset.perm] : role.perms.filter((p) => p !== box.dataset.perm);
        return act(() => api('admin/roles', { method: 'PUT', body: { ...role, perms } }), `${role.name}: ${box.checked ? '+' : '−'}${box.dataset.perm}`);
      }
    };
    d.onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, kind = f.dataset.form, v = Object.fromEntries(new FormData(f));
      const box = (n) => !!f.querySelector(`[name=${n}]`)?.checked;
      if (kind === 'adduser') return act(() => api('admin/users', { method: 'POST', body: v }), `added ${v.username}`);
      if (kind === 'addrole') { const base = data.roles.find((r) => r.id === v.from); return act(() => api('admin/roles', { method: 'PUT', body: { id: v.id, name: v.name, perms: base?.perms || [] } }), `role ${v.name} added`); }
      if (kind === 'settings') return act(() => api('admin/settings', { method: 'PATCH', body: { siteName: v.siteName, baseUrl: v.baseUrl, localLogin: box('localLogin'), signup: box('signup'), defaultRole: v.defaultRole,
        ranking: { defaultMode: v.defaultMode, upPerDay: v.upPerDay, downPerDay: v.downPerDay } } }).then(() => refresh().then(() => onChange?.('settings'))), 'settings saved');
      if (kind === 'sso') {
        const roleMap = Object.fromEntries(String(v.roleMap || '').split('\n').map((l) => l.split('=').map((x) => x.trim())).filter(([g, r]) => g && r));
        return act(() => api('admin/settings', { method: 'PATCH', body: { oidc: { enabled: box('enabled'), issuer: v.issuer, clientId: v.clientId, ...(v.clientSecret ? { clientSecret: v.clientSecret } : {}),
          scopes: v.scopes, label: v.label, autoCreate: box('autoCreate'), defaultRole: v.defaultRole, roleClaim: v.roleClaim, roleMap } } }).then(refresh), 'SSO settings saved');
      }
    };
    try { await load(); } catch (e) { msg = `✗ ${e.message}`; }
    render();
    if (!d.open) d.showModal();
  }

  return {
    refresh, can, onboarding, openLogin, openAdmin, switchRank, openPassword,
    get me() { return me; },
    setBudget(b) { if (me?.rank) { me.rank.budget = b; renderHeader(); } },
    // a 401/403 from the server: prompt to sign in, or explain the role limit
    denied(err) {
      if (err?.data?.perm && !me?.user) { openLogin(err.message); return true; }
      if (err?.data?.perm) { log(esc(err.message), 'warn'); return true; }
      return false;
    },
  };
}
