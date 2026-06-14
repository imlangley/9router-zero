import { getProxyPools, getSettings } from "@/lib/localDb.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";

const DEFAULT_SLOW_THRESHOLD_MS = 15_000;
const RUNTIME_PROXY_TYPES = new Set(["http", "vercel", "cloudflare", "deno"]);
const DEFAULT_POLICY_MODE = "one_to_one";
const PROXY_POLICY_MODES = new Set(["none", "one_to_one", "rotate_all", "rotate_selected"]);
const PROXY_FALLBACK_MODES = new Set(["fail", "one_to_one", "direct"]);
const rotationState = new Map();

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeProxyUrl(proxyUrl) {
  const raw = normalizeString(proxyUrl);
  if (!raw) return "";
  try {
    new URL(raw);
    return raw;
  } catch {
    return `http://${raw}`;
  }
}

function parseProxyUrl(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function getHostPort(proxyUrl) {
  const parsed = parseProxyUrl(proxyUrl);
  if (!parsed) return "unknown";
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.hostname}${port}`;
}

function maskProxyUrl(proxyUrl) {
  const parsed = parseProxyUrl(proxyUrl);
  if (!parsed) return "";
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function formatIndex(index) {
  return String(Math.max(0, Number(index) || 0) + 1).padStart(3, "0");
}

function buildDisplayLabels(pool, index) {
  const hostPort = getHostPort(pool?.proxyUrl);
  const name = normalizeString(pool?.name);
  const generated = `#${formatIndex(index)} · ${hostPort}`;
  const displayLabel = name && !name.startsWith("Imported ") ? name : generated;
  const shortHost = hostPort.split(":")[0] || hostPort;
  const shortLabel = displayLabel === name ? name : `#${formatIndex(index)} · ${shortHost}`;
  return { displayLabel, shortLabel, hostPort };
}

function poolToProxyOptions(pool) {
  const noProxy = normalizeString(pool?.noProxy);
  const type = normalizeString(pool?.type || "http").toLowerCase();
  const proxyUrl = normalizeString(pool?.proxyUrl);
  if (type === "vercel" || type === "cloudflare" || type === "deno") {
    return {
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: noProxy,
      vercelRelayUrl: proxyUrl,
      strictProxy: pool?.strictProxy === true,
    };
  }

  return {
    connectionProxyEnabled: true,
    connectionProxyUrl: proxyUrl,
    connectionNoProxy: noProxy,
    vercelRelayUrl: "",
    strictProxy: pool?.strictProxy === true,
  };
}

function buildDirectProxyOptions() {
  return {
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  };
}

function proxyConfigToOptions(proxyConfig = {}) {
  return {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: proxyConfig.strictProxy === true,
  };
}

function getState(rotationKey) {
  if (!rotationState.has(rotationKey)) {
    rotationState.set(rotationKey, { cursor: 0, stats: new Map() });
  }
  return rotationState.get(rotationKey);
}

function getFixedProxyMeta(proxyConfig = {}, { policyMode = "one_to_one", purpose = "chat", fallbackUsed = null } = {}) {
  const hasProxy = proxyConfig.connectionProxyEnabled === true
    || Boolean(proxyConfig.vercelRelayUrl);
  if (!hasProxy) {
    return {
      enabled: false,
      rotated: false,
      source: "none",
      policyMode,
      purpose,
      fallbackUsed,
      outcome: "none",
    };
  }

  const proxyUrl = proxyConfig.connectionProxyUrl || proxyConfig.vercelRelayUrl || "";
  const pool = proxyConfig.proxyPool || null;
  const poolName = pool?.name || null;
  return {
    enabled: true,
    rotated: false,
    source: proxyConfig.source || (proxyConfig.vercelRelayUrl ? "relay" : "connection"),
    policyMode,
    purpose,
    fallbackUsed,
    poolId: proxyConfig.proxyPoolId || pool?.id || null,
    poolName,
    displayLabel: poolName || getHostPort(proxyUrl),
    shortLabel: poolName || getHostPort(proxyUrl).split(":")[0],
    type: proxyConfig.vercelRelayUrl ? (pool?.type || "relay") : (pool?.type || "http"),
    urlMasked: maskProxyUrl(proxyUrl),
  };
}

