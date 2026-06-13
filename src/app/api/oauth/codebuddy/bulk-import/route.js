import { NextResponse } from "next/server";
import { getCodeBuddyBulkImportManager, parseCodeBuddyBulkAccounts } from "@/lib/oauth/services/codebuddyBulkImportManager";
import { getProxyPoolById, getProxyPools } from "@/models";

export const dynamic = "force-dynamic";

const ROUND_ROBIN_PROXY_POOL_VALUE = "__round_robin__";

async function resolveLoginProxyPools(body = {}) {
  const proxyPoolId = typeof body?.loginProxyPoolId === "string" ? body.loginProxyPoolId.trim() : "";
  if (!proxyPoolId || proxyPoolId === "__none__") {
    return { loginProxyStrategy: "none", loginProxyPools: [] };
  }

  if (proxyPoolId === ROUND_ROBIN_PROXY_POOL_VALUE) {
    const pools = (await getProxyPools({ isActive: true })).filter((pool) => pool.type === "http" && pool.proxyUrl);
    if (pools.length === 0) {
      return { error: "No active HTTP proxy pools are available for CodeBuddy bulk login" };
    }
    return { loginProxyStrategy: "round-robin", loginProxyPools: pools };
  }

  const pool = await getProxyPoolById(proxyPoolId);
  if (!pool) return { error: "Selected login proxy pool was not found" };
  if (pool.isActive !== true) return { error: "Selected login proxy pool is not active" };
  if (pool.type !== "http" || !pool.proxyUrl) {
    return { error: "CodeBuddy browser login requires an active HTTP proxy pool" };
  }

  return { loginProxyStrategy: "single", loginProxyPools: [pool] };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    const { parsed, invalidLines } = parseCodeBuddyBulkAccounts(accounts);

    if (!parsed.length) {
      return NextResponse.json(
        { error: "At least one account entry is required" },
        { status: 400 }
      );
    }

    if (invalidLines.length > 0) {
      return NextResponse.json(
        {
          error: "Invalid account format. Use one account per line: gmail@example.com|password",
          invalidLines,
        },
        { status: 400 }
      );
    }

    const manager = getCodeBuddyBulkImportManager();
    const loginProxyConfig = await resolveLoginProxyPools(body);
    if (loginProxyConfig.error) {
      return NextResponse.json({ error: loginProxyConfig.error }, { status: 400 });
    }

    const job = await manager.startJob({
      accounts,
      concurrency: body?.concurrency,
      generateApiKeys: body?.generateApiKeys === true,
      loginProxyStrategy: loginProxyConfig.loginProxyStrategy,
      loginProxyPools: loginProxyConfig.loginProxyPools,
    });

    return NextResponse.json({
      success: true,
      job,
    });
  } catch (error) {
    const status = Array.isArray(error?.invalidLines) ? 400 : 500;
    return NextResponse.json(
      {
        error: error?.error || error?.message || "Failed to start CodeBuddy bulk import",
        ...(Array.isArray(error?.invalidLines) ? { invalidLines: error.invalidLines } : {}),
      },
      { status }
    );
  }
}
