// STRINGER — file to the morgue. Opening the popup (click, or Alt+Shift+F) files the current tab: the page as the
// browser shows it is sent to your STRINGER server with your filing key, which extracts and files the article.
// Nothing runs on pages until you do this, and only on the tab you file (activeTab).
const ext = globalThis.browser ?? globalThis.chrome;
const $main = document.getElementById('main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const getSettings = async () => (await ext.storage.local.get(['server', 'key'])) || {};
const api = async (server, key, path, opts = {}) => {
  const r = await fetch(server.replace(/\/+$/, '') + '/api/ext/' + path, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${key}`, 'X-Requested-With': 'stringer', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `the server answered HTTP ${r.status}`);
  return data;
};

// runs in the page (only when you file it): the page as rendered, minus scripts / styles / media to keep it small
function capturePage() {
  const canon = document.querySelector('link[rel="canonical"]')?.href;
  let url = location.href;
  try { if (canon && new URL(canon).hostname.replace(/^www\./, '') === location.hostname.replace(/^www\./, '')) url = canon; } catch {}
  const root = document.documentElement.cloneNode(true);
  for (const el of root.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, svg, iframe, video, audio, canvas, template, link, object, embed')) el.remove();
  let html = '<!doctype html>' + root.outerHTML;
  if (html.length > 7.5e6) html = html.slice(0, 7.5e6);
  return { url, title: document.title, html };
}

function showSettings(note = '') {
  getSettings().then((s) => {
    $main.innerHTML = `
      ${note ? `<div class="warn small">${esc(note)}</div>` : ''}
      <label>server address<input id="server" placeholder="http://localhost:1337" value="${esc(s.server || '')}" spellcheck="false" /></label>
      <label>filing key<input id="key" placeholder="sfk_…" value="${esc(s.key || '')}" spellcheck="false" autocomplete="off" /></label>
      <div class="dim small">Both are in STRINGER: account menu → <b>browser extension…</b></div>
      <button type="button" class="btn" id="save">SAVE &amp; CHECK</button>
      <div id="out" class="small"></div>`;
    document.getElementById('save').onclick = async () => {
      const server = document.getElementById('server').value.trim().replace(/\/+$/, ''), key = document.getElementById('key').value.trim();
      const out = document.getElementById('out');
      if (!/^https?:\/\//i.test(server)) { out.innerHTML = '<span class="err">the server address starts with http:// or https://</span>'; return; }
      out.innerHTML = '<span class="spin">⟳</span> checking…';
      try {
        const me = await api(server, key, 'whoami');
        await ext.storage.local.set({ server, key });
        out.innerHTML = `<span class="ok">✓ connected to ${esc(me.site)} as ${esc(me.user)}</span>${me.canFile ? '' : '<br><span class="warn">but your role can\'t file articles</span>'}<br><button type="button" class="btn" id="go">FILE THIS PAGE</button>`;
        document.getElementById('go').onclick = fileCurrent;
      } catch (e) { out.innerHTML = `<span class="err">✗ ${esc(e.message)}</span>`; }
    };
  });
}

async function fileCurrent() {
  const s = await getSettings();
  if (!s.server || !s.key) return showSettings('Connect the extension to your STRINGER server first.');
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  $main.innerHTML = `<div class="title">${esc(tab?.title || '')}</div><div class="dim small">${esc((tab?.url || '').slice(0, 90))}</div><div id="st"><span class="spin">⟳</span> filing…</div>`;
  const st = document.getElementById('st');
  if (!/^https?:/i.test(tab?.url || '')) { st.innerHTML = '<span class="err">✗ only web pages can be filed</span>'; return; }
  let page;
  try {
    const [res] = await ext.scripting.executeScript({ target: { tabId: tab.id }, func: capturePage });
    page = res?.result;
  } catch (e) { st.innerHTML = `<span class="err">✗ couldn't read this page (${esc(e.message)})</span>`; return; }
  if (!page?.html) { st.innerHTML = '<span class="err">✗ couldn\'t read this page</span>'; return; }
  try {
    const r = await api(s.server, s.key, 'file', { method: 'POST', body: page });
    st.innerHTML = r.filed
      ? `<span class="ok">▣ filed in the morgue</span> · <span class="morgue">${esc(r.morgue || '')}</span><br><span class="dim small">${esc(r.outlet)} · ${(r.words || 0).toLocaleString()} words${r.status === 'partial' ? ' · partial' : ''}${r.replaced ? ' · replaced a shorter copy' : ''}</span>`
      : `<span class="warn">▣ already filed</span> · <span class="morgue">${esc(r.morgue || '')}</span><br><span class="dim small">${esc(r.note || '')}</span>`;
  } catch (e) { st.innerHTML = `<span class="err">✗ ${esc(e.message)}</span>`; }
}

document.getElementById('gear').onclick = () => showSettings();
fileCurrent();
