# AgentGrade

An automated auditor for WebMCP and AI-agent readiness: a scanner, a scoring
engine, a web studio, a CI gate, and a React SDK for fixing what it finds.

**Phase 1 — the inspection engine** (`src/scanner`) drives a headless Chromium
session and returns a strictly-typed `AuditReport`: every agent-callable tool,
every interactive surface, and every "friction trap" that would stop an agent
from completing a task.

**Phase 2 — the evaluation layer** (`src/evals`) turns that raw data into an
`AgentScorecard`: a deterministic 0–100 score across four weighted pillars, a
DOM-vs-WebMCP benchmark quoting the "Agent Friction Tax", and a ranked list of
`AuditIssue`s whose deductions reconcile exactly against the score.

**Phase 3 — the web studio** (`app/`, `components/`, `hooks/`, `src/lib`) is a
Next.js 15 App Router UI: a Lighthouse-style report, a code generator that turns
any finding into drop-in WebMCP snippets, and WebMCP self-registration so a
browser agent can drive the studio the same way a human clicks it.

**Phase 4 — the distributable packages** (`packages/`) are what other teams
install: [`@agentgrade/cli`](packages/cli) to gate CI on the score, and
[`@agentgrade/react`](packages/react) to fix what the audit finds.

## Architecture

```
                        ┌──────────────────────────────────┐
                        │  src/  — the engine (root)       │
   audits a site ──────▶│  scanner → evals → lib/codegen   │
                        └──────────────┬───────────────────┘
                                       │  @agentgrade/core
                   ┌───────────────────┼───────────────────┐
                   ▼                   ▼                   ▼
         ┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐
         │ app/ — studio    │  │ packages/cli │  │  .github/        │
         │ Next.js 15 UI    │  │ CI gate      │  │  workflows/      │
         └────────┬─────────┘  └──────┬───────┘  └──────────────────┘
                  │                   │
                  │ consumes          │ posts PR comment
                  ▼                   ▼
         ┌────────────────────────────────────────┐
         │ packages/react — the fix               │
         │ useWebMCP · <AgentForm />              │
         │ zero dependencies, react peer only     │
         └────────────────────────────────────────┘
```

Three deliberate edges in that graph:

- **`packages/react` depends on nothing.** Not on the engine, not on Playwright.
  It is what a stranger installs into their app, so its dependency surface is
  its most important property. It duplicates ~30 lines of verb tables from the
  auditor's classifier instead of importing them; a cross-package test pins the
  two copies to the same answers.
- **`packages/cli` bundles the engine** at build time under the
  `@agentgrade/core` alias rather than declaring a dependency on it. The engine
  lives at the repo root, so a workspace dependency would be circular. The
  published CLI has exactly one runtime dependency: `playwright`.
- **The studio consumes `@agentgrade/react`** rather than keeping its own copy
  of the hook. If the package's registration or cleanup breaks, the studio's own
  WebMCP tools break with it, and the test suite says so.

## Quickstart

```bash
npm install
npx playwright install chromium

npm run dev        # studio at http://localhost:3000
npm test           # 185 tests, real Chromium against a loopback fixture
npm run build:all  # engine → CLI → React SDK → studio
```

The studio hosts its own audit fixture at `/api/fixture`. Because that target is
on loopback, and the SSRF guard refuses private addresses by default, the sample
audits need an explicit opt-in:

```bash
AGENTGRADE_ALLOW_PRIVATE_TARGETS=1 npm run dev
```

### Network safety

The scanner is a real browser pointed at a caller-supplied URL, so by default it
refuses targets that resolve to private, loopback, CGNAT, or link-local
addresses — including the cloud metadata endpoint at `169.254.169.254`. Hosts
are judged by their *resolved* addresses rather than by their names, every A/AAAA
record must be public, and every request the page makes (redirects and
subresources included) is re-checked, so a public URL cannot 302 into your
network.

Opt in with `AGENTGRADE_ALLOW_PRIVATE_TARGETS=1`, `--allow-private` on the CLI,
or `allowPrivateTargets: true` on `scanUrl`.

