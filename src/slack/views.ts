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
          text: `*${task.title}*\nDue: ${due} · <${sourceLink}|source thread>\nReply in this DM thread to correct the title or due date, or suggest another owner.`,
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
