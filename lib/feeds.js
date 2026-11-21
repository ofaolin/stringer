// Minimal, dependency-free RSS / Atom / RDF fetching + parsing + feed discovery.
import { safeFetch } from './netguard.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—',
  ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', eacute: 'é', egrave: 'è',
  aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä',
};

// Feedsportal (rss.nytimes.com/c/…, feeds.washingtonpost.com/c/…, 2008-2016 era) wrapped every feed link in a
// redirect whose path encodes the real URL: …/l/0L0Snytimes0N0C2014…0Bhtml/story01.htm. The service is long gone,
// so decode the real address. Other links pass through unchanged.
const FP = { A: '0', B: '.', C: '/', D: '?', E: '-', F: '=', G: '&', H: ',', I: '_', J: '%', K: '+', L: 'http://', M: 'https://',
  N: '.com', O: '.co.uk', P: ';', Q: '|', R: ':', S: 'www.', T: '#', U: '$', V: '~', W: '!', X: '(', Y: ')', Z: 'Z' };
export function unwrapFeedLink(link) {
  if (!link) return link;
  const m = String(link).match(/^https?:\/\/[^/]+\/c\/\d+\/f\/\d+\/s\/[0-9a-f]+\/(?:sc\/\d+\/)?l\/(0[LM][^/]+)/i);
  if (!m) return link;
  const url = m[1].replace(/0([A-Z])/g, (x, c) => FP[c] ?? x);
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^(partner|emc|wpisrc|wprss|_r|utm_\w+)$/i.test(k)) u.searchParams.delete(k);
    return u.href;
  } catch { return link; }
}

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const stripCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

export function toText(raw) {
  if (!raw) return '';
  let s = decodeEntities(stripCdata(raw));
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

function tag(block, names) {
  for (const n of names) {
    const re = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i');
    const m = block.match(re);
    if (m && m[1].trim()) return m[1];
  }
  return null;
}

function attr(tagStr, name) {
  const m = tagStr.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3]) : null;
}

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

function findLink(block) {
  const orig = tag(block, ['feedburner:origLink']);
  if (orig && isHttp(toText(orig))) return toText(orig);
  // RSS <link>url</link>
  const rss = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (rss) {
    const u = toText(rss[1]);
    if (isHttp(u)) return u;
  }
  // Atom <link href rel>
  const links = block.match(/<link\b[^>]*\/?>/gi) || [];
  let fallback = null;
  for (const l of links) {
    const href = attr(l, 'href');
    if (!isHttp(href)) continue;
    const rel = (attr(l, 'rel') || 'alternate').toLowerCase();
    if (rel === 'alternate') return href;
    fallback ??= href;
  }
  if (fallback) return fallback;
  const guid = tag(block, ['guid', 'id']);
  if (guid && isHttp(toText(guid))) return toText(guid);
  return null;
}

function findImage(block) {
  const tags = block.match(/<(media:content|media:thumbnail|enclosure|itunes:image)\b[^>]*>/gi) || [];
  for (const t of tags) {
    const url = attr(t, 'url') || attr(t, 'href');
    const type = attr(t, 'type') || '';
    const medium = attr(t, 'medium') || '';
    if (isHttp(url) && (/image/i.test(type) || /image/i.test(medium) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url) || /thumbnail/i.test(t)))
      return url;
  }
  const html = decodeEntities(stripCdata(tag(block, ['content:encoded', 'description', 'summary', 'content']) || ''));
  const img = html.match(/<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  if (img && isHttp(img[1])) return decodeEntities(img[1]);
  return null;
}

function parseDate(block) {
  const raw = tag(block, ['pubDate', 'published', 'dc:date', 'updated', 'a10:updated', 'dcterms:modified']);
  if (!raw) return null;
  const d = Date.parse(toText(raw));
  return Number.isFinite(d) ? d : null;
}

export function parseFeed(xml) {
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0];
  const feedTitle = toText(tag(head, ['title']) || '');
  const items = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < 80) {
    const block = m[2];
    const title = toText(tag(block, ['title']) || '');
    const link = unwrapFeedLink(findLink(block));
    if (!title || !link) continue;
    let summary = toText(tag(block, ['description', 'summary', 'media:description', 'content:encoded', 'content']) || '');
    if (summary.length > 320) summary = summary.slice(0, 317).replace(/\s+\S*$/, '') + '…';
    if (summary.toLowerCase() === title.toLowerCase()) summary = '';
    items.push({ title, link, summary, date: parseDate(block), image: findImage(block) });
  }
  return { title: feedTitle, items };
}

const looksLikeFeed = (s) => /<(rss|feed|rdf:RDF)[\s>]/i.test(s.slice(0, 3000));

export async function fetchText(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    // (safeFetch: public addresses only, every redirect re-checked — see lib/netguard.js)
    const r = await safeFetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    let charset = (r.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1];
    if (!charset) {
      const head = new TextDecoder('latin1').decode(buf.slice(0, 300));
      charset = head.match(/encoding=["']([\w-]+)["']/i)?.[1] || 'utf-8';
    }
    let text;
    try { text = new TextDecoder(charset.toLowerCase()).decode(buf); }
    catch { text = new TextDecoder('utf-8').decode(buf); }
    return { text, url: r.finalUrl || url };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('timeout');
    throw new Error(e.cause?.code || e.message || String(e));
  } finally {
    clearTimeout(t);
  }
}

export async function fetchFeed(url) {
  const { text } = await fetchText(url);
  if (!looksLikeFeed(text)) throw new Error('not a feed');
  const feed = parseFeed(text);
  if (!feed.items.length) throw new Error('feed has no items');
  return feed;
}

// Given a site or feed URL, find a working feed.
export async function discoverFeed(input) {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const tried = [];
  const attempt = async (u) => {
    tried.push(u);
    try {
      const feed = await fetchFeed(u);
      return { feed: u, title: feed.title, sample: feed.items.slice(0, 5).map((i) => i.title), count: feed.items.length };
    } catch { return null; }
  };

  let page;
  try { page = await fetchText(url); } catch (e) { throw new Error(`could not reach ${url}: ${e.message}`); }

  if (looksLikeFeed(page.text)) {
    const feed = parseFeed(page.text);
    if (feed.items.length)
      return { feed: page.url, site: new URL(page.url).origin, title: feed.title, sample: feed.items.slice(0, 5).map((i) => i.title), count: feed.items.length };
  }

  const site = new URL(page.url).origin;
  const siteTitle = toText(page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const candidates = [];
  for (const l of page.text.match(/<link\b[^>]*>/gi) || []) {
    const type = (attr(l, 'type') || '').toLowerCase();
    const rel = (attr(l, 'rel') || '').toLowerCase();
    const href = attr(l, 'href');
    if (href && rel.includes('alternate') && /(rss|atom)\+xml|application\/xml|text\/xml/.test(type)) {
      try { candidates.push(new URL(href, page.url).href); } catch {}
    }
  }
  for (const p of ['/feed', '/rss', '/feed/', '/rss.xml', '/feed.xml', '/index.xml', '/atom.xml', '/feeds/rss.xml', '/rss/index.xml', '/feed/rss'])
    candidates.push(site + p);

  for (const c of [...new Set(candidates)]) {
    const r = await attempt(c);
    if (r) return { ...r, site, title: r.title || siteTitle };
  }
  throw new Error(`no RSS/Atom feed found (tried ${tried.length} URLs)`);
}
