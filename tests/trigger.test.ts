import { describe, expect, it, vi } from 'vitest';
import { verifySlackRequest } from '@slack/bolt';
import { createSlackApp } from '../src/slack/app.js';

describe('Slack event trigger', () => {
  it('uses Slack event ID to trigger the same Workflow run on redelivery', async () => {
    const trigger = { startTask: vi.fn().mockResolvedValue('run-1') };
    const slack = { postMessage: vi.fn() };
    const db = { hasImportStarted: vi.fn().mockResolvedValue(true) };
    const { app } = createSlackApp({
      db: db as never,
      trigger,
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    });

    await app.processEvent({
      body: {
        type: 'event_callback',
        event_id: 'Ev123',
        event: {
          type: 'message',
          channel: 'C123',
          user: 'U123',
          text: 'I will send the report',
          ts: '1',
        },
      },
      ack: vi.fn(),
      retryNum: undefined,
    } as never);
    await app.processEvent({
      body: {
        type: 'event_callback',
        event_id: 'Ev123',
        event: {
          type: 'message',
          channel: 'C123',
          user: 'U123',
          text: 'I will send the report',
          ts: '1',
        },
      },
      ack: vi.fn(),
      retryNum: undefined,
    } as never);

    expect(trigger.startTask).toHaveBeenNthCalledWith(
      1,
      'processSlackEvent',
      expect.any(Array),
      'Ev123',
    );
    expect(trigger.startTask).toHaveBeenNthCalledWith(
      2,
      'processSlackEvent',
      expect.any(Array),
      'Ev123',
    );
  });

  it('starts the first-channel import and live event in parallel before acknowledgement', async () => {
    let release!: () => void;
    const pending = new Promise<string>((resolve) => {
      release = () => resolve('run-1');
    });
    const trigger = { startTask: vi.fn(() => pending) };
    const { app } = createSlackApp({
      db: { hasImportStarted: vi.fn().mockResolvedValue(false) } as never,
      trigger,
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    });
    const processing = app.processEvent({
      body: {
        type: 'event_callback',
        event_id: 'EvFirst',
        event: {
          type: 'message',
          channel: 'C123',
          user: 'U123',
          text: 'I will send the report',
          ts: '1',
        },
      },
      ack: vi.fn(),
      retryNum: undefined,
    } as never);

    await vi.waitFor(() => expect(trigger.startTask).toHaveBeenCalled());
    expect(trigger.startTask).toHaveBeenCalledTimes(2);
    expect(trigger.startTask).toHaveBeenCalledWith(
      'importChannel',
      expect.any(Array),
      'first-import:C123',
    );
    release();
    await processing;
  });

  it('rejects a Slack event when Render cannot accept its Workflow task', async () => {
    const trigger = {
      startTask: vi.fn().mockRejectedValue(new Error('Render unavailable')),
    };
    const { app } = createSlackApp({
      db: { hasImportStarted: vi.fn().mockResolvedValue(true) } as never,
      trigger,
      signingSecret: 'secret',
      token: 'token',
      botUserId: 'B1',
      botId: 'B1',
    });

    await expect(
      app.processEvent({
        body: {
          type: 'event_callback',
          event_id: 'Ev123',
          event: {
            type: 'message',
            channel: 'C123',
            user: 'U123',
            text: 'I will send the report',
            ts: '1',
          },
        },
        ack: vi.fn(),
        retryNum: undefined,
      } as never),
    ).rejects.toThrow();
  });

  it('rejects a request with an invalid Slack signature', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev123',
      event: { type: 'message' },
    });
    expect(() =>
      verifySlackRequest({
        signingSecret: 'secret',
        body,
        headers: {
          'x-slack-request-timestamp': Math.floor(Date.now() / 1000),
          'x-slack-signature': 'v0=invalid',
        },
      }),
    ).toThrow();
  });
});
