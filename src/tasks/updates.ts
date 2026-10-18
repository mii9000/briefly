import { z } from 'zod';
import type { Db } from '../db/queries.js';
import type { ModelClient } from './extract.js';
import type { Task, TaskChange } from '../types.js';

const replySchema = z.object({
  type: z.enum([
    'confirm',
    'edit',
    'reassign',
    'complete',
    'reject',
    'progress',
    'none',
  ]),
  title: z.string().trim().min(1).max(240).nullable().optional(),
  dueAt: z.string().nullable().optional(),
  ownerId: z.string().min(1).nullable().optional(),
});

export async function applyTaskUpdate(
  taskId: string,
  actorId: string,
  change: TaskChange,
  db: Pick<Db, 'getTask' | 'updateTask'>,
): Promise<Task> {
  const task = await db.getTask(taskId);
  if (!task) throw new Error('Task not found');
  if (task.ownerId && task.ownerId !== actorId)
    throw new Error('Only the owner can update this task');
  const updated = await db.updateTask(taskId, actorId, change);
  if (!updated) throw new Error('Only the owner can update this task');
  return updated;
}

export async function applyReassignmentDecision(
  taskId: string,
  actorId: string,
  accept: boolean,
  db: Pick<Db, 'resolveReassignment'>,
): Promise<Task> {
  const updated = await db.resolveReassignment(taskId, actorId, accept);
  if (!updated) throw new Error('Only the proposed owner can respond');
  return updated;
}

export async function parseTaskReply(
  text: string,
  task: Task,
  model: ModelClient,
): Promise<TaskChange | null> {
  const mentions = [...text.matchAll(/<@([A-Z0-9]+)>/g)].map(
    (match) => match[1],
  );
  if (mentions.length === 1 && mentions[0] !== task.ownerId)
    return { type: 'reassign', ownerId: mentions[0]! };

  const result = replySchema.parse(
    await model.complete(JSON.stringify({ task, reply: text }), 'reply'),
  );
  if (result.type === 'none') return null;
  if (result.type === 'edit') {
    if (!result.title && result.dueAt === undefined) return null;
    if (result.dueAt && Number.isNaN(Date.parse(result.dueAt))) return null;
    return {
      type: 'edit',
      ...(result.title ? { title: result.title } : {}),
      ...(result.dueAt !== undefined ? { dueAt: result.dueAt } : {}),
    };
  }
  if (result.type === 'reassign') {
    const allowedOwners = new Set(
      [...text.matchAll(/<@([A-Z0-9]+)>/g)].map((match) => match[1]),
    );
    if (
      !result.ownerId ||
      result.ownerId === task.ownerId ||
      !allowedOwners.has(result.ownerId)
    )
      return null;
    return { type: 'reassign', ownerId: result.ownerId };
  }
  return { type: result.type } as TaskChange;
}

export async function renderTaskList(
  channelId: string,
  page: number,
  db: Pick<Db, 'listTasks'>,
): Promise<{ text: string; nextPage: number | null }> {
  const limit = 20;
  const safePage = Math.max(1, Math.floor(page));
  const tasks = await db.listTasks(
    channelId,
    limit + 1,
    (safePage - 1) * limit,
  );
  const hasNext = tasks.length > limit;
  const text = tasks
    .slice(0, limit)
    .map((task) => {
      const owner = task.ownerId ? `<@${task.ownerId}>` : 'unassigned';
      const due = task.dueAt
        ? new Date(task.dueAt).toLocaleDateString('en-GB')
        : 'date unknown';
      return `• ${task.title} — ${owner} — ${due} — ${task.status}`;
    })
    .join('\n');
  return {
    text: text || 'No tasks in this channel yet.',
    nextPage: hasNext ? safePage + 1 : null,
  };
}
