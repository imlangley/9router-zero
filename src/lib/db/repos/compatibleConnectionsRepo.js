import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_COMPATIBLE_CONNECTION_LIMIT = 100;
const DUPLICATE_NAME_ERROR = "Connection name already exists for this compatible provider node";
const CUSTOM_EMBEDDING_SINGLE_CONNECTION_ERROR = "Only one connection is allowed for this Custom Embedding node";

const EXTRA_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

function limitError(limit) {
  return `Compatible provider nodes support up to ${limit} API key connections`;
}

function connectionToRow(connection) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = connection;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function insertConnection(db, connection) {
  const row = connectionToRow(connection);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.provider, row.authType, row.name, row.email, row.priority, row.isActive, row.data, row.createdAt, row.updatedAt]
  );
}

function reorderInTx(db, providerId) {
  const rows = db.all(
    `SELECT id FROM providerConnections WHERE provider = ? ORDER BY COALESCE(priority, 0) ASC, updatedAt DESC`,
    [providerId]
  );
  rows.forEach((row, index) => {
    db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [index + 1, row.id]);
  });
}

export async function createCompatibleProviderConnection(data, options = {}) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const limit = options.limit || DEFAULT_COMPATIBLE_CONNECTION_LIMIT;
  let result;

  db.transaction(() => {
    const duplicate = db.get(
      `SELECT id FROM providerConnections WHERE provider = ? AND authType = 'apikey' AND name = ?`,
      [data.provider, data.name]
    );
    if (duplicate) {
      result = { error: DUPLICATE_NAME_ERROR };
      return;
    }

    const countRow = db.get(
      `SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ? AND authType = 'apikey'`,
      [data.provider]
    );
    const apiKeyCount = Number(countRow?.n || 0);
    if (apiKeyCount >= limit) {
      result = { error: limitError(limit) };
      return;
    }

    const maxPriorityRow = db.get(
      `SELECT COALESCE(MAX(priority), 0) AS n FROM providerConnections WHERE provider = ?`,
      [data.provider]
    );
    const connection = {
      id: uuidv4(),
      provider: data.provider,
      authType: "apikey",
      name: data.name || `Key ${apiKeyCount + 1}`,
      priority: data.priority || Number(maxPriorityRow?.n || 0) + 1,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };

    for (const field of EXTRA_FIELDS) {
      if (data[field] !== undefined && data[field] !== null) connection[field] = data[field];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      connection.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) connection.email = data.email;

    insertConnection(db, connection);
    reorderInTx(db, data.provider);
    result = { connection };
  });

  return result;
}

export async function createCustomEmbeddingProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    const existing = db.get(
      `SELECT id FROM providerConnections WHERE provider = ? AND authType = 'apikey'`,
      [data.provider]
    );
    if (existing) {
      result = { error: CUSTOM_EMBEDDING_SINGLE_CONNECTION_ERROR };
      return;
    }

    const connection = {
      id: uuidv4(),
      provider: data.provider,
      authType: "apikey",
      name: data.name || "Key 1",
      priority: data.priority || 1,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };

    for (const field of EXTRA_FIELDS) {
      if (data[field] !== undefined && data[field] !== null) connection[field] = data[field];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      connection.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) connection.email = data.email;

    insertConnection(db, connection);
    reorderInTx(db, data.provider);
    result = { connection };
  });

  return result;
}
