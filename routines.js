'use strict';

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
  if (!post.is_blocks_post_format && post.type !== 'text') {
    throw new Error(`Post ${id} is a legacy ${post.type || 'non-text'} post, which Tumblr's NPF editor cannot edit`);
  }

  const current = await client.getRequest(`/v2/blog/${blog}/posts/${id}`);
  if (!Array.isArray(current.content)) {
    throw new Error(`Tumblr returned no editable content for post ${id}`);
  }
  const options = { content: current.content, state };
  for (const key of ['layout', 'tags', 'source_url', 'slug', 'interactability_reblog',
    'parent_tumblelog_uuid', 'parent_post_id', 'reblog_key', 'hide_trail']) {
    if (current[key] !== undefined && current[key] !== null) options[key] = current[key];
  }
  await client.editPost(blog, id, options);
}

function createRoutines(client, blog, { delay = wait, logger = console } = {}) {
  let drafts = [];

  async function loadDrafts() {
    const found = [];
    const cursors = new Set();
    let before;
    while (true) {
      await delay(100);
      const { posts } = await client.blogDrafts(blog, before ? { before_id: before } : {});
      found.push(...posts);
      if (posts.length < DRAFT_PAGE_SIZE) break;
      before = postId(posts[posts.length - 1]);
      if (cursors.has(before)) throw new Error(`Draft pagination repeated cursor ${before}`);
      cursors.add(before);
    }
    return found.reverse();
  }

  async function publishOldestDraft() {
    if (!drafts.length) drafts = await loadDrafts();
    if (!drafts.length) {
      logger.log('No drafts to publish.');
      return;
    }
    const post = drafts[0];
    try {
      await changeState(client, blog, post, 'published');
      drafts.shift();
    } catch (error) {
      drafts = [];
      throw error;
    }
    logger.log(`Published draft ${postId(post)}.`);
  }

  async function draftFirstQueuePage() {
    const { posts } = await client.blogQueue(blog);
    let moved = 0;
    try {
      for (const post of posts) {
        await changeState(client, blog, post, 'draft');
        moved++;
      }
    } finally {
      if (moved) drafts = [];
    }
    logger.log(`Moved ${moved} queued posts to drafts.`);
  }

  return { publishOldestDraft, draftFirstQueuePage };
}

function scheduleRoutine(name, routine, interval, { logger = console, setTimer = setInterval, lock = { running: false } } = {}) {
  return setTimer(async () => {
    if (lock.running) {
      logger.warn(`${name} is still running; skipping this interval.`);
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
