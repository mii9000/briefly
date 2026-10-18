import { describe, expect, it, vi } from 'vitest';
import { isChannelMember, loadMemberDirectory } from '../src/slack/members.js';

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

describe('member directory', () => {
  it('loads active human names from paginated Slack results', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        members: [
          {
            id: 'U1',
            name: 'ibrahim',
            profile: { display_name: 'Ibrahim' },
          },
          {
            id: 'U2',
            name: 'domas',
            real_name: 'Domas Cole',
            profile: { display_name: 'Domas' },
          },
          { id: 'B1', name: 'Briefly', is_bot: true },
          { id: 'U4', name: 'deleted', deleted: true },
        ],
        response_metadata: { next_cursor: 'next-page' },
      })
      .mockResolvedValueOnce({
        members: [{ id: 'U3', name: 'unmentioned' }],
        response_metadata: { next_cursor: '' },
      });

    await expect(loadMemberDirectory({ users: { list } })).resolves.toEqual([
      { id: 'U1', names: ['Ibrahim', 'ibrahim'] },
      { id: 'U2', names: ['Domas', 'Domas Cole', 'domas'] },
      { id: 'U3', names: ['unmentioned'] },
    ]);
    expect(list).toHaveBeenNthCalledWith(1, { limit: 200, cursor: undefined });
    expect(list).toHaveBeenNthCalledWith(2, {
      limit: 200,
      cursor: 'next-page',
    });
  });
});
