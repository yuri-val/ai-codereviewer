import { createClaudeProvider, DEFAULT_MODEL as CLAUDE_MODEL } from "./claude";
import { createOpenAIProvider, DEFAULT_MODEL as OPENAI_MODEL } from "./openai";
import {
  createOpenRouterProvider,
  DEFAULT_MODEL as OPENROUTER_MODEL,
} from "./openrouter";
import { Provider } from "./types";

export * from "./types";

export type ProviderName = "openai" | "claude" | "open-router";

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: OPENAI_MODEL,
  claude: CLAUDE_MODEL,
  "open-router": OPENROUTER_MODEL,
};

const ALIASES: Record<string, ProviderName> = {
  openai: "openai",
  claude: "claude",
  anthropic: "claude",
  "open-router": "open-router",
  openrouter: "open-router",
  open_router: "open-router",
};

// Where each provider's key may come from: the action input first, then the
// environment (in the order listed).
const KEY_SOURCES: Record<ProviderName, { input: string; env: string[] }> = {
  openai: { input: "OPENAI_API_KEY", env: ["OPENAI_API_KEY"] },
  claude: {
    input: "ANTHROPIC_API_KEY",
    env: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  },
  "open-router": { input: "OPENROUTER_API_KEY", env: ["OPENROUTER_API_KEY"] },
};

export function normalizeProviderName(raw: string | undefined): ProviderName {
  const name = (raw ?? "").trim().toLowerCase();
  if (!name) {
    return "openai";
  }
  const canonical = ALIASES[name];
  if (!canonical) {
    throw new Error(
      `Unknown provider "${raw}". Use one of: openai, claude, open-router.`,
    );
  }
  return canonical;
}

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
  workspaceId: string;
}

// Inputs win over environment variables, so a workflow can set AI_PROVIDER /
// AI_MODEL once at job level and override them per step.
export function resolveProviderConfig(
  getInput: (name: string) => string,
  env: Record<string, string | undefined>,
): ProviderConfig {
  const provider = normalizeProviderName(
    getInput("AI_PROVIDER") || env.AI_PROVIDER,
  );

  const model =
    getInput("AI_MODEL") ||
    env.AI_MODEL ||
    // The original, OpenAI-only input keeps working.
    (provider === "openai" ? getInput("OPENAI_API_MODEL") : "") ||
    DEFAULT_MODELS[provider];

  const sources = KEY_SOURCES[provider];
  const apiKey =
    getInput(sources.input) ||
    sources.env.map((name) => env[name]).find(Boolean) ||
    "";
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${provider}": set the ${sources.input} input or one of ${sources.env.join(", ")}.`,
    );
  }

  return {
    provider,
    model,
    apiKey,
    workspaceId:
      getInput("ANTHROPIC_WORKSPACE_ID") || env.ANTHROPIC_WORKSPACE_ID || "",
  };
}

export function createProvider(config: ProviderConfig): Provider {
  switch (config.provider) {
    case "claude":
      return createClaudeProvider(
        config.apiKey,
        config.model,
        config.workspaceId || undefined,
      );
    case "open-router":
      return createOpenRouterProvider(config.apiKey, config.model);
    default:
      return createOpenAIProvider(config.apiKey, config.model);
  }
}
