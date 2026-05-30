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
          fail-on-reachable-only: false
          wait: true

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: quickchain-results
          path: QuickChainResults/
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | Yes | | QuickChain CI token generated from the QuickChain web app. |
| `project-id` | No | | QuickChain project ID. Recommended for reliable project matching. |
| `api-url` | No | `https://ironridgecyber.com` | QuickChain web app URL. Override only for dev or tunnel testing. |
| `fail-on` | No | `critical` | Severity threshold that fails the workflow. Use `none`, `any`, `low`, `medium`, `high`, or `critical`. |
| `fail-on-reachable-only` | No | `false` | When `true`, `fail-on` only evaluates vulnerabilities with potential runtime reachability. |
| `wait` | No | `true` | Wait for the QuickChain scan to finish before completing the step. |
| `write-artifacts` | No | `true` | Write SBOM, VEX, and remediation PDF files to the output directory when the scan completes. |
| `output-directory` | No | `QuickChainResults` | Directory where QuickChain result files are written. Existing contents are replaced. |
| `timeout-minutes` | No | `35` | Maximum time to wait for a scan. |
| `poll-interval-seconds` | No | `15` | Seconds between status checks while waiting. |

## Pass/Fail Behavior

When `wait` is `true`, the action fails if QuickChain finds any vulnerability at or above the `fail-on` severity. For example, `fail-on: high` fails on high or critical findings. `fail-on: none` never fails because of findings, and `fail-on: any` fails on any finding.

Set `fail-on-reachable-only: true` to only fail on findings with potential runtime reachability. Non-reachable findings are still included in the SBOM/VEX evidence trail, but they do not fail the workflow in that mode.

## Result Files

When `write-artifacts` is `true` and the scan completes, the action replaces the output directory and writes:

```text
QuickChainResults/
  sbom.json
  openvex.json
  remediation.pdf
```

GitHub-hosted runners discard workspace files after the job. Add `actions/upload-artifact` if you want to retain the files from the run.

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
| `critical-reachable-count` | Critical vulnerabilities with potential runtime reachability. |
| `high-reachable-count` | High vulnerabilities with potential runtime reachability. |
| `medium-reachable-count` | Medium vulnerabilities with potential runtime reachability. |
| `low-reachable-count` | Low vulnerabilities with potential runtime reachability. |
| `reachable-count` | Total vulnerabilities with potential runtime reachability. |
| `sbom-available` | Whether QuickChain produced an SBOM artifact for this scan. |
| `vex-available` | Whether QuickChain produced a VEX artifact for this scan. |
| `results-directory` | Directory containing QuickChain result files. |

## License

Apache-2.0
