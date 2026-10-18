import { describe, expect, it, vi } from 'vitest';
import { extractTasks, persistProposals } from '../src/tasks/extract.js';
import type { SourceMessage, Task } from '../src/types.js';

const message: SourceMessage = {
  channelId: 'C1',
  ts: '1710000000.000001',
  threadTs: null,
  userId: 'U1',
  text: 'I will send the report by Friday.',
};

describe('task extraction', () => {
  it('keeps unknown owner and due date empty', async () => {
    const model = {
      complete: vi.fn().mockResolvedValue({
        proposals: [
          {
            sourceTs: message.ts,
            title: 'Send the report',
            ownerId: null,
            dueAt: null,
          },
        ],
      }),
    };

    await expect(extractTasks([message], [], model)).resolves.toEqual([
      {
        sourceTs: message.ts,
        title: 'Send the report',
        ownerId: null,
        dueAt: null,
      },
    ]);
  });

  it('maps a plain member name to its Slack ID', async () => {
    const namedMessage = {
      ...message,
      text: 'Domas will review the API migration plan.',
    };
    const model = {
      complete: vi.fn().mockResolvedValue({
        proposals: [
          {
            sourceTs: namedMessage.ts,
            title: 'Review the API migration plan',
            ownerId: 'U1',
            dueAt: null,
          },
        ],
      }),
    };

    await expect(
      extractTasks([namedMessage], [], model, [
        { id: 'U1', names: ['Ibrahim'] },
        { id: 'U2', names: ['Domas', 'Domas Cole'] },
      ]),
    ).resolves.toMatchObject([{ ownerId: 'U2' }]);
    expect(JSON.parse(model.complete.mock.calls[0]?.[0] ?? '')).toMatchObject({
      members: [{ id: 'U2', names: ['Domas', 'Domas Cole'] }],
    });
  });

  it('drops a due date the source message does not state', async () => {
    const undatedMessage = {
      ...message,
      text: 'I will prepare the onboarding notes.',
    };
    const model = {
      complete: vi.fn().mockResolvedValue({
        proposals: [
          {
            sourceTs: undatedMessage.ts,
            title: 'Prepare onboarding notes',
            ownerId: 'U1',
            dueAt: '2026-10-18T00:00:00.000Z',
          },
        ],
      }),
    };

    await expect(
      extractTasks([undatedMessage], [], model),
    ).resolves.toMatchObject([{ dueAt: null }]);
  });

  it('keeps a due date when its exact source evidence resolves to that date', async () => {
    const datedMessage = {
      ...message,
      ts: '1792333442.000000',
      text: 'I will prepare the onboarding notes by 5 November 2026.',
    };
    const model = {
      complete: vi.fn().mockResolvedValue({
        proposals: [
          {
            sourceTs: datedMessage.ts,
            title: 'Prepare onboarding notes',
            ownerId: 'U1',
            dueAt: '2026-11-05T00:00:00.000Z',
            dueDateEvidence: 'by 5 November 2026',
          },
        ],
      }),
    };

    await expect(
      extractTasks([datedMessage], [], model),
    ).resolves.toMatchObject([{ dueAt: '2026-11-05T00:00:00.000Z' }]);
  });

  it('discards a model proposal that points outside its source context', async () => {
    const model = {
      complete: vi.fn().mockResolvedValue({
        proposals: [
          {
            sourceTs: '999',
            title: 'Invented task',
            ownerId: null,
            dueAt: null,
          },
        ],
      }),
    };

    await expect(extractTasks([message], [], model)).resolves.toEqual([]);
  });

  it('discards a model proposal with an invalid due date', async () => {
    const model = {
      complete: vi.fn().mockResolvedValue({
        proposals: [
          {
            sourceTs: message.ts,
            title: 'Send the report',
            ownerId: null,
            dueAt: 'next week',
          },
        ],
      }),
    };

    await expect(extractTasks([message], [], model)).resolves.toEqual([]);
  });

  it('discards past due dates and gives the model the source message date', async () => {
    const recentMessage = { ...message, ts: '1792333442.000000' };
    const model = {
      complete: vi.fn().mockResolvedValue({
        proposals: [
          {
            sourceTs: recentMessage.ts,
            title: 'Complete the hackathon',
            ownerId: null,
            dueAt: '2024-04-18T00:00:00.000Z',
          },
        ],
      }),
    };

    await expect(extractTasks([recentMessage], [], model)).resolves.toEqual([
      {
        sourceTs: recentMessage.ts,
        title: 'Complete the hackathon',
        ownerId: null,
        dueAt: null,
      },
    ]);
    expect(JSON.parse(model.complete.mock.calls[0]?.[0] ?? '')).toMatchObject({
      context: [
        { ts: recentMessage.ts, timestampUtc: '2026-10-18T14:24:02.000Z' },
      ],
    });
  });

  it('persists one task when the same source is retried', async () => {
    const records = new Set<string>();
    const db = {
      createProposal: vi.fn(
        async (
          _channelId: string,
          proposal: { sourceTs: string; title: string },
        ) => {
          const key = `${proposal.sourceTs}:${proposal.title}`;
          if (records.has(key)) return null;
          records.add(key);
          return {
            id: 'task-1',
            channelId: 'C1',
            sourceTs: proposal.sourceTs,
            title: proposal.title,
            ownerId: null,
            dueAt: null,
            status: 'open',
            lastUpdatedAt: '2026-10-01T00:00:00.000Z',
            lastDmAt: null,
            escalatedAt: null,
          } satisfies Task;
        },
      ),
    };
    const proposal = {
      sourceTs: message.ts,
      title: 'Send the report',
      ownerId: null,
      dueAt: null,
    };

    await persistProposals('C1', [proposal], db);
    await persistProposals('C1', [proposal], db);

    expect(db.createProposal).toHaveBeenCalledTimes(2);
    expect(records.size).toBe(1);
  });
});
