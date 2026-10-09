# AI Code Reviewer

AI Code Reviewer is a GitHub Action that uses OpenAI, Claude or any OpenRouter model to provide intelligent feedback and suggestions on your pull requests. This powerful tool helps improve code quality and saves developers time by automating the code review process.

## Features

- Reviews as many changed files together as the model's context window allows — usually the whole pull request in one request — each with its full content as context, not just the diff
- Reports only critical (🔴) and major (🟠) issues: bugs, security, data integrity, performance, reliability — no nitpicks or style comments
- Includes GitHub suggestion blocks for one-line fixes where possible
- Validates AI-proposed line numbers against the diff, so comments always anchor correctly
- Reviews files concurrently and retries transient provider failures automatically
- Works with three providers — OpenAI (default), Claude and OpenRouter — each in its own module
- Filters out files that match specified exclude patterns
- Easy to set up and integrate into your GitHub workflow

## Requirements

- A GitHub repository with pull request workflows
- An API key for the provider you use: OpenAI, Anthropic (Claude) or OpenRouter
- GitHub Actions enabled on your repository

## Configuration

Customize the behavior of AI Code Reviewer using the following inputs in your workflow file:

- `GITHUB_TOKEN`: Required. Used to authenticate and interact with the GitHub API.
- `AI_PROVIDER`: Optional. `openai` (default), `claude` or `open-router`.
- `AI_MODEL`: Optional. Model for the provider; defaults below.
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`: the key for the chosen provider.
- `ANTHROPIC_WORKSPACE_ID`: Optional. Only for Anthropic keys that are not scoped to a workspace.
- `OPENAI_API_MODEL`: Optional. Deprecated alias of `AI_MODEL` for the `openai` provider.
- `exclude`: Optional. A comma-separated list of file patterns to exclude from review.
- `MAX_CONTEXT_TOKENS`: Optional. The context window of the chosen model, in tokens.

### Providers

| `AI_PROVIDER`      | Default model                  | Key (input, or environment variable)            | Output                                                       |
| ------------------ | ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| `openai` (default) | `gpt-5.6-luna`                 | `OPENAI_API_KEY`                                | strict JSON schema                                           |
| `claude`           | `claude-haiku-5-5`             | `ANTHROPIC_API_KEY` (env also `CLAUDE_API_KEY`) | strict JSON schema (`output_config.format`)                  |
| `open-router`      | `deepseek/deepseek-v4.1-flash` | `OPENROUTER_API_KEY`                            | strict JSON schema, routed only to endpoints that support it |

Every setting is read from the action input first and from the environment second, so a
workflow can choose the provider once at job level:

```yaml
env:
  AI_PROVIDER: claude
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
steps:
  - uses: yuri-val/ai-codereviewer@v4
    with:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Each provider lives in its own module under `src/providers/` (`openai.ts`, `claude.ts`,
`openrouter.ts`) behind one interface; the context window comes from the Anthropic and
OpenRouter model APIs, and from the hand-kept table below for OpenAI.

#### Which model reviews best

Measured 2026-10-10 on a review fixture with five planted bugs (missing `await`, inverted
authorization check, SQL injection, off-by-one pagination, broken rounding) plus a clean file;
two runs per model, strict JSON-schema output:

| Provider / model                             | Bugs found | False positives | Avg time | Cost per review |
| -------------------------------------------- | ---------- | --------------- | -------- | --------------- |
| claude / `claude-haiku-5-5`                  | 10 / 10    | 0               | 6.7 s    | $0.0011         |
| openai / `gpt-5.6-luna`                      | 10 / 10    | 0               | 11.9 s   | $0.0016         |
| openai / `gpt-6-luna`                        | 10 / 10    | 0               | 13.4 s   | $0.0010         |
| open-router / `deepseek/deepseek-v4.1-flash` | 10 / 10    | 0               | 6.0 s    | $0.0027         |
| open-router / `z-ai/glm-5.3-flash`           | 9 / 10     | 0               | 6.0 s    | $0.0007         |
| open-router / `xiaomi/mimo-v2.6-flash`       | 10 / 10    | 0               | 29.8 s   | $0.0008         |
| open-router / `qwen/qwen3.8-flash`           | 10 / 10    | 0               | 56.5 s   | $0.0021         |
| open-router / `google/gemini-3.8-flash`      | 7 / 10     | 0               | 19.0 s   | $0.0122         |