async function buildAssignedDecision(credentials, { slowThresholdMs, policyMode = "one_to_one", purpose = "chat", fallbackUsed = null } = {}) {
  const proxyConfig = await resolveConnectionProxyConfig(credentials?.providerSpecificData || {});
  return {
    rotated: false,
    rotationKey: null,
    policyMode,
    purpose,
    proxyOptions: proxyConfigToOptions(proxyConfig),
    proxyMeta: getFixedProxyMeta(proxyConfig, { policyMode, purpose, fallbackUsed }),
    slowThresholdMs: slowThresholdMs || DEFAULT_SLOW_THRESHOLD_MS,
  };
}

function buildDirectDecision({ slowThresholdMs, policyMode = "none", purpose = "chat", fallbackUsed = null } = {}) {
  return {
    rotated: false,
    rotationKey: null,
    policyMode,
    purpose,
    proxyOptions: buildDirectProxyOptions(),
    proxyMeta: {
      enabled: false,
      rotated: false,
      source: "none",
      policyMode,
      purpose,
      fallbackUsed,
      outcome: "none",
    },
    slowThresholdMs: slowThresholdMs || DEFAULT_SLOW_THRESHOLD_MS,
  };
}

function isUsableRuntimePool(pool) {
  if (!pool || pool.isActive !== true) return false;
  if (!normalizeString(pool.proxyUrl)) return false;
  const type = normalizeString(pool.type || "http").toLowerCase();
  return RUNTIME_PROXY_TYPES.has(type);
}

function normalizePolicy(rawPolicy = {}, settings = {}) {
  const mode = PROXY_POLICY_MODES.has(rawPolicy.mode) ? rawPolicy.mode : DEFAULT_POLICY_MODE;
  const fallback = PROXY_FALLBACK_MODES.has(rawPolicy.fallback) ? rawPolicy.fallback : "fail";
  const selectedPoolIds = Array.isArray(rawPolicy.selectedPoolIds)
    ? rawPolicy.selectedPoolIds.map((id) => normalizeString(id)).filter(Boolean)
    : [];
  return {
    mode,
    fallback,
    selectedPoolIds,
    slowThresholdMs: Number(rawPolicy.slowThresholdMs) || Number(settings.runtimeProxySlowThresholdMs) || DEFAULT_SLOW_THRESHOLD_MS,
  };
}

function getProviderPolicy(settings = {}, provider) {
  const providerPolicies = settings.proxyProviderPolicies || {};
  return normalizePolicy(providerPolicies?.[provider] || {}, settings);
}

function getRotationKey(provider, policy) {
  const scope = policy.mode === "rotate_selected" ? policy.selectedPoolIds.slice().sort().join(",") : "all";
  return `provider:${provider || "global"}:${policy.mode}:${scope}`;
}

function buildBlockedDecision({ provider, policy, purpose, reason }) {
  const slowThresholdMs = policy.slowThresholdMs || DEFAULT_SLOW_THRESHOLD_MS;
  return {
    blocked: true,
    rotated: false,
    rotationKey: null,
    policyMode: policy.mode,
    purpose,
    proxyOptions: buildDirectProxyOptions(),
    error: reason,
    proxyMeta: {
      enabled: false,
      rotated: false,
      source: "blocked",
      policyMode: policy.mode,
      purpose,
      provider: provider || null,
      outcome: "failed",
      error: reason,
    },
    slowThresholdMs,
  };
}

async function buildFallbackDecision(credentials, policy, purpose, provider, reason) {
  if (policy.fallback === "direct") {
    const decision = buildDirectDecision({ slowThresholdMs: policy.slowThresholdMs, policyMode: policy.mode, purpose, fallbackUsed: "direct" });
    decision.proxyMeta.error = reason;
    return decision;
  }
  if (policy.fallback === "one_to_one") {
    const decision = await buildAssignedDecision(credentials, { slowThresholdMs: policy.slowThresholdMs, policyMode: policy.mode, purpose, fallbackUsed: "one_to_one" });
    decision.proxyMeta.error = reason;
    return decision;
  }
  return buildBlockedDecision({ provider, policy, purpose, reason });
}

