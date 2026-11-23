'use strict';

const tumblr = require('tumblr.js');
const { createRoutines, scheduleRoutine } = require('./routines');

const POSTS_PER_DAY = 125;
const POST_INTERVAL = 24 * 60 * 60 * 1000 / POSTS_PER_DAY;
const QUEUE_INTERVAL = 10 * 60 * 1000;

function loadEnvironment(env = process.env, path = '.env') {
  const { error } = require('dotenv').config({ path, processEnv: env, quiet: true, override: false });
  if (error && error.code !== 'ENOENT') throw error;
}

function main(env = process.env) {
  const variables = {
    consumer_key: 'TUMBLR_CONSUMER_KEY',
    consumer_secret: 'TUMBLR_CONSUMER_SECRET',
    token: 'TUMBLR_TOKEN',
    token_secret: 'TUMBLR_TOKEN_SECRET',
  };
  const missing = Object.values(variables).filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);

  const credentials = Object.fromEntries(
    Object.entries(variables).map(([key, name]) => [key, env[name]])
  );
  const blog = env.TUMBLR_BLOG || 'invalidcards.tumblr.com';
  const client = tumblr.createClient(credentials);
  const routines = createRoutines(client, blog);
  const lock = { running: false };
  scheduleRoutine('Publish draft', routines.publishOldestDraft, POST_INTERVAL, { lock });
  scheduleRoutine('Move queue to drafts', routines.draftFirstQueuePage, QUEUE_INTERVAL, { lock });
  console.log(`Started for ${blog}: publishing every ${POST_INTERVAL / 60000} minutes and checking the queue every 10 minutes.`);
}

if (require.main === module) {
  try {
    loadEnvironment();
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { loadEnvironment, main };
