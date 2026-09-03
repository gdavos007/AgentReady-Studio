'use client';

import { useCallback, useMemo } from 'react';

import type { AgentScorecard, AuditIssue, IssueSeverity, PillarId } from '@/src/evals/types';
import type { RemediationBundle, RemediationTabId } from '@/src/lib/codegen';
import { useWebMCPTools, type WebMcpResult, type WebMcpToolDefinition } from './useWebMCP';

/** Filter state the studio's issue list is driven by. */
export interface IssueFilter {
  severity: IssueSeverity | 'all';
  pillar: PillarId | 'all';
}

export interface StudioWebMCPOptions {
  scorecard: AgentScorecard;
  /** Issues currently rendered, after filtering. */
  visibleIssues: AuditIssue[];
  filter: IssueFilter;
  selectedIssueId: string | null;
  onFilterChange: (filter: IssueFilter) => void;
  onSelectIssue: (issueId: string | null) => void;
  onTabChange?: (tab: RemediationTabId) => void;
  /** Resolves an issue's generated code. */
  remediationFor: (issueId: string) => RemediationBundle | null;
}

const SEVERITIES: ReadonlyArray<IssueSeverity | 'all'> = ['all', 'critical', 'warning', 'info'];
const PILLARS: ReadonlyArray<PillarId | 'all'> = ['all', 'discovery', 'actionability', 'friction', 'safety'];
const SURFACES: ReadonlyArray<RemediationTabId | 'all'> = [
  'all',
  'browser-native',
  'react-hook',
  'declarative-html',
];

/**
 * Registers the studio's own WebMCP tools.
 *
 * AgentGrade tells sites to expose their actions as tools; the studio has to
 * hold itself to that. A browser agent can filter the findings, open one, and
 * pull the generated fix out — without parsing the DOM, and without a screenshot.
 *
 * All three tools are read-only: they move the studio's view and return data,
 * and none of them mutates an audit or touches the network.
 */
