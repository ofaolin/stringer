// Themed date picker (the native <input type=date> calendar can't be styled). Turns a text input into
// YYYY-MM-DD entry with a calendar popover: day grid, click the title to zoom out to months → years,
// optional quick-jump presets. Fires 'input' + 'change' on the input when a date is picked.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = (s) => {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
};

export function attachDatePicker(input, { min = '1980-01-01', max = null, presets = [] } = {}) {
  input.type = 'text';
  input.placeholder = 'YYYY-MM-DD';
  input.maxLength = 10;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.classList.add('dp-input');

  const wrap = document.createElement('span');
  wrap.className = 'dp-wrap';
  input.replaceWith(wrap);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dp-btn';
  btn.title = 'pick a date';
  btn.textContent = '▦';
  const panel = document.createElement('div');
  panel.className = 'dp';
  panel.hidden = true;
  wrap.append(input, btn, panel);

  const minD = parse(min), maxD = max ? parse(max) : null;
  const today = new Date();
  let view = 'days', cy, cm;                  // cursor year / month

  const inRange = (y, m, d) => {
    const t = new Date(y, m, d);
    return (!minD || t >= minD) && (!maxD || t <= maxD);
  };
  const setCursorFromInput = () => {
    const d = parse(input.value) || today;
    cy = d.getFullYear(); cm = d.getMonth();
  };

  function render() {
    const sel = parse(input.value);
    let title, body;
    if (view === 'days') {
      title = `${MONTHS[cm]} ${cy}`;
      const first = new Date(cy, cm, 1);
      const lead = (first.getDay() + 6) % 7;                    // Monday-first
      const days = new Date(cy, cm + 1, 0).getDate();
      let cells = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => `<span class="dp-dow">${d}</span>`).join('');
      for (let i = 0; i < lead; i++) cells += '<span></span>';
      for (let d = 1; d <= days; d++) {
        const ok = inRange(cy, cm, d);
        const isSel = sel && sel.getFullYear() === cy && sel.getMonth() === cm && sel.getDate() === d;
        const isToday = today.getFullYear() === cy && today.getMonth() === cm && today.getDate() === d;
        cells += `<button type="button" class="dp-cell${isSel ? ' on' : ''}${isToday ? ' today' : ''}" data-day="${d}"${ok ? '' : ' disabled'}>${d}</button>`;
      }
      body = `<div class="dp-grid dp-days">${cells}</div>`;
    } else if (view === 'months') {
      title = String(cy);
      body = `<div class="dp-grid dp-months">${MONTHS.map((n, m) => {
        const ok = inRange(cy, m, new Date(cy, m + 1, 0).getDate()) || inRange(cy, m, 1);
        const isSel = sel && sel.getFullYear() === cy && sel.getMonth() === m;
        return `<button type="button" class="dp-cell${isSel ? ' on' : ''}" data-month="${m}"${ok ? '' : ' disabled'}>${n}</button>`;
      }).join('')}</div>`;
    } else {
      const start = cy - (cy % 12);
      title = `${start} – ${start + 11}`;
      body = `<div class="dp-grid dp-months">${Array.from({ length: 12 }, (_, i) => start + i).map((y) => {
        const ok = (!minD || y >= minD.getFullYear()) && (!maxD || y <= maxD.getFullYear());
        return `<button type="button" class="dp-cell${sel && sel.getFullYear() === y ? ' on' : ''}" data-year="${y}"${ok ? '' : ' disabled'}>${y}</button>`;
      }).join('')}</div>`;
    }
    panel.innerHTML = `
      <div class="dp-head">
        <button type="button" class="dp-nav" data-nav="-1" title="previous">‹</button>
        <button type="button" class="dp-title" data-zoom="1" title="${view === 'years' ? '' : 'zoom out'}">${title}</button>
        <button type="button" class="dp-nav" data-nav="1" title="next">›</button>
      </div>
      ${body}
      <div class="dp-foot">
        <button type="button" class="dp-q" data-pick="${iso(today.getFullYear(), today.getMonth(), today.getDate())}">today</button>
        ${presets.map((p) => `<button type="button" class="dp-q" data-pick="${p}">${p.slice(0, 4)}</button>`).join('')}
      </div>`;
  }

  const open = () => { setCursorFromInput(); view = 'days'; render(); panel.hidden = false; };
  const close = () => { panel.hidden = true; };
  const pick = (value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  };

  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  input.addEventListener('focus', () => { if (panel.hidden) open(); });
  input.addEventListener('input', () => { if (!panel.hidden && parse(input.value)) { setCursorFromInput(); render(); } });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Enter') { close(); input.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  panel.addEventListener('mousedown', (e) => e.preventDefault());      // keep focus in the input
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.nav) {
      const d = Number(b.dataset.nav);
      if (view === 'days') { cm += d; if (cm < 0) { cm = 11; cy--; } if (cm > 11) { cm = 0; cy++; } }
      else if (view === 'months') cy += d;
      else cy += 12 * d;
    } else if (b.dataset.zoom) view = view === 'days' ? 'months' : 'years';
    else if (b.dataset.year) { cy = Number(b.dataset.year); view = 'months'; }
    else if (b.dataset.month) { cm = Number(b.dataset.month); view = 'days'; }
    else if (b.dataset.day) return pick(iso(cy, cm, Number(b.dataset.day)));
    else if (b.dataset.pick) return pick(b.dataset.pick);
    render();
  });
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) close(); });

  return { open, close, isOpen: () => !panel.hidden };
}
