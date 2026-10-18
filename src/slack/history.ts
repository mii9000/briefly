import type { SourceMessage } from '../types.js';

type SlackMessage = {
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  reply_count?: number;
  bot_id?: string;
};

type HistoryResponse = {
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
};

export type HistoryClient = {
  conversations: {
    history(args: {
      channel: string;
      oldest: string;
      limit: number;
      cursor?: string;
    }): Promise<HistoryResponse>;
    replies(args: {
      channel: string;
      ts: string;
      limit: number;
      cursor?: string;
    }): Promise<HistoryResponse>;
  };
};

type ImportDeps = {
  slack: HistoryClient;
  db: {
    startImport(channelId: string, joinedAt: Date): Promise<void>;
    getImportCursor(channelId: string): Promise<string | null>;
    saveSource(source: SourceMessage): Promise<boolean>;
    saveCheckpoint(
      channelId: string,
      cursor: string | null,
      oldestTs: string | null,
    ): Promise<void>;
  };
  process(source: SourceMessage, context: SourceMessage[]): Promise<void>;
  now?: Date;
};

export async function ensureChannelImport(
  channelId: string,
  joinedAt: Date,
  deps: {
    db: { hasImportStarted(channelId: string): Promise<boolean> };
    runImport(channelId: string, joinedAt: Date): Promise<void>;
  },
): Promise<void> {
  if (!(await deps.db.hasImportStarted(channelId)))
    await deps.runImport(channelId, joinedAt);
}

export async function importChannel(
  channelId: string,
  joinedAt: Date,
  deps: ImportDeps,
): Promise<void> {
  const oldest = String(
    Math.floor(
      ((deps.now ?? new Date()).getTime() - 30 * 24 * 60 * 60 * 1000) / 1000,
    ),
  );
  await deps.db.startImport(channelId, joinedAt);
  let cursor = (await deps.db.getImportCursor(channelId)) || undefined;
  let oldestTs: string | null = null;

  do {
    const page = await slackCall(() =>
      deps.slack.conversations.history({
        channel: channelId,
        oldest,
        limit: 100,
        cursor,
      }),
    );
    for (const parent of page.messages ?? []) {
      if (Number(parent.ts) < Number(oldest)) continue;
      oldestTs =
        !oldestTs || Number(parent.ts) < Number(oldestTs)
          ? parent.ts
          : oldestTs;
      const context = parent.reply_count
        ? await loadThread(channelId, parent, deps.slack)
        : [toSource(channelId, parent)];
      for (const source of context) {
        if (await deps.db.saveSource(source))
          await deps.process(source, context);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
    await deps.db.saveCheckpoint(channelId, cursor ?? null, oldestTs);
  } while (cursor);
}

export async function loadMessageContext(
  event: {
    channel: string;
    ts: string;
    thread_ts?: string;
    user?: string;
    text?: string;
  },
  deps: { slack: HistoryClient },
): Promise<SourceMessage[]> {
  if (event.thread_ts) {
    return loadThread(
      event.channel,
      { ts: event.thread_ts, reply_count: 1 },
      deps.slack,
      event,
    );
  }
  return [toSource(event.channel, event)];
}

async function loadThread(
  channelId: string,
  parent: SlackMessage,
  slack: HistoryClient,
  current?: SlackMessage,
): Promise<SourceMessage[]> {
  let cursor: string | undefined;
  const messages: SourceMessage[] = [];
  do {
    const page = await slackCall(() =>
      slack.conversations.replies({
        channel: channelId,
        ts: parent.ts,
        limit: 100,
        cursor,
      }),
    );
    messages.push(
      ...(page.messages ?? []).map((message) => toSource(channelId, message)),
    );
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  if (current && !messages.some((message) => message.ts === current.ts)) {
    messages.push(toSource(channelId, current));
  }
  return messages;
}

function toSource(channelId: string, message: SlackMessage): SourceMessage {
  return {
    channelId,
    ts: message.ts,
    threadTs: message.thread_ts ?? null,
    userId: message.user ?? null,
    text: message.text ?? '',
  };
}

async function slackCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const retryAfter =
      error && typeof error === 'object' && 'retryAfter' in error
        ? Number(error.retryAfter)
        : 0;
    if (!retryAfter) throw error;
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    return call();
  }
}
