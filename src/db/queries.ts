import type { Pool } from 'pg';
import type {
  Delivery,
  Proposal,
  SourceMessage,
  Task,
  TaskChange,
} from '../types.js';

export type Db = ReturnType<typeof createDb>;

export function createDb(pool: Pool) {
  return {
    async hasImportStarted(channelId: string) {
      const { rows } = await pool.query(
        'SELECT 1 FROM channels WHERE id = $1',
        [channelId],
      );
      return rows.length > 0;
    },
    async startImport(channelId: string, joinedAt: Date) {
      await pool.query(
        `INSERT INTO channels (id, joined_at) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
        [channelId, joinedAt],
      );
    },
    async getImportCursor(channelId: string) {
      const { rows } = await pool.query(
        'SELECT history_cursor FROM channels WHERE id = $1',
        [channelId],
      );
      return rows[0]?.history_cursor ? String(rows[0].history_cursor) : null;
    },
    async saveSource(source: SourceMessage) {
      const { rowCount } = await pool.query(
        `INSERT INTO source_messages (channel_id, ts, thread_ts, user_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [source.channelId, source.ts, source.threadTs, source.userId],
      );
      if (rowCount === 1) return true;
      const { rows } = await pool.query(
        'SELECT processed_at FROM source_messages WHERE channel_id = $1 AND ts = $2',
        [source.channelId, source.ts],
      );
      return rows.length > 0 && rows[0].processed_at === null;
    },
    async markSourceProcessed(channelId: string, ts: string) {
      await pool.query(
        `UPDATE source_messages SET processed_at = now() WHERE channel_id = $1 AND ts = $2`,
        [channelId, ts],
      );
    },
    async saveCheckpoint(
      channelId: string,
      cursor: string | null,
      oldestTs: string | null,
    ) {
      await pool.query(
        `UPDATE channels SET history_cursor = $2, oldest_imported_ts = $3, updated_at = now()
         WHERE id = $1`,
        [channelId, cursor, oldestTs],
      );
    },
    async finishImport(channelId: string) {
      await pool.query(
        'UPDATE channels SET imported_at = now(), updated_at = now() WHERE id = $1',
        [channelId],
      );
    },
    async createProposal(channelId: string, proposal: Proposal) {
      const { rows } = await pool.query(
        `INSERT INTO tasks (channel_id, source_ts, title, owner_id, due_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, source_ts, title) DO NOTHING
         RETURNING *`,
        [
          channelId,
          proposal.sourceTs,
          proposal.title,
          proposal.ownerId,
          proposal.dueAt,
        ],
      );
      if (rows[0]) return rowToTask(rows[0]);
      const existing = await pool.query(
        'SELECT * FROM tasks WHERE channel_id = $1 AND source_ts = $2 AND title = $3',
        [channelId, proposal.sourceTs, proposal.title],
      );
      return existing.rows[0] ? rowToTask(existing.rows[0]) : null;
    },
    async listTasks(channelId: string, limit = 20, offset = 0) {
      const { rows } = await pool.query(
        `SELECT * FROM tasks WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [channelId, limit, offset],
      );
      return rows.map(rowToTask);
    },
    async getTask(taskId: string) {
      const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [
        taskId,
      ]);
      return rows[0] ? rowToTask(rows[0]) : null;
    },
    async getTaskForSource(channelId: string, sourceTs: string) {
      const { rows } = await pool.query(
        `SELECT tasks.* FROM tasks
         LEFT JOIN source_messages ON source_messages.channel_id = tasks.channel_id
           AND source_messages.ts = tasks.source_ts
         WHERE tasks.channel_id = $1
           AND (tasks.source_ts = $2 OR source_messages.thread_ts = $2)
         ORDER BY tasks.created_at DESC LIMIT 1`,
        [channelId, sourceTs],
      );
      return rows[0] ? rowToTask(rows[0]) : null;
    },
    async getTaskForReminder(ownerId: string, messageTs: string) {
      const { rows } = await pool.query(
        `SELECT tasks.* FROM tasks
         JOIN deliveries ON deliveries.task_id = tasks.id
         WHERE deliveries.recipient_id = $1 AND deliveries.slack_message_ts = $2
         LIMIT 1`,
        [ownerId, messageTs],
      );
      return rows[0] ? rowToTask(rows[0]) : null;
    },
    async markProposalMessage(taskId: string, messageTs: string) {
      await pool.query(
        'UPDATE tasks SET proposal_message_ts = $2 WHERE id = $1',
        [taskId, messageTs],
      );
    },
    async updateTask(taskId: string, actorId: string, change: TaskChange) {
      const task = await this.getTask(taskId);
      if (!task || (task.ownerId && task.ownerId !== actorId)) return null;
      const values = {
        title:
          change.type === 'edit' ? (change.title ?? task.title) : task.title,
        dueAt:
          change.type === 'edit' && 'dueAt' in change
            ? change.dueAt
            : task.dueAt,
        ownerId: change.type === 'reassign' ? change.ownerId : task.ownerId,
        pendingOwnerId:
          change.type === 'reassign'
            ? change.ownerId
            : (task.pendingOwnerId ?? null),
        status:
          change.type === 'complete'
            ? 'complete'
            : change.type === 'reject'
              ? 'rejected'
              : task.status,
      };
      const { rows } = await pool.query(
        `UPDATE tasks SET title = $3, due_at = $4,
         owner_id = CASE WHEN $7::boolean THEN owner_id ELSE $5 END,
         pending_owner_id = $8, status = $6,
         last_updated_at = now(), last_dm_at = NULL, escalated_at = NULL
         WHERE id = $1 AND (owner_id IS NULL OR owner_id = $2) RETURNING *`,
        [
          taskId,
          actorId,
          values.title,
          values.dueAt,
          values.ownerId,
          values.status,
          change.type === 'reassign',
          values.pendingOwnerId,
        ],
      );
      return rows[0] ? rowToTask(rows[0]) : null;
    },
    async resolveReassignment(
      taskId: string,
      actorId: string,
      accept: boolean,
    ) {
      const { rows } = await pool.query(
        `UPDATE tasks SET owner_id = CASE WHEN $3 THEN $2 ELSE owner_id END,
         pending_owner_id = NULL,
         last_updated_at = CASE WHEN $3 THEN now() ELSE last_updated_at END,
         last_dm_at = CASE WHEN $3 THEN NULL ELSE last_dm_at END,
         escalated_at = CASE WHEN $3 THEN NULL ELSE escalated_at END
         WHERE id = $1 AND pending_owner_id = $2 RETURNING *`,
        [taskId, actorId, accept],
      );
      return rows[0] ? rowToTask(rows[0]) : null;
    },
    async dueTasks(now: Date) {
      const { rows } = await pool.query(
        `SELECT * FROM tasks WHERE status IN ('open', 'in_progress') AND owner_id IS NOT NULL
         ORDER BY last_updated_at`,
      );
      return rows.map(rowToTask);
    },
    async claimDelivery(delivery: Delivery) {
      const { rowCount } = await pool.query(
        `INSERT INTO deliveries (delivery_key, channel_id, task_id, recipient_id, message, blocks, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         ON CONFLICT (delivery_key) DO UPDATE SET status = 'pending', updated_at = now()
         WHERE deliveries.status = 'failed'`,
        [
          delivery.key,
          delivery.channelId,
          delivery.taskId ?? null,
          delivery.recipientId ?? null,
          delivery.text,
          delivery.blocks ? JSON.stringify(delivery.blocks) : null,
        ],
      );
      return rowCount === 1;
    },
    async markDelivery(key: string, status: 'sent' | 'failed' | 'uncertain') {
      await pool.query(
        'UPDATE deliveries SET status = $2, updated_at = now() WHERE delivery_key = $1',
        [key, status],
      );
    },
    async markDelivered(
      key: string,
      taskId?: string,
      kind?: 'dm' | 'escalation',
      now = new Date(),
      messageTs?: string,
    ) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "UPDATE deliveries SET status = 'sent', slack_message_ts = $2, updated_at = now() WHERE delivery_key = $1",
          [key, messageTs ?? null],
        );
        if (taskId && kind) {
          const column = kind === 'dm' ? 'last_dm_at' : 'escalated_at';
          await client.query(`UPDATE tasks SET ${column} = $2 WHERE id = $1`, [
            taskId,
            now,
          ]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async recoverStaleDeliveries(now = new Date()) {
      await pool.query(
        `UPDATE deliveries SET status = 'uncertain', updated_at = $1
         WHERE status = 'sending' AND updated_at < $2`,
        [now, new Date(now.getTime() - 5 * 60 * 1000)],
      );
    },
    async dueDeliveries() {
      const { rows } = await pool.query(
        `WITH claimed AS (
           SELECT delivery_key FROM deliveries WHERE status = 'pending'
           ORDER BY created_at FOR UPDATE SKIP LOCKED
         )
         UPDATE deliveries SET status = 'sending', updated_at = now()
         WHERE delivery_key IN (SELECT delivery_key FROM claimed)
         RETURNING delivery_key AS key, channel_id AS "channelId", task_id AS "taskId",
           recipient_id AS "recipientId", message AS text, blocks`,
      );
      return rows as Delivery[];
    },
    async markTaskMessage(
      taskId: string,
      kind: 'dm' | 'escalation',
      now: Date,
    ) {
      const column = kind === 'dm' ? 'last_dm_at' : 'escalated_at';
      await pool.query(`UPDATE tasks SET ${column} = $2 WHERE id = $1`, [
        taskId,
        now,
      ]);
    },
    async channels() {
      const { rows } = await pool.query('SELECT id FROM channels ORDER BY id');
      return rows.map((row) => row.id as string);
    },
  };
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    sourceTs: String(row.source_ts),
    title: String(row.title),
    ownerId: row.owner_id ? String(row.owner_id) : null,
    proposalMessageTs: row.proposal_message_ts
      ? String(row.proposal_message_ts)
      : null,
    pendingOwnerId: row.pending_owner_id ? String(row.pending_owner_id) : null,
    dueAt: row.due_at ? new Date(String(row.due_at)).toISOString() : null,
    status: row.status as Task['status'],
    lastUpdatedAt: new Date(String(row.last_updated_at)).toISOString(),
    lastDmAt: row.last_dm_at
      ? new Date(String(row.last_dm_at)).toISOString()
      : null,
    escalatedAt: row.escalated_at
      ? new Date(String(row.escalated_at)).toISOString()
      : null,
  };
}
