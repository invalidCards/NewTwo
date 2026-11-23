'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tumblr = require('tumblr.js');
const { changeState, createRoutines, scheduleRoutine } = require('../routines');

const silent = { log() {}, warn() {}, error() {} };
const draft = (id) => ({ id_string: String(id), type: 'text', is_blocks_post_format: true });

test('walks every draft page and publishes oldest first using string IDs', async () => {
  const calls = [];
  const first = Array.from({ length: 20 }, (_, i) => draft(100 - i));
  const client = {
    async blogDrafts(blog, options) {
      calls.push([blog, options]);
      return { posts: options.before_id ? [draft(80), draft(79)] : first };
    },
    async getRequest() { return { content: [] }; },
    async editPost(blog, id, options) { calls.push([blog, { id, state: options.state }]); },
  };
  const routines = createRoutines(client, 'example.tumblr.com', { delay: async () => {}, logger: silent });
  await routines.publishOldestDraft();
  await routines.publishOldestDraft();
  assert.deepEqual(calls, [
    ['example.tumblr.com', {}], ['example.tumblr.com', { before_id: '81' }],
    ['example.tumblr.com', { id: '79', state: 'published' }],
    ['example.tumblr.com', { id: '80', state: 'published' }],
  ]);
});

for (const [total, retained] of [[65, 25], [40, 20]]) {
  test(`retains the oldest drafts from ${total} posts and reloads when exhausted`, async () => {
    let drafts = Array.from({ length: total }, (_, i) => draft(total - i));
    let scans = 0;
    const published = [];
    const client = {
      async blogDrafts(blog, options) {
        if (!options.before_id) scans++;
        return { posts: drafts.filter((post) => !options.before_id || Number(post.id_string) < Number(options.before_id)).slice(0, 20) };
      },
      async getRequest() { return { content: [] }; },
      async editPost(blog, id) {
        published.push(Number(id));
        drafts = drafts.filter((post) => post.id_string !== id);
      },
    };
    const routines = createRoutines(client, 'blog', { delay: async () => {}, logger: silent });
    for (let i = 0; i < retained; i++) await routines.publishOldestDraft();
    assert.equal(scans, 1);
    await routines.publishOldestDraft();
    assert.equal(scans, 2);
    assert.deepEqual(published, Array.from({ length: retained + 1 }, (_, i) => i + 1));
  });
}

test('handles empty drafts and detects repeated pagination cursors', async () => {
  const empty = createRoutines({ blogDrafts: async () => ({ posts: [] }) }, 'blog', { delay: async () => {}, logger: silent });
  await empty.publishOldestDraft();
  const page = Array.from({ length: 20 }, () => draft(1));
  const looping = createRoutines({ blogDrafts: async () => ({ posts: page }) }, 'blog', { delay: async () => {}, logger: silent });
  await assert.rejects(looping.publishOldestDraft(), /repeated cursor/);
});

test('a failed publish skips that post without reloading the remaining drafts', async () => {
  let scans = 0;
  const attempted = [];
  const client = {
    async blogDrafts() { scans++; return { posts: [draft(3), draft(2), draft(1)] }; },
    async getRequest() { return { content: [] }; },
    async editPost(blog, id) {
      attempted.push(id);
      if (id === '1') throw new Error('failed');
    },
  };
  const routines = createRoutines(client, 'blog', { delay: async () => {}, logger: silent });
  await assert.rejects(routines.publishOldestDraft(), /failed/);
  await routines.publishOldestDraft();
  assert.equal(scans, 1);
  assert.deepEqual(attempted, ['1', '2']);
});

test('NPF edit passes fetched content and reblog details through the real v5 client', async () => {
  const client = tumblr.createClient({ consumer_key: 'key' });
  const content = [{ type: 'text', text: 'hello' }];
  const calls = [];
  client.getRequest = async (path) => {
    calls.push(path);
    return { content, layout: [], tags: ['one', 'two'], parent_post_id: '123', parent_tumblelog_uuid: 'uuid', reblog_key: 'key' };
  };
  client.putRequest = async (path, options) => { calls.push([path, options]); };
  await changeState(client, 'example.tumblr.com', { id_string: '90071992547409930', is_blocks_post_format: true }, 'draft');
  assert.deepEqual(calls, [
    '/v2/blog/example.tumblr.com/posts/90071992547409930',
    ['/v2/blog/example.tumblr.com/posts/90071992547409930', {
      state: 'draft', content, layout: [], tags: 'one,two', parent_post_id: '123', parent_tumblelog_uuid: 'uuid', reblog_key: 'key',
    }],
  ]);
});

test('rejects legacy non-text posts without calling a legacy endpoint', async () => {
  const client = { getRequest: () => assert.fail('unexpected request') };
  await assert.rejects(
    changeState(client, 'blog', { id_string: '1', type: 'photo', is_blocks_post_format: false }, 'published'),
    /legacy photo post/
  );
});

test('does not edit NPF posts if editable content is missing', async () => {
  const client = { getRequest: async () => ({}), editPost: () => assert.fail('unexpected edit') };
  await assert.rejects(changeState(client, 'blog', { id_string: '1', is_blocks_post_format: true }, 'published'), /no editable content/);
});

test('queue moves preserve the oldest cached drafts even if a later edit fails', async () => {
  let scans = 0;
  const published = [];
  const client = {
    async blogDrafts() { scans++; return { posts: [draft(2), draft(1)] }; },
    async blogQueue() { return { posts: [draft(3), draft(4)] }; },
    async getRequest() { return { content: [] }; },
    async editPost(blog, id, options) {
      if (id === '4') throw new Error('failed');
      if (options.state === 'published') published.push(id);
    },
  };
  const routines = createRoutines(client, 'blog', { delay: async () => {}, logger: silent });
  await routines.publishOldestDraft();
  await assert.rejects(routines.draftFirstQueuePage(), /failed/);
  await routines.publishOldestDraft();
  assert.equal(scans, 1);
  assert.deepEqual(published, ['1', '2']);
});

test('scheduled tasks log errors and share a lock to avoid overlapping', async () => {
  const callbacks = [];
  const errors = [];
  const lock = { running: false };
  const logger = { ...silent, error: (...args) => errors.push(args) };
  const setTimer = (callback) => { callbacks.push(callback); };
  let release;
  scheduleRoutine('first', () => new Promise((resolve) => { release = resolve; }), 1, { logger, setTimer, lock });
  scheduleRoutine('second', async () => { throw new Error('failure'); }, 1, { logger, setTimer, lock });
  const pending = callbacks[0]();
  await callbacks[1]();
  assert.equal(errors.length, 0);
  release();
  await pending;
  await callbacks[1]();
  assert.match(errors[0][0], /second failed/);
  assert.equal(lock.running, false);
});
