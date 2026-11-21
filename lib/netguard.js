// Outbound fetches to addresses the internet gave us (article links, feed URLs, sitemaps, redirects) must not reach
// this machine or its private network: a link to http://127.0.0.1:…, a DNS name that resolves to 10.x, or a public
// page that redirects inward would otherwise let anyone who can trigger a fetch read internal services (SSRF).
//
// safeFetch(url, opts) is fetch() with: http(s) only; the host resolved and every address checked against the private
// and reserved ranges (IP literals included); redirects followed one hop at a time, each re-checked. The response's
// final URL is on `finalUrl` (Response.url can't be overridden). Remaining gap: DNS could change between the check
// and the connection (rebinding) — narrow, and needs an attacker-controlled DNS server.
//
// STRINGER_ALLOW_PRIVATE_FETCH=1 turns the check off (a deliberately local setup, or tests). Single sign-on doesn't
// use this: an identity provider on the LAN is legitimate.
import dns from 'node:dns/promises';
import net from 'node:net';

const v4 = new net.BlockList(), v6 = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) v4.addSubnet(a, p, 'ipv4');
// (separate lists: a v4 address checked against a list holding ::ffff:0:0/96 counts as inside it)
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) v6.addSubnet(a, p, 'ipv6');

export function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return v4.check(ip, 'ipv4');
  if (v === 6) return v6.check(ip, 'ipv6');
  return true;                                                   // not an address at all: refuse
}
const allowPrivate = () => process.env.STRINGER_ALLOW_PRIVATE_FETCH === '1';
const refuse = () => Object.assign(new Error('only public web addresses can be fetched (that one points to a private or local network)'), { blocked: true });

// throws unless the URL is http(s) and its host only resolves to public addresses
export async function assertPublicUrl(url) {
  const u = url instanceof URL ? url : new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) addresses can be fetched');
  if (allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (isBlockedAddress(host)) throw refuse(); return u; }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
  catch (e) { throw Object.assign(new Error(`could not reach the site (${e.code || 'DNS lookup failed'})`), { cause: e }); }
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) throw refuse();
  return u;
}

const MAX_HOPS = 6;
export async function safeFetch(url, opts = {}) {
  let cur = new URL(url);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    await assertPublicUrl(cur);
    const r = await fetch(cur, { ...opts, redirect: 'manual' });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!loc) { r.finalUrl = cur.href; return r; }
    try { await r.body?.cancel(); } catch { /* nothing to discard */ }
    cur = new URL(loc, cur);                                     // relative redirects resolve against this hop
  }
  throw new Error('too many redirects');
}
