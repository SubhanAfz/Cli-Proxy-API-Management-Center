import type { ConversationItem } from '../types';

export const CONVERSATION_PAGE_SIZE = 25;
export const ACTIVITY_PAGE_SIZE = 100;

export interface ConversationBlock {
  user?: ConversationItem;
  activity: ConversationItem[];
  context?: ConversationItem;
}

export function conversationBlocks(items: ConversationItem[], showContext: boolean) {
  const blocks: ConversationBlock[] = [];
  for (const item of items) {
    if (item.context) {
      if (showContext) blocks.push({ activity: [], context: item });
      continue;
    }
    if (item.kind === 'message' && item.role === 'user') blocks.push({ user: item, activity: [] });
    else {
      if (!blocks.length || blocks[blocks.length - 1].context) blocks.push({ activity: [] });
      blocks[blocks.length - 1].activity.push(item);
    }
  }
  return blocks;
}
