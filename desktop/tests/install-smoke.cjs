'use strict';
// Native CI integration check. No account login; bridge startup is offline.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { RuntimeManager, SetupError, runBounded } = require('../lib/runtime.cjs');
const { takeReadToken, extensionRunner } = require('./github-access.cjs');
const ciReadToken=takeReadToken();
const { ExtensionRunner } = require('../lib/extensions.cjs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
let phase='environment';
const safeErrors=new Set(['无法检查上游稳定版本，请稍后重试','无法检查上游稳定版本，请检查网络后重试','插件下载失败，请重新检查版本后重试','插件下载失败，请检查网络后重试','依赖安装未完成或与现有环境不兼容；原插件尚未替换','插件依赖要求更改现有版本，已停止更新','插件名称或版本与检查结果不匹配','插件操作未完成，请检查网络、目录权限和可用空间后重试']);

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'DSWhale 桌面 验收-'));
  const runtime = path.join(directory, 'runtime');
  const stagedSource = process.env.DSWHALE_SMOKE_SOURCE || path.resolve(__dirname, '../../desktop-resources/backend');
  const manager = new RuntimeManager({ source: stagedSource, runtime,
    onProgress: event => { if (event.step) console.log(event.step); } });
  const extensions = new ExtensionRunner(manager,extensionRunner(runBounded,ciReadToken));
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
    const bridge = path.join(manager.host, 'data/plugins/astrbot_plugin_dswhale/dswhale/bili_bridge');
    // Run the installed files, not imports from the checkout that hid the a2 defect.
    await execute(manager.python, [path.resolve(__dirname, '../../scripts/verify_artifact.py'),
      '--installed-bridge', bridge, '--node', env.DSWHALE_NODE || process.execPath],
    { cwd: directory, env, timeout: 25000, maxBuffer: 65536, windowsHide: true });
    console.log('Installed packaged bridge reached ready offline within 15 seconds and stopped.');
    await execute(process.execPath, ['--test', path.resolve(__dirname, 'services.test.cjs')],
      { cwd: directory, env: { ...env, DSWHALE_TEST_PYTHON: manager.python }, timeout: 45000, maxBuffer: 65536, windowsHide: true });
    console.log('Pinned installed AstrBot refuses core updates in the managed host environment.');
    phase='extension-status';
    const status = await extensions.run('status');
    assert.equal(status.memory.installed, true);
    assert.equal(status.memes.installed, false);
    phase='extension-check';
    const checked = await extensions.run('check', 'memes');
    assert.equal(checked.memes.canUpdate, true);
    phase='extension-update';
    const updated = await extensions.run('update', 'memes');
    assert.equal(updated.memes.installed, true);
    assert.equal(updated.memes.canRollback, true);
    phase='extension-rollback';
    assert.equal((await extensions.run('rollback', 'memes')).memes.installed, false);
    assert.deepEqual(JSON.parse(await fs.readFile(fishPath, 'utf8')), synthetic);
    assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic memory survives upgrade');
    console.log('Independent plugin check, installation and rollback verified.');
    console.log('Fresh install and repeated upgrade verified; synthetic data preserved.');
  } finally { await extensions.close(); await manager.cancel(); await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error instanceof SetupError ? error.message : `Desktop installation smoke check failed at ${phase}.${safeErrors.has(error.message)?' '+error.message:''} Private temporary data was not uploaded.`); process.exitCode = 1; });