Chromium runs **with** its sandbox and with Site Isolation intact. Unprivileged
containers that cannot provide user namespaces opt out explicitly, with
`AGENTGRADE_NO_SANDBOX=1`, `--no-sandbox`, or `disableSandbox: true`.

### CLI

```bash
npx @agentgrade/cli audit https://example.com --threshold 80
```

Exit `0` at or above the threshold, `1` below it, `2` on a usage error, `3` when
the target could not be scanned — so a red build tells you whether the site
regressed or the deployment was down. Full options in
[`packages/cli/README.md`](packages/cli/README.md).

### CI/CD

`.github/workflows/agentgrade.yml` runs the audit against a staging URL, blocks
the build below the threshold, and posts the scorecard on the PR — updating one
comment rather than burying the thread:

```yaml
- run: npm run build:cli
- run: node packages/cli/dist/cli.js audit "$STAGING_URL" --threshold 80 --format markdown --output comment.md
```

Point it at a deployment with the `AGENTGRADE_URL` repository variable. With
none set it audits the bundled fixture, so a fork gets a green run on the first
push instead of a red one it has to debug.

### React SDK

```tsx
import { useWebMCP, AgentForm } from '@agentgrade/react';

// Register one action as a tool.
useWebMCP({
  name: 'search_products',
  description: 'Search the catalog and return matching items.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Free-text search.' } },
    required: ['query'],
  },
  execute: ({ query }) => searchProducts(query),
});

// Or make an existing form agent-callable — the schema is derived from the
// fields' own types and labels, and the agent's values submit through your
// existing onSubmit.
<AgentForm toolName="place_order" description="Place the order." onSubmit={handleSubmit}>
  <label htmlFor="email">Email address</label>
  <input id="email" name="email" type="email" required />
  <button type="submit">Buy</button>
</AgentForm>
```

Full API in [`packages/react/README.md`](packages/react/README.md).

```ts
import { auditUrl } from './src/index.js';

const { report, scorecard } = await auditUrl('https://example.com', {
  syntheticGoal: 'Execute product search',
});

console.log(scorecard.grade, scorecard.overallScore);          // "C" 74
console.log(scorecard.benchmark.frictionTax.headline);         // "$0.14 and 18.2s wasted…"
for (const issue of scorecard.issues.slice(0, 5)) {
  console.log(`-${issue.deductionPoints.toFixed(2)}  ${issue.title}`);
}
```

From the command line:

```bash
npm run scan -- https://example.com --out report.json
npm run scan -- https://example.com --score --goal "Execute product search"
npm run scan -- https://example.com --timeout 45000 --proxy http://127.0.0.1:8080
```

`--score` wraps the raw report in `{ report, scorecard }` rather than replacing
it, so consumers of the Phase 1 payload keep working unchanged.

## What it inspects

| Phase | What happens |
| --- | --- |
| **Session** | Chromium launched via Playwright with automation fingerprints removed, a realistic header set, and a CDP session attached (`Page`, `Runtime`, `Network`). |
| **Runtime WebMCP** | Waits for `navigator.modelContext` / `document.modelContext` to appear, then reads back every registered tool: name, description, input schema, output schema, annotations, and whether it has a callable handler. The registry is cross-checked through CDP so a page cannot hide tools from the Playwright binding. |
| **Declarative discovery** | Fetches `/.well-known/mcp` (and `mcp.json`), `/.well-known/agent.json`, and `/llms.txt`, rejecting SPA soft-404s that answer `200 OK` with HTML. Scans both the live DOM and the served HTML for `<tool-definition>`, `<mcp-tool>`, `<agent-tool>`, and `<form data-mcp-tool="…">`. |
| **Surface mapping** | Catalogs native `<form>`s, checkout/cart containers, standalone search inputs, and modal triggers — with fields, labels, label provenance, autocomplete tokens, and submit controls. |
| **Friction traps** | Flags the patterns that break agents (see below), each with a selector, severity, machine-readable evidence, and a concrete remediation. |
| **Report** | Everything is folded into `AgentAuditRawData`, validated at run time, and scored 0–100 with a letter grade. |

### Friction traps detected

