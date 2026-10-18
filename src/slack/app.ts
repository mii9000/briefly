import { App, ExpressReceiver } from '@slack/bolt';
import type { Db } from '../db/queries.js';
import type { TaskTrigger } from '../render/trigger.js';
import {
  applyReassignmentDecision,
  applyTaskUpdate,
  renderTaskList,
} from '../tasks/updates.js';

type Dependencies = {
  db: Db;
  trigger: TaskTrigger;
  signingSecret: string;
  token: string;
  botUserId: string;
  botId: string;
};

export function createSlackApp(deps: Dependencies) {
  const receiver = new ExpressReceiver({
    signingSecret: deps.signingSecret,
    processBeforeResponse: true,
    processEventErrorHandler: async ({ response }) => {
      response.statusCode = 503;
      response.end('Workflow trigger failed');
      return false;
    },
  });
  receiver.router.get('/healthz', (_req, res) => res.json({ ok: true }));

  const app = new App({
    token: deps.token,
    receiver,
    ignoreSelf: true,
    extendedErrorHandler: true,
    botUserId: deps.botUserId,
    botId: deps.botId,
  });

  app.error(async (error) => {
    throw error;
  });

  app.event('message', async ({ event, body }) => {
    if ('bot_id' in event) return;
    const eventId = 'event_id' in body ? String(body.event_id) : '';
    if (!eventId) throw new Error('Slack event is missing event_id');
    const tasks = [];
    if (
      'channel' in event &&
      event.channel_type !== 'im' &&
      !(await deps.db.hasImportStarted(event.channel))
    ) {
      tasks.push(
        deps.trigger.startTask(
          'importChannel',
          [event.channel, new Date().toISOString()],
          `first-import:${event.channel}`,
        ),
      );
    }
    tasks.push(deps.trigger.startTask('processSlackEvent', [body], eventId));
    await Promise.all(tasks);
  });

  app.event('member_joined_channel', async ({ event, body }) => {
    if ('user' in event && event.user === deps.botUserId) {
      await deps.trigger.startTask(
        'importChannel',
        [event.channel, new Date().toISOString()],
        `first-import:${event.channel}`,
      );
    }
  });

  app.command('/briefly', async ({ command, ack, respond }) => {
    await ack();
    void (async () => {
      const [subcommand, pageText] = command.text.trim().split(/\s+/);
      if (subcommand !== 'list') {
        await respond({
          text: 'Use `/briefly list` to view this channel’s tasks.',
        });
        return;
      }
      const pageNumber = Number(pageText ?? 1);
      const page = await renderTaskList(
        command.channel_id,
        Number.isInteger(pageNumber) ? pageNumber : 1,
        deps.db,
      );
      await respond({
        text:
          page.text +
          (page.nextPage ? `\nNext: /briefly list ${page.nextPage}` : ''),
      });
    })().catch((error) =>
      console.error('Failed to respond to /briefly', error),
    );
  });

  app.action(/task_/, async ({ action, body, ack, client }) => {
    await ack();
    if (
      !('value' in action) ||
      typeof action.value !== 'string' ||
      !('action_id' in action) ||
      !body.user ||
      !body.channel
    )
      return;
    const channelId = body.channel.id;
    if (
      action.action_id === 'task_reassign_accept' ||
      action.action_id === 'task_reassign_decline'
    ) {
      try {
        await applyReassignmentDecision(
          action.value,
          body.user.id,
          action.action_id === 'task_reassign_accept',
          deps.db,
        );
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text:
            action.action_id === 'task_reassign_accept'
              ? 'Task assigned to you.'
              : 'Reassignment declined.',
        });
      } catch (error) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text:
            error instanceof Error
              ? error.message
              : 'Could not respond to the reassignment.',
        });
      }
      return;
    }
    if (
      action.action_id === 'task_edit' ||
      action.action_id === 'task_reassign'
    ) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: `Reply in this task’s thread with your correction or @mention the suggested owner.`,
      });
      return;
    }
    const change =
      action.action_id === 'task_confirm'
        ? { type: 'confirm' as const }
        : action.action_id === 'task_reject'
          ? { type: 'reject' as const }
          : action.action_id === 'task_complete'
            ? { type: 'complete' as const }
            : null;
    if (!change) return;
    try {
      await applyTaskUpdate(action.value, body.user.id, change, deps.db);
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: `Task updated.`,
      });
    } catch (error) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: error instanceof Error ? error.message : 'Could not update task.',
      });
    }
  });

  return { app, receiver };
}
