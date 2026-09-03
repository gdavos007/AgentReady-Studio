# AgentGrade — Inspection Engine

The core inspection engine for **AgentGrade**, an automated auditor for WebMCP and
AI-agent readiness. Point it at a URL; it drives a headless Chromium session and
returns a strictly-typed `AuditReport` describing every agent-callable tool, every
interactive surface, and every "friction trap" that would stop an agent from
completing a task.

```ts
import { scanUrl, assertAgentAuditRawData } from './src/scanner/index.js';

const report = await scanUrl('https://example.com');
assertAgentAuditRawData(report.data);

console.log(report.data.summary.grade, report.data.summary.agentReadinessScore);
console.log(report.data.tools.map((tool) => `${tool.source} → ${tool.name}`));
```

From the command line:

```bash
npm run scan -- https://example.com --out report.json
npm run scan -- https://example.com --timeout 45000 --proxy http://127.0.0.1:8080
```

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

## Layout

```
src/scanner/
  engine.ts                 Playwright runner: launch → navigate → inspect → assemble
  dom-inspector.ts          Self-contained browser-evaluated inspection routines
  declarative-discovery.ts  Well-known descriptor fetching + static HTML mining
  validation.ts             Run-time conformance checks for AgentAuditRawData
  types.ts                  The complete data contract
  cli.ts                    Command-line front end
tests/
  scanner.test.ts           End-to-end suite against a loopback fixture server
  fixtures/mock-site.html   Storefront with registered tools and seeded traps
  helpers/fixture-server.ts Serves the fixtures plus the well-known descriptors
```

## Error handling

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
