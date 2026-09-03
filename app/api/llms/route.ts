export const runtime = 'nodejs';

/** The studio's `/llms.txt`, served via a rewrite. */
const LLMS_TXT = `# AgentGrade Studio

> Audits websites for WebMCP and AI-agent readiness: a scored report, a
> friction-tax benchmark, and drop-in remediation code.

## Capabilities

- [Run an audit](/api/audit): POST { "url": "https://example.com" } and read NDJSON progress until { "stage": "complete", "reportId": "..." }.
- [List recent audits](/api/reports): Returns the most recent stored reports, newest first.
- [View a report](/report/): Open /report/<reportId> for the full scorecard, benchmark, and issue list.
- [Sample target](/api/fixture): A verified mock storefront with registered tools and seeded friction traps.

## Notes

Report pages register WebMCP tools (filter_issues, select_issue,
export_remediation_code) so an agent can triage findings without reading the DOM.
`;

export async function GET(): Promise<Response> {
  return new Response(LLMS_TXT, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
