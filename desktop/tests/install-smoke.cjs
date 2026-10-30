'use strict';
// Native CI integration check. Uses synthetic data, never starts or logs into a bot.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { RuntimeManager, SetupError } = require('../lib/runtime.cjs');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'DSWhale 桌面 验收-'));
  const runtime = path.join(directory, 'runtime');
  const manager = new RuntimeManager({ source: path.resolve(__dirname, '../..'), runtime,
    onProgress: event => { if (event.step) console.log(event.step); } });
  try {
    const installed = await manager.install();
    assert.equal(installed.installed, true);
    const configPath = path.join(manager.host, 'data/cmd_config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(config.dashboard.host, '127.0.0.1');
    const credentialFile = path.join(runtime, 'desktop-auth.json');
    const credentials = await fs.readFile(credentialFile);
    assert.ok(JSON.parse(credentials).password.length >= 32);
    if (process.platform !== 'win32') assert.equal((await fs.stat(credentialFile)).mode & 0o777, 0o600);
    const fishPath = path.join(manager.host, 'data/config/astrbot_plugin_dswhale_config.json');
    await fs.mkdir(path.dirname(fishPath), { recursive: true });
    const synthetic = { persona: 'Synthetic CI companion; no personal information.', owner_qq: '', proactive_enabled: false };
    await fs.writeFile(fishPath, JSON.stringify(synthetic));
    const marker = path.join(manager.host, 'data/plugin_data/synthetic-memory-marker.txt');
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, 'synthetic memory survives upgrade');
    const receipt = path.join(runtime, 'desktop-install.json');
    const value = JSON.parse(await fs.readFile(receipt, 'utf8'));
    await fs.writeFile(receipt, JSON.stringify({ ...value, version: '0.0.0' }));
    assert.equal((await manager.inspect()).installed, false);
    assert.equal((await manager.install()).installed, true);
    assert.deepEqual(JSON.parse(await fs.readFile(fishPath, 'utf8')), synthetic);
    assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic memory survives upgrade');
    assert.deepEqual(await fs.readFile(credentialFile), credentials);
    assert.ok((await fs.readdir(path.join(runtime, 'backups'))).length);
    await fs.access(path.join(manager.host, 'data/plugins/astrbot_plugin_dswhale/dswhale/media_assets.json'));
    await fs.access(path.join(manager.host, 'data/plugins/astrbot_plugin_livingmemory/main.py'));
    const env = await manager.environment();
    assert.equal(env.ASTRBOT_ROOT, manager.host);
    console.log('Fresh install and repeated upgrade verified; synthetic data preserved.');
  } finally { await manager.cancel(); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error instanceof SetupError ? error.message : 'Desktop installation smoke check failed. Private temporary data was not uploaded.'); process.exitCode = 1; });
