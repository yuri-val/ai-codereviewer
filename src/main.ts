import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { File } from "parse-diff";
import { minimatch } from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

// How many review requests run concurrently. With batching most PRs need a
// single request, so this only matters for PRs too large for one context.
const FILE_CONCURRENCY = 3;

// Context window (total tokens, input + output) per model. Used to decide how
// many files travel in one review request.
//
// These are best-effort figures: OpenAI publishes no API to query them, so the
// table has to be maintained by hand and will drift as models are released.
// Nothing load-bearing depends on it being right — a request that overflows is
// caught and the batch is split (see ContextOverflowError). Treat the numbers
// as a starting point and override with MAX_CONTEXT_TOKENS when in doubt.
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
  o1: 200_000,
  "o1-mini": 128_000,
  o3: 200_000,
  "o3-mini": 200_000,
  "o4-mini": 200_000,
};

// Family fallbacks for versioned or dated model names ("gpt-4o-2024-08-06",
// "gpt-5.6-luna"). Longest prefix wins, so put specific families first.
const MODEL_CONTEXT_PREFIXES: Array<[string, number]> = [
  ["gpt-4.1", 1_047_576],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4-32k", 32_768],
  ["gpt-4", 8_192],
  ["gpt-3.5", 16_385],
  ["gpt-5", 400_000],
  ["o1-mini", 128_000],
  ["o1", 200_000],
  ["o3", 200_000],
  ["o4", 200_000],
];

// Used when the model is unknown to both lookups. Deliberately modest: every
// model worth using today has at least this much, and guessing low only costs
// an extra request or two.
const DEFAULT_CONTEXT_WINDOW = 128_000;

// Rough token estimate. Code averages a little under 4 characters per token;
// this is only used to pack batches, and the packing leaves enough headroom
// that a 10-20% error changes nothing.
const CHARS_PER_TOKEN = 4;

// Share of the context window a single request may fill with files. The rest
// covers the completion (see COMPLETION_TOKEN_BUDGETS), the system prompt and
// the slack in the character-based token estimate.
const INPUT_BUDGET_RATIO = 0.6;
// Full file content is context, not the review target — cap it so a single
// huge file can't blow the model's context window and fail the request.
const MAX_FILE_CONTENT_CHARS = 60_000;
// Completion budgets: retry once with a bigger budget if the model ran out
// of tokens mid-JSON (finish_reason === "length"). Reasoning models like
// gpt-5.6-luna spend completion tokens on internal reasoning before emitting
// JSON, so a small starting budget would make truncation-retries the common
// path and double latency/cost per file.
const COMPLETION_TOKEN_BUDGETS = [4_000, 8_000];

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

interface AIReview {
  file: string;
  lineNumber: number;
  severity: "critical" | "major";
  reviewComment: string;
}

// A file plus the content that goes into the prompt alongside its diff.
// Content is fetched once and carried through batch splitting.
interface ReviewTarget {
  file: File;
  content: string | null;
}

// Thrown when the model rejects a request for being too long. The table above
// is a guess, so the batch is split and retried rather than trusted.
class ContextOverflowError extends Error {}

interface ReviewComment {
  body: string;
  path: string;
  line: number;
  side: "RIGHT";
}

async function getPRDetails(eventData: any): Promise<PRDetails> {
  try {
    const prResponse = await octokit.pulls.get({
      owner: eventData.repository.owner.login,
      repo: eventData.repository.name,
      pull_number: eventData.number,
    });
    return {
      owner: eventData.repository.owner.login,
      repo: eventData.repository.name,
      pull_number: eventData.number,
      title: prResponse.data.title ?? "",
      description: prResponse.data.body ?? "",
    };
  } catch (error) {
    console.error("Error getting PR details:", error);
    throw error;
  }
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number,
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if ("content" in response.data && response.data.content) {
      return Buffer.from(response.data.content, "base64").toString("utf-8");
    }
    return null;
  } catch (error) {
    // Renamed, binary or oversized files can fail here — review the diff
    // alone instead of failing the whole run.
    console.warn(`Could not fetch content of "${path}", reviewing diff only.`);
    return null;
  }
}

