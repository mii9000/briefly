# Briefly MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit: `AGENTS.md` forbids commits unless asked.

**Goal:** Build a testable Slack pilot that turns channel commitments into per-channel tasks and follows up on stale work.

**Architecture:** A Slack Bolt web service sends slow Slack events to Render Workflows before acknowledging them. Workflow tasks import history, extract commitments, and write task state to Render Postgres. A Render hourly cron job starts a due-work task for reminders and Monday summaries.

**Tech Stack:** TypeScript on Node 22, `@slack/bolt`, `@renderinc/sdk`, `pg`, `zod`, native `fetch`, Vitest, Prettier, Docker Compose, Render web/Workflow/cron/Postgres.

**Spec:** `docs/superpowers/specs/2026-10-18-briefly-mvp-design.md`

## Global Constraints

- One internal Slack workspace; multiple public and private channels; one task list per channel.
- Initial import: 30 days of top-level messages and replies whose parent is in that window; process new replies after joining regardless of parent age.
- Unknown owner or date stays null. Proposals enter the list immediately; owners can confirm, correct, reject, or suggest reassignment.
- DM at 48 hours without an update and every 48 hours thereafter; channel escalation once after 72 hours without an update. An update resets both clocks.
- Monday summary at 10:00 in the configured IANA time zone, default `Europe/Amsterdam`.
- Render Workflows retains event input for 30 days and Hobby allows 50 root task starts per minute; the pilot accepts both limits.
- TypeScript, readable BDD-style tests, Prettier, local Postgres via Docker Compose, Render deployment. No Git commits.

## Review Focus

- A recent reply to an old parent arrives live: process it despite the backfill boundary (Task 2).
- Slack retries after a Workflow trigger response is lost: use the same event ID and create tasks once (Tasks 1 and 3).
- A member tries to alter another owner's task: reject the action without changing state (Task 4).
- The owner replies to a DM without changing the task: still escalate at 72 hours (Task 5).
- Cron or Workflow retries around Monday 10:00 or a DST change: post once, including overdue catch-up (Task 5).

## File map

- `src/{config,types,web,cron,workflows}.ts`: environment, domain types, web entry, cron trigger, and Workflow task registration.
- `src/db/{pool,migrate,queries}.ts`, `sql/001_init.sql`: Postgres connection, migration, task/source/delivery queries.
- `src/slack/{app,history,views}.ts`: Bolt handlers, history import, and Slack formatting.
- `src/tasks/{extract,updates,schedule}.ts`: model result, owner changes, and due-state rules.
- `src/render/trigger.ts`: task-run API client using an idempotency key.
- `tests/{trigger,history,extract,updates,schedule,flow}.test.ts`: behavior-focused tests with Slack/model/Render fakes.
- `compose.yaml`, `render.yaml`, `slack-app-manifest.yaml`, `README.md`: local and deployment setup.

### Task 1: Slack intake, Workflow trigger, and database foundation

**Files:** Create `package.json`, `tsconfig.json`, `.prettierrc.json`, `.gitignore`, `compose.yaml`, `sql/001_init.sql`, `src/config.ts`, `src/types.ts`, `src/db/{pool,migrate,queries}.ts`, `src/render/trigger.ts`, `src/slack/app.ts`, `src/web.ts`, `tests/trigger.test.ts`.

**Interfaces:** `startTask(task: string, input: unknown[], key: string): Promise<string>` calls Render's Run Task API with `idempotencyKey`; `createSlackApp(deps: { db: Db; trigger: TaskTrigger; slack: SlackClient }): App`; `Db` owns channel, source-message, task, and delivery queries. `src/types.ts` defines `SourceMessage`, `Task`, `TaskChange`, and `Proposal`.

- [ ] Write `trigger.test.ts`: Given a signed event sent twice, assert the same `event_id` is the trigger key and both responses are 200; assert a failed trigger returns non-2xx and an invalid Slack signature is rejected.
- [ ] Run `npm test -- tests/trigger.test.ts`; expect failure before implementation.
- [ ] Implement minimal schema, migration, config, Render trigger client, and Bolt handlers that wait for task acceptance before acknowledging. Ignore bot-authored messages. Use a short trigger timeout within Slack's three-second window.
- [ ] Run `npm test -- tests/trigger.test.ts`, `npm run typecheck`, and `npm run format:check`; expect pass.

### Task 2: Resumable import and live thread context

**Files:** Create `src/slack/history.ts`, `src/workflows.ts`, `tests/history.test.ts`; modify `src/slack/app.ts`, `src/db/queries.ts`.

**Interfaces:** `importChannel(channelId: string, joinedAt: Date, deps: ImportDeps): Promise<void>` uses `conversations.history` and `conversations.replies` for parents inside the 30-day window; `loadMessageContext(event: MessageEvent, deps: ImportDeps): Promise<SourceMessage[]>` handles live messages. Both pass message context to extraction and record unique `(channel_id, ts)` source IDs after processing.

- [ ] Write `history.test.ts`: assert in-window roots and replies are processed once after an import retry; assert an old-parent reply is skipped during import but processed from a new live event; assert the first message from an unseen channel starts import once.
- [ ] Run `npm test -- tests/history.test.ts`; expect failure.
- [ ] Implement Workflow tasks for import and live-message context, checkpointing, and Slack `Retry-After` handling. Trigger import on `member_joined_channel` when `event.user` is Briefly's bot ID, or on the first message from a channel with no import checkpoint.
- [ ] Run `npm test -- tests/history.test.ts`; expect pass.

