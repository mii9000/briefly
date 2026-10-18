export type TaskStatus = 'open' | 'in_progress' | 'complete' | 'rejected';

export type SourceMessage = {
  channelId: string;
  ts: string;
  threadTs: string | null;
  userId: string | null;
  text: string;
  permalink?: string;
};

export type Proposal = {
  sourceTs: string;
  title: string;
  ownerId: string | null;
  dueAt: string | null;
};

export type Task = {
  id: string;
  channelId: string;
  sourceTs: string;
  title: string;
  ownerId: string | null;
  proposalMessageTs?: string | null;
  pendingOwnerId?: string | null;
  dueAt: string | null;
  status: TaskStatus;
  lastUpdatedAt: string;
  lastDmAt: string | null;
  escalatedAt: string | null;
};

export type TaskChange =
  | { type: 'claim' }
  | { type: 'confirm' }
  | { type: 'edit'; title?: string; dueAt?: string | null }
  | { type: 'reassign'; ownerId: string }
  | { type: 'complete' }
  | { type: 'reject' }
  | { type: 'progress' };

export type Delivery = {
  key: string;
  channelId: string;
  recipientId?: string;
  taskId?: string;
  text: string;
  blocks?: unknown[];
};
