import Anthropic from "@anthropic-ai/sdk";
import {
  CompletionRequest,
  CompletionResult,
  ContextOverflowError,
  Provider,
  REVIEWS_SCHEMA,
} from "./types";

export const DEFAULT_MODEL = "claude-haiku-5-5";

// Models that take `output_config.effort` and structured outputs. Older ones
// (Haiku 4.5, Sonnet 4.5, 3.x) reject effort, so it is only sent where it is
// understood.
const CURRENT_MODEL_RE =
  /^claude-(opus-4-[5-9]|(opus|sonnet|haiku|fable|mythos)-([5-9]|[1-9][0-9]))/;

// Every current Claude model has a 1M window; the models API is asked first,
// this only covers keys that cannot read it.
const FALLBACK_CONTEXT_WINDOW = 200_000;

export function buildRequest(
  model: string,
  request: CompletionRequest,
): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    // Thinking is on by default on current models and counts toward
    // max_tokens, so the budget covers both the reasoning and the JSON.
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: "user", content: request.prompt }],
  };
  if (CURRENT_MODEL_RE.test(model)) {
    params.output_config = {
      // A review needs real reasoning, but not the most expensive kind.
      effort: "medium",
      // Constrain the answer to the {"reviews": [...]} schema, so it always
      // parses.
      format: { type: "json_schema", schema: REVIEWS_SCHEMA },
    } as Anthropic.MessageCreateParamsNonStreaming["output_config"];
  }
  return params;
}

// A request longer than the window comes back as a 400 whose message says
// the prompt is too long.
function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof Anthropic.BadRequestError)) {
    return false;
  }
  const message = String(error.message ?? "").toLowerCase();
  return (
    message.includes("prompt is too long") ||
    message.includes("context window") ||
    message.includes("too many tokens")
  );
}

function usageOf(response: Anthropic.Message): CompletionResult["usage"] {
  return {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
  };
}

export function createClaudeProvider(
  apiKey: string,
  model: string,
  workspaceId?: string,
  client?: Pick<Anthropic, "messages" | "models">,
): Provider {
  const anthropic =
    client ??
    new Anthropic({
      apiKey,
      // Per attempt; the SDK retries 408/409/429/5xx and connection errors.
      timeout: 5 * 60_000,
      maxRetries: 4,
      // Keys that are not scoped to a workspace must name one on every request.
      defaultHeaders: workspaceId
        ? { "anthropic-workspace-id": workspaceId }
        : undefined,
    });

  async function complete(
    request: CompletionRequest,
  ): Promise<CompletionResult> {
    let response: Anthropic.Message;
    try {
      // Streamed, then collected: long inputs with a large max_tokens are
      // what non-streaming requests time out on.
      response = await anthropic.messages
        .stream(buildRequest(model, request))
        .finalMessage();
    } catch (error) {
      if (isContextOverflow(error)) {
        throw new ContextOverflowError((error as Error).message);
      }
      throw error;
    }

    if (response.stop_reason === "model_context_window_exceeded") {
      throw new ContextOverflowError(
        "The request filled the model's context window.",
      );
    }
    if (response.stop_reason === "refusal") {
      console.warn(
        `Claude declined to review this batch${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}.`,
      );
      return {
        text: '{"reviews": []}',
        truncated: false,
        usage: usageOf(response),
      };
    }

    // Read text blocks by type: a response can begin with thinking blocks.
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      truncated: response.stop_reason === "max_tokens",
      usage: usageOf(response),
    };
  }

  return {
    name: "claude",
    model,
    completionBudgets: [16_000, 32_000],
    complete,
    contextWindow: async () => {
      try {
        const info = await anthropic.models.retrieve(model);
        return info.max_input_tokens ?? undefined;
      } catch {
        return FALLBACK_CONTEXT_WINDOW;
      }
    },
  };
}
