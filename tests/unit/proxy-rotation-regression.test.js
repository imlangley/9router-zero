import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function readRepoFile(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("provider proxy rotation regression", () => {
  it("routes chat requests through provider proxy policy decisions", () => {
    const chatCore = readRepoFile("open-sse/handlers/chatCore.js");

    expect(chatCore).toContain("selectProxyForRequest");
    expect(chatCore).toContain("recordProxyRequestResult");
    expect(chatCore).toContain("const proxyDecision = await selectProxyForRequest");
    expect(chatCore).toContain("const proxyOptions = proxyDecision.proxyOptions");
    expect(chatCore).not.toContain("credentials?.providerSpecificData?.connectionProxyUrl || \"\"");
  });

  it("keeps provider-scoped Apply Proxy policy controls on the provider page", () => {
    const providerPage = readRepoFile("src/app/(dashboard)/dashboard/providers/[id]/page.js");

    expect(providerPage).toContain("DEFAULT_PROXY_POLICY");
    expect(providerPage).toContain("PROXY_POLICY_OPTIONS");
    expect(providerPage).toContain("proxyProviderPolicies");
    expect(providerPage).toContain("Proxy Policy");
    expect(providerPage).toContain("One-to-one (rotate)");
    expect(providerPage).toContain("None (unbind all)");
  });
});

describe("combo strategy preservation", () => {
  it("keeps 0.5.2 combo strategy storage and runtime isolated from proxy policies", () => {
    const combosPage = readRepoFile("src/app/(dashboard)/dashboard/combos/page.js");
    const settingsRoute = readRepoFile("src/app/api/settings/route.js");
    const comboService = readRepoFile("open-sse/services/combo.js");

    expect(combosPage).toContain("comboStrategies");
    expect(combosPage).toContain("Fallback");
    expect(combosPage).toContain("Round Robin");
    expect(combosPage).toContain("Fusion");
    expect(combosPage).toContain("Capacity auto-switch");
    expect(settingsRoute).toContain("resetComboRotation");
    expect(comboService).toContain("handleFusionChat");
    expect(comboService).toContain("reorderByCapabilities");
  });
});
