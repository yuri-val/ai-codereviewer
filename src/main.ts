import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import { minimatch } from "minimatch"; // Ensure minimatch is imported correctly

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

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

async function getPRDetails(): Promise<PRDetails> {
  try {
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"),
    );
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
    console.error("Error parsing JSON:", error);
    console.log(process.env.GITHUB_EVENT_PATH);
    console.log(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
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
): Promise<string> {
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });

  if ("content" in response.data) {
    return Buffer.from(response.data.content, "base64").toString("utf-8");
  } else {
    throw new Error("Unable to get file content");
  }
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails,
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    const fileContent = await getFileContent(
      prDetails.owner,
      prDetails.repo,
      file.to!,
      `refs/pull/${prDetails.pull_number}/head`,
    );
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails, fileContent);
      console.log(prompt);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(
  file: File,
  chunk: Chunk,
  prDetails: PRDetails,
  fileContent: string,
): string {
  return `Your task is to review pull requests. 

Instructions:

YOU MUST:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.

YOU MUST NEVER:
- suggest adding comments to the code.
- give positive comments or compliments.
- provide general information about the code.


Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`

Full content of the file after changes:

\`\`\`
${fileContent}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>,
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>,
  batchSize = 10,
): Promise<void> {
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
      if (error instanceof Error && "status" in error && error.status === 422) {
        console.log(
          `Error creating review. batchSize = ${batchSize}. Retrying with smaller batch...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for 1 second
        if (batchSize > 1) {
          await createReviewComment(
            owner,
            repo,
            pull_number,
            batch,
            Math.ceil(batchSize / 2),
          );
        }
      } else {
        throw error;
      }
    }
  }
}
async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
  );

  if (eventData.action === "opened") {
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
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern),
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
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
