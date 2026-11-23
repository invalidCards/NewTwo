'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tumblr = require('tumblr.js');
const { createState } = require('../state');
const { createRoutines } = require('../routines');
const { createRateLimitedClient } = require('../rate-limit');

const silent = { log() {}, warn() {}, error() {} };
const draft = (id) => ({ id_string: String(id), type: 'text', is_blocks_post_format: true });

function statePath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newtwo-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}

test('a scan resumes at its saved cursor after a rate limit and a restart', async (t) => {
  const filename = statePath(t);
  const first = Array.from({ length: 20 }, (_, i) => draft(22 - i));
  const calls = [];
  const client = {
    async blogDrafts(blog, options) {
      calls.push(options.before_id || 'first');
      if (calls.length === 1) return { posts: first };
      if (calls.length === 2) throw new Error('API error: 429 Limit Exceeded');
      return { posts: [draft(2), draft(1)] };
    },
    async getRequest() { return { state: 'draft', content: [] }; },
    async editPost(blog, id) { calls.push(`published ${id}`); },
  };
  let state = createState('blog', filename);
  let routines = createRoutines(client, 'blog', { state, logger: silent, delay: async () => {} });
  await assert.rejects(routines.publishOldestDraft(), /429/);
  state = createState('blog', filename);
  assert.equal(state.data.before, '3');
  assert.equal(state.data.drafts.length, 20);
  routines = createRoutines(client, 'blog', { state, logger: silent, delay: async () => {} });
  await routines.publishOldestDraft();
  assert.deepEqual(calls, ['first', '3', '3', 'published 1']);
  state = createState('blog', filename);
  routines = createRoutines(client, 'blog', { state, logger: silent, delay: async () => {} });
  await routines.publishOldestDraft();
  assert.equal(calls.at(-1), 'published 2');
  assert.equal(calls.filter((call) => call === 'first').length, 1);
});

test('skips missing and non-draft posts immediately, publishing only the next draft', async () => {
  const state = createState('blog');
  state.data.phase = 'ready';
  state.data.drafts = [draft(4), draft(3), draft(2), draft(1)];
  const edited = [];
  const client = {
    async getRequest(url) {
      if (url.endsWith('/1')) { const error = new Error('not found'); error.statusCode = 404; throw error; }
      if (url.endsWith('/2')) return { state: 'published', content: [] };
      return { state: 'draft', content: [] };
    },
    async editPost(blog, id) { edited.push(id); },
  };
  await createRoutines(client, 'blog', { state, logger: silent }).publishOldestDraft();
  assert.deepEqual(edited, ['3']);
  assert.deepEqual(state.data.drafts.map((post) => post.id_string), ['4']);
});

test('does not discard an indexed post on a rate limit or unknown post state', async () => {
  const state = createState('blog');
  state.data.phase = 'ready';
  state.data.drafts = [draft(1)];
  let rateLimited = true;
  const client = {
    async getRequest() {
      if (rateLimited) throw new Error('API error: 429 Limit Exceeded');
      return { content: [] };
    },
    async editPost() { assert.fail('unexpected edit'); },
  };
  const routines = createRoutines(client, 'blog', { state, logger: silent });
  await assert.rejects(routines.publishOldestDraft(), /429/);
  rateLimited = false;
  await assert.rejects(routines.publishOldestDraft(), /did not return a state/);
  assert.equal(state.data.drafts.length, 1);
});

test('rate-limit pause blocks both routines and survives a restart', async (t) => {
  const filename = statePath(t);
  let now = 100000;
  let calls = 0;
  const raw = {
    blogDrafts(blog, options, callback) {
      calls++;
      if (calls === 1) callback(new Error('limited'), null, { statusCode: 429, headers: { 'retry-after': '120' } });
      else callback(null, { posts: [] }, { statusCode: 200 });
    },
    blogQueue(blog, callback) { calls++; callback(null, { posts: [] }, { statusCode: 200 }); },
  };
  let state = createState('blog', filename);
  let client = createRateLimitedClient(raw, state, { now: () => now, logger: silent });
  await assert.rejects(client.blogDrafts('blog', {}), /limited/);
  state = createState('blog', filename);
  client = createRateLimitedClient(raw, state, { now: () => now, logger: silent });
  await assert.rejects(client.blogQueue('blog'), /rate-limit pause/);
  assert.equal(calls, 1);
  now += 120000;
  assert.deepEqual(await client.blogDrafts('blog', {}), { posts: [] });
  assert.equal(createState('blog', filename).data.rateLimitCount, 0);
});

test('rate-limited wrapper uses the real tumblr.js callback signatures', async () => {
  const raw = tumblr.createClient({ consumer_key: 'key' });
  const calls = [];
  raw.getRequest = (url, options, callback) => {
    if (typeof options === 'function') { callback = options; options = undefined; }
    calls.push([url, options]);
    callback(null, { posts: [] }, { statusCode: 200 });
  };
  raw.putRequest = (url, options, callback) => {
    calls.push([url, options]);
    callback(null, { id: '1' }, { statusCode: 200 });
  };
  const client = createRateLimitedClient(raw, createState('blog'), { logger: silent });
  await client.blogDrafts('blog', { before_id: '10' });
  await client.blogQueue('blog');
  await client.getRequest('/v2/blog/blog/posts/1');
  await client.editPost('blog', '1', { content: [], state: 'published' });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], ['/v2/blog/blog/posts/draft', { before_id: '10' }]);
  assert.equal(calls[1][0], '/v2/blog/blog/posts/queue');
  assert.equal(calls[2][0], '/v2/blog/blog/posts/1');
  assert.equal(calls[3][0], '/v2/blog/blog/posts/1');
  assert.equal(calls[3][1].state, 'published');
});

test('rejects state belonging to another blog', (t) => {
  const filename = statePath(t);
  createState('blog', filename).save();
  assert.throws(() => createState('other', filename), /mismatched/);
});
