// Your activity history for the terminal's `log` command: what you opened, searched, saved, marked and voted on.
// Kept in this browser, per account (the last 1,000 actions); nothing is sent to the server.
const MAX = 1000;
export const KINDS = {
  story: '▤', read: '▸', archive: '▣', query: '⌕', save: '★', remove: '×', quote: '❝', note: '✎', mark: '✓', vote: '▲',
};
export function createActivity({ store, auth }) {
  const key = () => `activity:${auth.me?.user?.id ?? 'guest'}`;
  const list = () => store.get(key(), []);
  let last = null;
  function record(kind, text, ref = null) {
    const t = Date.now();
    const x = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    // the same thing twice within a few seconds (re-renders, double clicks) is one action
    if (last && last.k === kind && last.x === x && t - last.t < 4000) return;
    last = { t, k: kind, x, ...(ref ? { r: ref } : {}) };
    const all = list();
    all.push(last);
    if (all.length > MAX) all.splice(0, all.length - MAX);
    store.set(key(), all);
  }
  return { record, list, clear: () => store.set(key(), []) };
}
