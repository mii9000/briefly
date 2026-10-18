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

  it('rejects a model proposal that points outside its source context', async () => {
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

    await expect(extractTasks([message], [], model)).rejects.toThrow();
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
