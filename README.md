# AI Code Reviewer

AI Code Reviewer is a GitHub Action that leverages the OpenAI API to provide intelligent feedback and suggestions on your pull requests. This powerful tool helps improve code quality and saves developers time by automating the code review process.

## Features

- Reviews each changed file with its full content as context, not just the diff
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
- `OPENAI_API_MODEL`: Optional. The specific OpenAI model to use. Default is "gpt-5.4-mini" (bump to gpt-5.6-luna once your OpenAI org has access).
- `exclude`: Optional. A comma-separated list of file patterns to exclude from review.

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
permissions: write-all
jobs:
  code_review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3
      - name: Code Review
        uses: yuri-val/ai-codereviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "gpt-5.4-mini"
          exclude: "**/*.lock,dist/**,**/*.json,**/*.md"
```

4. Customize the `exclude` input to ignore specific file patterns from review.

5. Commit the changes to your repository.

6. Verify that your repository has the necessary permissions for GitHub Actions in Settings > Actions > General.

7. For the first run, approve the workflow in the "Actions" tab of your repository.

8. Test the setup by creating a new pull request or pushing changes to an existing one.

## How It Works

The AI Code Reviewer GitHub Action:

1. Retrieves the pull request diff (or, on `synchronize`, only the newly pushed commits)
2. Filters out excluded files and files with nothing new to review (e.g. pure deletions)
3. For each remaining file, sends the annotated diff plus the full file content (truncated if very large) to the OpenAI API — several files are processed in parallel
4. Parses and validates the AI's JSON response, dropping comments that don't map to a line in the diff
5. Posts the surviving comments to the pull request as a review, tagged 🔴 (critical) or 🟠 (major)

## Troubleshooting

- If encountering rate limiting issues with the OpenAI API, consider implementing a retry mechanism or reducing the frequency of reviews.
- Ensure that your `GITHUB_TOKEN` has the necessary permissions to comment on pull requests.
- Check the Actions tab in your repository for detailed logs if the workflow fails.

## Contributing

Contributions are welcome! Please submit issues or pull requests to improve the AI Code Reviewer GitHub Action.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
