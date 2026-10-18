import { describe, expect, it, vi } from 'vitest';
import { collectDueWork, deliver } from '../src/tasks/schedule.js';
import type { Delivery, Task } from '../src/types.js';

const task: Task = {
  id: 'task-1',
  channelId: 'C1',
  sourceTs: '100',
  title: 'Send report',
  ownerId: 'U1',
  dueAt: null,
  status: 'open',
  lastUpdatedAt: '2026-10-15T00:00:00.000Z',
  lastDmAt: null,
  escalatedAt: null,
};

function fakeDb(tasks: Task[] = [task]) {
  const keys = new Set<string>();
  return {
    dueTasks: vi.fn(async () => tasks),
    claimDelivery: vi.fn(async (item: Delivery) => {
      if (keys.has(item.key)) return false;
      keys.add(item.key);
      return true;
    }),
    channels: vi.fn(async () => [] as string[]),
    listTasks: vi.fn(async () => tasks),
    claimChannelSummary: vi.fn(async () => true),
  };
}

describe('scheduled follow-ups', () => {
  it('stores the Slack timestamp for a posted proposal card', async () => {
    const slack = {
      conversations: { open: vi.fn() },
      chat: { postMessage: vi.fn().mockResolvedValue({ ts: '203' }) },
    };
    const db = {
      markDelivery: vi.fn(),
      markDelivered: vi.fn(),
      markProposalMessage: vi.fn(),
    };

    await deliver(
      {
        key: `proposal:${task.id}`,
        channelId: task.channelId,
        taskId: task.id,
        text: 'Proposal',
      },
      slack as never,
      db as never,
    );

    expect(db.markProposalMessage).toHaveBeenCalledWith(task.id, '203');
    expect(db.markDelivered).toHaveBeenCalled();
  });

  it('DMs after 48 hours, escalates after 72, and repeats the DM after another 48', async () => {
    const db = fakeDb();

    const early = await collectDueWork(
      new Date('2026-10-16T23:00:00Z'),
      'Europe/Amsterdam',
      db,
    );
    const first = await collectDueWork(
      new Date('2026-10-17T00:00:00Z'),
      'Europe/Amsterdam',
      db,
    );
    const thirdDay = await collectDueWork(
      new Date('2026-10-18T00:00:00Z'),
      'Europe/Amsterdam',
      db,
    );
    const afterDm = fakeDb([
      {
        ...task,
        lastDmAt: '2026-10-17T00:00:00.000Z',
        escalatedAt: '2026-10-18T00:00:00.000Z',
      },
    ]);
    const nextDm = await collectDueWork(
      new Date('2026-10-19T00:00:00Z'),
      'Europe/Amsterdam',
      afterDm,
    );

    expect(early).toHaveLength(0);
    expect(first.map((item) => item.key)).toEqual([
      `dm:${task.id}:${task.lastUpdatedAt}`,
    ]);
    expect(first[0]?.text).toContain('Reply in this message’s thread');
    expect(thirdDay.map((item) => item.key)).toContain(
      `escalation:${task.id}:${task.lastUpdatedAt}`,
    );
    expect(nextDm.map((item) => item.key)).toContain(
      `dm:${task.id}:2026-10-17T00:00:00.000Z`,
    );
  });

  it('posts one Monday summary at 10:00 local time across both DST offsets', async () => {
    const db = fakeDb([]);
    db.channels.mockResolvedValue(['C1']);
    const beforeSummer = await collectDueWork(
      new Date('2026-03-30T07:00:00Z'),
      'Europe/Amsterdam',
      db,
    );
    const summer = await collectDueWork(
      new Date('2026-03-30T08:00:00Z'),
      'Europe/Amsterdam',
      db,
    );
    const winter = await collectDueWork(
      new Date('2026-11-02T09:00:00Z'),
      'Europe/Amsterdam',
      db,
    );

    expect(beforeSummer).toHaveLength(0);
    expect(summer.map((item) => item.key)).toEqual(['summary:C1:2026-03-30']);
    expect(winter.map((item) => item.key)).toEqual(['summary:C1:2026-11-02']);
  });

  it('skips complete and unassigned tasks', async () => {
    const db = fakeDb([
      { ...task, status: 'complete' },
      { ...task, id: 'task-2', ownerId: null },
    ]);

    await expect(
      collectDueWork(new Date('2026-10-20T00:00:00Z'), 'Europe/Amsterdam', db),
    ).resolves.toEqual([]);
  });
});