// GitHub review comments must anchor to a line that is part of the diff.
// Added lines are the review targets; unchanged (context) lines are kept as
// a fallback so a slightly-off AI answer still lands instead of causing 422s.
function getCommentableLines(file: File): {
  added: Set<number>;
  context: Set<number>;
} {
  const added = new Set<number>();
  const context = new Set<number>();
  for (const chunk of file.chunks) {
    for (const change of chunk.changes) {
      if (change.type === "add") {
        added.add(change.ln);
      } else if (change.type === "normal") {
        context.add(change.ln2);
      }
    }
  }
  return { added, context };
}

function resolveContextWindow(model: string): number {
  const override = Number(core.getInput("MAX_CONTEXT_TOKENS"));
  if (Number.isFinite(override) && override > 0) {
    return override;
  }

  const name = model.trim().toLowerCase();
  if (MODEL_CONTEXT_WINDOWS[name]) {
    return MODEL_CONTEXT_WINDOWS[name];
  }

  const match = MODEL_CONTEXT_PREFIXES.filter(([prefix]) =>
    name.startsWith(prefix),
  ).sort((a, b) => b[0].length - a[0].length)[0];

  if (match) {
    return match[1];
  }

  console.warn(
    `Unknown context window for model "${model}", assuming ${DEFAULT_CONTEXT_WINDOW} tokens. Set MAX_CONTEXT_TOKENS to review more files per request.`,
  );
  return DEFAULT_CONTEXT_WINDOW;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Groups files so each request carries as many as its model can hold. A file
// whose own material exceeds the budget still gets a batch of its own — the
// prompt truncates its content, and the diff is what matters anyway.
function packIntoBatches(
  targets: ReviewTarget[],
  budgetTokens: number,
): ReviewTarget[][] {
  const batches: ReviewTarget[][] = [];
  let current: ReviewTarget[] = [];
  let currentTokens = 0;

  for (const target of targets) {
    const cost = estimateTokens(describeTarget(target));

    if (current.length > 0 && currentTokens + cost > budgetTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(target);
    currentTokens += cost;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails,
): Promise<ReviewComment[]> {
  const reviewableFiles = parsedDiff.filter(
    (file) =>
      file.to &&
      file.to !== "/dev/null" && // deleted files
      getCommentableLines(file).added.size > 0, // nothing new to review
  );

  const targets: ReviewTarget[] = await mapWithConcurrency(
    reviewableFiles,
    FILE_CONCURRENCY,
    async (file) => ({
      file,
      content: await getFileContent(
        prDetails.owner,
        prDetails.repo,
        file.to!,
        `refs/pull/${prDetails.pull_number}/head`,
      ),
    }),
  );

  const contextWindow = resolveContextWindow(OPENAI_API_MODEL);
  const budgetTokens = Math.floor(contextWindow * INPUT_BUDGET_RATIO);
  const batches = packIntoBatches(targets, budgetTokens);

  console.log(
    `Reviewing ${targets.length} file(s) in ${batches.length} request(s) — model "${OPENAI_API_MODEL}", ~${contextWindow} token context, ${budgetTokens} tokens of files per request.`,
  );

  const results = await mapWithConcurrency(batches, FILE_CONCURRENCY, (batch) =>
    analyzeBatch(batch, prDetails),
  );
  return results.flat();
}

async function analyzeBatch(
  batch: ReviewTarget[],
  prDetails: PRDetails,
): Promise<ReviewComment[]> {
  try {
    const prompt = createPromptForBatch(batch, prDetails);
    const aiReviews = await getAIResponse(prompt);
    return createCommentsForBatch(batch, aiReviews);
  } catch (error) {
    // The context table is a guess; if it was too generous, halve the batch
    // and try again instead of losing the review for these files.
    if (error instanceof ContextOverflowError && batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      console.warn(
        `Batch of ${batch.length} file(s) exceeded the model context, splitting.`,
      );
      const halves = await Promise.all([
        analyzeBatch(batch.slice(0, middle), prDetails),
        analyzeBatch(batch.slice(middle), prDetails),
      ]);
      return halves.flat();
    }

    // A single file that still does not fit: drop its content and review the
    // diff alone, which is the part that actually needs reviewing. Without
    // this, one oversized file on a small-context model gets no review at all.
    if (error instanceof ContextOverflowError && batch[0]?.content) {
      console.warn(
        `"${batch[0].file.to}" does not fit with its content, reviewing the diff alone.`,
      );
      return analyzeBatch([{ file: batch[0].file, content: null }], prDetails);
    }

    const names = batch.map((t) => t.file.to).join(", ");
    console.error(`Error analyzing "${names}", skipping:`, error);
    return [];
  }
}

const SYSTEM_PROMPT = `You are an expert senior software engineer performing a rigorous review of a GitHub pull request. You are given a set of changed files together and report only issues that genuinely matter.

## Output format

Respond ONLY with valid JSON in exactly this shape, with no extra text:
{"reviews": [{"file": "<path exactly as given>", "lineNumber": <number>, "severity": "critical" | "major", "reviewComment": "<GitHub Markdown comment>"}]}

"file" must be copied verbatim from the "### File: <path>" heading the finding belongs to. A comment whose path does not match one of the given files is discarded.

If there are no qualifying issues, respond with {"reviews": []}. Most files in a maintained pull request contain no critical or major issue, so an empty list is the single most common correct answer — never invent problems to have something to say. If you have produced more than two findings for one file, re-read them and keep only those you could defend by quoting the lines you were given.

## Only report what the material in front of you proves

You are given the files listed below — each one's diff and, where available, its content. Use all of them: if one of them settles a question about another, that is exactly what they are there for, and a finding proven across two given files is among the most valuable you can report. Anything outside that list you cannot see: modules that are not included, callers elsewhere in the repository, base classes, tests, or the result of running anything.

- Report a finding only if the material you were given is enough to prove it. If confirming it would require reading code you were not shown, do not report it.
- A conditional is not a finding. If the comment needs "if", "may", "could", "assuming", "unless the implementation…", or "please verify that…", then you have a question rather than a finding — drop it.
- Never ask the author to check something on your behalf. They know their code; a request to verify reads as noise and costs you their trust in every other comment you make.
- Assume unseen code is correct: a function you cannot see does what its name says, a framework behaves as documented, a guard you cannot see is present. Report a violation only when the lines you were given show it themselves.

Severity:
- "critical" — will or is very likely to break functionality, corrupt/lose data, or create a security vulnerability.
- "major" — a significant risk: latent bug, realistic edge-case failure, serious performance or reliability problem.
Anything below "major" must NOT be reported.

## What to look for

- Correctness: logic errors, inverted/incorrect conditions, off-by-one errors, wrong operators, broken control flow, incorrect async/promise handling (missing await, unhandled rejection), unhandled edge cases (null/undefined/empty/zero/negative/boundary values), type coercion pitfalls.
- Security: injection (SQL/NoSQL/command/path traversal), XSS, SSRF, missing authentication/authorization checks, hardcoded secrets or credentials, weak or misused cryptography, unsafe handling of user input, sensitive data written to logs.
- Data integrity: data loss or corruption, race conditions, concurrency hazards, missing transactions where partial writes would corrupt state.
- Performance: N+1 queries, unbounded loops or memory growth, accidental O(n^2)+ on realistically large inputs, blocking calls on hot paths, missing pagination on large datasets, resource/connection/file-handle leaks.
- Reliability: swallowed or missing error handling for operations that can realistically fail (network, IO, parsing), missing timeouts where a hang would break the feature, breaking changes to public APIs, contracts, or serialized formats.

## Reviewing test files

In *_spec.rb / *_test.rb / *.test.* / *.spec.* files, only these qualify:
- an assertion that would still pass if the behaviour under test were broken;
- something that will fail for reasons unrelated to that behaviour — a real flake source such as wall-clock time, ordering between examples, network access, or shared mutable state;
- an assertion encoding a contract that contradicts the code under test.

Do not comment on test structure, naming, setup style, missing coverage, or the order of steps inside an example that is already correct. Before commenting, work out which test case the line belongs to: a line in a setup step belongs to the example that follows it, and judging such a line in isolation produces a false report.

## Rules

- Comment ONLY on lines added or changed in this PR — the diff lines starting with "+". Use the new-file line number shown at the start of the diff line as "lineNumber".
- Use the full file content only to understand context (imports, callers, types). NEVER report issues in unchanged code.
- Each comment must be specific and actionable: state the problem, why it matters, and the concrete fix. 1-3 sentences plus optional code.
- If the fix is a small, self-contained replacement of the commented line, include a GitHub suggestion block:
\`\`\`suggestion
<corrected line>
\`\`\`
  The suggestion must be the exact, complete replacement for that one line — original indentation preserved, no diff markers, no line numbers. If a correct fix needs changes on other lines too, explain it in prose instead of a suggestion block.
- Report each distinct problem exactly once, anchored to the single most relevant line. If several symptoms share one root cause, write one comment about the root cause.
- Name the symbol or quote the fragment you are judging, so a mis-anchored comment is obvious to the reader instead of reading as authoritative.
- If many issues qualify, report only the most impactful ones — at most 7 per file.
- NEVER: praise the code, comment on style/formatting/naming, suggest adding code comments or documentation, restate what the code does, make vague suggestions ("consider improving..."), or report an issue you are not confident is real.`;

// Renders one file's section of the prompt. Also used to size batches, so the
// packing measures exactly the text that will be sent.
function describeTarget(target: ReviewTarget): string {
  const { file, content } = target;

  const diffContent = file.chunks
    .map((chunk) => {
      const lines = chunk.changes.map((c) => {
        // Prefix each line with its NEW-file line number so the model
        // anchors comments to numbers GitHub will actually accept.
        // Deleted lines have no new-file number.
        const ln = c.type === "add" ? c.ln : c.type === "normal" ? c.ln2 : "";
        return `${ln}\t${c.content}`;
      });
      return [chunk.content, ...lines].join("\n");
    })
    .join("\n");

  let truncatedContent = content;
  if (truncatedContent && truncatedContent.length > MAX_FILE_CONTENT_CHARS) {
    truncatedContent =
      truncatedContent.slice(0, MAX_FILE_CONTENT_CHARS) +
      "\n... [file truncated] ...";
  }

  const contentSection = truncatedContent
    ? `Content after the changes (context only — do not review unchanged code):

\`\`\`
${truncatedContent}
\`\`\``
    : `(Content is not available; review the diff on its own.)`;

  return `### File: ${file.to}

Diff:

\`\`\`diff
${diffContent}
\`\`\`

${contentSection}`;
}

function createPromptForBatch(
  batch: ReviewTarget[],
  prDetails: PRDetails,
): string {
  const paths = batch.map((t) => `- ${t.file.to}`).join("\n");
  const sections = batch.map(describeTarget).join("\n\n---\n\n");

  return `Review the changes to the following ${batch.length} file(s) from this pull request, as one connected change. Respond with the JSON format defined in your instructions, tagging every finding with the "file" it belongs to.

Files in this review:
${paths}

Pull request title: ${prDetails.title}

Pull request description (context only):
---
${prDetails.description}
---

Each file below is given as a diff followed by its content. In the diffs the format is: <new-file line number><TAB><diff line>; deleted lines have no line number. Comment only on "+" lines, using their line number.

${sections}`;
}

function createCommentsForBatch(
  batch: ReviewTarget[],
  aiReviews: AIReview[],
): ReviewComment[] {
  // Line validity is per file, so each finding is checked against the diff of
  // the file it names — a comment naming a file outside this batch is dropped.
  const byPath = new Map(
    batch.map((t) => [t.file.to!, getCommentableLines(t.file)]),
  );

  const comments: ReviewComment[] = [];

  for (const review of aiReviews) {
    const path = review.file?.trim();
    const lines = path ? byPath.get(path) : undefined;

    if (!lines) {
      console.warn(
        `Dropping comment for "${review.file}" — not one of the files under review.`,
      );
      continue;
    }

    const line = Number(review.lineNumber);
    if (
      !Number.isInteger(line) ||
      (!lines.added.has(line) && !lines.context.has(line))
    ) {
      console.warn(
        `Dropping comment for "${path}" — line ${review.lineNumber} is not part of the diff.`,
      );
      continue;
    }

    comments.push({
      body: `${review.severity === "critical" ? "🔴" : "🟠"} ${review.reviewComment}`,
      path,
      line,
      side: "RIGHT" as const,
    });
  }

  return comments;
}

function parseAIReviews(raw: string): AIReview[] {
  let text = raw.trim();
  // Some models wrap JSON in a markdown fence despite instructions.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    text = fenced[1].trim();
  }

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.reviews)) {
      return [];
    }
    return parsed.reviews.filter(
      (r: any) =>
        r &&
        typeof r.file === "string" &&
        r.file.trim() !== "" &&
        typeof r.reviewComment === "string" &&
        r.reviewComment.trim() !== "" &&
        Number.isFinite(Number(r.lineNumber)),
    );
  } catch (error) {
    console.error("Failed to parse AI response as JSON:", text.slice(0, 500));
    return [];
  }
}

