'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { NapCatSession } = require('../lib/napcat-session.cjs');
const { NapCatManager } = require('../lib/napcat.cjs');

function managerFor(session) {
  const app = Object.create(NapCatManager.prototype);
  app.session = session;
  app.child = { exitCode: null, killed: false };
  app._webui = async () => ({ port: 6199, token: 'synthetic-webui-token' });
  app.identityAccount = '';
  app.identityKnown = false;
  app.identityToken = crypto.randomBytes(16).toString('hex');
  return app;
}

test('identity token is stable for the same account and changes only on a real switch or unknown state', async () => {
  let account = '12345678';
  let unknown = false;
  const session = new NapCatSession();
  session._call = async route => {
    if (route.includes('CheckLoginStatus')) return { isLogin: true, coreReady: true };
    return { uin: unknown ? 'not-a-number' : account, online: !unknown };
  };
  const app = managerFor(session);
  const first = await app.identityRevision({ fresh: true });
  assert.equal(first.known, true);
  assert.doesNotMatch(first.token, /12345678/);
  const refresh = await app.identityRevision({ fresh: true });
  assert.equal(refresh.token, first.token, 'same-account refresh must not invalidate plans');
  account = '87654321';
  const switched = await app.identityRevision({ fresh: true });
  assert.notEqual(switched.token, first.token);
  assert.doesNotMatch(switched.token, /87654321/);
  unknown = true;
  const unknownState = await app.identityRevision({ fresh: true });
  assert.equal(unknownState.known, false);
  assert.notEqual(unknownState.token, switched.token);
  const stableUnknown = await app.identityRevision({ fresh: true });
  assert.equal(stableUnknown.token, unknownState.token);
});
