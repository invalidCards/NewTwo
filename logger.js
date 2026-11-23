'use strict';

function createLogger(output = console, now = () => new Date()) {
  return Object.fromEntries(['log', 'warn', 'error'].map((level) => [
    level,
    (...args) => output[level](`[${now().toISOString()}]`, ...args),
  ]));
}

module.exports = { createLogger };
