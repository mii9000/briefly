import type { WebClient } from '@slack/web-api';
import { proposalMessage } from './views.js';
import type { Task } from '../types.js';

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
