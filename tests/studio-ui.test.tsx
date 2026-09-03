/**
 * @vitest-environment jsdom
 *
 * Rendering tests for the studio's report view.
 *
 * These run against a mock scorecard rather than a live scan so they stay fast,
 * and they assert the three things a report has to get right: the headline
 * numbers, the interactive filtering, and the WebMCP tools the page registers
 * on itself.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ReportView } from '../app/report/[id]/report-view.js';
import { BenchmarkComparison } from '../components/BenchmarkComparison.js';
import { IssueCard, SelectorPreview } from '../components/IssueCard.js';
import { PillarBreakdown } from '../components/PillarBreakdown.js';
import { ScoreGauge } from '../components/ScoreGauge.js';
import type { WebMcpResult, WebMcpToolDefinition } from '../hooks/useWebMCP.js';
import { makeStudioFixture, type StudioFixture } from './helpers/studio-fixture.js';

let fixture: StudioFixture;

beforeAll(async () => {
  fixture = await makeStudioFixture();
});

afterEach(() => {
  cleanup();
  // The polyfilled registry lives on `navigator`; reset it between tests so a
  // registration from one test cannot satisfy another's assertion.
  delete (navigator as { modelContext?: unknown }).modelContext;
});

/** Renders the full report view with the fixture's data. */
function renderReport() {
  return render(
    <ReportView
      scorecard={fixture.scorecard}
      remediations={fixture.remediations}
      url="https://shop.example/"
      scanStatus="ok"
      scanDurationMs={4200}
    />,
  );
}

/** Reads the tools the page registered, as an agent would. */
function registeredTools(): Array<WebMcpToolDefinition<never>> {
  const context = (navigator as { modelContext?: { getTools?: () => unknown[] } }).modelContext;
  return (context?.getTools?.() ?? []) as Array<WebMcpToolDefinition<never>>;
}

/**
 * Calls a registered tool and parses its JSON envelope.
 *
 * Wrapped in `act` because these tools are invoked by an agent, not by a React
 * event handler: the state they set has to be flushed before the assertions
 * can see the re-rendered list — which is also exactly what the browser does.
 */
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = registeredTools().find((entry) => entry.name === name);
  if (!tool) throw new Error(`Tool "${name}" is not registered.`);

  let result: WebMcpResult;
  await act(async () => {
    result = (await tool.execute(args as never)) as WebMcpResult;
  });
  return JSON.parse(result!.content[0].text) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */

describe('ScoreGauge', () => {
  it('renders the score, the grade, and an accessible label', () => {
    render(<ScoreGauge score={73.6} grade="C" label="3 tools" />);
    expect(screen.getByTestId('score-value').textContent).toBe('74');
    expect(screen.getByTestId('score-grade').textContent).toBe('C');
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('grade C');
  });

  it('fills the arc in proportion to the score', () => {
    const { container } = render(<ScoreGauge score={50} grade="F" />);
    const [track, fill] = Array.from(container.querySelectorAll('circle'));
    const dashOf = (element: Element) => Number(element.getAttribute('stroke-dasharray')!.split(' ')[0]);
    expect(dashOf(fill) / dashOf(track)).toBeCloseTo(0.5, 6);
  });

  it('clamps impossible scores instead of drawing outside the ring', () => {
    for (const [score, expected] of [
      [-20, '0'],
      [140, '100'],
      [Number.NaN, '0'],
    ] as const) {
      cleanup();
      render(<ScoreGauge score={score} grade="F" />);
      expect(screen.getByTestId('score-value').textContent).toBe(expected);
    }
  });
});

describe('PillarBreakdown', () => {
  it('renders all four pillars with their components', () => {
    render(<PillarBreakdown pillars={fixture.scorecard.pillars} />);
    for (const pillar of fixture.scorecard.pillars) {
      const card = screen.getByTestId(`pillar-${pillar.pillar}`);
      expect(card.textContent).toContain(pillar.label);
      expect(card.textContent).toContain(`/ ${pillar.maxPoints}`);
      for (const component of pillar.components) {
        expect(card.textContent).toContain(component.label);
      }
    }
  });

  it('reports the pillar a reader clicked', () => {
    const clicked: string[] = [];
    render(
      <PillarBreakdown pillars={fixture.scorecard.pillars} onSelectPillar={(id) => clicked.push(id)} />,
    );
    fireEvent.click(screen.getByTestId('pillar-friction'));
    expect(clicked).toEqual(['friction']);
  });
});