| Type | What it catches |
| --- | --- |
| `unlabelled-control` | Buttons/links with no accessible name (icon-only controls). |
| `unlabelled-input` | Fields with no programmatic label, or a placeholder used as one. |
| `opaque-iframe` | Untitled iframes, and empty embed containers awaiting a third-party frame. |
| `nested-scroll-container` | Scroll containers inside scroll containers, hiding content from a flat DOM read. |
| `non-semantic-control` | `div`/`span` acting as a button with no role or keyboard affordance. |
| `multi-step-non-semantic` | Wizards driven by non-semantic step controls with no `aria-current`. |
| `closed-shadow-surface` | Custom elements rendering pixels but no readable DOM (closed shadow roots). |
| `pointer-only-interaction` | Drag/hover interactions with no keyboard equivalent. |

## Scoring (Phase 2)

Four weighted pillars, each scored 0–100 internally, then combined:

| Pillar | Weight | What it measures |
| --- | --- | --- |
| **Discovery** | 20% | `/llms.txt` (15), `/.well-known/mcp` (25), `/.well-known/agent.json` (15), semantic page metadata (20), and whether tool descriptions explain the action rather than restating its name (25). |
| **Actionability & Surface Coverage** | 35% | The ratio of critical surfaces (search, checkout, authentication, signup) backed by a registered tool (55), overall surface coverage (15), tools callable at runtime (15), and critical surfaces left reachable only through raw DOM (15). A page with no critical surface is scored on its tool surface alone. |
| **Friction & Trap Penalty** | 25% | Starts at 100, subtracting severity-weighted penalties (critical 12, high 7, medium 3, low 1), amplified 1.5× for a trap inside a critical surface. Clamped at zero. |
| **Safety & Schema Conformance** | 20% | Typed input schemas (30), per-parameter descriptions (25), declared `required` (15), and correct `annotations.readOnlyHint` on query vs. mutation tools (30). A tool annotated read-only whose name says otherwise scores zero and raises a critical issue. |

Grades: **A** 90–100, **B** 80–89, **C** 70–79, **D** 60–69, **F** below 60.

Both `AgentScorecard.grade` and the Phase 1 `ScanSummary.grade` map through
`src/shared/grade.ts`, so a grade means the same thing in the CLI, the API, and
the studio. The underlying *scores* still differ — the scanner's is a quick-look
heuristic, the scorecard's is the weighted four-pillar composite — but they are
never graded on different scales.

Scoring is **deterministic**: no randomness, no wall clock in any scored value
(`generatedAt` is injectable), and every ratio is guarded, so an empty scan
yields a bounded number rather than `NaN`.

### Deductions reconcile

Every point a pillar loses is attributed to exactly one issue:

```
sum(scorecard.issues.map(i => i.deductionPoints)) === 100 - scorecard.overallScoreExact
```

Scanner diagnostics (a blocked descriptor fetch, a degraded DOM pass) appear as
zero-deduction issues — they explain why a pillar may be under-reporting without
penalising the site for the scan's own problems.

## Agent Friction Tax (Phase 2)

`estimateBenchmark` models one transaction twice — an agent driving the DOM, and
the same agent calling a tool — and reports the difference:

```
$0.85 and 133.0s wasted per user transaction without WebMCP, and 89.8% more likely to fail.
```

The DOM baseline charges a fresh page snapshot on every step, grows conversation
history quadratically, and buys extra recovery steps per friction trap. The
WebMCP column charges the tool schemas once and emits a single call. Costs are
quoted at Claude Opus 5 rates by default ($5/$25 per MTok) and are overridable
via `BenchmarkOptions.pricing`.

These are **estimates**, not measurements: token counts use a ~4 chars/token
heuristic, and every comparison carries an `assumptions` array stating what was
assumed. For exact counts of a concrete prompt, use `messages.countTokens`.

## Synthetic evaluator (Phase 2)

`runSyntheticEvaluation` gives an agent a goal and reports what happens:

- **Tools registered** → it selects one, synthesizes arguments from the declared
  input schema, and — given a live Playwright page — invokes it for real.
- **No tools** → it returns the DOM plan an agent would be forced to execute
  instead, with each step annotated by the traps that would break it.

