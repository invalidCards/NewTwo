'use strict';

const { createState } = require('./state');
const { isRateLimit } = require('./rate-limit');
const DRAFT_PAGE_SIZE = 20;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function postId(post) {
  if (typeof post.id_string !== 'string' || !post.id_string) {
    throw new Error('Tumblr returned a post without an id_string');
  }
  return post.id_string;
}

// NPF edits require the post's content. Fetch the editing representation so that
// changing its state does not replace the content with an empty post.
async function changeState(client, blog, post, state) {
  const id = postId(post);
  if (state !== 'published' && !post.is_blocks_post_format && post.type !== 'text') {
    throw new Error(`Post ${id} is a legacy ${post.type || 'non-text'} post, which Tumblr's NPF editor cannot edit`);
  }

  let current;
  try {
    current = await client.getRequest(`/v2/blog/${blog}/posts/${id}`);
  } catch (error) {
    if (state === 'published' && (error.statusCode === 404 || /\b404\b/.test(error.message || ''))) return false;
    throw error;
  }
  if (state === 'published') {
    if (typeof current.state !== 'string') {
      const error = new Error(`Tumblr did not return a state for draft ${id}; refusing to publish`);
      error.unknownPostState = true;
      throw error;
    }
    if (current.state !== 'draft') return false;
    if (!post.is_blocks_post_format && post.type !== 'text') {
      throw new Error(`Post ${id} is a legacy ${post.type || 'non-text'} post, which Tumblr's NPF editor cannot edit`);
    }
  }
  if (!Array.isArray(current.content)) {
    throw new Error(`Tumblr returned no editable content for post ${id}`);
  }
  const options = { content: current.content, state };
  for (const key of ['layout', 'tags', 'source_url', 'slug', 'interactability_reblog',
    'parent_tumblelog_uuid', 'parent_post_id', 'reblog_key', 'hide_trail']) {
    if (current[key] !== undefined && current[key] !== null) options[key] = current[key];
  }
  await client.editPost(blog, id, options);
  return true;
}

function createRoutines(client, blog, { delay = wait, logger = console, state = createState(blog) } = {}) {
  const data = state.data;

  async function loadDrafts() {
    const seen = new Set(data.drafts.map(postId));
    logger.log(data.pages ? `Resuming draft scan after ${data.pages} pages...` : 'Scanning drafts for the oldest posts...');
    while (true) {
      await delay(100);
      const { posts } = await client.blogDrafts(blog, data.before ? { before_id: data.before } : {});
      if (!Array.isArray(posts)) throw new Error('Tumblr returned an invalid draft page');
      const cursor = posts.length === DRAFT_PAGE_SIZE ? postId(posts[posts.length - 1]) : null;
      if (cursor && seen.has(cursor)) throw new Error(`Draft pagination repeated cursor ${cursor}`);
      const entries = posts.map((post) => ({ id_string: postId(post), type: post.type, is_blocks_post_format: post.is_blocks_post_format }));
      for (const post of entries) {
        if (!seen.has(post.id_string)) {
          data.drafts.push(post);
          seen.add(post.id_string);
        }
      }
      data.pages++;
      if (posts.length < DRAFT_PAGE_SIZE) {
        data.phase = 'ready';
        data.before = null;
        state.save();
        break;
      }
      data.before = cursor;
      state.save();
      if (data.pages % 100 === 0) logger.log(`Scanned ${data.pages} draft pages so far.`);
    }
    logger.log(`Finished scanning drafts: ${data.pages} pages checked, ${data.drafts.length} drafts indexed.`);
  }

  async function publishOldestDraft() {
    if (data.phase === 'ready' && !data.drafts.length) {
      data.phase = 'scanning';
      data.pages = 0;
      data.before = null;
      state.save();
    }
    if (data.phase === 'scanning') await loadDrafts();
    while (data.drafts.length) {
      const post = data.drafts[data.drafts.length - 1];
      let published;
      try {
        published = await changeState(client, blog, post, 'published');
      } catch (error) {
        if (isRateLimit(error) || error.unknownPostState) throw error;
        data.drafts.pop();
        state.save();
        throw new Error(`Failed to publish draft ${postId(post)}: ${error.message}`, { cause: error });
      }
      data.drafts.pop();
      state.save();
      if (published) {
        logger.log(`Published draft ${postId(post)}.`);
        return;
      }
      logger.log(`Skipped draft ${postId(post)}: it is missing or no longer a draft.`);
    }
    if (!data.drafts.length) {
      logger.log('No drafts to publish.');
    }
  }

  async function draftFirstQueuePage() {
    const { posts } = await client.blogQueue(blog);
    let moved = 0;
    for (const post of posts) {
      await changeState(client, blog, post, 'draft');
      moved++;
    }
    logger.log(`Moved ${moved} queued posts to drafts.`);
  }

  return { publishOldestDraft, draftFirstQueuePage };
}

function scheduleRoutine(name, routine, interval, { logger = console, setTimer = setInterval, lock = { running: false } } = {}) {
  return setTimer(async () => {
    if (lock.running) {
      logger.warn(`${name} skipped: a scheduled routine is still running.`);
      return;
    }
    lock.running = true;
    try {
      await routine();
    } catch (error) {
      logger.error(`${name} failed:`, error);
    } finally {
      lock.running = false;
    }
  }, interval);
}

module.exports = { changeState, createRoutines, scheduleRoutine };
