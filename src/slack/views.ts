import type { ModalView } from '@slack/types';
import type { Task } from '../types.js';

export function proposalMessage(task: Task, sourceLink: string) {
  const owner = task.ownerId ? `<@${task.ownerId}>` : 'owner unknown';
  const due = task.dueAt
    ? new Date(task.dueAt).toLocaleDateString('en-GB')
    : 'date unknown';
  const actions =
    ['complete', 'rejected'].includes(task.status) || task.ownerId
      ? []
      : [button('task_claim', 'Claim task', task.id, 'primary')];
  return {
    text: `Briefly proposed: ${task.title} (${owner}, ${due})`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${task.title}*\nOwner: ${owner} · Due: ${due} · <${sourceLink}|source>`,
        },
      },
      ...(actions.length ? [{ type: 'actions', elements: actions }] : []),
    ],
  };
}

export function ownerActionsMessage(task: Task, sourceLink: string) {
  const due = task.dueAt
    ? new Date(task.dueAt).toLocaleDateString('en-GB')
    : 'date unknown';
  return {
    text: `Briefly task assigned to you: ${task.title} (due ${due})`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${task.title}*\nDue: ${due} · <${sourceLink}|source thread>\nEdit the title or due date, or suggest a new owner with the controls below.`,
        },
      },
      ...(task.status === 'complete' || task.status === 'rejected'
        ? []
        : [
            {
              type: 'actions',
              elements: [
                button('task_edit', 'Correct', task.id),
                button('task_reassign', 'Suggest reassignment', task.id),
                button('task_reject', 'Reject', task.id, 'danger'),
              ],
            },
          ]),
    ],
  };
}

export function taskCorrectionView(task: Task): ModalView {
  return {
    type: 'modal',
    callback_id: 'task_edit_submission',
    private_metadata: task.id,
    title: { type: 'plain_text', text: 'Correct task' },
    submit: { type: 'plain_text', text: 'Save changes' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'task_title',
        label: { type: 'plain_text', text: 'Task title' },
        element: {
          type: 'plain_text_input',
          action_id: 'title',
          initial_value: task.title,
          max_length: 240,
        },
      },
      {
        type: 'input',
        block_id: 'task_due',
        optional: true,
        label: { type: 'plain_text', text: 'Due date' },
        element: {
          type: 'datepicker',
          action_id: 'due_date',
          ...(task.dueAt ? { initial_date: task.dueAt.slice(0, 10) } : {}),
        },
      },
      {
        type: 'input',
        block_id: 'task_clear_due',
        optional: true,
        label: { type: 'plain_text', text: 'Due date options' },
        element: {
          type: 'checkboxes',
          action_id: 'clear_due_date',
          options: [
            {
              text: { type: 'plain_text', text: 'Remove due date' },
              value: 'clear',
            },
          ],
        },
      },
    ],
  };
}

export function reassignmentView(task: Task): ModalView {
  return {
    type: 'modal',
    callback_id: 'task_reassign_submission',
    private_metadata: task.id,
    title: { type: 'plain_text', text: 'Suggest reassignment' },
    submit: { type: 'plain_text', text: 'Suggest owner' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'task_owner',
        label: { type: 'plain_text', text: 'New owner' },
        element: {
          type: 'users_select',
          action_id: 'owner',
          placeholder: {
            type: 'plain_text',
            text: 'Choose a workspace member',
          },
        },
      },
    ],
  };
}

export function reassignmentMessage(task: Task, proposedBy: string) {
  return {
    text: `Task reassignment proposed by <@${proposedBy}>: ${task.title}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Would you like to own *${task.title}*? Proposed by <@${proposedBy}>.`,
        },
      },
      {
        type: 'actions',
        elements: [
          button('task_reassign_accept', 'Accept task', task.id, 'primary'),
          button('task_reassign_decline', 'Decline', task.id),
        ],
      },
    ],
  };
}

function button(
  actionId: string,
  text: string,
  taskId: string,
  style?: string,
) {
  return {
    type: 'button',
    action_id: actionId,
    value: taskId,
    text: { type: 'plain_text', text },
    ...(style ? { style } : {}),
  };
}
