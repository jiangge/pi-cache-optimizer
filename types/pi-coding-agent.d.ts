declare module "@earendil-works/pi-coding-agent" {
  export type BuildSystemPromptOptions = {
    customPrompt?: string;
    appendSystemPrompt?: string;
    selectedTools?: string[];
    toolSnippets?: Record<string, string | undefined>;
    promptGuidelines?: string[];
    contextFiles?: Array<{ path: string; content: string }>;
    skills?: Array<{
      name: string;
      filePath: string;
      description?: string;
      disableModelInvocation?: boolean;
    }>;
  };

  export type ExtensionModel = {
    provider: string;
    id: string;
    name?: string;
    api?: string;
    baseUrl?: string;
    compat?: Record<string, unknown>;
    reasoning?: boolean;
    input?: string[];
    cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
    contextWindow?: number;
    maxTokens?: number;
  };

  export type ExtensionContext = {
    model?: ExtensionModel;
    modelRegistry: {
      find(provider: string, modelId: string): ExtensionModel | undefined;
      getAvailable(): ExtensionModel[];
      getAll(): ExtensionModel[];
    };
    sessionManager: { getSessionId(): string };
    ui: {
      notify(message: string, level?: "info" | "warning" | "error" | string): void;
      setStatus(key: string, value: string | undefined): void;
      confirm(title: string, message: string): Promise<boolean>;
      select(title: string, options: string[]): Promise<string | undefined>;
    };
    hasUI?: boolean;
  };

  export type CommandContext = ExtensionContext & { hasUI?: boolean };

  export type ExtensionAPI = {
    on(event: "session_start", handler: (event: { reason?: string }, ctx: ExtensionContext) => unknown): void;
    on(event: "model_select", handler: (event: { model?: ExtensionModel }, ctx: ExtensionContext) => unknown): void;
    on(event: "before_agent_start", handler: (event: { systemPrompt: string; systemPromptOptions: BuildSystemPromptOptions }, ctx: ExtensionContext) => unknown): void;
    on(event: "before_provider_request", handler: (event: { payload: unknown }, ctx: ExtensionContext) => unknown): void;
    on(event: "after_provider_response", handler: (event: { status: number; headers?: Record<string, string> }, ctx: ExtensionContext) => unknown): void;
    on(event: "message_end", handler: (event: { message: unknown }, ctx: ExtensionContext) => unknown): void;
    registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: CommandContext) => unknown }): void;
  };
}
