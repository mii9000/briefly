import type { WebClient } from '@slack/web-api';
import { ownerActionsMessage, proposalMessage } from './views.js';
import type { Delivery, Task } from '../types.js';

export function ownerActionsDelivery(task: Task, sourceLink: string): Delivery {
  const message = ownerActionsMessage(task, sourceLink);
  return {
    key: `owner-actions:${task.id}:${task.ownerId}`,
    channelId: task.channelId,
    taskId: task.id,
    recipientId: task.ownerId!,
    text: message.text,
    blocks: message.blocks,
  };
}

export function proposalDeliveries(task: Task, sourceLink: string): Delivery[] {
  const message = proposalMessage(task, sourceLink);
  return [
    {
      key: `proposal:${task.id}`,
      channelId: task.channelId,
      taskId: task.id,
      text: message.text,
      blocks: message.blocks,
    },
    ...(task.ownerId && !['complete', 'rejected'].includes(task.status)
      ? [ownerActionsDelivery(task, sourceLink)]
      : []),
  ];
}

export async function updateProposalMessage(
  task: Task,
  slack: WebClient,
  db: { markProposalMessage(taskId: string, messageTs: string): Promise<void> },
) {
  let messageTs = task.proposalMessageTs;
  if (!messageTs) {
    const { messages } = await slack.conversations.history({
      channel: task.channelId,
      limit: 100,
    });
    const proposal = messages?.find((message) =>
      message.blocks?.some(
        (block) =>
          block.type === 'actions' &&
          'elements' in block &&
          Array.isArray(block.elements) &&
          block.elements.some(
            (element) => 'value' in element && element.value === task.id,
          ),
      ),
    );
    messageTs = proposal?.ts;
    if (!messageTs) return;
    await db.markProposalMessage(task.id, messageTs);
  }

  const { permalink } = await slack.chat.getPermalink({
    channel: task.channelId,
    message_ts: task.sourceTs,
  });
  const message = proposalMessage(task, permalink ?? '');
  console.info('processSlackEvent: updating Slack task proposal');
  const updateStarted = Date.now();
  await slack.chat.update({
    channel: task.channelId,
    ts: messageTs,
    text: message.text,
    blocks: message.blocks as never,
  });
  console.info(
    `processSlackEvent: updated Slack task proposal in ${Date.now() - updateStarted}ms`,
  );
}
