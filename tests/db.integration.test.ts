import { readFile } from 'node:fs/promises';
import { config as loadDotEnv } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/queries.js';

loadDotEnv({ quiet: true });
const testUrl = process.env.TEST_DATABASE_URL;
const pool = testUrl ? new pg.Pool({ connectionString: testUrl }) : null;

describe.skipIf(!pool)('Postgres integration', () => {
  const db = createDb(pool!);

  beforeAll(async () => {
    const migration = await readFile(
      new URL('../sql/001_init.sql', import.meta.url),
      'utf8',
    );
    await pool!.query(migration);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('links thread replies, gates reassignment on the proposed owner, and claims a delivery once', async () => {
    const channelId = `TEST_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const parentTs = '9000000001.000001';
    const replyTs = '9000000002.000002';
    const taskId = crypto.randomUUID();

    try {
      await pool!.query(
        'INSERT INTO channels (id, joined_at) VALUES ($1, now())',
        [channelId],
      );
      await pool!.query(
        'INSERT INTO source_messages (channel_id, ts, thread_ts, user_id) VALUES ($1, $2, $3, $4)',
        [channelId, replyTs, parentTs, 'U1'],
      );
      await pool!.query(
        'INSERT INTO tasks (id, channel_id, source_ts, title, owner_id) VALUES ($1, $2, $3, $4, $5)',
        [taskId, channelId, replyTs, 'thread task', 'U1'],
      );

      expect(await db.hasImportStarted(channelId)).toBe(true);
      expect((await db.getTaskForSource(channelId, parentTs))?.id).toBe(taskId);
      await db.claimDelivery({
        key: `dm:${taskId}`,
        channelId,
        taskId,
        recipientId: 'U1',
        text: 'Reminder',
      });
      await db.markDelivered(`dm:${taskId}`, taskId, 'dm', new Date(), '203');
      expect(await db.getTaskForReminder('U1', '203')).toMatchObject({
        id: taskId,
      });
      await expect(
        db.updateTask(taskId, 'U2', { type: 'reassign', ownerId: 'U3' }),
      ).resolves.toBeNull();
      await expect(
        db.updateTask(taskId, 'U1', { type: 'reassign', ownerId: 'U2' }),
      ).resolves.toMatchObject({ ownerId: 'U1', pendingOwnerId: 'U2' });
      await expect(
        db.resolveReassignment(taskId, 'U1', true),
      ).resolves.toBeNull();
      await expect(
        db.resolveReassignment(taskId, 'U2', true),
      ).resolves.toMatchObject({
        ownerId: 'U2',
        pendingOwnerId: null,
      });

      await db.claimDelivery({
        key: `test:${taskId}`,
        channelId,
        taskId,
        text: 'test',
      });
      const claims = await Promise.all([
        db.dueDeliveries(),
        db.dueDeliveries(),
      ]);
      expect(claims.flat()).toHaveLength(1);
    } finally {
      await pool!.query('DELETE FROM channels WHERE id = $1', [channelId]);
    }
  });
});
