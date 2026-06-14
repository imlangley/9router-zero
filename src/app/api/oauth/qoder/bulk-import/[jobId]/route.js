import { NextResponse } from "next/server";
import { buildLookupResponse, getQoderBulkImportManager } from "@/lib/oauth/services/qoderBulkImportManager";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { jobId } = await params;
  const manager = getQoderBulkImportManager();
  const job = await manager.getJobWithPreview(jobId);

  if (!job) {
    return NextResponse.json({
      success: false,
      ...buildLookupResponse(null, { stale: true }),
      error: "Bulk import job not found",
    }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    ...buildLookupResponse(job),
  });
}