export function useStudioWebMCP(options: StudioWebMCPOptions): void {
  const {
    scorecard,
    visibleIssues,
    filter,
    selectedIssueId,
    onFilterChange,
    onSelectIssue,
    onTabChange,
    remediationFor,
  } = options;

  /** Compact issue projection — enough for an agent to decide what to open. */
  const project = useCallback(
    (issue: AuditIssue) => ({
      id: issue.id,
      title: issue.title,
      severity: issue.severity,
      pillar: issue.pillar,
      deductionPoints: issue.deductionPoints,
      selectors: issue.relatedSelectors.slice(0, 5),
    }),
    [],
  );

  const filterIssues = useCallback(
    (args: { severity?: string; pillar?: string }): WebMcpResult => {
      const severity = normalise(args?.severity, SEVERITIES, 'all') as IssueSeverity | 'all';
      const pillar = normalise(args?.pillar, PILLARS, 'all') as PillarId | 'all';

      const matches = scorecard.issues.filter(
        (issue) =>
          (severity === 'all' || issue.severity === severity) &&
          (pillar === 'all' || issue.pillar === pillar),
      );

      onFilterChange({ severity, pillar });

      return json({
        applied: { severity, pillar },
        matchCount: matches.length,
        totalDeduction: round2(matches.reduce((total, issue) => total + issue.deductionPoints, 0)),
        issues: matches.map(project),
      });
    },
    [scorecard.issues, onFilterChange, project],
  );

  const selectIssue = useCallback(
    (args: { issueId?: string }): WebMcpResult => {
      const issueId = typeof args?.issueId === 'string' ? args.issueId : '';
      const issue = scorecard.issues.find((entry) => entry.id === issueId);

      if (!issue) {
        return json(
          {
            error: `No issue with id "${issueId}".`,
            availableIds: scorecard.issues.map((entry) => entry.id),
          },
          true,
        );
      }

      onSelectIssue(issue.id);

      return json({
        ...project(issue),
        impactDescription: issue.impactDescription,
        remediation: issue.remediation,
        componentId: issue.componentId,
        evidence: issue.evidence,
        scoreIfFixed: round2(Math.min(100, scorecard.overallScoreExact + issue.deductionPoints)),
      });
    },
    [scorecard.issues, scorecard.overallScoreExact, onSelectIssue, project],
  );

  const exportRemediationCode = useCallback(
    (args: { issueId?: string; surface?: string }): WebMcpResult => {
      const issueId = typeof args?.issueId === 'string' ? args.issueId : selectedIssueId ?? '';
      const bundle = remediationFor(issueId);

      if (!bundle) {
        return json(
          {
            error: issueId
              ? `No remediation available for issue "${issueId}".`
              : 'No issue selected and no issueId supplied.',
            availableIds: scorecard.issues.map((entry) => entry.id),
          },
          true,
        );
      }

      const surface = normalise(args?.surface, SURFACES, 'all') as RemediationTabId | 'all';
      const tabs = surface === 'all' ? bundle.tabs : bundle.tabs.filter((tab) => tab.id === surface);

      // Selecting a surface also moves the visible drawer, so what the agent
      // received and what a human sees on screen stay in agreement.
      if (surface !== 'all') {
        onSelectIssue(issueId);
        onTabChange?.(surface);
      }

      return json({
        issueId: bundle.issueId,
        kind: bundle.kind,
        toolName: bundle.toolName,
        summary: bundle.summary,
        targetSelectors: bundle.targetSelectors,
        tabs: tabs.map((tab) => ({
          id: tab.id,
          language: tab.language,
          filename: tab.filename,
          explanation: tab.explanation,
          code: tab.code,
        })),
      });
    },
    [remediationFor, selectedIssueId, scorecard.issues, onSelectIssue, onTabChange],
  );

  const tools = useMemo<Array<WebMcpToolDefinition<never>>>(
    () => [
      {
        name: 'filter_issues',
        description:
          'Filter the audit findings currently shown in AgentGrade Studio by severity and/or pillar, and return the matching issues with the points each one costs.',
        inputSchema: {
          type: 'object',
          properties: {
            severity: {
              type: 'string',
              enum: [...SEVERITIES],
              description: 'Severity to filter by. "all" clears the severity filter.',
            },
            pillar: {
              type: 'string',
              enum: [...PILLARS],
              description: 'Scoring pillar to filter by. "all" clears the pillar filter.',
            },
          },
          required: [],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
        execute: filterIssues as (args: never) => WebMcpResult,
      },
      {
        name: 'select_issue',
        description:
          'Select one audit issue by id, opening its remediation drawer, and return its full detail including root-cause selectors and the score it would restore.',
        inputSchema: {
          type: 'object',
          properties: {
            issueId: {
              type: 'string',
              description: 'The issue id, e.g. "friction.unlabelled-input". Use filter_issues to list them.',
            },
          },
          required: ['issueId'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
        execute: selectIssue as (args: never) => WebMcpResult,
      },
      {
        name: 'export_remediation_code',
        description:
          'Return the generated WebMCP remediation code for an issue: the browser-native registerTool call, the React useWebMCP hook, and the declarative HTML markup.',
        inputSchema: {
          type: 'object',
          properties: {
            issueId: {
              type: 'string',
              description: 'The issue to generate code for. Defaults to the currently selected issue.',
            },
            surface: {
              type: 'string',
              enum: [...SURFACES],
              description: 'Which code surface to return. "all" returns every tab.',
            },
          },
          required: [],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
        execute: exportRemediationCode as (args: never) => WebMcpResult,
      },
    ],
    [filterIssues, selectIssue, exportRemediationCode],
  );

  useWebMCPTools(tools);

  // `filter` and `visibleIssues` are not read inside the tool closures — the
  // tools recompute from the scorecard so an agent always sees the full set —
  // but they are part of this hook's contract, so touching them here keeps the
  // dependency intent explicit for future edits.
  void filter;
  void visibleIssues;
}

/** Coerces an argument to one of a known set, falling back to a default. */
function normalise<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Wraps a payload in the WebMCP text-content envelope. */
function json(payload: unknown, isError = false): WebMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
