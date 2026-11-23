'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnvironment } = require('../index');

test('loads .env and preserves existing environment variables', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qewtwo-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'TUMBLR_CONSUMER_KEY="example key"\nTUMBLR_BLOG=file.example\n');
  const env = { TUMBLR_BLOG: 'host.example' };
  loadEnvironment(env, envFile);
  assert.deepEqual(env, { TUMBLR_CONSUMER_KEY: 'example key', TUMBLR_BLOG: 'host.example' });
});

test('allows a missing .env but reports other file errors', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qewtwo-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.doesNotThrow(() => loadEnvironment({}, path.join(dir, '.env')));
  assert.throws(() => loadEnvironment({}, dir));
});
