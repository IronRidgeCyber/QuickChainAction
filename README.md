# QuickChain Action

Run a QuickChain supply-chain scan from GitHub Actions. This action is a thin client for the hosted QuickChain API; the scanner, tenant authorization, GitHub App token exchange, and scan processing stay inside QuickChain.

## Prerequisites

1. Sign in to QuickChain.
2. Connect the QuickChain GitHub App.
3. Register the target repository as a QuickChain project.
4. Create a QuickChain CI token.
5. Add the CI token to the target repository as an Actions secret named `QUICKCHAIN_API_KEY`.
6. Add the QuickChain project ID as an Actions variable named `QUICKCHAIN_PROJECT_ID`.

## Workflow

Create `.github/workflows/quickchain.yml` in the repository you want to scan:

```yaml
name: QuickChain

on:
  workflow_dispatch:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  quickchain:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: IronRidgeCyber/QuickChainAction@v1
        with:
          api-key: ${{ secrets.QUICKCHAIN_API_KEY }}
          project-id: ${{ vars.QUICKCHAIN_PROJECT_ID }}
          fail-on: critical
          wait: true
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | Yes | | QuickChain CI token generated from the QuickChain web app. |
| `project-id` | No | | QuickChain project ID. Recommended for reliable project matching. |
| `api-url` | No | `https://ironridgecyber.com` | QuickChain web app URL. Override only for dev or tunnel testing. |
| `fail-on` | No | `critical` | Severity threshold that fails the workflow. Use `none`, `any`, `low`, `medium`, `high`, or `critical`. |
| `wait` | No | `true` | Wait for the QuickChain scan to finish before completing the step. |
| `timeout-minutes` | No | `35` | Maximum time to wait for a scan. |
| `poll-interval-seconds` | No | `15` | Seconds between status checks while waiting. |

## Local Tunnel Testing

GitHub-hosted runners cannot reach `localhost` on your machine. To test a local QuickChain instance from a real GitHub workflow, expose your local frontend with a tunnel and pass the public URL:

```yaml
      - uses: IronRidgeCyber/QuickChainAction@v1
        with:
          api-url: ${{ vars.QUICKCHAIN_API_URL }}
          api-key: ${{ secrets.QUICKCHAIN_API_KEY }}
          project-id: ${{ vars.QUICKCHAIN_PROJECT_ID }}
          fail-on: critical
          wait: true
```

Set `QUICKCHAIN_API_URL` to your current HTTPS tunnel URL, for example a `trycloudflare.com` URL.

## Outputs

| Output | Description |
| --- | --- |
| `scan-id` | QuickChain scan ID. |
| `dashboard-url` | QuickChain dashboard URL for the scan. |
| `status` | Final or accepted scan status. |
| `critical-count` | Critical vulnerability count. |
| `high-count` | High vulnerability count. |
| `medium-count` | Medium vulnerability count. |
| `low-count` | Low vulnerability count. |
| `total-count` | Total vulnerability count. |

## License

Apache-2.0
