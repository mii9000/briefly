import { describe, expect, it, vi } from 'vitest';
import {
  ensureChannelImport,
  importChannel,
  loadMessageContext,
} from '../src/slack/history.js';
import type { SourceMessage } from '../src/types.js';

const source = (
  ts: string,
  threadTs: string | null,
  text: string,
): SourceMessage => ({
  channelId: 'C1',
  ts,
  threadTs,
  userId: 'U1',
  text,
});

describe('channel history', () => {
  it('starts one backfill when the first message arrives from a channel', async () => {
    let imported = false;
    const runImport = vi.fn(async () => void (imported = true));
    const deps = { db: { hasImportStarted: async () => imported }, runImport };

    await ensureChannelImport('C1', new Date(0), deps);
    await ensureChannelImport('C1', new Date(0), deps);

    expect(runImport).toHaveBeenCalledTimes(1);
  });

  it('imports only the last 30 days and processes each parent and reply once across retries', async () => {
    const saved = new Set<string>();
    const processed: string[] = [];
    const slack = {
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [
            {
              ts: '2678500',
              text: 'Recent commitment',
              user: 'U1',
              reply_count: 1,
            },
            { ts: '100', text: 'Old message', user: 'U1' },
          ],
          response_metadata: { next_cursor: '' },
        }),
        replies: vi.fn().mockResolvedValue({
          messages: [
            { ts: '2678500', text: 'Recent commitment', user: 'U1' },
            {
              ts: '2678501',
              thread_ts: '2678500',
              text: 'I will do it',
              user: 'U2',
            },
          ],
          response_metadata: { next_cursor: '' },
        }),
      },
    };
    const deps = {
      slack,
      db: {
        startImport: vi.fn(),
        getImportCursor: vi.fn(async () => null),
        saveSource: vi.fn(async ({ ts }: SourceMessage) => {
          if (saved.has(ts)) return false;
          saved.add(ts);
          return true;
        }),
        saveCheckpoint: vi.fn(),
      },
      process: vi.fn(
        async (message: SourceMessage) => void processed.push(message.ts),
      ),
      now: new Date(31 * 24 * 60 * 60 * 1000),
    };

    await importChannel('C1', new Date(0), deps);
    await importChannel('C1', new Date(0), deps);

    expect(slack.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({ oldest: expect.any(String) }),
    );
    expect(processed).toEqual(['2678500', '2678501']);
    expect(deps.db.saveSource).toHaveBeenCalledTimes(4);
    expect(deps.process).toHaveBeenCalledTimes(2);
  });

  it('loads replies to an old parent when a new reply arrives live', async () => {
    const context = await loadMessageContext(
      {
        channel: 'C1',
        ts: '500',
        thread_ts: '100',
        user: 'U2',
        text: 'I finished it',
      },
      {
        slack: {
          conversations: {
            history: vi.fn(),
            replies: vi.fn().mockResolvedValue({
              messages: [
                { ts: '100', text: 'Old parent', user: 'U1' },
                {
                  ts: '500',
                  thread_ts: '100',
                  text: 'I finished it',
                  user: 'U2',
                },
              ],
            }),
          },
        },
      },
    );

    expect(context.map((message) => message.ts)).toEqual(['100', '500']);
  });
});
