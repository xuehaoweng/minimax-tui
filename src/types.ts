export type Role = "system" | "user" | "assistant" | "tool";
export type ChatMode = "chat" | "plan" | "agent";

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
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

export interface ConversationSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  activeSkills?: string[];
  activePlugins?: string[];
}

export interface ConversationStore {
  currentSessionId: string;
  sessions: ConversationSession[];
}

export interface ConversationSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  activeSkills?: string[];
  activePlugins?: string[];
}

export interface SkillManifest {
  name: string;
  description: string;
  instructions: string;
  sourcePath: string;
  installedAt: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  installedAt: string;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  repository?: string;
  homepage?: string;
  license?: string;
  skills?: string;
  hooks?: string;
  mcpServers?: string;
  apps?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    longDescription?: string;
    developerName?: string;
    category?: string;
    defaultPrompt?: string[];
  };
}

export interface PluginSummary {
  name: string;
  displayName: string;
  description: string;
  installedAt: string;
  skillCount: number;
}
