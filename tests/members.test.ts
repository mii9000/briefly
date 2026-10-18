import { describe, expect, it, vi } from 'vitest';
import { isChannelMember } from '../src/slack/members.js';

describe('channel membership lookup', () => {
  it('checks paginated channel members before allowing an unassigned-task claim', async () => {
    const members = vi
      .fn()
      .mockResolvedValueOnce({
        members: ['U1'],
        response_metadata: { next_cursor: 'next' },
      })
      .mockResolvedValueOnce({ members: ['U2'] });
    const slack = { conversations: { members } };

    await expect(isChannelMember('C1', 'U2', slack)).resolves.toBe(true);
    expect(members).toHaveBeenCalledTimes(2);
  });

  it('returns false when the user is not in the channel', async () => {
    const slack = {
      conversations: {
        members: vi.fn().mockResolvedValue({ members: ['U1'] }),
      },
    };

    await expect(isChannelMember('C1', 'U2', slack)).resolves.toBe(false);
  });
});
