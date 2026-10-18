import { describe, expect, it, vi } from 'vitest';
import { createSlackApp } from '../src/slack/app.js';
import { proposalMessage } from '../src/slack/views.js';
import { extractTasks, persistProposals } from '../src/tasks/extract.js';
import { collectDueWork } from '../src/tasks/schedule.js';
import { applyTaskUpdate, parseTaskReply } from '../src/tasks/updates.js';
import type { SourceMessage, Task, TaskChange } from '../src/types.js';

const source: SourceMessage = {
  channelId: 'C1',
  ts: '101',
  threadTs: null,
  userId: 'U1',
  text: 'I will send the report',
};

const task: Task = {
  id: 'd1415b54-59f1-4ab4-af8f-dc4ec0a972cb',
  channelId: 'C1',
  sourceTs: source.ts,
  title: 'Send the report',
  ownerId: 'U1',
  dueAt: null,
  status: 'open',
  lastUpdatedAt: '2026-10-15T09:00:00.000Z',
  lastDmAt: null,
  escalatedAt: null,
};

describe('Briefly local flow', () => {
  it('creates the channel row before scheduling first-message processing', async () => {
    const calls: string[] = [];
    const db = {
      hasImportStarted: vi.fn().mockResolvedValue(false),
      startImport: vi.fn(async () => {
        calls.push('channel row');
      }),
    };
    const app = createSlackApp({
      db: db as never,
      trigger: {
        startTask: vi.fn(async (name) => {
          calls.push(name);
          return 'run-1';
        }),
      },
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    }).app;

    await app.processEvent({
      body: {
        type: 'event_callback',
        event_id: 'EvFirstMessage',
        event: {
          type: 'message',
          channel: 'C1',
          channel_type: 'channel',
          user: 'U1',
          text: 'I will lead the pilot.',
          ts: '102',
        },
      },
      ack: vi.fn(),
      retryNum: undefined,
    } as never);

    expect(calls).toEqual([
      'channel row',
      'importChannel',
      'processSlackEvent',
    ]);
  });

  it('turns a Slack event into a proposal, applies an owner correction, and schedules due messages', async () => {
    const trigger = { startTask: vi.fn().mockResolvedValue('run-1') };
    const app = createSlackApp({
      db: { hasImportStarted: vi.fn().mockResolvedValue(true) } as never,
      trigger,
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    }).app;
    await app.processEvent({
      body: {
        type: 'event_callback',
        event_id: 'EvFlow',
        event: {
          type: 'message',
          channel: 'C1',
          user: 'U1',
          text: source.text,
          ts: source.ts,
        },
      },
      ack: vi.fn(),
      retryNum: undefined,
    } as never);

    const taskState: { current: Task | null } = { current: null };
    const deliveries: Array<{ key: string; text: string }> = [];
    const db = {
      createProposal: vi.fn(async () => {
        taskState.current = task;
        return task;
      }),
      getTask: vi.fn(async () => taskState.current),
      updateTask: vi.fn(
        async (_id: string, _actor: string, change: TaskChange) => {
          if (!taskState.current) return null;
          taskState.current = {
            ...taskState.current,
            title:
              change.type === 'edit'
                ? (change.title ?? taskState.current.title)
                : taskState.current.title,
          };
          return taskState.current;
        },
      ),
      dueTasks: vi.fn(async () =>
        taskState.current ? [taskState.current] : [],
      ),
      channels: vi.fn(async () => ['C1']),
      listTasks: vi.fn(async () =>
        taskState.current ? [taskState.current] : [],
      ),
      claimDelivery: vi.fn(async (delivery: { key: string; text: string }) => {
        deliveries.push(delivery);
        return true;
      }),
    };
    const model = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          proposals: [
            {
              sourceTs: source.ts,
              title: task.title,
              ownerId: task.ownerId,
              dueAt: null,
            },
          ],
        })
        .mockResolvedValueOnce({
          type: 'edit',
          title: 'Send the final report',
        }),
    };
    const proposals = await extractTasks([source], [], model);
    const created = await persistProposals('C1', proposals, db);
    const proposal = proposalMessage(created[0]!, 'https://slack.test/source');
    await db.claimDelivery({ key: `proposal:${task.id}`, text: proposal.text });

    const change = await parseTaskReply(
      'Please call it the final report',
      task,
      model,
    );
    await applyTaskUpdate(task.id, 'U1', change!, db);
    await collectDueWork(
      new Date('2026-10-19T08:00:00.000Z'),
      'Europe/Amsterdam',
      db,
    );

    expect(trigger.startTask).toHaveBeenCalledWith(
      'processSlackEvent',
      expect.any(Array),
      'EvFlow',
    );
    expect(proposal.text).toContain(task.title);
    expect(taskState.current?.title).toBe('Send the final report');
    expect(deliveries.map(({ key }) => key)).toEqual([
      `proposal:${task.id}`,
      expect.stringMatching(/^dm:/),
      expect.stringMatching(/^escalation:/),
      'summary:C1:2026-10-19',
    ]);
  });
});
