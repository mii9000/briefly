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
