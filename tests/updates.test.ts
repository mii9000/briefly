import { describe, expect, it, vi } from 'vitest';
import {
  applyReassignmentDecision,
  applyTaskUpdate,
  parseTaskReply,
  renderTaskList,
} from '../src/tasks/updates.js';
import type { Task, TaskChange } from '../src/types.js';

const task: Task = {
  id: 'task-1',
  channelId: 'C1',
  sourceTs: '100',
  title: 'Send report',
  ownerId: 'U1',
  dueAt: null,
  status: 'open',
  lastUpdatedAt: '2026-10-01T00:00:00.000Z',
  lastDmAt: null,
  escalatedAt: null,
};

describe('task updates', () => {
  it('applies the owner change and rejects changes from another member', async () => {
    const db = {
      getTask: vi.fn(async () => task),
      updateTask: vi.fn(
        async (_id: string, _actor: string, change: TaskChange) => ({
          ...task,
          status:
            change.type === 'complete' ? ('complete' as const) : task.status,
        }),
      ),
    };

    await expect(
      applyTaskUpdate(task.id, 'U1', { type: 'complete' }, db),
    ).resolves.toMatchObject({ status: 'complete' });
    await expect(
      applyTaskUpdate(task.id, 'U2', { type: 'reject' }, db),
    ).rejects.toThrow('Only the owner');
    expect(db.updateTask).toHaveBeenCalledTimes(1);
  });

  it('proposes an unassigned task to a channel member without changing owner yet', async () => {
    const db = {
      getTask: vi.fn(async () => ({ ...task, ownerId: null })),
      updateTask: vi.fn(async () => ({ ...task, pendingOwnerId: 'U2' })),
    };

    await expect(
      applyTaskUpdate(task.id, 'U1', { type: 'reassign', ownerId: 'U2' }, db),
    ).resolves.toMatchObject({ ownerId: 'U1', pendingOwnerId: 'U2' });
  });

  it('lets only the proposed owner accept a reassignment', async () => {
    const db = {
      resolveReassignment: vi.fn(
        async (_id: string, actorId: string, accept: boolean) =>
          actorId === 'U2'
            ? { ...task, ownerId: accept ? actorId : task.ownerId }
            : null,
      ),
    };

    await expect(
      applyReassignmentDecision(task.id, 'U1', true, db),
    ).rejects.toThrow('proposed owner');
    await expect(
      applyReassignmentDecision(task.id, 'U2', true, db),
    ).resolves.toMatchObject({ ownerId: 'U2' });
  });

  it('classifies progress text as an update and acknowledgment text as no update', async () => {
    const model = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ type: 'progress' })
        .mockResolvedValueOnce({ type: 'none' }),
    };

    await expect(parseTaskReply('still working', task, model)).resolves.toEqual(
      { type: 'progress' },
    );
    await expect(parseTaskReply('thanks', task, model)).resolves.toBeNull();
  });

  it('only proposes reassignment to a Slack user mentioned in the owner reply', async () => {
    const model = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ type: 'reassign', ownerId: 'U2' })
        .mockResolvedValueOnce({ type: 'reassign', ownerId: 'U3' }),
    };

    await expect(
      parseTaskReply('Could <@U2> take this?', task, model),
    ).resolves.toEqual({ type: 'reassign', ownerId: 'U2' });
    await expect(
      parseTaskReply('Could <@U2> take this?', task, model),
    ).resolves.toBeNull();
  });

  it('renders only the requested channel and pages the task list', async () => {
    const tasks = [
      task,
      { ...task, id: 'task-2', channelId: 'C2', title: 'Private task' },
    ];
    const db = {
      listTasks: vi.fn(
        async (channelId: string, limit: number, offset: number) =>
          tasks
            .filter((item) => item.channelId === channelId)
            .slice(offset, offset + limit),
      ),
    };

    const page = await renderTaskList('C1', 1, db);

    expect(page.text).toContain('Send report');
    expect(page.text).not.toContain('Private task');
    expect(db.listTasks).toHaveBeenCalledWith('C1', expect.any(Number), 0);
  });
});
