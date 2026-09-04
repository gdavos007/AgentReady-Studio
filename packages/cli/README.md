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
| `--allow-private` | Permit private, loopback and link-local targets. Off by default, so a CI job handed a URL cannot pivot into the runner's network. Also `AGENTGRADE_ALLOW_PRIVATE_TARGETS=1`. |
| `--no-sandbox` | Launch Chromium without its sandbox. Only for unprivileged containers. Also `AGENTGRADE_NO_SANDBOX=1`. |
| `--bypass-csp` | Disable the target's Content-Security-Policy. Records a `csp-bypassed` warning in the report. |
| `--ignore-https-errors` | Accept invalid or self-signed TLS certificates. Records a `tls-errors-ignored` warning. |
| `--no-color` | Disable ANSI colour. `NO_COLOR` is also honoured. |
| `--quiet` | Suppress progress output on stderr. |

## Corpus scanning

```bash
agentgrade scan-corpus sites.txt --out corpus.csv
agentgrade scan-corpus a.com b.com --concurrency 4 --delay 2000
agentgrade scan-corpus sites.txt > corpus.csv     # progress stays on stderr
```

Scans many sites and emits one row each. A single audit says whether one site is
agent-ready; a corpus says how a metric is *distributed*, which is the question
that tells you whether a score discriminates at all.

| Option | Default | |
| --- | ---: | --- |
| `--concurrency <n>` | `2` | Parallel scans, max 8. Each one is a browser, so this is a memory budget. |
| `--delay <ms>` | `1000` | Spacing between requests to the **same** host. Different hosts never wait on each other. |
| `--timeout <ms>` | `45000` | Per-site budget. |
| `--out <path>` | stdout | `.json` emits JSON; anything else CSV. |

Targets come from a file (one per line, `#` comments and a CSV first column both
work), from positional URLs, or both. Bare hostnames get `https://`. Duplicates
are dropped — published site lists repeat hosts, and a duplicate row skews the
distribution you are computing.

### Reading the output

`status` distinguishes four outcomes, and the difference matters:

| `status` | Meaning |
| --- | --- |
| `ok` | Every stage completed. |
| `partial` | Loaded, but a stage degraded. Still a real measurement. |
| `bot-blocked` | The site served a wall. Structural columns describe the **wall**, not the site; the score is blank. |
| `unreachable` | Never loaded. Every measured column is blank. |

A failed site is emitted as a row rather than skipped, so "12% of the list
refused us" stays visible instead of leaving you to treat the survivors as the
whole sample.

Columns that could not be measured are **blank, not zero**. This matters more
than it sounds: the scorer rates a page that never loaded **100 on friction**,
because a document with no elements has no traps in it. Left in the table, every
dead host would rank among the best sites in the corpus and quietly pull any
average with it.

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