OpenRouter models are the ones that add ready-to-apply ` ```suggestion ` blocks; OpenAI and Claude
explain the fix in prose.

### How much is reviewed at once

The action packs as many changed files into a single request as the model's
context window allows, so the model sees a change as a whole and can confirm a
finding in one file against another. Most pull requests fit in one request;
larger ones are split into as few as possible.

Model context windows are looked up from a table built into the action
(figures from the OpenAI model reference, checked 2026-08-04):

| Model                                                     | Context window    |
| --------------------------------------------------------- | ----------------- |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` | 1,050,000         |
| `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`                 | 1,047,576         |
| `gpt-5`, `gpt-5.1`                                        | 400,000           |
| `o1`, `o3`, `o3-mini`, `o4-mini`                          | 200,000           |
| `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `o1-mini`         | 128,000           |
| `gpt-4-32k`                                               | 32,768            |
| `gpt-3.5-turbo`                                           | 16,385            |
| `gpt-4`                                                   | 8,192             |
| anything else                                             | 128,000 (assumed) |

Dated and suffixed names (`gpt-4o-2024-08-06`) resolve through their family
prefix. A request may fill 60% of the window with files, leaving room for the
reply, the instructions and the error in the character-based token estimate;
on a million-token model that is roughly 2.5M characters of diff and content,
which is more than most pull requests contain.

OpenAI publishes no API for these figures, so the table is maintained by hand
and can lag behind new releases — set `MAX_CONTEXT_TOKENS` to state the window
explicitly for a model it gets wrong, or to deliberately review fewer files per
request. A request that overflows anyway is not lost: the batch is split and
retried, and a single file that still does not fit is reviewed from its diff
without its full content.

## Setup

1. Obtain an OpenAI API key by signing up at [OpenAI](https://platform.openai.com/signup).

2. Add the OpenAI API key as a GitHub Secret in your repository with the name `OPENAI_API_KEY`. For more information on GitHub Secrets, refer to the [official documentation](https://docs.github.com/en/actions/security-guides/encrypted-secrets).

3. Create a `.github/workflows/main.yml` file in your repository with the following content:

```yaml
name: Code Review with OpenAI
on:
  pull_request:
    types:
      - opened
      - reopened
      - ready_for_review
      - synchronize
permissions:
  contents: read
  pull-requests: write
jobs:
  code_review:
    runs-on: ubuntu-latest
    steps:
      - name: Code Review
        uses: yuri-val/ai-codereviewer@v4
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "gpt-5.6-luna"
          exclude: "**/*.lock,dist/**,**/*.json,**/*.md"
```

4. Customize the `exclude` input to ignore specific file patterns from review. Secret-bearing
   files (`.env*`, `*.pem`, `*.key`, `*.p12`/`*.pfx`/`*.jks`, SSH keys, `.npmrc`/`.netrc`,
   `credentials.yml*`/`secrets.yml*`, ...) are always excluded and never sent to the provider.

   No `actions/checkout` step is needed: the action reads everything through the GitHub API.
   Use the `pull_request` trigger — not `pull_request_target`, which would hand a write token
   and your API key to a run reviewing untrusted fork code.

5. Commit the changes to your repository.

6. Verify that your repository has the necessary permissions for GitHub Actions in Settings > Actions > General.

7. For the first run, approve the workflow in the "Actions" tab of your repository.

8. Test the setup by creating a new pull request or pushing changes to an existing one.

## How It Works

The AI Code Reviewer GitHub Action:

1. Retrieves the pull request diff. On `synchronize` it reviews only the lines the new push
   added (lines from earlier pushes stay visible as context, changes merged in from the base
   branch are ignored); after a force-push or rebase the whole pull request is reviewed again
2. Filters out excluded files and files with nothing new to review (e.g. pure deletions)
3. Packs the remaining files into as few requests as the model's context window allows, sending each file's annotated diff plus its full content (truncated if very large) to the chosen provider — requests are processed in parallel
4. Parses and validates the AI's JSON response, dropping comments that don't map to a line in the diff
5. Posts the surviving comments to the pull request as a review, tagged 🔴 (critical) or 🟠 (major)

## Troubleshooting

- Provider requests time out after 5 minutes and are retried (rate limits, 5xx, network errors) with backoff, honouring `Retry-After`.
- Ensure that your `GITHUB_TOKEN` has the necessary permissions to comment on pull requests.
- Check the Actions tab in your repository for detailed logs if the workflow fails.

## Contributing

Contributions are welcome! Please submit issues or pull requests to improve the AI Code Reviewer GitHub Action.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