Tool selection runs through a pluggable driver, resolved in order: a
caller-supplied driver, the Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), the
Anthropic SDK (`@anthropic-ai/sdk`, Claude Opus 5 with adaptive thinking), and
finally a deterministic simulated driver. All three live packages are optional
peer dependencies loaded by dynamic import; with none installed, or with no
`ANTHROPIC_API_KEY`, the simulated driver runs offline and the reason lands in
`warnings`.

**Mutation safety.** Registered tools are real — `place_order` places an order.
Live invocation is restricted to tools classified read-only unless the caller
passes `allowMutations: true`.

## The Studio (Phase 3)

### Routes

| Route | What it does |
| --- | --- |
| `/` | URL entry bar, sample targets, and recent audits from the local database. |
| `POST /api/audit` | Runs the scanner + scorer and **streams NDJSON progress** — `launch` → `discovery` → `surfaces` → `traps` → `benchmark` → `complete`, ending with a `reportId`. |
| `GET /api/reports` | Lists stored audits, newest first. |
| `/report/[id]` | The scorecard: gauge, pillar grid, friction-tax banner, filterable issue list, remediation drawer. |
| `/api/fixture`, `/.well-known/mcp`, `/.well-known/agent.json`, `/llms.txt` | The studio hosts its own verified audit target and its own descriptors, so a local install produces a real report with **no outbound network at all**. |

Reports are stored via Node's built-in `node:sqlite` in `.agentgrade/reports.db`
— no native build step, no daemon, no cloud. If `node:sqlite` is unavailable the
store degrades to an in-process map with the same interface.

### The remediation engine

`src/lib/codegen.ts` turns any `AuditIssue` into three copyable surfaces, all
derived from the site's own scan — tool names from the surface category, schemas
from its real fields and their labels, selectors from the elements the scanner
found:

| Tab | Output |
| --- | --- |
| **Browser Native** | `navigator.modelContext.registerTool({ … })`, shipping the `setValue`/`setChecked` helpers so it runs as pasted. |
| **React Hook** | `useWebMCP({ … })` plus a generated TypeScript `Args` interface. |
| **Declarative HTML** | `<form data-mcp-tool="…" data-mcp-schema='…'>` with `<label for>`-paired inputs, and element-level fixes for each trap type. |

Generation is pure and deterministic. Every snippet is parsed in the test suite
— esbuild for JS and TSX, JSDOM for HTML — because this code goes straight into
someone's app.

Selectors that cross a shadow root carry Playwright's `>>>`, which
`document.querySelector` cannot follow. The generator emits the deepest plain-CSS
segment into code, and the UI badges the `>>>` boundary separately so a developer
pasting a selector into the console knows why it would return `null`.

### WebMCP self-registration

The studio holds itself to the standard it audits against. Report pages register
three read-only tools via `navigator.modelContext`:

| Tool | What an agent gets |
| --- | --- |
| `filter_issues` | Filters by severity and/or pillar, returns the matches and their total deduction — and moves the visible list to match. |
| `select_issue` | Opens one issue's drawer, returns its detail, root-cause selectors, and the score it would restore. |
| `export_remediation_code` | Returns the generated code for an issue, all three surfaces or one. |

`hooks/useWebMCP.ts` installs a marked polyfill (`__agentgradePolyfill`) when the
browser has no WebMCP runtime, so the declarations stay present and inspectable
even where nothing can call them.

## Layout

