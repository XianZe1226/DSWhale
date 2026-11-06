// Diagnostic only: fixed stock OS command, no SDK, accounts or environment values exported.
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export async function minimizeEnvironment(base, extras, check, limit = 16) {
  let calls = 0;
  const test = async keys => {
    if (calls >= limit) return null;
    calls++;
    return Boolean(await check({...base, ...Object.fromEntries(keys.map(k => [k, extras[k]]))}));
  };
  const keys = Object.keys(extras).sort();
  const baseline = await test([]), expanded = await test(keys);
  if (baseline || !expanded) return {baseline, expanded, calls, requiredKeys: [], isolated: false};
  let current = keys, granularity = 2;
  while (current.length && calls < limit) {
    const size = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length && calls < limit; start += size) {
      const remaining = current.filter((_, i) => i < start || i >= start + size);
      if (await test(remaining)) {current = remaining; reduced = true; break;}
    }
    if (reduced) granularity = Math.max(2, granularity - 1);
    else if (granularity >= current.length) break;
    else granularity = Math.min(current.length, granularity * 2);
  }
  const repeated = await test(current);
  return {baseline, expanded, calls, requiredKeys: current, isolated: repeated === true};
}

export async function diagnoseWindowsStartup(base, parent, root) {
  const blocked = /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|KEY|HOOK|PROFIL|STARTUP|NODE|PYTHON|PSMODULEPATH|COR_|COMPLUS|^LD_|^DYLD_|DSWHALE|ASTRBOT/i;
  const baseNames = new Set(Object.keys(base).map(k => k.toUpperCase()));
  const extras = {};
  for (const [key, value] of Object.entries(parent)) {
    if (!blocked.test(key) && !baseNames.has(key.toUpperCase()) && value !== undefined) extras[key] = value;
  }
  const exe = path.win32.join(base.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "Write-Output 'DSWHALE_STARTUP_OK'; exit 0";
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const observations = [];
  const check = env => {
    const start = Date.now();
    const result = spawnSync(exe, args, {cwd: root, env, windowsHide: true, input: '', encoding: 'utf8', timeout: 8000, maxBuffer: 65536});
    const passed = result.status === 0 && String(result.stdout).replace(/\0/g, '').includes('DSWHALE_STARTUP_OK');
    observations.push({passed, elapsedMs: Date.now() - start, status: result.status, timeout: result.error?.code === 'ETIMEDOUT'});
    return passed;
  };
  const reduction = await minimizeEnvironment(base, extras, check, 16);
  // Never export values, raw child output or the full inherited environment.
  return {...reduction, candidateKeyCount: Object.keys(extras).length, observations};
}
