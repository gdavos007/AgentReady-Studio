export const runtime = 'nodejs';

/**
 * The studio's own `/.well-known/mcp` manifest (via a rewrite).
 *
 * These are the same three tools `useStudioWebMCP` registers at runtime, so an
 * agent that never executes the page still finds them — which is exactly what
 * AgentGrade's Discovery pillar asks every audited site to do.
 */
const MANIFEST = {
  schemaVersion: '2025-06-18',
  name: 'agentgrade-studio',
  description: 'Audit any site for WebMCP and AI-agent readiness.',
  tools: [
    {
      name: 'filter_issues',
      description:
        'Filter the audit findings currently shown in AgentGrade Studio by severity and/or pillar, and return the matching issues with the points each one costs.',
      inputSchema: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['all', 'critical', 'warning', 'info'],
            description: 'Severity to filter by. "all" clears the severity filter.',
          },
          pillar: {
            type: 'string',
            enum: ['all', 'discovery', 'actionability', 'friction', 'safety'],
            description: 'Scoring pillar to filter by. "all" clears the pillar filter.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
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
            enum: ['all', 'browser-native', 'react-hook', 'declarative-html'],
            description: 'Which code surface to return. "all" returns every tab.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ],
} as const;

export async function GET(): Promise<Response> {
  return Response.json(MANIFEST, {
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
