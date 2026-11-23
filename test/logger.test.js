'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../logger');

test('timestamps each log level while preserving error details', () => {
  const entries = [];
  const output = Object.fromEntries(['log', 'warn', 'error'].map((level) => [
    level, (...args) => entries.push([level, ...args]),
  ]));
  const logger = createLogger(output, () => new Date('2026-11-23T12:34:56.789Z'));
  const error = new Error('request failed');
  logger.log('started');
  logger.warn('skipped');
  logger.error('failed:', error);
  assert.deepEqual(entries, [
    ['log', '[2026-11-23T12:34:56.789Z]', 'started'],
    ['warn', '[2026-11-23T12:34:56.789Z]', 'skipped'],
    ['error', '[2026-11-23T12:34:56.789Z]', 'failed:', error],
  ]);
});
