import { test } from "node:test";
import assert from "node:assert";
import {
  ContextOverflowError,
  normalizeProviderName,
  resolveProviderConfig,
} from "./index";
import { buildRequest, createClaudeProvider } from "./claude";
import { isContextOverflow, lookupContextWindow } from "./openai";

const inputs =
  (values: Record<string, string>) =>
  (name: string): string =>
    values[name] ?? "";

test("provider names are normalised and unknown ones rejected", () => {
  assert.strictEqual(normalizeProviderName(""), "openai");
  assert.strictEqual(normalizeProviderName(" Anthropic "), "claude");
  assert.strictEqual(normalizeProviderName("openrouter"), "open-router");
  assert.throws(() => normalizeProviderName("gemini"), /Unknown provider/);
});

test("defaults to openai and keeps OPENAI_API_MODEL working", () => {
  const cfg = resolveProviderConfig(
    inputs({ OPENAI_API_KEY: "k", OPENAI_API_MODEL: "gpt-6-luna" }),
    {},
  );
  assert.deepStrictEqual(
    [cfg.provider, cfg.model, cfg.apiKey],
    ["openai", "gpt-6-luna", "k"],
  );
});

test("environment fills in, inputs win", () => {
  const fromEnv = resolveProviderConfig(inputs({}), {
    AI_PROVIDER: "claude",
    CLAUDE_API_KEY: "ck",
    ANTHROPIC_WORKSPACE_ID: "ws",
  });
  assert.deepStrictEqual(
    [fromEnv.provider, fromEnv.model, fromEnv.apiKey, fromEnv.workspaceId],
    ["claude", "claude-haiku-5-5", "ck", "ws"],
  );

  const fromInputs = resolveProviderConfig(
    inputs({
      AI_PROVIDER: "open-router",
      AI_MODEL: "qwen/qwen3.8-flash",
      OPENROUTER_API_KEY: "in",
    }),
    { AI_PROVIDER: "claude", OPENROUTER_API_KEY: "env" },
  );
  assert.deepStrictEqual(
    [fromInputs.provider, fromInputs.model, fromInputs.apiKey],
    ["open-router", "qwen/qwen3.8-flash", "in"],
  );
});

test("a missing key names where to put it", () => {
  assert.throws(
    () => resolveProviderConfig(inputs({ AI_PROVIDER: "claude" }), {}),
    /ANTHROPIC_API_KEY input or one of ANTHROPIC_API_KEY, CLAUDE_API_KEY/,
  );
});

test("openai context table and overflow detection", () => {
  assert.strictEqual(lookupContextWindow("gpt-5.6-luna"), 1_050_000);
  assert.strictEqual(lookupContextWindow("gpt-6-luna"), 1_050_000);
  assert.strictEqual(lookupContextWindow("gpt-4o-2024-08-06"), 128_000);
  assert.strictEqual(lookupContextWindow("mystery"), undefined);
  assert.ok(isContextOverflow({ code: "context_length_exceeded" }));
  assert.ok(isContextOverflow(new Error("maximum context length is 8192")));
  assert.ok(!isContextOverflow(new Error("rate limited")));
});

test("claude request: structured output and effort for current models only", () => {
  const current = buildRequest("claude-haiku-5-5", {
    system: "s",
    prompt: "p",
    maxTokens: 16_000,
  });
  assert.strictEqual(current.max_tokens, 16_000);
  assert.strictEqual(current.system, "s");
  assert.strictEqual((current as any).temperature, undefined);
  assert.strictEqual((current.output_config as any).effort, "medium");
  assert.strictEqual((current.output_config as any).format.type, "json_schema");

  const legacy = buildRequest("claude-haiku-4-5", {
    system: "s",
    prompt: "p",
    maxTokens: 4_000,
  });
  assert.strictEqual(legacy.output_config, undefined);
});

function fakeClient(
  message: any,
  models: any = { max_input_tokens: 1_000_000 },
) {
  return {
    messages: {
      stream: () => ({ finalMessage: async () => message }),
    },
    models: { retrieve: async () => models },
  } as any;
}

test("claude: text by block type, truncation, refusal, overflow", async () => {
  const ok = createClaudeProvider(
    "k",
    "claude-haiku-5-5",
    undefined,
    fakeClient({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "", signature: "x" },
        { type: "text", text: '{"reviews": []}' },
      ],
    }),
  );
  assert.deepStrictEqual(
    await ok.complete({ system: "s", prompt: "p", maxTokens: 1 }),
    {
      text: '{"reviews": []}',
      truncated: false,
      usage: { input: 0, output: 0 },
    },
  );
  assert.strictEqual(await ok.contextWindow(), 1_000_000);

  const cut = createClaudeProvider(
    "k",
    "claude-haiku-5-5",
    undefined,
    fakeClient({ stop_reason: "max_tokens", content: [] }),
  );
  assert.strictEqual(
    (await cut.complete({ system: "s", prompt: "p", maxTokens: 1 })).truncated,
    true,
  );

  const refused = createClaudeProvider(
    "k",
    "claude-haiku-5-5",
    undefined,
    fakeClient({
      stop_reason: "refusal",
      stop_details: { category: "cyber" },
      content: [],
    }),
  );
  assert.strictEqual(
    (await refused.complete({ system: "s", prompt: "p", maxTokens: 1 })).text,
    '{"reviews": []}',
  );

  const full = createClaudeProvider(
    "k",
    "claude-haiku-5-5",
    undefined,
    fakeClient({ stop_reason: "model_context_window_exceeded", content: [] }),
  );
  await assert.rejects(
    full.complete({ system: "s", prompt: "p", maxTokens: 1 }),
    ContextOverflowError,
  );
});
