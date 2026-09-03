# AgentGrade

An automated auditor for WebMCP and AI-agent readiness, in two phases.

**Phase 1 — the inspection engine** (`src/scanner`) drives a headless Chromium
session and returns a strictly-typed `AuditReport`: every agent-callable tool,
every interactive surface, and every "friction trap" that would stop an agent
from completing a task.

**Phase 2 — the evaluation layer** (`src/evals`) turns that raw data into an
`AgentScorecard`: a deterministic 0–100 score across four weighted pillars, a
DOM-vs-WebMCP benchmark quoting the "Agent Friction Tax", and a ranked list of
`AuditIssue`s whose deductions reconcile exactly against the score.

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

> `AgentScorecard.grade` is the authoritative grade. The Phase 1
> `ScanSummary.grade` is a quick-look scanner heuristic on a different scale and
> is not used by the evaluation layer.

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

## Layout

```
src/
  index.ts                  auditUrl(): scan + score in one call
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
tests/
  scanner.test.ts           Phase 1 end-to-end suite
  evals.test.ts             Phase 2 scoring, benchmark, and agent suite
  fixtures/mock-site.html   Storefront with registered tools and seeded traps
  helpers/fixture-server.ts Serves the fixtures plus the well-known descriptors
  helpers/audit-factory.ts  Builders for synthetic AgentAuditRawData payloads
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
npm test          # launches real Chromium against the loopback fixture server
npm run build
```

The test suite needs a Chromium build. If Playwright has not downloaded one yet:

```bash
npx playwright install chromium
```
