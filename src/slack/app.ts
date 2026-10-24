import { App, ExpressReceiver } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { Db } from '../db/queries.js';
import type { TaskTrigger } from '../render/trigger.js';
import type { Task } from '../types.js';
import {
  applyReassignmentDecision,
  applyTaskUpdate,
  renderTaskList,
} from '../tasks/updates.js';
import { ownerActionsDelivery, updateProposalMessage } from './proposals.js';
import {
  reassignmentMessage,
  reassignmentView,
  taskCorrectionView,
} from './views.js';

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

  async function queueOwnerActions(task: Task, client: WebClient) {
    const { permalink } = await client.chat.getPermalink({
      channel: task.channelId,
      message_ts: task.sourceTs,
    });
    const delivery = ownerActionsDelivery(task, permalink ?? '');
    if (await deps.db.claimDelivery(delivery)) {
      try {
        await deps.trigger.startTask(
          'sendPending',
          [],
          `send-pending:${delivery.key}`,
        );
      } catch (error) {
        console.error(
          'Owner action DM is queued for the next delivery run',
          error,
        );
      }
    }
  }

  app.event('message', async ({ event, body }) => {
    if ('bot_id' in event || Object.hasOwn(event, 'subtype')) return;
    const eventId = 'event_id' in body ? String(body.event_id) : '';
    if (!eventId) throw new Error('Slack event is missing event_id');
    const tasks = [];
    if (
      'channel' in event &&
      event.channel_type !== 'im' &&
      !(await deps.db.hasImportStarted(event.channel))
    ) {
      await deps.db.startImport(event.channel, new Date());
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
        `channel-join:${body.event_id}`,
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

  app.view('task_edit_submission', async ({ body, view, ack, client }) => {
    await ack();
    const task = await deps.db.getTask(view.private_metadata);
    if (!task) return;
    if (!task.ownerId || task.ownerId !== body.user.id) {
      await client.chat.postEphemeral({
        channel: task.channelId,
        user: body.user.id,
        text: `Only <@${task.ownerId}> can update this task.`,
      });
      return;
    }

    const values = view.state.values;
    const title = values.task_title?.title?.value?.trim();
    if (!title) return;
    const dueDate = values.task_due?.due_date?.selected_date;
    const clearDueDate =
      values.task_clear_due?.clear_due_date?.selected_options?.some(
        (option) => option.value === 'clear',
      );
    try {
      const updated = await applyTaskUpdate(
        task.id,
        body.user.id,
        {
          type: 'edit',
          title,
          dueAt: clearDueDate
            ? null
            : dueDate
              ? `${dueDate}T00:00:00.000Z`
              : task.dueAt,
        },
        deps.db,
      );
      await updateProposalMessage(updated, client, deps.db);
      await client.chat.postEphemeral({
        channel: task.channelId,
        user: body.user.id,
        text: 'Task details updated.',
      });
    } catch (error) {
      await client.chat.postEphemeral({
        channel: task.channelId,
        user: body.user.id,
        text: error instanceof Error ? error.message : 'Could not update task.',
      });
    }
  });

  app.view('task_reassign_submission', async ({ body, view, ack, client }) => {
    await ack();
    const task = await deps.db.getTask(view.private_metadata);
    if (!task) return;
    if (!task.ownerId || task.ownerId !== body.user.id) {
      await client.chat.postEphemeral({
        channel: task.channelId,
        user: body.user.id,
        text: `Only <@${task.ownerId}> can update this task.`,
      });
      return;
    }

    const ownerId =
      view.state.values.task_owner?.owner?.selected_user ?? undefined;
    if (!ownerId || ownerId === task.ownerId) {
      await client.chat.postEphemeral({
        channel: task.channelId,
        user: body.user.id,
        text: 'Choose a different workspace member to suggest as owner.',
      });
      return;
    }
    try {
      const updated = await applyTaskUpdate(
        task.id,
        body.user.id,
        { type: 'reassign', ownerId },
        deps.db,
      );
      await updateProposalMessage(updated, client, deps.db);
      const message = reassignmentMessage(updated, body.user.id);
      const key = `reassignment:${task.id}:${ownerId}:${view.id}`;
      if (
        await deps.db.claimDelivery({
          key,
          channelId: task.channelId,
          taskId: task.id,
          recipientId: ownerId,
          text: message.text,
          blocks: message.blocks,
        })
      ) {
        try {
          await deps.trigger.startTask(
            'sendPending',
            [],
            `send-pending:${key}`,
          );
        } catch (error) {
          console.error(
            'Reassignment DM is queued for the next delivery run',
            error,
          );
        }
      }
      await client.chat.postEphemeral({
        channel: task.channelId,
        user: body.user.id,
        text: `Reassignment suggested to <@${ownerId}>. They need to accept the handoff.`,
      });
    } catch (error) {
      await client.chat.postEphemeral({
        channel: task.channelId,
        user: body.user.id,
        text:
          error instanceof Error
            ? error.message
            : 'Could not suggest reassignment.',
      });
    }
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
        const updated = await applyReassignmentDecision(
          action.value,
          body.user.id,
          action.action_id === 'task_reassign_accept',
          deps.db,
        );
        await updateProposalMessage(updated, client, deps.db);
        if (action.action_id === 'task_reassign_accept')
          await queueOwnerActions(updated, client);
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
    const task = await deps.db.getTask(action.value);
    if (!task) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: 'This task is no longer available.',
      });
      return;
    }
    if (task.ownerId && task.ownerId !== body.user.id) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: `Only <@${task.ownerId}> can update this task.`,
      });
      return;
    }
    if (!task.ownerId && action.action_id !== 'task_claim') {
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: 'Claim this task before changing it.',
      });
      return;
    }
    if (action.action_id === 'task_claim') {
      try {
        const updated = await applyTaskUpdate(
          task.id,
          body.user.id,
          { type: 'claim' },
          deps.db,
        );
        await updateProposalMessage(updated, client, deps.db);
        await queueOwnerActions(updated, client);
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text: 'Task assigned to you.',
        });
      } catch (error) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text:
            error instanceof Error
              ? error.message
              : 'Could not claim this task.',
        });
      }
      return;
    }
    if (
      action.action_id === 'task_edit' ||
      action.action_id === 'task_reassign'
    ) {
      if (!('trigger_id' in body)) return;
      try {
        await client.views.open({
          trigger_id: body.trigger_id,
          view:
            action.action_id === 'task_edit'
              ? taskCorrectionView(task)
              : reassignmentView(task),
        });
      } catch (error) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: body.user.id,
          text:
            error instanceof Error
              ? error.message
              : 'Could not open task controls.',
        });
      }
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
      const updated = await applyTaskUpdate(
        action.value,
        body.user.id,
        change,
        deps.db,
      );
      await updateProposalMessage(updated, client, deps.db);
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
