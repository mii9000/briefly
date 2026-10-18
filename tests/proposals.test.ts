import { describe, expect, it, vi } from 'vitest';
import { updateProposalMessage } from '../src/slack/proposals.js';
import { proposalMessage, reassignmentMessage } from '../src/slack/views.js';
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
  it('offers only owner actions for assigned tasks and a claim for unassigned tasks', () => {
    const actionIds = (message: ReturnType<typeof proposalMessage>) =>
      (
        message.blocks.find((block) => block.type === 'actions')?.elements as
          Array<{ action_id: string }> | undefined
      )?.map(({ action_id }) => action_id) ?? [];

    expect(
      actionIds(proposalMessage({ ...task, ownerId: 'U1' }, 'source')),
    ).toEqual(['task_edit', 'task_reassign', 'task_reject']);
    expect(actionIds(proposalMessage(task, 'source'))).toEqual(['task_claim']);
    expect(
      actionIds(
        proposalMessage(
          { ...task, ownerId: 'U1', status: 'rejected' },
          'source',
        ),
      ),
    ).toEqual([]);
  });

  it('omits the actions block when a task is rejected', () => {
    const message = proposalMessage(
      { ...task, ownerId: 'U1', status: 'rejected' },
      'source',
    );

    expect(message.blocks.map(({ type }) => type)).toEqual(['section']);
  });

  it('keeps task IDs out of visible proposal and reassignment text', () => {
    const messages = [
      proposalMessage(task, 'https://slack.test/source'),
      reassignmentMessage(task, 'U2'),
    ];
    const blocks = messages.map(
      (message) =>
        message.blocks as Array<{
          type: string;
          text?: { text: string };
          elements?: Array<{ value: string; text: { text: string } }>;
        }>,
    );
    const visibleText = messages.flatMap((message, index) => [
      message.text,
      ...blocks[index]!.flatMap((block) =>
        block.type === 'section'
          ? [block.text?.text ?? '']
          : (block.elements ?? []).map((element) => element.text.text),
      ),
    ]);

    expect(visibleText.join(' ')).not.toContain(task.id);
    expect(
      blocks.flatMap((messageBlocks) =>
        messageBlocks.flatMap((block) =>
          (block.elements ?? []).map((element) => element.value),
        ),
      ),
    ).toEqual([task.id, task.id, task.id]);
  });

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
