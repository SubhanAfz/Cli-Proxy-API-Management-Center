export interface ConversationAttachment {
  type: 'image' | 'file';
  name: string;
}

export interface ConversationItem {
  id: string;
  kind: 'message' | 'tool' | 'tool-result' | 'reasoning' | 'error';
  role: string;
  text: string;
  callId?: string;
  name?: string;
  arguments?: string;
  output?: string;
  attachments?: ConversationAttachment[];
  phase?: string;
  context?: boolean;
  requestId: string;
}

export interface RequestReference {
  id: string;
  timestamp: string;
  path: string;
  status?: number;
  duration?: string;
  sequence?: number;
}

export interface ConversationRequest extends RequestReference {
  model: string;
  client: string;
  threadId?: string;
  responseId?: string;
  previousResponseId?: string;
  items: ConversationItem[];
  inputTokens: number;
  outputTokens: number;
}

export interface ConversationThread {
  id: string;
  title: string;
  preview: string;
  timestamp: string;
  client: string;
  models: string[];
  requests: ConversationRequest[];
  items: ConversationItem[];
  inputTokens: number;
  outputTokens: number;
  ungrouped: boolean;
  hasErrors: boolean;
}
