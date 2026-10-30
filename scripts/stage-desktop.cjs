'use strict';
const { spawnSync } = require('node:child_process');
// Build machines provide Python; the shipped app prepares its own runtime.
const python = process.env.DSWHALE_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['-m', 'scripts.stage_desktop'], { stdio: 'inherit' });
if (result.error) console.error(`Cannot run ${python}; install Python 3.12 or set DSWHALE_BUILD_PYTHON.`);
process.exit(result.status ?? 1);
