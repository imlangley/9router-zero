import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupTestContext(nodeData) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compatible-provider-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const { GET, POST } = await import("@/app/api/providers/route.js");
  const {
    createProviderNode,
    getProviderConnections,
  } = await import("@/models/index.js");

  const node = await createProviderNode(nodeData);

  return {
    node,
    GET,
    POST,
    getProviderConnections,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

async function setupProviderNodeRouteTestContext() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-provider-node-route-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const { POST } = await import("@/app/api/provider-nodes/route.js");
  const { PUT } = await import("@/app/api/provider-nodes/[id]/route.js");
  const { getProviderNodeById } = await import("@/models/index.js");

  return {
    POST,
    PUT,
    getProviderNodeById,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function makeRequest(provider, overrides = {}) {
  return new Request("https://9router.local/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      apiKey: "test-key",
      name: "Test Connection",
      defaultModel: "test-model",
      ...overrides,
    }),
  });
}

function expectCompatibleConnection(connection, node, { apiType } = {}) {
  expect(connection.provider).toBe(node.id);
  expect(connection.authType).toBe("apikey");
  expect(connection.defaultModel).toBe("test-model");
  expect(connection.providerSpecificData).toMatchObject({
    prefix: node.prefix,
    baseUrl: node.baseUrl,
    nodeName: node.name,
  });

  if (apiType !== undefined) {
    expect(connection.providerSpecificData.apiType).toBe(apiType);
  }
}

