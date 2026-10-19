# Briefly MVP design

## Outcome and scope

Briefly helps one pilot Slack workspace keep commitments visible. The app can join multiple public or private channels, including accessible threads, and maintains a separate task list for each channel. Slack is the entire user interface for this release. The app is installed as an internal workspace app; external workspace installation, a web dashboard, and billing are outside this MVP.

Success means a team can invite Briefly to a channel, see task proposals from up to 30 days of accessible history and new conversation, correct those proposals, maintain tasks in Slack, receive reminders, and see a Monday status post. A local test suite and Render deployment definition must exercise and package the same behavior without live credentials.

## User behavior

1. When invited to a channel, Briefly imports up to 30 days of accessible top-level messages and replies in threads whose parent message is within that window. It continues from the last imported message as new Slack events arrive. The import can take time under Slack API limits; progress is recorded so it resumes without duplicate proposals.
2. Briefly proposes a task only when a message or thread expresses a concrete commitment. The proposal links to the source. It records the owner only when the conversation identifies a workspace member, and records a due date only when an explicit date or unambiguous relative date can be resolved from the message time. Otherwise the field is unknown. It does not guess either field.
3. A proposed task enters the channel's canonical list immediately, and an identified owner is treated as having accepted it. The shared proposal shows the source and task details; only unassigned tasks show a public Claim action. The owner receives a private DM with Correct, Suggest reassignment, and Reject actions. Correct opens a modal to edit the title or due date; Suggest reassignment opens a workspace member picker, then asks the proposed owner to accept the handoff in a private DM. Rejected tasks remain in the record with their status, but do not receive reminders.
4. `/briefly list` shows the channel's tasks, their owners, dates, and states, in pages when the list grows beyond one Slack message. Owners can update tasks through their private DM controls and replies, a reply in the source thread, or a reminder DM. Those surfaces carry a task identifier so an update cannot target an unrelated task. A completed task remains in the list's history. Members can view the list; only the owner can change or reject their assigned task. An unassigned task can be assigned by any channel member.
5. For an incomplete, assigned task, Briefly DMs the owner after two days without a task update, then every two days while it remains unchanged. If there is still no task update on day three, Briefly posts one channel follow-up for that stale period. A DM reply without a task update does not prevent that follow-up. Any task update, including confirmation, correction, reassignment, or a progress update, starts a new stale period. Completed, rejected, and unassigned tasks get no owner reminders.
6. Every Monday at 10:00 in the pilot workspace's configured time zone, Briefly posts a channel summary of current task states. The pilot defaults to `Europe/Amsterdam`; deployment can set the workspace's actual time zone. The summary does not alter reminder timing.

"Single, growing list" means one canonical database-backed list per channel, available in Slack through `/briefly list` and summarized weekly. It is not one Slack message edited indefinitely.

## Architecture

```text
Slack events -> Render web service -> Render Workflows -> OpenRouter Gemma
                    |                         |       |
Slack actions ------+-------------------------+       +-> Slack proposals and updates
                    |                         |
                    +-------------------------+----------> Render Postgres (tasks and deliveries)

Render hourly cron job -> Render Workflow due-work task -> Slack reminders and summaries
```

The TypeScript web service uses Slack Bolt to verify signed requests. For message and channel-join events, it starts a Render Workflow task using Slack's event ID as the trigger idempotency key and acknowledges Slack only after Render accepts the run; a failed trigger returns an error so Slack can retry. Bot-authored messages are ignored. A bot join event starts channel import when received; the first message from an unseen channel also starts it, so import does not depend on receiving the bot's own join event. Owner actions and `/briefly list` use short Postgres operations in the web service. Workflow tasks import history, call inference, and apply task changes. Postgres holds channel configuration, backfill checkpoints, source-message IDs, tasks, and outbound delivery records. Source-message uniqueness makes Workflow retries and history/live overlap safe beyond Render's 24-hour, version-scoped trigger deduplication.

OpenRouter's `google/gemma-3-27b-it` is the pilot inference model. The extraction call requests structured output; runtime validation still checks fields, Slack user IDs, source references, and dates before storing proposals. Invalid output is retried a limited number of times, then marked for inspection without creating a task. Ambiguous output creates no task. The model never directly writes to Slack or the database. Only messages from channels where Briefly is a member are sent for extraction. Workflow event inputs, including message text, are retained by Render for 30 days; tasks retain their source link and the minimum text needed to identify the commitment.

An hourly Render cron job starts a due-work Workflow task. That task checks Postgres against the workspace's local time and task update timestamps, so a delayed run picks up overdue work. It sends due DMs and channel escalations and claims the Monday post once per channel and local calendar week. Database uniqueness guards prevent repeated scheduling across retries. A known failed Slack send can retry. When Slack's response is lost after a send, delivery is marked uncertain for inspection rather than blindly reposted; each outbound message includes a task or summary reference to aid reconciliation.

The pilot uses one bot token and signing secret supplied as Render environment secrets. It does not need multi-workspace OAuth token storage. The repository includes a Slack app manifest with only the scopes and event subscriptions needed for public/private channel history, threads, DM interaction, commands, and posting. A Render Blueprint provisions the web service, Workflow service, hourly cron job, and Postgres. Render Workflows owns queuing, task retries, and task compute; there is no app-managed queue or always-on worker. The pilot accepts the Hobby limit of 50 root task starts per minute; if channel traffic exceeds it, the Render plan must be raised before adding those channels.

## Local development and verification

- TypeScript throughout; Prettier for formatting. Docker Compose supplies local Postgres. The web service, cron command, and Render Workflows local task server run locally against it.
- Local Slack and OpenRouter adapters use fixtures, so normal tests do not require credentials or send messages. A live Slack pilot is a separate deployment check after credentials and a workspace are provided.
- Unit tests use readable Given/When/Then cases for extraction validation, owner actions, list isolation by channel, reminder cadence, update resets, and Monday scheduling across daylight-saving changes.
- Integration tests run against local Postgres and cover duplicate Slack delivery, history/live overlap, Workflow retry, and a webhook-to-proposal-to-owner-update path. Tests assert resulting state and outbound messages rather than implementation details.
- Deployment verification checks build, typecheck, formatting, tests, Blueprint validity, and local startup. Live verification checks a public channel, a private channel, a thread, a DM update, a two-day reminder, a third-day follow-up, and a Monday post using controlled timestamps or manual job execution.

## Limits and decisions

- The app sees only channels and history Slack permits its bot to access. It does not monitor every workspace conversation by default.
- Historical import can be slow and is resumable because Slack history and reply calls are rate limited. New events are processed while backfill runs.
- Slack events are acknowledged only after their Workflow run is accepted. Slack retries failed deliveries, while Render's 24-hour trigger idempotency key and permanent Postgres source IDs prevent repeated task creation.
- The initial import does not discover recent replies to threads whose parent is older than 30 days. New replies in those threads are processed after Briefly joins the channel.
- Slack replies and DMs modify tasks only when tied to a task identifier; unrelated conversation continues through extraction as potential new commitments.
- The app does not infer implied due dates, silently assign an unclear owner, or treat a DM acknowledgement alone as a task update.
