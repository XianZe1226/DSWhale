const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('native installer workflow parses before it reaches GitHub Actions', () => {
  const file = path.resolve(__dirname, '../../.github/workflows/desktop.yml');
  const workflow = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.equal(workflow.name, 'Desktop installers');
  assert.equal(workflow.jobs.build.strategy.matrix.include.length, 3);
});

test('an empty optional signing secret does not become a certificate path', () => {
  const config = path.resolve(__dirname, '../../electron-builder.cjs');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(config)}); if (process.env.CSC_LINK !== undefined) process.exit(1)`], {
    env: { ...process.env, CSC_LINK: '', CSC_KEY_PASSWORD: '' }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('checksum step runs from a temporary Actions script outside the repository', () => {
  const root = path.resolve(__dirname, '../..');
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/desktop.yml'), 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dswhale-workflow-'));
  try {
    fs.writeFileSync(path.join(directory, 'DSWhale-fixture.exe'), 'synthetic installer');
    const step = workflow.jobs.build.steps.find(step => step.name === 'Create checksums for installers only');
    const script = path.join(directory, 'action.py');
    fs.writeFileSync(script, step.run.replace("Path('desktop-dist')", `Path(${JSON.stringify(directory)})`).replaceAll('${{ matrix.platform }}', 'fixture'));
    const python = process.env.DSWHALE_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const result = spawnSync(python, [script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(path.join(directory, 'SHA256SUMS-fixture.txt'), 'utf8'), /^[a-f0-9]{64}  DSWhale-fixture\.exe\r?\n$/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('source artifact gate runs from the temporary Actions script location',()=>{
  const root=path.resolve(__dirname,'../..');
  const workflow=yaml.load(fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8'));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dswhale-source-gate-'));
  try{
    const step=workflow.jobs.test.steps.find(step=>step.name==='Verify wheel and source bridge inventory independently');
    const setup=`import subprocess, zipfile, tarfile\nfrom pathlib import Path\nfolder=Path(${JSON.stringify(directory)})\nnames=subprocess.check_output(['git','ls-files','-z','--','dswhale/bili_bridge']).decode().split('\\0')\nwith zipfile.ZipFile(folder/'dswhale-0.0.0-py3-none-any.whl','w') as wheel, tarfile.open(folder/'dswhale-0.0.0.tar.gz','w:gz') as source:\n    for name in filter(None,names):\n        wheel.write(name,name)\n        source.add(name,arcname='dswhale-0.0.0/'+name)\n`;
    const script=path.join(directory,'action.py');
    fs.writeFileSync(script,setup+step.run.replace("Path('dist')",`Path(${JSON.stringify(directory)})`));
    const python=process.env.DSWHALE_BUILD_PYTHON||(process.platform==='win32'?'python':'python3');
    const result=spawnSync(python,[script],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal((result.stdout.match(/123 bridge source files verified/g)||[]).length,2);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
