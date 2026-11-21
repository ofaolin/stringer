// Themed hover tooltips for every element with a title attribute (native ones can't be styled).
// Titles are moved to data-tip on first hover, so code that renders `title="…"` keeps working unchanged.
// Add data-tip-head / data-tip-foot for a framed tooltip with a header and footer (the title is the body),
// data-tip-head-right for a right-aligned part of the header, data-tip-title for a bold first line in the body, and
// data-tip-sub for dim italic lines right under the title, data-tip-note for a dim italic last line, and
// data-tip-alert for a highlighted line above the header.
export function installTooltips({ delay = 350 } = {}) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  let target = null, timer = null;

  let mouseX = null;
  const hide = () => { clearTimeout(timer); timer = null; target = null; tip.hidden = true; };
  function place() {
    if (!target?.isConnected) return hide();
    // modal <dialog>s render in the top layer — the tip must live inside the open one to show above it
    const host = target.closest('dialog[open]') || document.body;
    if (tip.parentNode !== host) host.append(tip);
    // optional header / footer (data-tip-head / data-tip-foot) frame the text like a popover; all via textContent
    const { tipAlert: alert, tipHead: head, tipHeadRight: headRight, tipTitle: title, tipSub: sub, tipNote: note, tipFoot: foot } = target.dataset;
    tip.classList.toggle('framed', !!(head || foot));
    if (head || foot) {
      // text may carry tiny color marks: ⟦cls|text⟧ → <span class="tc-cls">text</span> (text still via textContent)
      const part = (cls, text) => {
        const d = document.createElement('div'); d.className = cls;
        for (const [i, seg] of String(text ?? '').split(/⟦([a-z0-9-]+)\|([^⟧]*)⟧/i).entries()) {
          const k = i % 3;
          if (k === 0) { if (seg) d.append(seg); }
          else if (k === 1) { const sp = document.createElement('span'); sp.className = `tc-${seg}`; d.append(sp); }
          else d.lastChild.textContent = seg;
        }
        return d;
      };
      const body = part('tip-body', target.dataset.tip);
      if (sub) body.prepend(part('tip-sub', sub));       // dim italic lines right under the title
      if (title) body.prepend(part('tip-title', title));
      if (note) body.append(part('tip-note', note));
      const h = head && part('tip-head', '');
      if (h) { h.append(part('tip-head-l', head)); if (headRight) h.append(part('tip-head-r', headRight)); }
      tip.replaceChildren(...[alert && part('tip-alert', alert), h, body, foot && part('tip-foot', foot)].filter(Boolean));
    } else tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const r = target.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let top = r.bottom + 6;
    if (top + t.height > vh - 4) top = Math.max(4, r.top - t.height - 6);
    // centred under the element — or, for a wide one (a whole line of text), under where the pointer came in
    const cx = r.width > Math.max(320, t.width * 1.5) && mouseX != null ? mouseX : r.left + r.width / 2;
    const left = Math.min(Math.max(4, cx - t.width / 2), vw - t.width - 4);
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('[title], [data-tip]');
    if (el === target) return;
    mouseX = e.clientX;
    if (!el) return hide();
    const t = el.getAttribute('title');
    if (t != null) { el.removeAttribute('title'); if (t) el.dataset.tip = t; else delete el.dataset.tip; }
    if (!el.dataset.tip) return hide();
    hide();
    target = el;
    timer = setTimeout(place, delay);
  });
  document.addEventListener('mouseout', (e) => {
    if (target && !target.contains(e.relatedTarget)) hide();
  });
  for (const ev of ['mousedown', 'keydown', 'wheel']) document.addEventListener(ev, hide, { capture: true, passive: true });
  document.addEventListener('scroll', hide, { capture: true, passive: true });
  return { hide };
}