### Task 3: Extract and propose commitments

**Files:** Create `src/tasks/extract.ts`, `tests/extract.test.ts`; modify `src/db/queries.ts`, `src/workflows.ts`, `src/slack/views.ts`.

**Interfaces:** `extractTasks(context: SourceMessage[], existing: TaskSummary[], model: ModelClient): Promise<Proposal[]>`; `processSource(source: SourceMessage, context: SourceMessage[], deps: WorkflowDeps): Promise<void>` atomically records source completion, tasks, and proposal delivery claims. Raw message text stays in Workflow inputs, not the task database.

- [ ] Write `extract.test.ts`: assert a source-backed commitment becomes one task, an unsupported source ID is rejected, unknown owner/date stay null, and repeat processing leaves the task count at one.
- [ ] Run `npm test -- tests/extract.test.ts`; expect failure.
- [ ] Implement the OpenRouter `google/gemma-3-27b-it` call with `response_format: json_schema`, `provider.require_parameters: true`, Zod validation, at most three attempts, and proposal formatting with source links.
- [ ] Run `npm test -- tests/extract.test.ts`; expect pass.

### Task 4: Owner actions and channel list

**Files:** Create `src/tasks/updates.ts`, `tests/updates.test.ts`; modify `src/slack/{app,views}.ts`, `src/db/queries.ts`, `src/workflows.ts`.

**Interfaces:** `applyTaskUpdate(taskId: string, actorId: string, change: TaskChange, db: Db): Promise<UpdateResult>` enforces owner permission and resets `last_updated_at`; `parseTaskReply(text: string, task: Task, model: ModelClient): Promise<TaskChange | null>` returns null for non-updates; `renderTaskList(channelId: string, db: Db): Promise<KnownBlock[]>` serves paged `/briefly list` output.

- [ ] Write `updates.test.ts`: assert owner confirm/edit/reject/complete/reassign transitions and new-owner proposal; assert non-owner edits fail, an unassigned task can be claimed, and lists are channel-scoped and paged. Assert "still working" is an update and "thanks" is not.
- [ ] Run `npm test -- tests/updates.test.ts`; expect failure.
- [ ] Implement short synchronous Slack actions and list reads in the web service; process task-linked thread/DM replies in Workflows using validated model classification. Keep unrelated messages on the extraction path.
- [ ] Run `npm test -- tests/updates.test.ts`; expect pass.

### Task 5: Reminders, summaries, and Render cron

**Files:** Create `src/tasks/schedule.ts`, `src/cron.ts`, `tests/schedule.test.ts`; modify `src/workflows.ts`, `src/db/queries.ts`, `src/slack/views.ts`.

**Interfaces:** `collectDueWork(now: Date, timeZone: string, db: Db): Promise<Delivery[]>` runs in a Workflow task started by hourly UTC cron; `deliver(item: Delivery, slack: SlackClient, db: Db): Promise<void>` records sent, known-failed, or uncertain status. Unique due-period and `(channel_id, local_monday)` keys prevent repeat scheduling.

- [ ] Write `schedule.test.ts`: assert DM at 48 hours, escalation at 72, next DM at 96; "thanks" does not reset time; update/completion changes due work; cron retry and DST yield one Monday post at local 10:00.
- [ ] Run `npm test -- tests/schedule.test.ts`; expect failure.
- [ ] Implement due queries, delivery claims, and cron task trigger; retry known failures and hold uncertain Slack sends for inspection.
- [ ] Run `npm test -- tests/schedule.test.ts`; expect pass.

### Task 6: End-to-end local path and Render packaging

**Files:** Create `tests/flow.test.ts`, `render.yaml`, `slack-app-manifest.yaml`, `README.md`; modify package scripts and entry points as needed.

**Interfaces:** `npm run dev:web`, `npm run dev:workflows`, `npm run migrate`, `npm test`; secrets include `DATABASE_URL`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `OPENROUTER_API_KEY`, and `RENDER_API_KEY`; settings include `BRIEFLY_TIME_ZONE` and `RENDER_WORKFLOW_SLUG`.

- [ ] Write `flow.test.ts`: Given a fixture Slack event, assert the web service triggers one local Workflow, the task proposal is sent, owner correction changes it, and due work sends the expected reminder and summary.
- [ ] Run `npm test -- tests/flow.test.ts`; expect failure.
- [ ] Add the Render web/Workflow/hourly cron/Postgres Blueprint, local setup, and Slack manifest with `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `chat:write`, `commands`, and `users:read`; subscribe to `message.channels`, `message.groups`, `message.im`, and `member_joined_channel`.
- [ ] Run `docker compose up -d`, `npm run migrate`, `npm test`, `npm run typecheck`, `npm run format:check`, and `npm run build`; expect pass. Smoke-test with `render workflows dev` and validate the Blueprint against current Render docs.

## Execution handoff

No commit step appears because the repository instructions prohibit commits without a direct request. Live workspace verification requires Slack, OpenRouter, and Render credentials and a pilot workspace; report that separately from locally verified behavior.
