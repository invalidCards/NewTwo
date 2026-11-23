'use strict';

const fs = require('node:fs');

function emptyState(blog) {
  return { version: 1, blog, phase: 'scanning', before: null, pages: 0, drafts: [], cooldownUntil: 0, rateLimitCount: 0 };
}

function createState(blog, path) {
  let data = emptyState(blog);
  if (path && fs.existsSync(path)) {
    data = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (data.version !== 1 || data.blog !== blog || !['scanning', 'ready'].includes(data.phase) ||
        !Array.isArray(data.drafts) || !data.drafts.every((post) => typeof post.id_string === 'string') ||
        !Number.isSafeInteger(data.pages) || data.pages < 0 ||
        !(data.before === null || typeof data.before === 'string') ||
        !Number.isFinite(data.cooldownUntil) || !Number.isSafeInteger(data.rateLimitCount)) {
      throw new Error(`Invalid or mismatched scheduler state in ${path}`);
    }
  }
  function save() {
    if (!path) return;
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temporary, path);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) { /* Preserve the original error. */ }
      throw error;
    }
  }
  return { data, save };
}

module.exports = { createState };
