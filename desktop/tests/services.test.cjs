const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

test('host refuses an occupied port and never adopts or stops another process', async () => {
  const { ServiceSupervisor } = require('../lib/services.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-services-'));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/cmd_config.json'), JSON.stringify({ dashboard: { host: '127.0.0.1', port: server.address().port } }));
  const supervisor = new ServiceSupervisor({ manager: { host: root, source: root, python: process.execPath, environment: async () => process.env } });
  try {
    await assert.rejects(supervisor.start(), /占用/);
    await supervisor.stop();
    assert.ok(server.listening);
    assert.equal(supervisor.running, false);
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

test('only loopback dashboard configuration can be embedded', () => {
  const { dashboardURL } = require('../lib/services.cjs');
  assert.equal(dashboardURL({ dashboard: { host: '127.0.0.1', port: 6185 } }), 'http://127.0.0.1:6185/');
  for (const config of [{ dashboard: { host: '0.0.0.0', port: 6185 } }, { dashboard: { host: '127.0.0.1', port: 0 } }, { dashboard: { host: '127.0.0.1', port: 6185, ssl: { enable: true } } }]) assert.throws(() => dashboardURL(config));
});

test('stop fences a pending start before the owned process can spawn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dswhale-cancel-start-'));
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/cmd_config.json'), JSON.stringify({ dashboard: { host: '127.0.0.1', port } }));
  let entered, release, fakeServer, child, spawnCount = 0;
  const inEnvironment = new Promise(resolve => { entered = resolve; });
  const environment = new Promise(resolve => { release = resolve; });
  const exports = { exports: {} };
  const source = await fs.readFile(path.join(__dirname, '../lib/services.cjs'), 'utf8');
  vm.runInNewContext(source, { module: exports, require: name => name === 'node:child_process' ? { spawn() {
    spawnCount++;
    child = new EventEmitter(); child.pid = 123456789; child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    fakeServer = net.createServer().listen(port, '127.0.0.1');
    return child;
  } } : require(name), process: { platform: 'darwin', kill() { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); } }, setTimeout, clearTimeout, console, URL });
  const supervisor = new exports.exports.ServiceSupervisor({ manager: { host: root, source: root, python: 'fake-python', environment() { entered(); return environment; } } });
  const start = supervisor.start();
  start.catch(() => {});
  try {
    await inEnvironment;
    const stopping = supervisor.stop();
    release(process.env);
    await stopping;
    await assert.rejects(start, /取消|停止/);
    assert.equal(spawnCount, 0);
    assert.equal(supervisor.running, false);
  } finally {
    await supervisor.stop();
    if (fakeServer) await new Promise(resolve => fakeServer.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
