import OpenAI from "openai";
import {
  CompletionRequest,
  CompletionResult,
  ContextOverflowError,
  Provider,
  REVIEWS_SCHEMA,
} from "./types";

export const DEFAULT_MODEL = "gpt-6-luna";

// Context window (total tokens, input + output) per model. Used to decide how
// many files travel in one review request.
//
// Figures from developers.openai.com/api/docs/models (checked 2026-10-10).
// OpenAI publishes no API to query them, so this table is maintained by hand
// and will drift as models are released. Nothing load-bearing depends on it
// being right — a request that overflows is caught and the batch is split (see
// ContextOverflowError) — but a stale entry costs extra requests, so override
// with MAX_CONTEXT_TOKENS for a model newer than this comment.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-3.5-turbo": 16_385,
  "gpt-4": 8_192,
  "gpt-4-32k": 32_768,
  "gpt-4-turbo": 128_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  "gpt-5": 400_000,
  "gpt-5.1": 400_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.6": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-6-luna": 1_050_000,
  o1: 200_000,
  "o1-mini": 128_000,
  o3: 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
};

// Family fallbacks for versioned or dated model names ("gpt-4o-2024-08-06",
// "gpt-5.6-luna-preview"). Longest prefix wins, so put specific families
// first — "gpt-5.6" must be tried before "gpt-5", which is a different window.
const MODEL_CONTEXT_PREFIXES: Array<[string, number]> = [
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4-32k", 32_768],
  ["gpt-4", 8_192],
  ["gpt-3.5", 16_385],
  ["gpt-6-luna", 1_050_000],
  ["gpt-5.6", 1_050_000],
  ["gpt-5.5", 1_050_000],
  ["gpt-5", 400_000],
  ["o1-mini", 128_000],
  ["o1", 200_000],
  ["o3", 200_000],
  ["o4", 200_000],
];

export function lookupContextWindow(model: string): number | undefined {
  const name = model.trim().toLowerCase();
  if (MODEL_CONTEXT_WINDOWS[name]) {
    return MODEL_CONTEXT_WINDOWS[name];
  }
  const match = MODEL_CONTEXT_PREFIXES.filter(([prefix]) =>
    name.startsWith(prefix),
  ).sort((a, b) => b[0].length - a[0].length)[0];
  return match?.[1];
}

// OpenAI reports an oversized request as a 400 with code
// "context_length_exceeded"; older/proxied deployments (and OpenRouter) only
// say so in the message, so both are checked.
export function isContextOverflow(error: unknown): boolean {
  const code = (error as any)?.code ?? (error as any)?.error?.code;
  if (code === "context_length_exceeded") {
    return true;
  }
  const message = String((error as any)?.message ?? "").toLowerCase();
  return (
    message.includes("context length") ||
    message.includes("context_length") ||
    message.includes("maximum context") ||
    message.includes("too many tokens")
  );
}

// Structured output: the answer must match the {"reviews": [...]} schema.
// Plain JSON mode (`json_object`) only asks for JSON and still lets a model
// emit a broken document now and then, which loses the whole batch.
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "reviews", strict: true, schema: REVIEWS_SCHEMA },
} as const;

// One chat completions call with structured output. Shared with OpenRouter,
// which speaks the same protocol.
export async function completeChat(
  client: OpenAI,
  model: string,
  request: CompletionRequest,
  extraBody: Record<string, unknown> = {},
): Promise<CompletionResult> {
  try {
    // GPT-5 and later reject the old knobs: `max_tokens` is
    // `max_completion_tokens`, and a custom `temperature` is not accepted.
    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: request.maxTokens,
      response_format: RESPONSE_FORMAT,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      ...extraBody,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

    const choice = response.choices[0];
    return {
      text: choice?.message?.content ?? "",
      truncated: choice?.finish_reason === "length",
      usage: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
    };
  } catch (error) {
    if (isContextOverflow(error)) {
      throw new ContextOverflowError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

export function createOpenAIProvider(apiKey: string, model: string): Provider {
  // The SDK retries connection errors, timeouts, 408/409/429 and 5xx with
  // backoff and honours Retry-After. The timeout is per attempt: without it a
  // hung request would hold the job for the SDK's 10-minute default per try.
  const client = new OpenAI({ apiKey, timeout: 5 * 60_000, maxRetries: 4 });

  return {
    name: "openai",
    model,
    // Reasoning models spend completion tokens on internal reasoning before
    // emitting JSON, so a small starting budget would make truncation-retries
    // the common path and double latency/cost per request.
    completionBudgets: [4_000, 8_000],
    complete: (request) => completeChat(client, model, request),
    contextWindow: async () => lookupContextWindow(model),
  };
}
