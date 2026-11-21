// Discussion threads for the story and article popovers. A story's thread is every story-scope comment on any of
// its articles (so it survives regrouping); an article's thread is keyed to that article. One level of replies.
// Comment text is plain text (escaped), newlines kept.
export function createComments(ctx) {
  const { api, esc, log, auth, ago } = ctx;

  // mount a thread into `el`. what: { scope: 'story', links: [...], postLink } or { scope: 'article', link }
  async function mount(el, what) {
    if (!el) return;
    if (!auth.can('comments.read')) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="dim cm-loading"><span class="spin">⟳</span> loading the discussion…</div>';
    let data;
    try {
      data = await api('comments/find', { method: 'POST', body: what.scope === 'story' ? { story: what.links } : { article: what.link } });
    } catch (e) { el.innerHTML = `<div class="err small">✗ comments: ${esc(e.message)}</div>`; return; }
    const list = (what.scope === 'story' ? data.story : data.article) || [];
    let replyTo = null, editing = null, composing = false, menuFor = null;
    const target = what.scope === 'story' ? what.postLink : what.link;

    const one = (c, isReply) => {
      const mine = c.userId === data.me;
      const canDel = !c.deleted && ((mine && data.canPost) || data.canModerate);
      const canEdit = mine && !c.deleted && data.canPost;
      // reply is a small ↩; edit/delete sit in a ⋯ menu that floats over the comment (no layout shift)
      return `<div class="cm ${isReply ? 'cm-reply' : ''} ${c.deleted ? 'cm-deleted' : ''}" data-cid="${c.id}">
        <div class="cm-meta">${c.deleted ? '<span class="dim">[deleted]</span>' : `<b>${esc(c.author)}</b>`} <span class="dim" title="${esc(new Date(c.created).toLocaleString())}">· ${ago(c.created)}${c.edited ? ' · edited' : ''}</span>
          <span class="cm-tools">${!c.deleted && data.canPost && !isReply ? '<button type="button" class="link cm-tool" data-cm="reply" title="reply">↩</button>' : ''}${canEdit || canDel ? `<button type="button" class="link cm-tool" data-cm="menu" title="${canEdit ? 'edit / delete' : 'delete (moderator)'}" aria-expanded="${menuFor === c.id}">⋯</button>` : ''}</span></div>
        ${menuFor === c.id ? `<div class="cm-menu">${canEdit ? '<button type="button" data-cm="edit">edit</button>' : ''}${canDel ? `<button type="button" class="err" data-cm="delete">${mine ? 'delete' : 'delete (moderator)'}</button>` : ''}</div>` : ''}
        ${editing === c.id ? `<div class="cm-form"><textarea data-cm-edit maxlength="4000">${esc(c.body)}</textarea><div class="cm-form-acts"><button type="button" class="link" data-cm="cancel">[cancel]</button> <button type="button" data-cm="save">SAVE</button></div></div>`
          : c.deleted ? '' : `<div class="cm-body">${esc(c.body)}</div>`}
        ${replyTo === c.id ? form('reply') : ''}
      </div>`;
    };
    function form(kind) {
      return `<div class="cm-form" data-kind="${kind}"><textarea data-cm-new maxlength="4000" placeholder="${kind === 'reply' ? 'reply…' : what.scope === 'story' ? 'add to the discussion of this story…' : 'comment on this article…'}"></textarea>
        <div class="cm-form-acts"><span class="dim small">plain text · ctrl+⏎ to post</span><button type="button" class="link" data-cm="cancel">[cancel]</button> <button type="button" data-cm="post">POST</button></div></div>`;
    }
    function render() {
      const top = list.filter((c) => !c.parent);
      const replies = (id) => list.filter((c) => c.parent === id);
      const live = list.filter((c) => !c.deleted).length;
      el.innerHTML = `
        <div class="cm-list">${top.length ? top.map((c) => one(c, false) + replies(c.id).map((r) => one(r, true)).join('')).join('') : '<div class="dim cm-none">&gt; no comments yet</div>'}</div>
        ${data.canPost ? (composing ? form('new') : '<button type="button" class="link cm-add" data-cm="compose">[+ add a comment]</button>') : `<div class="dim small cm-signin">${auth.me?.user ? 'your role can read comments but not post them' : '<button type="button" class="link" data-cm="signin">[sign in]</button> to join the discussion'}</div>`}`;
      el.dataset.count = live;
      el.closest('.pop-cm-sec, section')?.querySelector('.cm-count')?.replaceChildren(document.createTextNode(live ? `· ${live}` : ''));
      // the sidebar's rail shows the total across its threads (visible even when collapsed)
      const aside = el.closest('.pop-cm');
      if (aside) {
        const total = [...aside.querySelectorAll('.cm-slot')].reduce((t, x) => t + (Number(x.dataset.count) || 0), 0);
        aside.querySelector('.cm-total').textContent = total ? String(total) : '';
      }
    }
    async function reload() {
      data = await api('comments/find', { method: 'POST', body: what.scope === 'story' ? { story: what.links } : { article: what.link } });
      list.splice(0, list.length, ...((what.scope === 'story' ? data.story : data.article) || []));
      render();
    }
    async function post(ta, parent) {
      const body = ta.value.trim();
      if (!body) return;
      ta.disabled = true;
      try {
        await api('comments', { method: 'POST', body: { link: target, scope: what.scope, body, parent } });
        replyTo = null; composing = false;
        await reload();
        ctx.onPosted?.();
      } catch (e) { ta.disabled = false; if (!auth.denied(e)) log(`comment failed: ${esc(e.message)}`, 'err'); }
    }
    el.onclick = async (e) => {
      const b = e.target.closest('[data-cm]');
      if (!b) { if (menuFor != null && !e.target.closest('.cm-menu')) { menuFor = null; render(); } return; }
      const act = b.dataset.cm, id = Number(b.closest('[data-cid]')?.dataset.cid) || null;
      if (act === 'signin') return auth.openLogin('sign in to comment');
      if (act === 'menu') { menuFor = menuFor === id ? null : id; return render(); }
      menuFor = null;
      if (act === 'compose') { composing = true; replyTo = editing = null; render(); el.querySelector('[data-kind=new] textarea')?.focus(); return; }
      if (act === 'reply') { replyTo = id; editing = null; composing = false; render(); el.querySelector('[data-kind=reply] textarea')?.focus(); return; }
      if (act === 'edit') { editing = id; replyTo = null; render(); el.querySelector('[data-cm-edit]')?.focus(); return; }
      if (act === 'cancel') { replyTo = editing = null; composing = false; return render(); }
      if (act === 'post') return post(b.closest('.cm-form').querySelector('textarea'), b.closest('[data-kind=reply]') ? replyTo : null);
      if (act === 'save') {
        try { await api(`comments/${editing}`, { method: 'PATCH', body: { body: el.querySelector('[data-cm-edit]').value } }); editing = null; await reload(); }
        catch (ex) { log(`edit failed: ${esc(ex.message)}`, 'err'); }
        return;
      }
      if (act === 'delete') {
        if (!confirm('delete this comment?')) return;
        try { await api(`comments/${id}`, { method: 'DELETE' }); await reload(); ctx.onPosted?.(); } catch (ex) { log(`delete failed: ${esc(ex.message)}`, 'err'); }
      }
    };
    el.onkeydown = (e) => {
      e.stopPropagation();                                     // typing here must not trigger popover shortcuts (j/k/o/u/d…)
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('textarea[data-cm-new]')) {
        e.preventDefault();
        post(e.target, e.target.closest('[data-kind=reply]') ? replyTo : null);
      }
      if (e.key === 'Escape' && (replyTo || editing || composing || menuFor != null)) { e.preventDefault(); replyTo = editing = menuFor = null; composing = false; render(); }
    };
    render();
  }
  return { mount };
}