describe('BenchmarkComparison', () => {
  it('leads with the friction tax and shows both execution modes', () => {
    render(<BenchmarkComparison benchmark={fixture.scorecard.benchmark} />);
    expect(screen.getByTestId('friction-tax-headline').textContent).toBe(
      fixture.scorecard.benchmark.frictionTax.headline,
    );

    const dom = screen.getByTestId('benchmark-dom-traversal');
    const mcp = screen.getByTestId('benchmark-webmcp-direct');
    expect(dom.textContent).toContain(`${fixture.scorecard.benchmark.domTraversal.steps} steps`);
    expect(mcp.textContent).toContain(`${fixture.scorecard.benchmark.webMcpDirect.steps} steps`);
    expect(dom.textContent).toContain('Failure risk');
  });

  it('discloses the assumptions behind the estimate', () => {
    render(<BenchmarkComparison benchmark={fixture.scorecard.benchmark} />);
    expect(screen.getByText(/Assumptions behind these numbers/)).toBeTruthy();
    for (const assumption of fixture.scorecard.benchmark.assumptions) {
      expect(screen.getByText(`— ${assumption}`)).toBeTruthy();
    }
  });
});

describe('IssueCard', () => {
  it('leads with the deduction and marks shadow-DOM selectors', () => {
    const issue = fixture.scorecard.issues.find((entry) => entry.deductionPoints > 0)!;
    render(<IssueCard issue={issue} />);
    const card = screen.getByTestId(`issue-${issue.id}`);
    expect(card.textContent).toContain(issue.title);
    expect(card.textContent).toContain(`−${issue.deductionPoints.toFixed(2)}`);
    expect(card.getAttribute('data-severity')).toBe(issue.severity);
  });

  it('highlights a >>> shadow boundary rather than printing it inline', () => {
    render(<SelectorPreview selector="body > checkout-widget >>> div.pay-button" />);
    const marked = screen.getByTestId('shadow-selector');
    expect(marked.textContent).toContain('>>>');
    const badge = within(marked).getByTitle(/Crosses a shadow root/);
    expect(badge.textContent).toBe('>>>');
  });

  it('leaves a plain selector unadorned', () => {
    render(<SelectorPreview selector="form#login" />);
    expect(screen.queryByTestId('shadow-selector')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('ReportView', () => {
  it('renders the hero, pillars, benchmark and issue list', () => {
    renderReport();
    expect(screen.getByTestId('score-value').textContent).toBe(String(fixture.scorecard.overallScore));
    expect(screen.getByTestId('score-grade').textContent).toBe(fixture.scorecard.grade);
    expect(screen.getByTestId('pillar-grid')).toBeTruthy();
    expect(screen.getByTestId('benchmark')).toBeTruthy();

    const list = screen.getByTestId('issue-list');
    expect(within(list).getAllByRole('button').length).toBe(fixture.scorecard.issues.length);
  });

  it('opens the highest-impact issue by default with its remediation code', () => {
    renderReport();
    const drawer = screen.getByTestId('code-drawer');
    const top = fixture.scorecard.issues[0];
    expect(drawer.textContent).toContain(top.title);
    expect(drawer.textContent).toContain(top.id);
    expect(screen.getByTestId('code-block')).toBeTruthy();
    expect(screen.getByTestId('tab-browser-native')).toBeTruthy();
  });

  it('filters the issue list by severity', () => {
    renderReport();
    const criticals = fixture.scorecard.issues.filter((issue) => issue.severity === 'critical');
    expect(criticals.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('filter-critical'));
    const list = screen.getByTestId('issue-list');
    expect(within(list).getAllByRole('button').length).toBe(criticals.length);

    fireEvent.click(screen.getByTestId('filter-all'));
    expect(within(list).getAllByRole('button').length).toBe(fixture.scorecard.issues.length);
  });

  it('filters by pillar when a pillar card is clicked, and clears on a second click', () => {
    renderReport();
    const frictionIssues = fixture.scorecard.issues.filter((issue) => issue.pillar === 'friction');
    expect(frictionIssues.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('pillar-friction'));
    const list = screen.getByTestId('issue-list');
    expect(within(list).getAllByRole('button').length).toBe(frictionIssues.length);

    fireEvent.click(screen.getByTestId('pillar-friction'));
    expect(within(list).getAllByRole('button').length).toBe(fixture.scorecard.issues.length);
  });

  it('switches remediation tabs', () => {
    renderReport();
    const before = screen.getByTestId('code-block').textContent ?? '';
    fireEvent.click(screen.getByTestId('tab-declarative-html'));
    const after = screen.getByTestId('code-block').textContent ?? '';
    expect(after).not.toBe(before);
    expect(after).toContain('AgentGrade remediation');
  });

  it('shows the synthetic agent trace for the audited target', () => {
    renderReport();
    const trace = screen.getByTestId('agent-trace');
    expect(trace.textContent).toContain(fixture.scorecard.syntheticEvaluation!.goal);
    expect(trace.textContent).toContain(fixture.scorecard.syntheticEvaluation!.mode);
  });

  it('closes the drawer and shows the empty state', () => {
    renderReport();
    fireEvent.click(screen.getByLabelText('Close remediation drawer'));
    expect(screen.getByTestId('code-drawer-empty')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */

describe('WebMCP self-registration', () => {
  it('registers the studio’s three tools with schemas and read-only annotations', () => {
    renderReport();
    const tools = registeredTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'export_remediation_code',
      'filter_issues',
      'select_issue',
    ]);

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema?.type).toBe('object');
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it('filter_issues narrows the rendered list and returns the matches', async () => {
    renderReport();
    const criticals = fixture.scorecard.issues.filter((issue) => issue.severity === 'critical');

    const payload = await callTool('filter_issues', { severity: 'critical' });
    expect(payload.matchCount).toBe(criticals.length);
    expect((payload.issues as unknown[]).length).toBe(criticals.length);
    expect(payload.applied).toEqual({ severity: 'critical', pillar: 'all' });

    // The visible list moved too, so agent and human see the same thing.
    const list = screen.getByTestId('issue-list');
    expect(within(list).getAllByRole('button').length).toBe(criticals.length);
  });

  it('filter_issues rejects an out-of-enum severity with the valid values', async () => {
    renderReport();
    const tool = registeredTools().find((entry) => entry.name === 'filter_issues')!;

    let result!: WebMcpResult;
    await act(async () => {
      result = (await tool.execute({ severity: 'catastrophic' } as never)) as WebMcpResult;
    });

    // The SDK validates against the schema the tool advertises, so a value
    // outside the declared enum never reaches the handler — and the model is
    // told what it should have sent instead of silently getting everything.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"severity" must be one of');
    expect(result.content[0].text).toContain('"critical"');
  });

  it('filter_issues defaults to everything when no arguments are supplied', async () => {
    renderReport();
    const payload = await callTool('filter_issues', {});
    expect(payload.applied).toEqual({ severity: 'all', pillar: 'all' });
    expect(payload.matchCount).toBe(fixture.scorecard.issues.length);
  });

  it('select_issue opens the drawer for that issue', async () => {
    renderReport();
    const target = fixture.scorecard.issues[2];

    const payload = await callTool('select_issue', { issueId: target.id });
    expect(payload.id).toBe(target.id);
    expect(payload.title).toBe(target.title);
    expect(payload.scoreIfFixed).toBeGreaterThanOrEqual(fixture.scorecard.overallScoreExact);

    expect(screen.getByTestId('code-drawer').textContent).toContain(target.title);
  });

  it('select_issue reports an error and lists valid ids for an unknown one', async () => {
    renderReport();
    const tool = registeredTools().find((entry) => entry.name === 'select_issue')!;
    const result = (await tool.execute({ issueId: 'nope' } as never)) as WebMcpResult;
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as { error: string; availableIds: string[] };
    expect(payload.error).toContain('nope');
    expect(payload.availableIds).toEqual(fixture.scorecard.issues.map((issue) => issue.id));
  });

  it('export_remediation_code returns all three surfaces', async () => {
    renderReport();
    const target = fixture.scorecard.issues[0];
    const payload = await callTool('export_remediation_code', { issueId: target.id });

    const tabs = payload.tabs as Array<{ id: string; code: string; language: string }>;
    expect(tabs.map((tab) => tab.id)).toEqual(['browser-native', 'react-hook', 'declarative-html']);
    for (const tab of tabs) expect(tab.code.length).toBeGreaterThan(40);
    expect(payload.issueId).toBe(target.id);
  });

  it('export_remediation_code can return one surface and moves the drawer to match', async () => {
    renderReport();
    const target = fixture.scorecard.issues[1];

    const payload = await callTool('export_remediation_code', {
      issueId: target.id,
      surface: 'declarative-html',
    });
    const tabs = payload.tabs as Array<{ id: string }>;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe('declarative-html');

    const drawer = screen.getByTestId('code-drawer');
    expect(drawer.textContent).toContain(target.title);
    expect(screen.getByTestId('tab-declarative-html').getAttribute('aria-selected')).toBe('true');
  });

  it('export_remediation_code defaults to the selected issue', async () => {
    renderReport();
    const payload = await callTool('export_remediation_code', {});
    expect(payload.issueId).toBe(fixture.scorecard.issues[0].id);
  });

  it('unregisters its tools when the report unmounts', () => {
    const view = renderReport();
    expect(registeredTools()).toHaveLength(3);
    view.unmount();
    expect(registeredTools()).toHaveLength(0);
  });
});
