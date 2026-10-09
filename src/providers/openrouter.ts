import OpenAI from "openai";
import { completeChat } from "./openai";
import { Provider } from "./types";

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

const BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter speaks the OpenAI chat completions protocol, so the OpenAI SDK
// talks to it with a different base URL. `reasoning.effort` is OpenRouter's
// unified knob: reasoning models think at that level, the rest ignore it.
export function createOpenRouterProvider(
  apiKey: string,
  model: string,
): Provider {
  const client = new OpenAI({
    apiKey,
    baseURL: BASE_URL,
    timeout: 5 * 60_000,
    maxRetries: 4,
    // Optional attribution headers OpenRouter shows in its dashboards.
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/yuri-val/ai-codereviewer",
      "X-Title": "ai-codereviewer",
    },
  });

  return {
    name: "open-router",
    model,
    completionBudgets: [8_000, 16_000],
    complete: (request) =>
      completeChat(client, model, request, {
        reasoning: { effort: "medium" },
        // Route only to endpoints that honour every parameter sent — above
        // all the response schema; otherwise OpenRouter may silently drop it.
        provider: { require_parameters: true },
      }),
    // OpenRouter publishes each model's context length, so no table to keep.
    contextWindow: async () => {
      try {
        const response = await fetch(`${BASE_URL}/models/${model}/endpoints`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          return undefined;
        }
        const body: any = await response.json();
        const lengths: number[] = (body?.data?.endpoints ?? [])
          .map((endpoint: any) => Number(endpoint?.context_length))
          .filter((n: number) => Number.isFinite(n) && n > 0);
        // The request may land on any endpoint: size for the smallest.
        return lengths.length > 0 ? Math.min(...lengths) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
