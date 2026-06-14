import { getProviderConnections } from "../../../models/index.js";

export const BULK_ACCOUNT_SKIP_STATUSES = new Set([
  "skipped_duplicate",
  "skipped_duplicate_input",
]);

export function normalizeBulkAccountEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function isKnownGeneratedCodeBuddyApiKeyConnection(connection) {
  if (!connection || connection.provider !== "codebuddy" || connection.authType !== "apikey") {
    return false;
  }

  const providerData = connection.providerSpecificData || {};
  const keyId = providerData.apiKeyId || connection.apiKey || connection.accessToken || "";
  const keyName = providerData.apiKeyName || connection.name || "";
  return providerData.credentialKind === "codebuddy_api_key"
    && providerData.automation === "apikey-generated"
    && typeof keyId === "string"
    && keyId.startsWith("ck_")
    && typeof keyName === "string"
    && keyName.startsWith("9r-");
}

export function getKnownGeneratedCodeBuddyKeyId(connection) {
  if (!isKnownGeneratedCodeBuddyApiKeyConnection(connection)) return null;
  const providerData = connection.providerSpecificData || {};
  const keyId = providerData.apiKeyId || connection.apiKey || connection.accessToken || "";
  if (typeof keyId !== "string") return null;
  const normalized = keyId.trim();
  return normalized.startsWith("ck_") ? normalized : null;
}

function buildExistingEmailIndex(connections = []) {
  const index = new Map();
  for (const connection of connections) {
    const emailKey = normalizeBulkAccountEmail(connection?.email || connection?.providerSpecificData?.loginEmail);
    if (!emailKey) continue;
    const matches = index.get(emailKey) || [];
    matches.push(connection);
    index.set(emailKey, matches);
  }
  return index;
}

function classifyExistingDuplicate({ providerId, account, existingConnections }) {
  if (!existingConnections.length) return null;

  if (providerId === "codebuddy") {
    const generatedConnections = existingConnections.filter(isKnownGeneratedCodeBuddyApiKeyConnection);
    const generatedConnectionIds = generatedConnections.map((connection) => connection.id).filter(Boolean);
    const generatedApiKeyIds = generatedConnections.map(getKnownGeneratedCodeBuddyKeyId).filter(Boolean);
    const allConnectionIds = existingConnections.map((connection) => connection.id).filter(Boolean);
    const allConnectionNames = existingConnections.map((connection) => connection.name || connection.email).filter(Boolean);

    const onlyGenerated = generatedConnections.length > 0 && generatedConnections.length === existingConnections.length;
    const message = onlyGenerated
      ? `Skipped before browser launch: email already has ${generatedConnections.length} 9Router-generated CodeBuddy key(s). Delete them in the dashboard if you want to re-import.`
      : "Skipped before browser launch: this email already has a CodeBuddy connection.";

    return {
      status: "skipped_duplicate",
      error: "Email already has a CodeBuddy connection",
      step: "skipped_duplicate",
      message,
      existingConnectionIds: allConnectionIds,
      existingConnectionNames: allConnectionNames,
      ...(generatedConnectionIds.length > 0 ? { oldConnectionIds: generatedConnectionIds } : {}),
      ...(generatedApiKeyIds.length > 0 ? { oldApiKeyIds: generatedApiKeyIds } : {}),
    };
  }

  const label = providerId === "kiro" ? "Kiro" : providerId;
  return {
    status: "skipped_duplicate",
    error: `Email already has a ${label} connection`,
    step: "skipped_duplicate",
    message: `Skipped before browser launch: this email already has a ${label} connection.`,
    existingConnectionIds: existingConnections.map((connection) => connection.id).filter(Boolean),
    existingConnectionNames: existingConnections.map((connection) => connection.name || connection.email).filter(Boolean),
  };
}

export async function classifyBulkAccountDuplicates({ providerId, accounts = [], getConnections = getProviderConnections } = {}) {
  const providerConnections = await getConnections({ provider: providerId });
  const existingByEmail = buildExistingEmailIndex(providerConnections);
  const firstInputLineByEmail = new Map();

  return accounts.map((account) => {
    const emailKey = normalizeBulkAccountEmail(account.email);
    if (!emailKey) {
      return { status: "queued" };
    }

    if (firstInputLineByEmail.has(emailKey)) {
      const duplicateOfLine = firstInputLineByEmail.get(emailKey);
      return {
        status: "skipped_duplicate_input",
        error: `Duplicate input email already queued on line ${duplicateOfLine}`,
        step: "skipped_duplicate_input",
        message: `Skipped before browser launch: duplicate input email already queued on line ${duplicateOfLine}.`,
        duplicateOfLine,
      };
    }
    firstInputLineByEmail.set(emailKey, account.line);

    return classifyExistingDuplicate({
      providerId,
      account,
      existingConnections: existingByEmail.get(emailKey) || [],
    }) || { status: "queued" };
  });
}
