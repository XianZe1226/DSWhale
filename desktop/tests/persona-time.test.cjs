'use strict';
// T4-I2 (persona timestamp display) — end-to-end through the Python shim that
// main.py installs. Synthetic persona only; no AstrBot instance, database or QQ.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '../..');
const python = process.env.DSWHALE_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

const script = `
import json
from datetime import datetime
from dswhale.persona_time_compat import install

class Persona:
    created_at = datetime(2026, 11, 7, 9, 30)
    updated_at = None

class Service:
    @staticmethod
    def serialize_persona(persona, empty_lists_for_tools=False):
        return {
            "created_at": persona.created_at.isoformat() if persona.created_at else None,
            "updated_at": persona.updated_at.isoformat() if persona.updated_at else None,
        }

assert install(Service) is True
print(json.dumps(Service.serialize_persona(Persona())))
`;

function personaPayload(timezone) {
  const result = spawnSync(python, ['-c', script], {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: { ...process.env, TZ: timezone, PYTHONPATH: sourceRoot },
  });
  assert.equal(result.status, 0, result.stderr || `python exited ${result.status}`);
  return JSON.parse(result.stdout.trim());
}

for (const timezone of ['UTC', 'Asia/Shanghai']) {
  test(`T4-I2: naive persona timestamps carry an explicit UTC offset under TZ=${timezone}`, () => {
    const payload = personaPayload(timezone);
    assert.equal(payload.created_at, '2026-11-07T09:30:00+00:00');
    // The dashboard uses new Date(...).toLocaleString(); with the explicit
    // offset this is the same instant everywhere (local rendering only).
    assert.equal(new Date(payload.created_at).toISOString(), '2026-11-07T09:30:00.000Z');
    assert.equal(payload.updated_at, null);
    assert.doesNotMatch(payload.created_at, /^2026-11-07T09:30:00$/);
    // Same instant, rendered in the viewer's zone: 09:30 UTC == 17:30 UTC+8.
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(payload.created_at));
    assert.equal(local, timezone === 'UTC' ? '09:30' : '17:30');
  });
}
