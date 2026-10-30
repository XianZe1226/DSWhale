const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

test('native installer workflow parses before it reaches GitHub Actions', () => {
  const file = path.resolve(__dirname, '../../.github/workflows/desktop.yml');
  const workflow = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.equal(workflow.name, 'Desktop installers');
  assert.equal(workflow.jobs.build.strategy.matrix.include.length, 3);
});
