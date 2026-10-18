import { task, type TaskContext } from '@renderinc/sdk/workflows';
import { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createDb } from './db/queries.js';
import { getPool } from './db/pool.js';
import {
  importChannel,
  loadMessageContext,
  type HistoryClient,
} from './slack/history.js';
import { proposalMessage, reassignmentMessage } from './slack/views.js';
import { updateProposalMessage } from './slack/proposals.js';
import { isChannelMember } from './slack/members.js';
import { applyTaskUpdate, parseTaskReply } from './tasks/updates.js';
import {
  createOpenRouterModel,
  extractTasks,
  persistProposals,
} from './tasks/extract.js';
import { collectDueWork, deliver } from './tasks/schedule.js';
import type { SourceMessage, Task } from './types.js';

const eventSchema = z
  .object({
    event_id: z.string().min(1),
    event: z
      .object({
        type: z.string(),
        channel: z.string().optional(),
        channel_type: z.string().optional(),
        ts: z.string().optional(),
        thread_ts: z.string().optional(),
        user: z.string().optional(),
        text: z.string().optional(),
        bot_id: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

function runtime() {
  const config = loadConfig();
  const db = createDb(getPool());
  const slack = new WebClient(config.SLACK_BOT_TOKEN);
  return {
    config,
    db,
    slack,
    model: createOpenRouterModel(config.OPENROUTER_API_KEY),
  };
}

async function processSource(
  source: SourceMessage,
  context: SourceMessage[],
  deps: ReturnType<typeof runtime>,
) {
  const existing = await deps.db.listTasks(source.channelId, 100, 0);
  const proposals = await extractTasks(context, existing, deps.model);
  const tasks = await persistProposals(source.channelId, proposals, deps.db);
  for (const task of tasks) {
    const { permalink } = await deps.slack.chat.getPermalink({
      channel: task.channelId,
      message_ts: task.sourceTs,
    });
    const message = proposalMessage(task, permalink ?? '');
    await deps.db.claimDelivery({
      key: `proposal:${task.id}`,
      channelId: task.channelId,
      taskId: task.id,
      text: message.text,
      blocks: message.blocks,
    });
  }
  await deps.db.markSourceProcessed(source.channelId, source.ts);
  await sendPending(deps);
}

async function sendPending(deps: ReturnType<typeof runtime>) {
  await deps.db.recoverStaleDeliveries();
  for (const delivery of await deps.db.dueDeliveries())
    await deliver(delivery, deps.slack, deps.db);
}

async function updateLinkedTask(
  event: z.infer<typeof eventSchema>['event'],
  context: SourceMessage[],
  deps: ReturnType<typeof runtime>,
) {
  if (!event.channel || !event.user) return false;
  let task: Task | null = null;
  if (event.channel_type === 'im') {
    task = event.thread_ts
      ? await deps.db.getTaskForReminder(event.user, event.thread_ts)
      : null;
    const id = context
      .map((message) => message.text)
      .join('\n')
      .match(/task ([0-9a-f-]{36})/i)?.[1];
    if (!task && id) task = await deps.db.getTask(id);
  } else if (event.thread_ts) {
    task = await deps.db.getTaskForSource(event.channel, event.thread_ts);
  }
  if (!task) return false;
  if (
    !task.ownerId &&
    event.channel_type === 'im' &&
    !(await isChannelMember(task.channelId, event.user, deps.slack))
  )
    return true;
  const change = await parseTaskReply(event.text ?? '', task, deps.model);
  if (change) {
    const updated = await applyTaskUpdate(task.id, event.user, change, deps.db);
    if (change.type !== 'confirm' && change.type !== 'progress')
      await updateProposalMessage(updated, deps.slack, deps.db);
    if (change.type === 'reassign' && updated.pendingOwnerId && event.ts) {
      const message = reassignmentMessage(updated, event.user);
      await deps.db.claimDelivery({
        key: `reassignment:${task.id}:${change.ownerId}:${event.ts}`,
        channelId: task.channelId,
        taskId: task.id,
        recipientId: change.ownerId,
        text: message.text,
        blocks: message.blocks,
      });
    }
  }
  return event.channel_type === 'im' || change !== null;
}

export const importChannelTask = task(
  { name: 'importChannel', retry: { maxRetries: 3, waitDurationMs: 1000 } },
  async (_ctx: TaskContext, channelId: string, joinedAt: string) => {
    const deps = runtime();
    await importChannel(channelId, new Date(joinedAt), {
      slack: deps.slack as unknown as HistoryClient,
      db: deps.db,
      process: (source, context) => processSource(source, context, deps),
    });
    await deps.db.finishImport(channelId);
  },
);

export const processSlackEventTask = task(
  { name: 'processSlackEvent', retry: { maxRetries: 3, waitDurationMs: 1000 } },
  async (ctx: TaskContext, input: unknown) => {
    const { event } = eventSchema.parse(input);
    if (
      event.type !== 'message' ||
      !event.channel ||
      !event.ts ||
      !event.text ||
      event.bot_id
    )
      return;
    const deps = runtime();
    const context = await loadMessageContext(
      event as {
        channel: string;
        ts: string;
        thread_ts?: string;
        user?: string;
        text?: string;
      },
      {
        slack: deps.slack as unknown as HistoryClient,
      },
    );
    if (await updateLinkedTask(event, context, deps)) {
      await sendPending(deps);
      return;
    }
    if (event.channel_type === 'im') return;
    const source = context.find((message) => message.ts === event.ts);
    if (source && (await deps.db.saveSource(source)))
      await processSource(source, context, deps);
  },
);

export const runDueWorkTask = task(
  { name: 'runDueWork', retry: { maxRetries: 2, waitDurationMs: 1000 } },
  async (_ctx: TaskContext, nowIso: string) => {
    const deps = runtime();
    await collectDueWork(
      new Date(nowIso),
      deps.config.BRIEFLY_TIME_ZONE,
      deps.db,
    );
    await sendPending(deps);
  },
);
