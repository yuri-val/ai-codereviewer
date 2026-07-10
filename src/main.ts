import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { File } from "parse-diff";
import { minimatch } from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

// How many files are reviewed concurrently. Keeps large PRs fast without
// hammering the OpenAI / GitHub rate limits.
const FILE_CONCURRENCY = 3;
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
  lineNumber: number;
  severity: "critical" | "major";
  reviewComment: string;
}

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

  const results = await mapWithConcurrency(
    reviewableFiles,
    FILE_CONCURRENCY,
    (file) => analyzeFile(file, prDetails),
  );
  return results.flat();
}

async function analyzeFile(
  file: File,
  prDetails: PRDetails,
): Promise<ReviewComment[]> {
  try {
    const fileContent = await getFileContent(
      prDetails.owner,
      prDetails.repo,
      file.to!,
      `refs/pull/${prDetails.pull_number}/head`,
    );

    const prompt = createPromptForFile(file, prDetails, fileContent);
    const aiReviews = await getAIResponse(prompt);
    return createCommentsForFile(file, aiReviews);
  } catch (error) {
    console.error(`Error analyzing "${file.to}", skipping file:`, error);
    return [];
  }
}

const SYSTEM_PROMPT = `You are an expert senior software engineer performing a rigorous review of a GitHub pull request. You review one file at a time and report only issues that genuinely matter.

## Output format

Respond ONLY with valid JSON in exactly this shape, with no extra text:
{"reviews": [{"lineNumber": <number>, "severity": "critical" | "major", "reviewComment": "<GitHub Markdown comment>"}]}

If there are no qualifying issues, respond with {"reviews": []}. An empty list is a normal, expected outcome — never invent problems to have something to say.

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
- If many issues qualify, report only the most impactful ones — at most 7 per file.
- NEVER: praise the code, comment on style/formatting/naming, suggest adding code comments or documentation, restate what the code does, make vague suggestions ("consider improving..."), or report an issue you are not confident is real.`;

function createPromptForFile(
  file: File,
  prDetails: PRDetails,
  fileContent: string | null,
): string {
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

  let truncatedContent = fileContent;
  if (truncatedContent && truncatedContent.length > MAX_FILE_CONTENT_CHARS) {
    truncatedContent =
      truncatedContent.slice(0, MAX_FILE_CONTENT_CHARS) +
      "\n... [file truncated] ...";
  }

  const fileContextSection = truncatedContent
    ? `Full content of "${file.to}" after the changes (context only — do not review unchanged code):

\`\`\`
${truncatedContent}
\`\`\``
    : `(Full file content is not available; review the diff on its own.)`;

  return `Review the changes to the file "${file.to}" from this pull request. Respond with the JSON format defined in your instructions.

Pull request title: ${prDetails.title}

Pull request description (context only):
---
${prDetails.description}
---

Git diff to review. Format: <new-file line number><TAB><diff line>; deleted lines have no line number. Comment only on "+" lines, using their line number:

\`\`\`diff
${diffContent}
\`\`\`

${fileContextSection}`;
}

function createCommentsForFile(
  file: File,
  aiReviews: AIReview[],
): ReviewComment[] {
  const { added, context } = getCommentableLines(file);

  return aiReviews
    .filter((review) => {
      const line = Number(review.lineNumber);
      if (!Number.isInteger(line) || (!added.has(line) && !context.has(line))) {
        console.warn(
          `Dropping comment for "${file.to}" — line ${review.lineNumber} is not part of the diff.`,
        );
        return false;
      }
      return true;
    })
    .map((review) => ({
      body: `${review.severity === "critical" ? "🔴" : "🟠"} ${review.reviewComment}`,
      path: file.to!,
      line: Number(review.lineNumber),
      side: "RIGHT" as const,
    }));
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
        typeof r.reviewComment === "string" &&
        r.reviewComment.trim() !== "" &&
        Number.isFinite(Number(r.lineNumber)),
    );
  } catch (error) {
    console.error("Failed to parse AI response as JSON:", text.slice(0, 500));
    return [];
  }
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
  console.log(
    `Reviewed ${filteredDiff.length} file(s), produced ${comments.length} comment(s).`,
  );
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
