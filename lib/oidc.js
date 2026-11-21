// OpenID Connect sign-in (authorization code flow + PKCE), dependency-free. Works with any standard provider:
// Authentik, Authelia, Keycloak, Zitadel, Okta, Auth0, Google, Microsoft Entra…
// The ID token's signature is checked against the provider's published keys (JWKS), along with issuer, audience,
// expiry and nonce.
import crypto from 'node:crypto';

const cache = new Map();          // issuer -> { meta, at } · jwks_uri -> { keys, at }
const TTL = 60 * 60e3;

async function getJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(`${new URL(url).host} answered with something that isn't JSON (HTTP ${r.status})`); }
    if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${new URL(url).host} took too long to answer`);
    throw e;
  } finally { clearTimeout(t); }
}

export async function discover(issuer) {
  const iss = String(issuer || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(iss)) throw new Error('the OIDC issuer must be an http(s) URL');
  const c = cache.get(iss);
  if (c && Date.now() - c.at < TTL) return c.meta;
  const meta = await getJson(`${iss}/.well-known/openid-configuration`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!meta[k]) throw new Error(`the provider's discovery document has no ${k}`);
  cache.set(iss, { meta, at: Date.now() });
  return meta;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// → { url, state, verifier, nonce } — store state/verifier/nonce server-side, redirect the browser to url
export async function authorizeUrl(cfg, redirectUri) {
  const meta = await discover(cfg.issuer);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const u = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri, scope: cfg.scopes || 'openid profile email',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).forEach(([k, v]) => u.searchParams.set(k, v));
  return { url: u.href, state, verifier, nonce };
}

async function jwks(uri, force = false) {
  const c = cache.get(uri);
  if (!force && c && Date.now() - c.at < TTL) return c.keys;
  const j = await getJson(uri);
  cache.set(uri, { keys: j.keys || [], at: Date.now() });
  return j.keys || [];
}

const ALGS = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: 32 }, PS384: { hash: 'sha384', pss: 48 }, PS512: { hash: 'sha512', pss: 64 },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
  EdDSA: { hash: null },
};

export async function verifyIdToken(idToken, { issuer, clientId, nonce, jwksUri }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('the provider returned a malformed ID token');
  const [h, p, sig] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`unsupported ID token algorithm ${header.alg}`);   // never accepts "none" or HMAC
  const pick = (keys) => keys.find((k) => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'));
  let jwk = pick(await jwks(jwksUri));
  if (!jwk) jwk = pick(await jwks(jwksUri, true));                              // keys rotated: refetch once
  if (!jwk) throw new Error('the ID token was signed with a key the provider does not publish');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(sig, 'base64url');
  const ok = alg.hash === null ? crypto.verify(null, data, key, signature)
    : crypto.verify(alg.hash, data, alg.ec ? { key, dsaEncoding: 'ieee-p1363' }
      : alg.pss ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: alg.pss } : key, signature);
  if (!ok) throw new Error('the ID token signature is invalid');
  const now = Math.floor(Date.now() / 1000), skew = 120;
  if (String(claims.iss).replace(/\/+$/, '') !== String(issuer).replace(/\/+$/, '')) throw new Error('the ID token was issued by a different provider');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('the ID token is for a different client');
  if (!(claims.exp > now - skew)) throw new Error('the ID token has expired');
  if (claims.nbf && claims.nbf > now + skew) throw new Error('the ID token is not valid yet');
  if (claims.nonce !== nonce) throw new Error('the ID token nonce does not match this sign-in');
  if (!claims.sub) throw new Error('the ID token has no subject');
  return claims;
}

// code → verified ID token claims (+ userinfo when the provider has it, for name/email/groups)
export async function finishLogin(cfg, { code, verifier, nonce, redirectUri }) {
  const meta = await discover(cfg.issuer);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: cfg.clientId });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const methods = meta.token_endpoint_auth_methods_supported || ['client_secret_basic'];
  if (cfg.clientSecret) {
    if (methods.includes('client_secret_basic') || !methods.includes('client_secret_post')) {
      headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');
    } else body.set('client_secret', cfg.clientSecret);
  }
  const tok = await getJson(meta.token_endpoint, { method: 'POST', headers, body });
  if (!tok.id_token) throw new Error('the provider did not return an ID token (is the "openid" scope enabled?)');
  const claims = await verifyIdToken(tok.id_token, { issuer: meta.issuer || cfg.issuer, clientId: cfg.clientId, nonce, jwksUri: meta.jwks_uri });
  if (meta.userinfo_endpoint && tok.access_token) {
    try {
      const info = await getJson(meta.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (info.sub === claims.sub) Object.assign(claims, { ...info, ...claims, groups: claims.groups ?? info.groups });
    } catch { /* userinfo is optional */ }
  }
  return { claims, issuer: meta.issuer || cfg.issuer };
}
