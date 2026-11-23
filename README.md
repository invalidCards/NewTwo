# NewTwo

A small Tumblr scheduler: it publishes the oldest draft spaced apart evenly throughout the day depending on the set posts per day, and every 10 minutes it moves the first page of queued posts to drafts. Both timers start when the process starts; neither task runs immediately. Only run one instance for a blog at a time.

## Setup

Install Node.js 18 or newer and run `npm install`. Create a Tumblr OAuth application and obtain the consumer key, consumer secret, OAuth token and token secret as described in the [tumblr.js authentication guide](https://tumblr.github.io/tumblr.js/). Copy the example file and fill in your credentials:

```sh
cp .env.example .env
```

Start the scheduler with:

```sh
npm start
```

The scheduler loads `.env` from the current working directory at startup. Environment variables already set by the host take precedence. Keep credentials out of source control. Use a blog hostname or another Tumblr blog identifier for `TUMBLR_BLOG`. The program logs failed requests and retries on the next scheduled interval. It uses Tumblr's NPF editing endpoint. Tumblr does not support editing legacy non-text posts through NPF, so the program logs an error for those posts; they must be handled separately.

Log messages begin with an ISO 8601 timestamp in UTC (the `Z` suffix). Routine completion messages are timestamped when the routine finishes.

To find the oldest drafts, the scheduler scans all draft pages and saves a compact index of IDs and editing metadata in `.newtwo-state.json` in the working directory. The scan is checkpointed after each page and resumes after a restart or failed request. Once the scan is complete, publishing works through the index, and a new scan begins only after the index is exhausted. Posts added after a scan begins are picked up on a later scan. Keep this state file when deploying updates and include it in backups; do not run multiple instances for the same blog.

Missing posts and posts no longer in the draft state are skipped immediately. If another post-specific error occurs, the scheduler logs it, skips that post and tries the next one on the next publishing interval. A skipped post that remains a draft can be indexed again on a later scan. The scheduler requires Tumblr to report the post's current state before publishing; if the state is missing, it leaves the post in the index and logs an error instead of editing it.

When Tumblr returns a 429, the scheduler pauses all its API requests, preserves the scan position or current post, and resumes on a scheduled check after the pause. It uses `Retry-After` when supplied; otherwise it starts with a one-hour pause and increases it on consecutive limits, up to 24 hours. The pause is also saved across restarts. Other applications using the same Tumblr API key can still consume its shared quota.

## Running with PM2

After completing the setup above, install PM2 and start one scheduler process from the project directory:

```sh
npm install -g pm2
cd /path/to/NewTwo
pm2 start index.js --name newtwo
```

Starting from the project directory ensures the scheduler finds its `.env` file. PM2 will restart the process if it exits. To start it automatically after a machine reboot, run this as the user that manages the process:

```sh
pm2 startup
```

Run the command PM2 prints, then save the process list:

```sh
pm2 save
```

Use these commands to manage the scheduler:

```sh
pm2 status
pm2 logs newtwo
pm2 restart newtwo
pm2 stop newtwo
```

Restart the process after changing `.env` or updating the code. If you change environment variables supplied by the shell rather than `.env`, use `pm2 restart newtwo --update-env`. Keep only one scheduler process per blog to avoid duplicate posts. See the [PM2 startup documentation](https://pm2.keymetrics.io/docs/usage/startup/) for platform-specific details.

Run `npm test` for the offline tests. The tests do not publish or modify Tumblr posts.
