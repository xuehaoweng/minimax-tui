export type Role = "system" | "user" | "assistant";
export type ChatMode = "chat" | "plan" | "agent";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  mode: ChatMode;
}

export interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  mode?: ChatMode;
}

export interface ConversationState {
  messages: ChatMessage[];
  updatedAt: string;
}