export async function selectProxyForRequest({ provider, credentials, purpose = "chat" } = {}) {
  const settings = await getSettings().catch(() => ({}));
  const policy = getProviderPolicy(settings, provider);

  if (policy.mode === "none") {
    return buildDirectDecision({ slowThresholdMs: policy.slowThresholdMs, policyMode: policy.mode, purpose });
  }

  if (policy.mode === "one_to_one") {
    return buildAssignedDecision(credentials, { slowThresholdMs: policy.slowThresholdMs, policyMode: policy.mode, purpose });
  }

  const pools = await getProxyPools({ isActive: true }).catch(() => []);
  const usablePools = pools.filter((pool) => {
    if (!isUsableRuntimePool(pool)) return false;
    if (policy.mode !== "rotate_selected") return true;
    return policy.selectedPoolIds.includes(pool.id);
  });
  if (usablePools.length === 0) {
    const reason = policy.mode === "rotate_selected"
      ? `No active selected proxy pools for ${provider || "provider"}`
      : `No active proxy pools for ${provider || "provider"}`;
    return buildFallbackDecision(credentials, policy, purpose, provider, reason);
  }

  const rotationKey = getRotationKey(provider, policy);
  const state = getState(rotationKey);
  const selectedIndex = state.cursor % usablePools.length;
  state.cursor += 1;
  const pool = usablePools[selectedIndex];
  const labels = buildDisplayLabels(pool, selectedIndex);
  const parsed = parseProxyUrl(pool.proxyUrl);

  return {
    rotated: true,
    rotationKey,
    selectedIndex,
    policyMode: policy.mode,
    purpose,
    slowThresholdMs: policy.slowThresholdMs,
    proxyOptions: poolToProxyOptions(pool),
    proxyMeta: {
      enabled: true,
      rotated: true,
      source: "rotation",
      policyMode: policy.mode,
      purpose,
      poolId: pool.id,
      poolName: pool.name || null,
      displayLabel: labels.displayLabel,
      shortLabel: labels.shortLabel,
      host: parsed?.hostname || null,
      port: parsed?.port || null,
      hostPort: labels.hostPort,
      type: normalizeString(pool.type || "http").toLowerCase(),
      urlMasked: maskProxyUrl(pool.proxyUrl),
    },
  };
}

export function recordProxyRequestResult(proxyDecision, result = {}) {
  const latencyMs = Number(result.latencyMs) || 0;
  const failed = result.failed === true;
  const slowThresholdMs = Number(proxyDecision?.slowThresholdMs) || DEFAULT_SLOW_THRESHOLD_MS;
  const outcome = failed ? "failed" : latencyMs >= slowThresholdMs ? "slow" : "success";
  const proxy = {
    ...(proxyDecision?.proxyMeta || { enabled: false, source: "none" }),
    outcome,
    latencyMs,
    statusCode: result.statusCode || null,
    error: result.error || null,
    slowThresholdMs,
  };

  if (proxyDecision?.rotated && proxyDecision.rotationKey) {
    const state = getState(proxyDecision.rotationKey);
    if (proxy.poolId) {
      const stats = state.stats.get(proxy.poolId) || {
        successCount: 0,
        failureCount: 0,
        slowCount: 0,
      };
      if (outcome === "failed") stats.failureCount += 1;
      else if (outcome === "slow") stats.slowCount += 1;
      else stats.successCount += 1;
      stats.lastOutcome = outcome;
      stats.lastLatencyMs = latencyMs;
      stats.lastStatusCode = result.statusCode || null;
      stats.lastError = result.error || null;
      stats.lastUsedAt = new Date().toISOString();
      state.stats.set(proxy.poolId, stats);
    }
  }

  return proxy;
}
