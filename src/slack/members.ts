import type { TaskMember } from '../tasks/extract.js';

type DirectoryClient = {
  users: {
    list(args: { limit: number; cursor?: string }): Promise<{
      members?: Array<{
        id?: string;
        name?: string;
        real_name?: string;
        deleted?: boolean;
        is_bot?: boolean;
        profile?: { display_name?: string; real_name?: string };
      }>;
      response_metadata?: { next_cursor?: string };
    }>;
  };
};

export async function loadMemberDirectory(
  slack: DirectoryClient,
): Promise<TaskMember[]> {
  let cursor: string | undefined;
  const members: TaskMember[] = [];
  do {
    const page = await slack.users.list({ limit: 200, cursor });
    for (const user of page.members ?? []) {
      if (!user.id || user.deleted || user.is_bot) continue;
      const names = [
        user.profile?.display_name,
        user.profile?.real_name,
        user.real_name,
        user.name,
      ].filter((name): name is string => Boolean(name));
      members.push({ id: user.id, names: [...new Set(names)] });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return members;
}

type MemberClient = {
  conversations: {
    members(args: {
      channel: string;
      limit: number;
      cursor?: string;
    }): Promise<{
      members?: string[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
};

export async function isChannelMember(
  channelId: string,
  userId: string,
  slack: MemberClient,
): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await slack.conversations.members({
      channel: channelId,
      limit: 200,
      cursor,
    });
    if (page.members?.includes(userId)) return true;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return false;
}