// OpenAI reports an oversized request as a 400 with code
// "context_length_exceeded"; older/proxied deployments only say so in the
// message, so both are checked.
function isContextOverflow(error: unknown): boolean {
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

async function getAIResponse(prompt: string): Promise<AIReview[]> {
  // GPT-5.x models reject the old chat-completions knobs: `max_tokens` was
  // renamed to `max_completion_tokens`, and a custom `temperature` is not
  // accepted (only the default). These models also spend completion tokens
  // on internal reasoning before emitting JSON, so if the budget runs out
  // (finish_reason === "length") we retry once with a bigger one.
  for (const budget of COMPLETION_TOKEN_BUDGETS) {
    try {
      const response = await withRetries(() =>
        openai.chat.completions.create({
          model: OPENAI_API_MODEL,
          max_completion_tokens: budget,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        }),
      );

      const choice = response.choices[0];
      if (choice?.finish_reason === "length") {
        console.warn(
          `AI response truncated at ${budget} completion tokens, retrying with a larger budget...`,
        );
        continue;
      }
      return parseAIReviews(choice?.message?.content ?? "{}");
    } catch (error) {
      // Surfaced so the caller can split the batch — the context table is a
      // hand-maintained guess and this is how being wrong gets corrected.
      if (isContextOverflow(error)) {
        throw new ContextOverflowError(
          error instanceof Error ? error.message : String(error),
        );
      }
      console.error("OpenAI request failed:", error);
      return [];
    }
  }
  console.error("AI response stayed truncated at the maximum token budget.");
  return [];
}

// Retries transient OpenAI failures (rate limits, 5xx) with exponential backoff.
async function withRetries<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 2_000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const status = error?.status ?? error?.response?.status;
      const transient = status === 429 || (status >= 500 && status < 600);
      if (!transient || attempt >= maxAttempts) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `OpenAI request failed with status ${status}, retry ${attempt}/${maxAttempts - 1} in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: ReviewComment[],
  batchSize = 10,
  retryCount = 0,
): Promise<void> {
  const maxRetries = 5;
  const baseDelay = 1000; // 1 second

  for (let i = 0; i < comments.length; i += batchSize) {
    const batch = comments.slice(i, i + batchSize);
    try {
      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number,
        comments: batch,
        event: "COMMENT",
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "status" in error &&
        (error.status === 422 || error.status === 403)
      ) {
        console.log(
          `Error creating review. batchSize = ${batchSize}. Retrying...\nERROR:\n${error}`,
        );
        if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          await new Promise((resolve) => setTimeout(resolve, delay));
          await createReviewComment(
            owner,
            repo,
            pull_number,
            batch,
            Math.max(1, Math.floor(batchSize / 2)),
            retryCount + 1,
          );
        } else {
          console.error(`Max retries reached for batch. Skipping...`);
        }
      } else {
        throw error;
      }
    }
  }
}

async function main() {
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
  );
  const prDetails = await getPRDetails(eventData);
  let diff: string | null;

  if (["opened", "reopened", "ready_for_review"].includes(eventData.action)) {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern),
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  console.log(`Produced ${comments.length} comment(s).`);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments,
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  console.error(error?.data?.errors);
  process.exit(1);
});
