import { describe, expect, it, vi } from 'vitest';
import { updateProposalMessage } from '../src/slack/proposals.js';
import type { Task } from '../src/types.js';

const task: Task = {
  id: 'd1415b54-59f1-4ab4-af8f-dc4ec0a972cb',
  channelId: 'C1',
  sourceTs: '101',
  title: 'Deploy test service',
  ownerId: null,
  dueAt: '2026-10-31T00:00:00.000Z',
  status: 'open',
  lastUpdatedAt: '2026-10-18T14:41:00.000Z',
  lastDmAt: null,
  escalatedAt: null,
};

describe('proposal messages', () => {
  it('finds an existing proposal card and refreshes its task details', async () => {
    const slack = {
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [
            { ts: '202', blocks: [{ type: 'actions', elements: [] }] },
            {
              ts: '203',
              blocks: [
                {
                  type: 'actions',
                  elements: [{ type: 'button', value: task.id }],
                },
              ],
            },
          ],
        }),
      },
      chat: {
        getPermalink: vi
          .fn()
          .mockResolvedValue({ permalink: 'https://slack.test/source' }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    const db = { markProposalMessage: vi.fn() };

    await updateProposalMessage(task, slack as never, db);

    expect(slack.chat.update).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '203',
      text: 'Briefly proposed: Deploy test service (owner unknown, 31/10/2026)',
      blocks: expect.arrayContaining([
        expect.objectContaining({
          type: 'section',
          text: expect.objectContaining({
            text: expect.stringContaining('Due: 31/10/2026'),
          }),
        }),
      ]),
    });
    expect(db.markProposalMessage).toHaveBeenCalledWith(task.id, '203');
  });

  it('uses the stored Slack timestamp without reading channel history', async () => {
    const slack = {
      conversations: { history: vi.fn() },
      chat: {
        getPermalink: vi
          .fn()
          .mockResolvedValue({ permalink: 'https://slack.test/source' }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
    const db = { markProposalMessage: vi.fn() };

    await updateProposalMessage(
      { ...task, proposalMessageTs: '204' },
      slack as never,
      db,
    );

    expect(slack.conversations.history).not.toHaveBeenCalled();
    expect(slack.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', ts: '204' }),
    );
  });
});
