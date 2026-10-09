# AI Code Reviewer

AI Code Reviewer is a GitHub Action that leverages the OpenAI API to provide intelligent feedback and suggestions on your pull requests. This powerful tool helps improve code quality and saves developers time by automating the code review process.

## Features

- Reviews as many changed files together as the model's context window allows — usually the whole pull request in one request — each with its full content as context, not just the diff
- Reports only critical (🔴) and major (🟠) issues: bugs, security, data integrity, performance, reliability — no nitpicks or style comments
- Includes GitHub suggestion blocks for one-line fixes where possible
- Validates AI-proposed line numbers against the diff, so comments always anchor correctly
- Reviews files concurrently and retries transient OpenAI failures automatically
- Filters out files that match specified exclude patterns
- Easy to set up and integrate into your GitHub workflow

## Requirements

- A GitHub repository with pull request workflows
- An OpenAI API key
- GitHub Actions enabled on your repository

## Configuration

Customize the behavior of AI Code Reviewer using the following inputs in your workflow file:

- `GITHUB_TOKEN`: Required. Used to authenticate and interact with the GitHub API.
- `OPENAI_API_KEY`: Required. Your OpenAI API key.
- `OPENAI_API_MODEL`: Optional. The specific OpenAI model to use. Default is "gpt-5.6-luna".
- `exclude`: Optional. A comma-separated list of file patterns to exclude from review.
- `MAX_CONTEXT_TOKENS`: Optional. The context window of the chosen model, in tokens.

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
   `credentials.yml*`/`secrets.yml*`, ...) are always excluded and never sent to OpenAI.

   No `actions/checkout` step is needed: the action reads everything through the GitHub API.
   Use the `pull_request` trigger — not `pull_request_target`, which would hand a write token
   and your OpenAI key to a run reviewing untrusted fork code.

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
3. Packs the remaining files into as few requests as the model's context window allows, sending each file's annotated diff plus its full content (truncated if very large) to the OpenAI API — requests are processed in parallel
4. Parses and validates the AI's JSON response, dropping comments that don't map to a line in the diff
5. Posts the surviving comments to the pull request as a review, tagged 🔴 (critical) or 🟠 (major)

## Troubleshooting

- OpenAI requests time out after 5 minutes and are retried (rate limits, 5xx, network errors) with backoff, honouring `Retry-After`.
- Ensure that your `GITHUB_TOKEN` has the necessary permissions to comment on pull requests.
- Check the Actions tab in your repository for detailed logs if the workflow fails.

## Contributing

Contributions are welcome! Please submit issues or pull requests to improve the AI Code Reviewer GitHub Action.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
