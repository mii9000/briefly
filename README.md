# Briefly

Briefly turns clear commitments in Slack into a task list for each channel. It leaves unclear owners and dates blank, lets owners update tasks from a proposal, DM, or thread, and reminds them when a task has had no update.

## How it works

The Slack Bolt web app verifies Slack requests and starts a Render Workflow task with Slack's event ID as the idempotency key before acknowledging the event. Workflows import channel history, classify conversations with Gemma through OpenRouter, and save tasks and delivery claims in Postgres. An hourly Render cron starts a Workflow that finds reminders due at 48 hours, channel escalations due at 72 hours, and Monday summaries. A task update resets the reminder clock; a reply that does not change task state does not.

Render Workflows provide durable task execution and retries. Postgres owns task state, import cursors, source IDs, and Slack delivery status. Workflow inputs are retained by Render for 30 days, so raw Slack event text is not copied into the application database.

## Schema

- `channels`: joined time, history cursor, import boundary, completion time.
- `source_messages`: channel and Slack timestamp, thread parent, user, processing marker. No message body is stored.
- `tasks`: proposal title, source timestamp, optional owner/date, status, and reminder timestamps. `(channel_id, source_ts, title)` is unique for retries.
- `deliveries`: idempotency key, target, message/blocks, and status (`pending`, `sending`, `sent`, `failed`, `uncertain`). Pending sends are atomically claimed; a stale in-flight send is held as uncertain instead of being blindly repeated.

See [sql/001_init.sql](sql/001_init.sql).

See the [system architecture diagram](docs/architecture/briefly-solution.html).

## Local development

Requirements: Node 22+, Docker, and a Render CLI with Workflows support (CLI 2.12+).

```sh
cp .env.example .env
# Fill the Slack, OpenRouter, and Render credentials in .env.
docker compose up -d
npm ci
npm run migrate
```

In separate terminals, run `npm run dev:workflows` and `npm run dev:web`. For local task execution, set `RENDER_USE_LOCAL_DEV=true` in `.env`; configure Slack's request URL to your local tunnel at `/slack/events`. Run `npm test`, `npm run typecheck`, and `npm run format:check`. After running migrations, `npm run test:integration` checks the delivery claim and reassignment gates against the local database in `TEST_DATABASE_URL`.

## Slack setup

Create an app from [slack-app-manifest.yaml](slack-app-manifest.yaml), set its event and interactivity request URLs to `https://<web-service>/slack/events`, install it to the pilot workspace, and add Briefly to each channel to track. Bot scopes and events are listed in the manifest. Keep all credentials in service environment variables.

The app imports accessible parent messages from the last 30 days and replies to those parents. A new reply to an older parent is still handled live. Use `/briefly list [page]` in a channel to view its tasks.

## Render deployment

Use [render.yaml](render.yaml) as a Blueprint for the web service, Workflow service, hourly cron, and Postgres database. The web service and Postgres use Free plans for the pilot. The web service runs the idempotent schema migration at startup, since Render Free services don't support pre-deploy commands. Free web services sleep after 15 minutes without traffic, and a Free Postgres database expires after 30 days. Upgrade Postgres before the expiry date to keep pilot data. Render charges at least $1/month for a Cron Job; Workflow task compute and OpenRouter model calls are usage billed. Set the `sync: false` secrets in the Render dashboard. Configure the Slack request URL after deploy, then install the Slack app. The Workflow slug defaults to `briefly`; the time zone defaults to `Europe/Amsterdam`.

A Git repository is required for Render Blueprint deployment. The supplied workspace currently has no Git repository, so deploy after placing this project in the intended Git remote. Render Workflow Hobby limits and retention accepted for this pilot: 50 root task starts per minute and 30 days of task input retention.