```
app/
  page.tsx                  URL entry, sample targets, recent audits
  layout.tsx                Root layout, descriptor <link> hints
  report/[id]/page.tsx      Server route: loads the report, generates remediations
  report/[id]/report-view.tsx  Client: filter/selection state + WebMCP registration
  api/audit/route.ts        Streaming NDJSON audit pipeline
  api/reports/route.ts      Stored report listing
  api/fixture/route.ts      Self-hosted audit target
  api/well-known/*, api/llms  The studio's own discovery descriptors
components/
  ScoreGauge.tsx            SVG gauge, server-rendered
  PillarBreakdown.tsx       Four-card pillar grid with per-component detail
  BenchmarkComparison.tsx   Friction-tax banner + DOM-vs-WebMCP columns
  IssueCard.tsx             Issue row, shadow-DOM selector badging
  CodeDrawer.tsx            Detail pane, agent trace, three code tabs
  AuditLauncher.tsx         URL bar + live stage rail
hooks/
  useWebMCP.ts              Generic registration hook + marked polyfill
  useStudioWebMCP.ts        The studio's own three tools
src/
  index.ts                  auditUrl(): scan + score in one call
  lib/
    codegen.ts              WebMCP remediation code generator
    highlight.ts            Dependency-free syntax highlighter
    pipeline.ts             Scan → score → persist, with staged progress
    stages.ts               Client-safe stage vocabulary
    store.ts                node:sqlite report storage
  shared/
    grade.ts                Single source of truth for letter grades
  scanner/
    engine.ts               Playwright runner: launch → navigate → inspect → assemble
    dom-inspector.ts        Self-contained browser-evaluated inspection routines
    declarative-discovery.ts Well-known descriptor fetching + static HTML mining
    validation.ts           Run-time conformance checks for AgentAuditRawData
    types.ts                The Phase 1 data contract
    cli.ts                  Command-line front end
  evals/
    scorer.ts               Deterministic four-pillar scoring
    benchmark.ts            Token tax and friction calculation
    issues.ts               Issue categorization and remediation mapping
    synthetic-agent.ts      Active evaluation agent + simulated fallback
    analysis.ts             Shared derivations (tool classification, coverage)
    types.ts                The Phase 2 data contract
packages/
  cli/                      @agentgrade/cli — terminal audits and the CI gate
    src/cli.ts              Argument parsing, exit codes
    src/audit.ts            Scan + score runner
    src/formatters/         pretty · json · markdown
    src/terminal.ts         ANSI styling and tables, no dependencies
    build.mjs               esbuild bundle; Playwright stays external
  react/                    @agentgrade/react — the fix, zero dependencies
    src/useWebMCP.ts        Registration, validation, unmount cleanup
    src/AgentForm.tsx       Form introspection → tool schema
    src/schema.ts           JSON Schema / Zod / Standard Schema validation
    src/semantics.ts        readOnlyHint inference
    src/runtime.ts          modelContext resolution and marked polyfill
.github/workflows/
  agentgrade.yml            Threshold gate + PR comment
tests/
  scanner.test.ts           Phase 1 end-to-end suite
  evals.test.ts             Phase 2 scoring, benchmark, and agent suite
  codegen.test.ts           Generated-code syntax validity and highlighting
  studio-api.test.ts        Store, pipeline, and API route execution
  studio-ui.test.tsx        Component rendering and WebMCP tool behaviour
  cli.test.ts               CLI exit codes, formats, and file output
  react-sdk.test.tsx        Tool registration, validation, unmount cleanup
  fixtures/mock-site.html   Storefront with registered tools and seeded traps
  helpers/fixture-server.ts Serves the fixtures plus the well-known descriptors
  helpers/audit-factory.ts  Builders for synthetic AgentAuditRawData payloads
  helpers/studio-fixture.ts A representative scored audit for studio tests
```

## Error handling (Phase 1)

`scanUrl` never throws for page-level problems. Navigation timeouts, DNS failures,
HTTP errors, and bot walls are reported through `AuditReport.status`
(`ok` | `partial` | `failed`), `navigation.status`, and the `diagnostics` list —
the report always conforms to the schema, even for a target that never loaded.
A soft navigation timeout that still rendered usable DOM is inspected anyway.

## Development

```bash
npm install
npm run typecheck
npm test            # 185 tests, real Chromium against a loopback fixture server
npm run build       # engine (tsc → dist/)
npm run build:cli   # @agentgrade/cli (esbuild bundle)
npm run build:react # @agentgrade/react (tsc → declarations)
npm run build:web   # studio (next build)
npm run build:all   # all four, in dependency order
npm run dev         # studio at http://localhost:3000
```

Workspaces are plain npm workspaces (`packages/*`) — no Turborepo, because the
build graph is four ordered steps and a task runner would be more moving parts
than it saves.

The test suite needs a Chromium build. If Playwright has not downloaded one yet:

```bash
npx playwright install chromium
```
