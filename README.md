# NewTwo

A small Tumblr scheduler that publishes the oldest indexed draft at a regular interval and moves the first page of queued posts to drafts every 10 minutes. Only run one instance for a blog at a time.

## Setup

Install Node.js 18 or newer and run `npm install`. Create a Tumblr OAuth application and obtain the consumer key, consumer secret, OAuth token and token secret as described in the [tumblr.js authentication guide](https://tumblr.github.io/tumblr.js/). Copy the example file and fill in your credentials:

```sh
cp .env.example .env
```

Start the scheduler with:

```sh
npm start
```

The scheduler loads `.env` from the current working directory at startup. Environment variables already set by the host take precedence. Keep credentials out of source control. Use a blog hostname or another Tumblr blog identifier for `TUMBLR_BLOG`; if omitted, it defaults to `invalidcards.tumblr.com`.

## Schedule

Set `POSTS_PER_DAY` in `index.js` to change the target publishing rate. It is currently 220, giving an interval of approximately 6 minutes 33 seconds. Restart the scheduler after changing it or the environment. Both timers start at launch, so neither routine runs immediately. A run is skipped if either routine is still running when its timer fires, so the configured rate is a target rather than a guarantee.

## Drafts and logging

Log messages begin with an ISO 8601 timestamp in UTC (the `Z` suffix). Routine completion messages are timestamped when the routine finishes.

To find the oldest drafts, the scheduler scans all draft pages and saves a compact index of IDs and editing metadata in `.newtwo-state.json` in the working directory. The scan is checkpointed after each page and resumes after a restart or failed request. Once the scan is complete, publishing works through the index, and a new scan begins only after the index is exhausted. Posts added after a scan begins may not appear until a later scan. Keep this state file when deploying updates and include it in backups. The saved state is tied to the configured blog, so the scheduler rejects it if the blog identifier changes.

Missing posts and posts no longer in the draft state are skipped immediately. If another post-specific error occurs, the scheduler logs it, skips that post and tries the next one on the next publishing interval. A skipped post that remains a draft can be indexed again on a later scan. The scheduler requires Tumblr to report the post's current state before publishing; if the state is missing, it leaves the post in the index and logs an error instead of editing it. The scheduler uses Tumblr's NPF editing endpoint, which does not support legacy non-text posts; those must be handled separately.

When Tumblr returns a 429, the scheduler pauses all its API requests, preserves the scan position or current post, and resumes on a scheduled check after the pause. It uses `Retry-After` when supplied; otherwise it starts with a one-hour pause and increases it on consecutive limits, up to 24 hours. The pause is also saved across restarts. Other applications using the same Tumblr API key can still consume its shared quota.

## Tests

Run `npm test` for the offline tests. The tests do not publish or modify Tumblr posts.
