import { DateTime } from 'luxon';
import { WebAPIPlatformError, WebAPIRateLimitedError } from '@slack/web-api';
import type { Db } from '../db/queries.js';
import type { Delivery, Task } from '../types.js';

const day = 24 * 60 * 60 * 1000;

export async function collectDueWork(
  now: Date,
  timeZone: string,
  db: Pick<Db, 'dueTasks' | 'claimDelivery' | 'channels' | 'listTasks'>,
): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  for (const task of await db.dueTasks(now)) {
    if (!task.ownerId || !['open', 'in_progress'].includes(task.status))
      continue;
    const updatedAt = Date.parse(task.lastUpdatedAt);
    const dmBase = Math.max(
      updatedAt,
      task.lastDmAt ? Date.parse(task.lastDmAt) : updatedAt,
    );
    if (now.getTime() - dmBase >= 2 * day) {
      const key = `dm:${task.id}:${new Date(dmBase).toISOString()}`;
      const delivery = {
        key,
        channelId: task.channelId,
        recipientId: task.ownerId,
        taskId: task.id,
        text: `Please update task ${task.id}: ${task.title}\nReply in this message’s thread to confirm, correct, complete, or suggest a new owner.`,
      };
      if (await db.claimDelivery(delivery)) deliveries.push(delivery);
    }

    if (
      now.getTime() - updatedAt >= 3 * day &&
      (!task.escalatedAt || Date.parse(task.escalatedAt) < updatedAt)
    ) {
      const delivery = {
        key: `escalation:${task.id}:${task.lastUpdatedAt}`,
        channelId: task.channelId,
        taskId: task.id,
        text: `Task ${task.id} has had no update for three days: ${task.title}`,
      };
      if (await db.claimDelivery(delivery)) deliveries.push(delivery);
    }
  }

  const localNow = DateTime.fromJSDate(now, { zone: timeZone });
  const monday = localNow.startOf('week');
  const summaryTime = monday.set({
    hour: 10,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  if (localNow.toMillis() >= summaryTime.toMillis()) {
    for (const channelId of await db.channels()) {
      const week = monday.toISODate();
      const tasks = await db.listTasks(channelId, 100, 0);
      if (!week) continue;
      const delivery = {
        key: `summary:${channelId}:${week}`,
        channelId,
        text: renderSummary(tasks),
      };
      if (await db.claimDelivery(delivery)) deliveries.push(delivery);
    }
  }
  return deliveries;
}

export async function deliver(
  item: Delivery,
  slack: {
    conversations: {
      open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
    };
    chat: {
      postMessage(args: {
        channel: string;
        text: string;
        blocks?: unknown[];
      }): Promise<{ ts?: string }>;
    };
  },
  db: Pick<Db, 'markDelivery' | 'markDelivered' | 'markProposalMessage'>,
  now = new Date(),
): Promise<void> {
  try {
    const channel = item.recipientId
      ? (await slack.conversations.open({ users: item.recipientId })).channel
          ?.id
      : item.channelId;
    if (!channel) throw new Error('Slack did not return a DM channel');
    const response = await slack.chat.postMessage({
      channel,
      text: item.text,
      blocks: item.blocks,
    });
    if (item.key.startsWith('proposal:') && item.taskId && response.ts)
      await db.markProposalMessage(item.taskId, response.ts);
    await db.markDelivered(
      item.key,
      item.taskId,
      item.taskId
        ? item.key.startsWith('dm:')
          ? 'dm'
          : 'escalation'
        : undefined,
      now,
    );
  } catch (error) {
    const status =
      error instanceof WebAPIPlatformError ||
      error instanceof WebAPIRateLimitedError
        ? 'failed'
        : 'uncertain';
    await db.markDelivery(item.key, status);
  }
}

function renderSummary(tasks: Task[]): string {
  const counts = tasks.reduce<Record<string, number>>((summary, task) => {
    summary[task.status] = (summary[task.status] ?? 0) + 1;
    return summary;
  }, {});
  return `Briefly weekly summary: ${counts.open ?? 0} open, ${counts.in_progress ?? 0} in progress, ${counts.complete ?? 0} complete, ${counts.rejected ?? 0} rejected.`;
}
