// Password fields show asterisks instead of the browser's dots. Browsers draw the mask themselves (CSS can only pick
// disc / circle / square), so the real <input type=password> stays — password managers and autofill keep working —
// with its own mask made transparent, and a layer on top draws one * per character. The site font is monospaced,
// so the caret and selection line up with the asterisks. Applies to every password field, now and later.
export function installPasswordMask() {
  const wrap = (inp) => {
    if (inp._pwm || !inp.isConnected) return;
    inp._pwm = true;
    const w = document.createElement('span');
    w.className = 'pwm';
    inp.parentNode.insertBefore(w, inp);
    w.append(inp);
    const ov = document.createElement('span');
    ov.className = 'pwm-ov';
    ov.setAttribute('aria-hidden', 'true');
    const txt = document.createElement('span');
    ov.append(txt);
    w.append(ov);
    const place = () => {
      const cs = getComputedStyle(inp);
      const l = inp.offsetLeft + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const r = parseFloat(cs.borderRightWidth) + parseFloat(cs.paddingRight);
      Object.assign(ov.style, { left: `${l}px`, top: `${inp.offsetTop}px`, height: `${inp.offsetHeight}px`, width: `${Math.max(0, inp.offsetWidth - (l - inp.offsetLeft) - r)}px`, font: cs.font, letterSpacing: cs.letterSpacing });
    };
    // only touch the DOM when something changed (the layer's own updates must not feed back into the observer)
    let shown = -1, shift = 0;
    const sync = () => {
      if (inp.value.length !== shown) { shown = inp.value.length; txt.textContent = '*'.repeat(shown); }
      if (inp.scrollLeft !== shift) { shift = inp.scrollLeft; txt.style.transform = `translateX(${-shift}px)`; }
    };
    for (const ev of ['input', 'change', 'keyup', 'scroll', 'select', 'focus']) inp.addEventListener(ev, () => { if (ev === 'focus') place(); sync(); });
    new ResizeObserver(place).observe(inp);
    place(); sync();
    // forms that set the value from code (e.g. re-rendering with what was typed) don't fire input events
    inp._pwmSync = sync;
  };
  const scan = () => {
    for (const inp of document.querySelectorAll('input[type=password]')) { if (!inp._pwm) wrap(inp); else inp._pwmSync?.(); }
  };
  // new password fields appear when forms render; ignore changes inside our own asterisk layers
  new MutationObserver((muts) => { if (muts.some((m) => !m.target.closest?.('.pwm-ov'))) scan(); }).observe(document.body, { childList: true, subtree: true });
  scan();
}
