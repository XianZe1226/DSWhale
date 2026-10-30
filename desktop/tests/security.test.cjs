const test = require('node:test');
const assert = require('node:assert/strict');

test('only local shell main frame may invoke allowlisted actions', () => {
  const { validateRequest } = require('../lib/security.cjs');
  const shell = { id: 17, mainFrame: {} };
  assert.doesNotThrow(() => validateRequest({ sender: shell, senderFrame: shell.mainFrame }, shell, 'inspect'));
  assert.doesNotThrow(() => validateRequest({ sender: shell, senderFrame: shell.mainFrame }, shell, 'initial-login'));
  assert.doesNotThrow(() => validateRequest({ sender: shell, senderFrame: shell.mainFrame }, shell, 'restore'));
  assert.doesNotThrow(() => validateRequest({ sender: shell, senderFrame: shell.mainFrame }, shell, 'open-panel', { panel: 'napcat' }));
  for (const [event, action] of [
    [{ sender: { id: 9 }, senderFrame: {} }, 'install'],
    [{ sender: shell, senderFrame: {} }, 'open-data'],
    [{ sender: shell, senderFrame: shell.mainFrame }, 'exec'],
  ]) assert.throws(() => validateRequest(event, shell, action));
});

test('embedded consoles only navigate to exact approved loopback origin', () => {
  const { permittedNavigation, biliURL } = require('../lib/security.cjs');
  assert.equal(permittedNavigation('http://127.0.0.1:6185/#/models', 'http://127.0.0.1:6185/'), true);
  for (const url of ['http://127.0.0.1:6186/', 'https://evil.example/', 'file:///etc/passwd', 'http://localhost:6185/', 'http://user@127.0.0.1:6185/', 'javascript:alert(1)']) {
    assert.equal(permittedNavigation(url, 'http://127.0.0.1:6185/'), false);
  }
  assert.match(biliURL({ port: 12345, token: 'test-secret-token_123' }), /^http:\/\/127\.0\.0\.1:12345\/#token=/);
  assert.throws(() => biliURL({ port: 0, token: 'bad token' }));
});

test('same-origin plugin popups stay in the current console; external popups are rejected', () => {
  const { consolePopupTarget } = require('../lib/security.cjs');
  const base = 'http://127.0.0.1:6185/';
  assert.equal(consolePopupTarget(base + 'api/plugin/pages/memory', base), base + 'api/plugin/pages/memory');
  for (const url of ['https://untrusted.example/', 'http://127.0.0.1:6099/', 'file:///private/file', 'javascript:alert(1)']) assert.equal(consolePopupTarget(url, base), null);
});
