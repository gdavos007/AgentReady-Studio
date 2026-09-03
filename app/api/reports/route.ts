import { getReportStore } from '@/src/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Lists stored audits for the home page's recent-runs rail. */
export async function GET(request: Request): Promise<Response> {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? '10');
  const store = getReportStore();
  return Response.json({
    backend: store.backend,
    reports: store.list(Number.isFinite(limit) ? limit : 10),
  });
}

/** Deletes one stored audit. */
export async function DELETE(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'An "id" query parameter is required.' }, { status: 400 });
  const deleted = getReportStore().delete(id);
  return Response.json({ deleted }, { status: deleted ? 200 : 404 });
}
