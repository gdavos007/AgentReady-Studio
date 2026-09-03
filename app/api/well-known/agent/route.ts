export const runtime = 'nodejs';

/** The studio's agent card, served at `/.well-known/agent.json` via a rewrite. */
const AGENT_CARD = {
  name: 'AgentGrade Studio',
  description:
    'Audits websites for WebMCP and AI-agent readiness, scores them 0–100, and generates drop-in remediation code.',
  url: '/',
  version: '1.0.0',
  skills: [
    { id: 'audit', name: 'run_audit', description: 'Scan a URL and produce a scored agent-readiness report.' },
    { id: 'triage', name: 'filter_issues', description: 'Filter audit findings by severity or scoring pillar.' },
    { id: 'remediate', name: 'export_remediation_code', description: 'Generate WebMCP code that fixes a finding.' },
  ],
} as const;

export async function GET(): Promise<Response> {
  return Response.json(AGENT_CARD, { headers: { 'cache-control': 'public, max-age=300' } });
}
