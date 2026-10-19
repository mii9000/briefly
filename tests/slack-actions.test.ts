import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackApp } from '../src/slack/app.js';
import {
  ownerActionsMessage,
  reassignmentView,
  taskCorrectionView,
} from '../src/slack/views.js';
import type { Task } from '../src/types.js';

const task: Task = {
  id: 'd1415b54-59f1-4ab4-af8f-dc4ec0a972cb',
  channelId: 'C1',
  sourceTs: '101',
  proposalMessageTs: '102',
  title: 'Deploy test service',
  ownerId: 'U1',
  dueAt: '2026-10-31T00:00:00.000Z',
  status: 'open',
  lastUpdatedAt: '2026-10-18T14:41:00.000Z',
  lastDmAt: null,
  escalatedAt: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('task action views', () => {
  it('offers title and due-date fields in the correction modal', () => {
    const view = taskCorrectionView(task);

    expect(view.callback_id).toBe('task_edit_submission');
    expect(view.private_metadata).toContain(task.id);
    expect(JSON.stringify(view.blocks)).toContain('Deploy test service');
    expect(JSON.stringify(view.blocks)).toContain('2026-10-31');
    expect(JSON.stringify(view.blocks)).toContain('Remove due date');
  });

  it('offers a Slack user picker for reassignment', () => {
    const view = reassignmentView(task);

    expect(view.callback_id).toBe('task_reassign_submission');
    expect(view.private_metadata).toContain(task.id);
    expect(JSON.stringify(view.blocks)).toContain('users_select');
  });

  it('describes the controls as direct actions instead of asking for a reply', () => {
    const message = ownerActionsMessage(task, 'source');
    const text = message.blocks
      .filter((block) => block.type === 'section')
      .map((block) =>
        'text' in block && block.text && 'text' in block.text
          ? block.text.text
          : '',
      )
      .join(' ');

    expect(text).not.toContain('Reply in this DM thread');
    expect(text).toContain('Edit the title or due date');
  });
});

describe('task action submissions', () => {
  it('opens the selected control as a Slack modal', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        () => new Response(JSON.stringify({ ok: true, view: { id: 'V1' } })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { app } = createSlackApp({
      db: { getTask: vi.fn().mockResolvedValue(task) } as never,
      trigger: { startTask: vi.fn() },
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    });

    await app.processEvent({
      body: {
        type: 'block_actions',
        user: { id: 'U1', name: 'Ibrahim' },
        channel: { id: 'D1' },
        trigger_id: 'T1',
        actions: [{ type: 'button', action_id: 'task_edit', value: task.id }],
      },
      ack: vi.fn(),
      retryNum: undefined,
    } as never);

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('views.open'),
      ),
    ).toBe(true);
    const request = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('views.open'),
    );
    expect(String(request?.[1]?.body)).toContain('task_edit_submission');
  });

  it('opens the owner picker when Suggest reassignment is clicked', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        () => new Response(JSON.stringify({ ok: true, view: { id: 'V1' } })),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { app } = createSlackApp({
      db: { getTask: vi.fn().mockResolvedValue(task) } as never,
      trigger: { startTask: vi.fn() },
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    });

    await app.processEvent({
      body: {
        type: 'block_actions',
        user: { id: 'U1', name: 'Ibrahim' },
        channel: { id: 'D1' },
        trigger_id: 'T1',
        actions: [
          { type: 'button', action_id: 'task_reassign', value: task.id },
        ],
      },
      ack: vi.fn(),
      retryNum: undefined,
    } as never);

    const request = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('views.open'),
    );
    expect(String(request?.[1]?.body)).toContain('task_reassign_submission');
  });

  it('saves correction fields and refreshes the channel task card', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            permalink: 'https://slack.test/source',
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const db = {
      getTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn().mockResolvedValue({
        ...task,
        title: 'Deploy final service',
        dueAt: '2026-11-01T00:00:00.000Z',
      }),
    };
    const { app } = createSlackApp({
      db: db as never,
      trigger: { startTask: vi.fn() },
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    });
    const ack = vi.fn();

    await app.processEvent({
      body: {
        type: 'view_submission',
        user: { id: 'U1', name: 'Ibrahim' },
        view: {
          callback_id: 'task_edit_submission',
          private_metadata: task.id,
          state: {
            values: {
              task_title: { title: { value: 'Deploy final service' } },
              task_due: { due_date: { selected_date: '2026-11-01' } },
              task_clear_due: { clear_due_date: { selected_options: [] } },
            },
          },
        },
      },
      ack,
      retryNum: undefined,
    } as never);

    expect(ack).toHaveBeenCalledOnce();
    expect(db.updateTask).toHaveBeenCalledWith(task.id, 'U1', {
      type: 'edit',
      title: 'Deploy final service',
      dueAt: '2026-11-01T00:00:00.000Z',
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes('chat.update'),
      ),
    ).toBe(true);
  });

  it('saves the proposed owner and queues their private handoff', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            permalink: 'https://slack.test/source',
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const updated = { ...task, pendingOwnerId: 'U2' };
    const db = {
      getTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn().mockResolvedValue(updated),
      claimDelivery: vi.fn().mockResolvedValue(true),
    };
    const trigger = { startTask: vi.fn().mockResolvedValue('run-1') };
    const { app } = createSlackApp({
      db: db as never,
      trigger,
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    });

    await app.processEvent({
      body: {
        type: 'view_submission',
        user: { id: 'U1', name: 'Ibrahim' },
        view: {
          id: 'V1',
          callback_id: 'task_reassign_submission',
          private_metadata: task.id,
          state: { values: { task_owner: { owner: { selected_user: 'U2' } } } },
        },
      },
      ack: vi.fn(),
      retryNum: undefined,
    } as never);

    expect(db.updateTask).toHaveBeenCalledWith(task.id, 'U1', {
      type: 'reassign',
      ownerId: 'U2',
    });
    expect(db.claimDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `reassignment:${task.id}:U2:V1`,
        recipientId: 'U2',
        taskId: task.id,
      }),
    );
    expect(trigger.startTask).toHaveBeenCalledWith(
      'sendPending',
      [],
      `send-pending:reassignment:${task.id}:U2:V1`,
    );
  });

  it('rechecks ownership when a stale correction modal is submitted', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() => new Response(JSON.stringify({ ok: true }))),
    );
    const db = {
      getTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn(),
    };
    const { app } = createSlackApp({
      db: db as never,
      trigger: { startTask: vi.fn() },
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    });

    await app.processEvent({
      body: {
        type: 'view_submission',
        user: { id: 'U2', name: 'Domas' },
        view: {
          callback_id: 'task_edit_submission',
          private_metadata: task.id,
          state: { values: { task_title: { title: { value: 'New title' } } } },
        },
      },
      ack: vi.fn(),
      retryNum: undefined,
    } as never);

    expect(db.updateTask).not.toHaveBeenCalled();
  });
});
