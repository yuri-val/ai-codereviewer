# AI Code Reviewer

AI Code Reviewer is a GitHub Action that leverages OpenAI's GPT-4 API to provide intelligent feedback and suggestions on your pull requests. This powerful tool helps improve code quality and saves developers time by automating the code review process.

## Features

- Reviews pull requests using OpenAI's GPT API
- Provides intelligent comments and suggestions for improving your code
- Filters out files that match specified exclude patterns
- Easy to set up and integrate into your GitHub workflow

## Requirements

- A GitHub repository with pull request workflows
- An OpenAI API key with access to the GPT-4 API
- GitHub Actions enabled on your repository

## Configuration

Customize the behavior of AI Code Reviewer using the following inputs in your workflow file:

- `GITHUB_TOKEN`: Required. Used to authenticate and interact with the GitHub API.
- `OPENAI_API_KEY`: Required. Your OpenAI API key for accessing the GPT-4 API.
- `OPENAI_API_MODEL`: Optional. The specific OpenAI model to use. Default is "gpt-4o-mini".
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
          OPENAI_API_MODEL: "gpt-4o-mini"
          exclude: "**/*.lock,dist/**,**/*.json,**/*.md"
```

4. Customize the `exclude` input to ignore specific file patterns from review.

5. Commit the changes to your repository.

6. Verify that your repository has the necessary permissions for GitHub Actions in Settings > Actions > General.

7. For the first run, approve the workflow in the "Actions" tab of your repository.

8. Test the setup by creating a new pull request or pushing changes to an existing one.

## How It Works

The AI Code Reviewer GitHub Action:

1. Retrieves the pull request diff
2. Filters out excluded files
3. Sends code chunks to the OpenAI API
4. Generates review comments based on the AI's response
5. Adds the comments to the pull request

## Troubleshooting

- If encountering rate limiting issues with the OpenAI API, consider implementing a retry mechanism or reducing the frequency of reviews.
- Ensure that your `GITHUB_TOKEN` has the necessary permissions to comment on pull requests.
- Check the Actions tab in your repository for detailed logs if the workflow fails.

## Contributing

Contributions are welcome! Please submit issues or pull requests to improve the AI Code Reviewer GitHub Action.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
