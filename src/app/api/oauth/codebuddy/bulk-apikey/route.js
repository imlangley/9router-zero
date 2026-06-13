import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

export const dynamic = "force-dynamic";

const CODEBUDDY_PROVIDER_ID = "codebuddy";
const CODEBUDDY_DOMAIN = "www.codebuddy.ai";

export async function POST(request) {
  try {
    const body = await request.json();
    const rawKeys = body?.keys;

    if (!rawKeys || (typeof rawKeys !== "string" && !Array.isArray(rawKeys))) {
      return NextResponse.json(
        { error: "Provide keys as a string (one per line) or array" },
        { status: 400 }
      );
    }

    const keyList = Array.isArray(rawKeys)
      ? rawKeys.map((k) => String(k || "").trim()).filter(Boolean)
      : String(rawKeys)
          .split(/[\r\n]+/)
          .map((k) => k.trim())
          .filter(Boolean);

    if (keyList.length === 0) {
      return NextResponse.json(
        { error: "At least one API key is required" },
        { status: 400 }
      );
    }

    const results = [];

    for (const key of keyList) {
      try {
        if (!key.startsWith("ck_")) {
          results.push({
            key: key.substring(0, 12) + "...",
            status: "failed",
            error: "Invalid key format (must start with ck_)",
          });
          continue;
        }

        const connection = await createProviderConnection({
          provider: CODEBUDDY_PROVIDER_ID,
          authType: "apikey",
          name: `CodeBuddy API Key ${key.substring(0, 15)}...`,
          apiKey: key,
          accessToken: key,
          email: `apikey-${key.substring(3, 15)}...`,
          providerSpecificData: {
            domain: CODEBUDDY_DOMAIN,
            loginEmail: null,
            automation: "bulk-apikey-import",
            credentialKind: "codebuddy_api_key",
            credentialSource: "manual_apikey_import",
            routingAuthHeader: "bearer",
            routingEndpoint: "https://www.codebuddy.ai/v2/chat/completions",
            apiKeyId: key.substring(3, 15),
            apiKeyName: "imported",
            apiKeyExpiresAt: "9999-12-30 00:00:00",
          },
          testStatus: "active",
        });

        results.push({
          keyId: key.substring(3, 15) + "...",
          status: "success",
          connectionId: connection.id,
        });
      } catch (error) {
        results.push({
          key: key.substring(0, 12) + "...",
          status: "failed",
          error: error.message || "Failed to import key",
        });
      }
    }

    const successCount = results.filter((r) => r.status === "success").length;
    const failedCount = results.filter((r) => r.status === "failed").length;

    return NextResponse.json({
      success: true,
      imported: successCount,
      failed: failedCount,
      total: keyList.length,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to import API keys" },
      { status: 500 }
    );
  }
}
