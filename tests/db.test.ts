import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/queries.js';

describe('database deliveries', () => {
  it('serializes Slack blocks as JSON for the jsonb column', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const db = createDb({ query } as never);
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'A, B' } }];

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
