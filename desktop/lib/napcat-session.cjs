'use strict';
// Only the owned loopback management API is used here. QQ authentication,
// QR refresh, logout and device-management endpoints are deliberately absent.
const http = require('node:http');
const crypto = require('node:crypto');
const unknown = () => ({ loginState: 'unknown' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class NapCatSessionError extends Error {
  constructor() { super('本机 QQ 登录管理暂不可用，请稍后刷新或打开登录管理查看。'); this.name = 'NapCatSessionError'; this.code = 'NAP-SESSION'; }
}

function readJSON(port, route, body, credential, { signal, timeout, maxBytes }) {
  return new Promise((resolve, reject) => {
    let bytes;
    try { bytes = Buffer.from(JSON.stringify(body)); if (bytes.length > maxBytes) throw new Error(); }
    catch { reject(new NapCatSessionError()); return; }
    let settled = false, timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(new NapCatSessionError()) : resolve(value); };
    const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length,
        ...(credential ? { Authorization: 'Bearer ' + credential } : {}) } }, response => {
      // Core HTTP neither uses system proxies nor follows redirects. Never send
      // even a hashed local management credential to an advertised destination.
      if (response.statusCode !== 200 || response.headers.location || !/^application\/json\b/i.test(response.headers['content-type'] || '')) {
        response.resume(); finish(true); request.destroy(); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > maxBytes) { finish(true); request.destroy(); } else chunks.push(chunk); });
      response.once('error', () => finish(true));
      response.once('end', () => {
        if (settled) return;
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!object(value) || !Number.isInteger(value.code)) throw new Error(); finish(null, value); }
        catch { finish(true); }
      });
    });
    request.once('error', () => finish(true));
    timer = setTimeout(() => { finish(true); request.destroy(); }, timeout);
    request.end(bytes);
  });
}

class NapCatSession {
  constructor({ now = Date.now, timeout = 2000, maxBytes = 256 * 1024 } = {}) {
    this.now = now; this.timeout = timeout; this.maxBytes = maxBytes; this.generation = 0; this.reset();
  }
  reset() {
    this.generation++; this.controller?.abort(); this.controller = new AbortController();
    this.identityRevision = (this.identityRevision || 0) + 1;
    this.key = null; this.credential = null; this.credentialUntil = 0; this.nextAuth = 0;
    this.cached = null; this.pending = null; this.authPending = null;
  }
  _prepare(context) {
    if (!object(context) || !Number.isInteger(context.port) || context.port < 1024 || context.port > 65535
      || typeof context.token !== 'string' || context.token.length < 8 || context.token.length > 4096 || /[\x00-\x1f\x7f]/.test(context.token)) throw new NapCatSessionError();
    const hash = crypto.createHash('sha256').update(context.token + '.napcat').digest('hex');
    const key = context.port + ':' + hash;
    if (this.key !== key) { this.reset(); this.key = key; this.port = context.port; this.hash = hash; }
  }
  async _request(route, body, credential) {
    const generation = this.generation;
    const result = await readJSON(this.port, route, body, credential, { signal: this.controller.signal, timeout: this.timeout, maxBytes: this.maxBytes });
    if (generation !== this.generation) throw new NapCatSessionError();
    return result;
  }
  async _authenticate() {
    if (this.credential && this.credentialUntil > this.now()) return;
    if (this.nextAuth > this.now()) throw new NapCatSessionError();
    if (this.authPending) return this.authPending;
    const pending = this._request('/api/auth/login', { hash: this.hash }).then(result => {
      const value = result.data?.Credential;
      if (result.code !== 0 || result.data?.require2FA || typeof value !== 'string' || !/^[A-Za-z0-9+/=]{4,8192}$/.test(value)) {
        this.nextAuth = this.now() + 60000; throw new NapCatSessionError();
      }
      this.credential = value; this.credentialUntil = this.now() + 50 * 60 * 1000;
    }).finally(() => { if (this.authPending === pending) this.authPending = null; });
    this.authPending = pending; return pending;
  }
  async _call(route, body = {}) {
    await this._authenticate();
    const result = await this._request(route, body, this.credential);
    if (result.code !== 0) {
      if (result.message === 'Unauthorized') { this.credential = null; this.nextAuth = this.now() + 60000; }
      throw new NapCatSessionError();
    }
    return result.data;
  }
  async inspect(context, { fresh = false } = {}) {
    try { this._prepare(context); } catch { return unknown(); }
    // A mutation must not reuse the identity that preceded an account switch,
    // including an older read still in flight when that mutation began.
    if (fresh && this.pending) { await this.pending; return this.inspect(context, { fresh: true }); }
    if (!fresh && this.cached && this.cached.until > this.now()) return this.cached.value;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = (async () => {
      let value;
      try {
        const status = await this._call('/api/QQLogin/CheckLoginStatus');
        if (!object(status) || typeof status.isLogin !== 'boolean' || typeof status.coreReady !== 'boolean') throw new NapCatSessionError();
        if (status.isLogin && status.coreReady) {
          const info = await this._call('/api/QQLogin/GetQQLoginInfo');
          const account = typeof info?.uin === 'string' ? info.uin : Number.isSafeInteger(info?.uin) ? String(info.uin) : '';
          if (info?.online !== true || !/^[1-9]\d{4,19}$/.test(account)) throw new NapCatSessionError();
          value = { loginState: 'online', account };
        } else {
          const phases = { waiting_qrcode: 'scan-required', qrcode_scanned: 'confirming', initializing: 'connecting', reconnecting: 'connecting', offline: 'offline' };
          value = { loginState: status.isOffline === true ? 'offline' : phases[status.loginPhase] || 'unknown' };
        }
      } catch { value = unknown(); }
      if (generation !== this.generation) return unknown();
      this.identityRevision++;
      this.cached = { until: this.now() + 5000, value }; return value;
    })().finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending; return pending;
  }
  async getConfig(context) {
    this._prepare(context); const config = await this._call('/api/OB11Config/GetConfig');
    if (!object(config)) throw new NapCatSessionError();
    return config;
  }
  async setConfig(context, config) {
    this._prepare(context);
    if (!object(config)) throw new NapCatSessionError();
    let raw; try { raw = JSON.stringify(config); } catch { throw new NapCatSessionError(); }
    // A failed write is never retried here: the next explicit apply first reads
    // current configuration and can determine whether it already took effect.
    await this._call('/api/OB11Config/SetConfig', { config: raw });
    this.cached = null;
  }
}
module.exports = { NapCatSession, NapCatSessionError };
