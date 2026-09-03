# `@agentgrade/cli`

Audit any site for WebMCP and AI-agent readiness from the terminal, and gate CI
builds on the score.

```bash
npx @agentgrade/cli audit https://example.com
```

## Usage

```
agentgrade audit <url> [options]
```

| Option | Description |
| --- | --- |
| `--threshold <number>` | Minimum score to pass. Default `80`. |
| `--format <format>` | `pretty` (default), `json`, or `markdown`. |
| `--output <path>` | Write the report to a file instead of stdout. |
| `--proxy <url>` | Egress proxy for navigation and descriptor fetches. |
| `--timeout <ms>` | Navigation timeout. Default `30000`. |
| `--goal <text>` | Goal for the synthetic agent evaluation. |
| `--header <k: v>` | Extra request header. Repeatable — use it for a staging auth token. |
| `--max-issues <n>` | How many issues to show. |
| `--no-color` | Disable ANSI colour. `NO_COLOR` is also honoured. |
| `--quiet` | Suppress progress output on stderr. |

## Exit codes

The gate's contract. A build that goes red should say *why*:

| Code | Meaning |
| ---: | --- |
| `0` | The score met the threshold. |
| `1` | The score is below the threshold. |
| `2` | Usage error — a bad flag or a missing target. |
| `3` | The target could not be scanned at all. |

`1` and `3` are deliberately distinct: a single non-zero code cannot tell you
whether your site regressed or your staging box was down.

## Formats

**`pretty`** — grade, friction tax, pillar bars, and the top deductions.
Colour is disabled automatically when stdout is not a TTY, so it stays readable
in CI logs.

**`json`** — a flat envelope with `passed`, `score`, `threshold` and `grade` at
the top level, plus the complete scorecard and raw scan underneath:

```bash
agentgrade audit https://example.com --format json | jq '.score, .frictionTax.costUsd'
```

**`markdown`** — a PR-comment body, stamped with a stable
`<!-- agentgrade-report -->` marker so a workflow can update its previous
comment instead of posting a new one on every push.

## In CI

```yaml
- run: npx @agentgrade/cli audit "$STAGING_URL" --threshold 80 --format markdown --output comment.md
```

A complete workflow — threshold gate, PR comment, job summary, artifact upload —
is at [`.github/workflows/agentgrade.yml`](../../.github/workflows/agentgrade.yml).

## Programmatic use

```ts
import { runAudit, formatMarkdown } from '@agentgrade/cli';

const result = await runAudit('https://staging.example.com', { threshold: 80 });
if (!result.passed) await postComment(formatMarkdown(result));
```

## Dependencies

One: `playwright`. Terminal colour and tables are implemented in-package rather
than pulled from `chalk` and `cli-table3` — a tool that runs on every build in
every repo that adopts it should have a dependency surface you can read in an
afternoon.
