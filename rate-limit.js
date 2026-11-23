'use strict';

const HOUR = 60 * 60 * 1000;

function isRateLimit(error) {
  return error.statusCode === 429 || /\b429\b/.test(error.message || '');
}

function createRateLimitedClient(client, state, { now = Date.now, logger = console } = {}) {
  function call(method, args) {
    const current = now();
    if (current < state.data.cooldownUntil) {
      const error = new Error(`Tumblr rate-limit pause until ${new Date(state.data.cooldownUntil).toISOString()}`);
      error.statusCode = 429;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      client[method](...args, (error, result, response) => {
        if (error) {
          error.statusCode = response?.statusCode;
          if (isRateLimit(error)) {
            const receivedAt = now();
            const value = response?.headers?.['retry-after'];
            const seconds = Number(value);
            const date = Date.parse(value);
            const retryAt = value !== undefined && Number.isFinite(seconds) && seconds >= 0
              ? receivedAt + seconds * 1000 : date;
            state.data.rateLimitCount++;
            const fallback = Math.min(24 * HOUR, HOUR * 2 ** Math.min(state.data.rateLimitCount - 1, 5));
            state.data.cooldownUntil = Number.isFinite(retryAt) && retryAt > receivedAt ? retryAt : receivedAt + fallback;
            try { state.save(); } catch (saveError) { reject(saveError); return; }
            logger.warn(`Tumblr rate limit reached; pausing requests until ${new Date(state.data.cooldownUntil).toISOString()}.`);
          }
          reject(error);
          return;
        }
        if (state.data.rateLimitCount) {
          state.data.rateLimitCount = 0;
          state.data.cooldownUntil = 0;
          try { state.save(); } catch (saveError) { reject(saveError); return; }
        }
        resolve(result);
      });
    });
  }
  return Object.fromEntries(['blogDrafts', 'blogQueue', 'getRequest', 'editPost']
    .map((method) => [method, (...args) => call(method, args)]));
}

module.exports = { createRateLimitedClient, isRateLimit };
