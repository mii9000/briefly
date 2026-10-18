import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/queries.js';

describe('database deliveries', () => {
  it('does not let an unowned task be reassigned without first being claimed', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'task-1',
          channel_id: 'C1',
          source_ts: '101',
          title: 'Task',
          owner_id: null,
          due_at: null,
          status: 'open',
          last_updated_at: '2026-10-18T14:41:00.000Z',
          last_dm_at: null,
          escalated_at: null,
        },
      ],
    });
    const db = createDb({ query } as never);

    await expect(
      db.updateTask('task-1', 'U1', { type: 'reassign', ownerId: 'U2' }),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('assigns an unowned task to the member who claims it', async () => {
    const row = {
      id: 'task-1',
      channel_id: 'C1',
      source_ts: '101',
      title: 'Task',
      owner_id: null,
      due_at: null,
      status: 'open',
      last_updated_at: '2026-10-18T14:41:00.000Z',
      last_dm_at: null,
      escalated_at: null,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockImplementationOnce(async (_sql, values) => ({
        rows: [{ ...row, owner_id: values[4] }],
      }));
    const db = createDb({ query } as never);

    await expect(
      db.updateTask('task-1', 'U2', { type: 'claim' }),
    ).resolves.toMatchObject({ ownerId: 'U2' });
    expect(query.mock.calls[1]![1]).toEqual([
      'task-1',
      'U2',
      'Task',
      null,
      'U2',
      'open',
      false,
      null,
      true,
    ]);
  });

  it('marks a confirmed task as in progress', async () => {
    const row = {
      id: 'task-1',
      channel_id: 'C1',
      source_ts: '101',
      title: 'Task',
      owner_id: 'U1',
      due_at: null,
      status: 'open',
      last_updated_at: '2026-10-18T14:41:00.000Z',
      last_dm_at: null,
      escalated_at: null,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockImplementationOnce(async (_sql, values) => ({
        rows: [{ ...row, status: values[5] }],
      }));
    const db = createDb({ query } as never);

    await expect(
      db.updateTask('task-1', 'U1', { type: 'confirm' }),
    ).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('finds a task from the owner and Slack reminder timestamp', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'task-1',
          channel_id: 'C1',
          source_ts: '101',
          title: 'Task',
          owner_id: 'U1',
          due_at: null,
          status: 'open',
          last_updated_at: '2026-10-18T14:41:00.000Z',
          last_dm_at: null,
          escalated_at: null,
        },
      ],
    });
    const db = createDb({ query } as never);

    await expect(db.getTaskForReminder('U1', '203')).resolves.toMatchObject({
      id: 'task-1',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('slack_message_ts'),
      ['U1', '203'],
    );
  });

  it('finds a task from replies to its proposal message', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'task-1',
          channel_id: 'C1',
          source_ts: '101',
          title: 'Task',
          owner_id: 'U1',
          proposal_message_ts: '203',
          pending_owner_id: null,
          due_at: null,
          status: 'open',
          last_updated_at: '2026-10-18T14:41:00.000Z',
          last_dm_at: null,
          escalated_at: null,
        },
      ],
    });
    const db = createDb({ query } as never);

    await expect(db.getTaskForSource('C1', '203')).resolves.toMatchObject({
      proposalMessageTs: '203',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('proposal_message_ts = $2'),
      ['C1', '203'],
    );
  });

  it('loads the Slack timestamp for a task proposal', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'task-1',
          channel_id: 'C1',
          source_ts: '101',
          title: 'Task',
          owner_id: null,
          proposal_message_ts: '203',
          pending_owner_id: null,
          due_at: null,
          status: 'open',
          last_updated_at: '2026-10-18T14:41:00.000Z',
          last_dm_at: null,
          escalated_at: null,
        },
      ],
    });
    const db = createDb({ query } as never);

    await expect(db.getTask('task-1')).resolves.toMatchObject({
      proposalMessageTs: '203',
    });
  });

  it('stores the Slack timestamp for a task proposal', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const db = createDb({ query } as never);

    await db.markProposalMessage('task-1', '203');

    expect(query).toHaveBeenCalledWith(
      'UPDATE tasks SET proposal_message_ts = $2 WHERE id = $1',
      ['task-1', '203'],
    );
  });

  it('serializes Slack blocks as JSON for the jsonb column', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const db = createDb({ query } as never);
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: 'A, B' } },
    ];

    await db.claimDelivery({
      key: 'proposal:task-1',
      channelId: 'C1',
      taskId: 'task-1',
      text: 'proposal',
      blocks,
    });

    expect(query.mock.calls[0]?.[1]?.[5]).toBe(JSON.stringify(blocks));
  });
});
