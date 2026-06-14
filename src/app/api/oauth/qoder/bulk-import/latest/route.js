import { NextResponse } from "next/server";
import { buildLookupResponse, getQoderBulkImportManager } from "@/lib/oauth/services/qoderBulkImportManager";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const manager = getQoderBulkImportManager();
  const searchParams = new URL(request.url).searchParams;
  const scope = searchParams.get("scope");
  const includeRecentTerminal = scope === "recent" || scope === "recoverable" || scope === "all";
  const job = await manager.getLatestJobWithPreview({ includeRecentTerminal });

  if (!job) {
    return NextResponse.json({
      success: false,
      ...buildLookupResponse(null),
      error: "Bulk import job not found",
    }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    ...buildLookupResponse(job),
  });
}
