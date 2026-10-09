// The contract every model provider implements. main.ts only talks to this.

export interface CompletionRequest {
  system: string;
  prompt: string;
  // Completion budget for this attempt; reasoning tokens count against it.
  maxTokens: number;
}

export interface CompletionResult {
  // The model's answer: a JSON document in the {"reviews": [...]} shape.
  text: string;
  // The answer was cut off by maxTokens; the caller retries with a bigger one.
  truncated: boolean;
  // Tokens billed for this request, for the log.
  usage: { input: number; output: number };
}

export interface Provider {
  name: string;
  model: string;
  // Budgets tried in order while the answer comes back truncated.
  completionBudgets: number[];
  complete(request: CompletionRequest): Promise<CompletionResult>;
  // Context window in tokens if the provider can tell, else undefined.
  contextWindow(): Promise<number | undefined>;
}

// Thrown by a provider when the request is longer than the model's context.
// The context-window figure is a guess, so the caller splits the batch and
// retries rather than trusting it.
export class ContextOverflowError extends Error {}

// The {"reviews": [...]} answer as a JSON schema, for providers that can
// constrain their output to one.
export const REVIEWS_SCHEMA = {
  type: "object",
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          lineNumber: { type: "integer" },
          severity: { type: "string", enum: ["critical", "major"] },
          reviewComment: { type: "string" },
        },
        required: ["file", "lineNumber", "severity", "reviewComment"],
        additionalProperties: false,
      },
    },
  },
  required: ["reviews"],
  additionalProperties: false,
} as const;