describe("compatible provider connections API", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("creates one API-key connection for an OpenAI-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-test",
      type: "openai-compatible",
      name: "OpenAI Compatible Test Node",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://openai-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node, { apiType: "chat" });
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        apiType: "chat",
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  it("creates one API-key connection for an Anthropic-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "anthropic-compatible-test",
      type: "anthropic-compatible",
      name: "Anthropic Compatible Test Node",
      prefix: "act",
      baseUrl: "https://anthropic-compatible.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id));
    const body = await response.json();
    const connection = body.connection;
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(201);
    expect(storedConnections).toHaveLength(1);
    expectCompatibleConnection(connection, ctx.node);
    expect(storedConnections[0]).toMatchObject({
      provider: ctx.node.id,
      authType: "apikey",
      defaultModel: "test-model",
      providerSpecificData: {
        prefix: ctx.node.prefix,
        baseUrl: ctx.node.baseUrl,
        nodeName: ctx.node.name,
      },
    });
  });

  it("creates multiple API-key connections for an OpenAI-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-multi-key-test",
      type: "openai-compatible",
      name: "Multi Key Node",
      prefix: "multi",
      apiType: "chat",
      baseUrl: "https://multi-key.test/v1",
    });
    cleanup = ctx.cleanup;

    const firstResponse = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "test-key-1",
      name: "Key One",
    }));
    const secondResponse = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "test-key-2",
      name: "Key Two",
    }));
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(storedConnections).toHaveLength(2);
    expect(storedConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Key One", apiKey: "test-key-1" }),
      expect.objectContaining({ name: "Key Two", apiKey: "test-key-2" }),
    ]));
    expectCompatibleConnection(storedConnections[0], ctx.node, { apiType: "chat" });
    expectCompatibleConnection(storedConnections[1], ctx.node, { apiType: "chat" });
  });

  it("rejects duplicate compatible API-key connection names without overwriting the existing key", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-duplicate-name-test",
      type: "openai-compatible",
      name: "Duplicate Name Node",
      prefix: "dupname",
      apiType: "chat",
      baseUrl: "https://duplicate-name.test/v1",
    });
    cleanup = ctx.cleanup;

    const firstResponse = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "original-key",
      name: "Shared Name",
      defaultModel: "original-model",
    }));
    const secondResponse = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "replacement-key",
      name: "Shared Name",
      defaultModel: "replacement-model",
    }));
    const body = await secondResponse.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(400);
    expect(body.error).toBe("Connection name already exists for this compatible provider node");
    expect(storedConnections).toHaveLength(1);
    expect(storedConnections[0]).toMatchObject({
      name: "Shared Name",
      apiKey: "original-key",
      defaultModel: "original-model",
    });
  });

  it("allows only one concurrent compatible API-key connection with the same name", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-concurrent-duplicate-test",
      type: "openai-compatible",
      name: "Concurrent Duplicate Node",
      prefix: "condup",
      apiType: "chat",
      baseUrl: "https://concurrent-duplicate.test/v1",
    });
    cleanup = ctx.cleanup;

    const responses = await Promise.all([
      ctx.POST(makeRequest(ctx.node.id, {
        apiKey: "concurrent-key-1",
        name: "Shared Concurrent Name",
      })),
      ctx.POST(makeRequest(ctx.node.id, {
        apiKey: "concurrent-key-2",
        name: "Shared Concurrent Name",
      })),
    ]);
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    const failedResponse = responses.find((response) => response.status === 400);
    const body = await failedResponse.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(statuses).toEqual([201, 400]);
    expect(body.error).toBe("Connection name already exists for this compatible provider node");
    expect(storedConnections).toHaveLength(1);
    expect(storedConnections[0].name).toBe("Shared Concurrent Name");
    expect(["concurrent-key-1", "concurrent-key-2"]).toContain(storedConnections[0].apiKey);
  });

  it("creates multiple API-key connections for an Anthropic-compatible node", async () => {
    const ctx = await setupTestContext({
      id: "anthropic-compatible-multi-key-test",
      type: "anthropic-compatible",
      name: "Anthropic Multi Key Node",
      prefix: "anthropic-multi",
      baseUrl: "https://anthropic-multi-key.test/v1",
    });
    cleanup = ctx.cleanup;

    const firstResponse = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "anthropic-test-key-1",
      name: "Anthropic Key One",
    }));
    const secondResponse = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "anthropic-test-key-2",
      name: "Anthropic Key Two",
    }));
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(storedConnections).toHaveLength(2);
    expect(storedConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Anthropic Key One", apiKey: "anthropic-test-key-1" }),
      expect.objectContaining({ name: "Anthropic Key Two", apiKey: "anthropic-test-key-2" }),
    ]));
    expectCompatibleConnection(storedConnections[0], ctx.node);
    expectCompatibleConnection(storedConnections[1], ctx.node);
  });

  it("rejects OpenAI-compatible API-key connections without a default model", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-default-model-test",
      type: "openai-compatible",
      name: "Default Model Node",
      prefix: "dm",
      apiType: "chat",
      baseUrl: "https://default-model.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id, {
      defaultModel: " ",
    }));
    const body = await response.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(400);
    expect(body.error).toBe("Default model is required for OpenAI Compatible nodes");
    expect(storedConnections).toHaveLength(0);
  });

  it("rejects Anthropic-compatible API-key connections without a default model", async () => {
    const ctx = await setupTestContext({
      id: "anthropic-compatible-default-model-test",
      type: "anthropic-compatible",
      name: "Anthropic Default Model Node",
      prefix: "adm",
      baseUrl: "https://anthropic-default-model.test/v1",
    });
    cleanup = ctx.cleanup;

    const response = await ctx.POST(makeRequest(ctx.node.id, {
      defaultModel: " ",
    }));
    const body = await response.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(400);
    expect(body.error).toBe("Default model is required for Anthropic Compatible nodes");
    expect(storedConnections).toHaveLength(0);
  });

  it("rejects compatible API-key connections after the server-side limit", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-limit-test",
      type: "openai-compatible",
      name: "Limited Node",
      prefix: "limit",
      apiType: "chat",
      baseUrl: "https://limit.test/v1",
    });
    cleanup = ctx.cleanup;

    for (let index = 1; index <= 100; index += 1) {
      const response = await ctx.POST(makeRequest(ctx.node.id, {
        apiKey: `test-key-${index}`,
        name: `Key ${index}`,
        priority: index,
      }));
      expect(response.status).toBe(201);
    }

    const response = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "test-key-101",
      name: "Key 101",
      priority: 101,
    }));
    const body = await response.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(400);
    expect(body.error).toBe("Compatible provider nodes support up to 100 API key connections");
    expect(storedConnections).toHaveLength(100);
  });

  it("allows only one concurrent compatible API-key connection at the limit boundary", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-concurrent-limit-test",
      type: "openai-compatible",
      name: "Concurrent Limit Node",
      prefix: "conlimit",
      apiType: "chat",
      baseUrl: "https://concurrent-limit.test/v1",
    });
    cleanup = ctx.cleanup;

    for (let index = 1; index <= 99; index += 1) {
      const response = await ctx.POST(makeRequest(ctx.node.id, {
        apiKey: `preloaded-key-${index}`,
        name: `Preloaded Key ${index}`,
        priority: index,
      }));
      expect(response.status).toBe(201);
    }

    const responses = await Promise.all([
      ctx.POST(makeRequest(ctx.node.id, {
        apiKey: "boundary-key-100",
        name: "Boundary Key 100",
        priority: 100,
      })),
      ctx.POST(makeRequest(ctx.node.id, {
        apiKey: "boundary-key-101",
        name: "Boundary Key 101",
        priority: 101,
      })),
    ]);
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    const failedResponse = responses.find((response) => response.status === 400);
    const body = await failedResponse.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(statuses).toEqual([201, 400]);
    expect(body.error).toBe("Compatible provider nodes support up to 100 API key connections");
    expect(storedConnections).toHaveLength(100);
  });

  it("rejects Anthropic-compatible API-key connections after the server-side limit", async () => {
    const ctx = await setupTestContext({
      id: "anthropic-compatible-limit-test",
      type: "anthropic-compatible",
      name: "Anthropic Limited Node",
      prefix: "anthropic-limit",
      baseUrl: "https://anthropic-limit.test/v1",
    });
    cleanup = ctx.cleanup;

    for (let index = 1; index <= 100; index += 1) {
      const response = await ctx.POST(makeRequest(ctx.node.id, {
        apiKey: `anthropic-test-key-${index}`,
        name: `Anthropic Key ${index}`,
        priority: index,
      }));
      expect(response.status).toBe(201);
    }

    const response = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "anthropic-test-key-101",
      name: "Anthropic Key 101",
      priority: 101,
    }));
    const body = await response.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(response.status).toBe(400);
    expect(body.error).toBe("Compatible provider nodes support up to 100 API key connections");
    expect(storedConnections).toHaveLength(100);
  });

  it("keeps Custom Embedding nodes limited to one API-key connection", async () => {
    const ctx = await setupTestContext({
      id: "custom-embedding-single-connection-test",
      type: "custom-embedding",
      name: "Custom Embedding Node",
      prefix: "embed",
      baseUrl: "https://custom-embedding.test/v1",
    });
    cleanup = ctx.cleanup;

    const firstResponse = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "embedding-key-1",
      name: "Embedding Key One",
    }));
    const secondResponse = await ctx.POST(makeRequest(ctx.node.id, {
      apiKey: "embedding-key-2",
      name: "Embedding Key Two",
    }));
    const body = await secondResponse.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(400);
    expect(body.error).toBe("Only one connection is allowed for this Custom Embedding node");
    expect(storedConnections).toHaveLength(1);
    expect(storedConnections[0]).toMatchObject({
      name: "Embedding Key One",
      apiKey: "embedding-key-1",
    });
  });

  it("allows only one concurrent Custom Embedding API-key connection", async () => {
    const ctx = await setupTestContext({
      id: "custom-embedding-concurrent-single-connection-test",
      type: "custom-embedding",
      name: "Concurrent Custom Embedding Node",
      prefix: "embed-concurrent",
      baseUrl: "https://custom-embedding-concurrent.test/v1",
    });
    cleanup = ctx.cleanup;

    const responses = await Promise.all([
      ctx.POST(makeRequest(ctx.node.id, {
        apiKey: "embedding-concurrent-key-1",
        name: "Embedding Concurrent Key One",
      })),
      ctx.POST(makeRequest(ctx.node.id, {
        apiKey: "embedding-concurrent-key-2",
        name: "Embedding Concurrent Key Two",
      })),
    ]);
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    const failedResponse = responses.find((response) => response.status === 400);
    const body = await failedResponse.json();
    const storedConnections = await ctx.getProviderConnections({ provider: ctx.node.id });

    expect(statuses).toEqual([201, 400]);
    expect(body.error).toBe("Only one connection is allowed for this Custom Embedding node");
    expect(storedConnections).toHaveLength(1);
    expect(["embedding-concurrent-key-1", "embedding-concurrent-key-2"]).toContain(storedConnections[0].apiKey);
  });

  it("redacts nested provider-specific credentials from provider list responses", async () => {
    const ctx = await setupTestContext({
      id: "openai-compatible-redaction-context",
      type: "openai-compatible",
      name: "Redaction Context Node",
      prefix: "redactctx",
      apiType: "chat",
      baseUrl: "https://redaction-context.test/v1",
    });
    cleanup = ctx.cleanup;

    const createResponse = await ctx.POST(makeRequest("openai", {
      apiKey: "top-level-secret-key",
      accessToken: "top-level-access-token",
      refreshToken: "top-level-refresh-token",
      idToken: "top-level-id-token",
      name: "Nested Secret Connection",
      providerSpecificData: {
        safeBaseUrl: "https://safe.example/v1",
        apiKey: "nested-api-key",
        accessToken: "nested-access-token",
        refreshToken: "nested-refresh-token",
        idToken: "nested-id-token",
        nested: {
          apiKey: "deep-api-key",
          accessToken: "deep-access-token",
          refreshToken: "deep-refresh-token",
          idToken: "deep-id-token",
          safeValue: "kept",
        },
        tokens: [
          { apiKey: "array-api-key", safeValue: "array-kept" },
        ],
      },
    }));
    const listResponse = await ctx.GET();
    const listBody = await listResponse.json();
    const connection = listBody.connections.find((item) => item.name === "Nested Secret Connection");

    expect(createResponse.status).toBe(201);
    expect(listResponse.status).toBe(200);
    expect(connection).toBeTruthy();
    expect(connection).not.toHaveProperty("apiKey");
    expect(connection).not.toHaveProperty("accessToken");
    expect(connection).not.toHaveProperty("refreshToken");
    expect(connection).not.toHaveProperty("idToken");
    expect(connection.providerSpecificData).toMatchObject({
      safeBaseUrl: "https://safe.example/v1",
      nested: { safeValue: "kept" },
      tokens: [{ safeValue: "array-kept" }],
    });
    expect(connection.providerSpecificData).not.toHaveProperty("apiKey");
    expect(connection.providerSpecificData).not.toHaveProperty("accessToken");
    expect(connection.providerSpecificData).not.toHaveProperty("refreshToken");
    expect(connection.providerSpecificData).not.toHaveProperty("idToken");
    expect(connection.providerSpecificData.nested).not.toHaveProperty("apiKey");
    expect(connection.providerSpecificData.nested).not.toHaveProperty("accessToken");
    expect(connection.providerSpecificData.nested).not.toHaveProperty("refreshToken");
    expect(connection.providerSpecificData.nested).not.toHaveProperty("idToken");
    expect(connection.providerSpecificData.tokens[0]).not.toHaveProperty("apiKey");
  });

  it("normalizes OpenAI-compatible full endpoint URLs on create", async () => {
    const ctx = await setupProviderNodeRouteTestContext();
    cleanup = ctx.cleanup;

    const createResponse = await ctx.POST(new Request("https://9router.local/api/provider-nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Endpoint Paste Node",
        prefix: "ep",
        apiType: "chat",
        type: "openai-compatible",
        baseUrl: "https://compatible.test/api/v1/chat/completions",
      }),
    }));
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created.node.baseUrl).toBe("https://compatible.test/api/v1");
    const storedNode = await ctx.getProviderNodeById(created.node.id);

    expect(storedNode.baseUrl).toBe("https://compatible.test/api/v1");

    const updateResponse = await ctx.PUT(new Request("https://9router.local/api/provider-nodes/test", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Endpoint Paste Node",
        prefix: "ep",
        apiType: "responses",
        baseUrl: "https://compatible.test/api/v1/responses",
      }),
    }), { params: Promise.resolve({ id: created.node.id }) });
    const updated = await updateResponse.json();

    expect(updateResponse.status).toBe(200);
    expect(updated.node.baseUrl).toBe("https://compatible.test/api/v1");
  });
});
