import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBuddyBulkImportManager } from "../../src/lib/oauth/services/codebuddyBulkImportManager.js";
import { getProviderConnections } from "../../src/models/index.js";

vi.mock("../../src/models/index.js", () => ({
  getProviderConnections: vi.fn(async () => []),
  getProxyPools: vi.fn(async () => []),
}));

function createFakeBrowser() {
  const fakePage = {
    on() {},
    off() {},
    url() {
      return "about:blank";
    },
    bringToFront: async () => null,
    context() {
      return {};
    },
  };

  return {
    async newContext() {
      return {
        async newPage() {
          return fakePage;
        },
        on() {},
        off() {},
        async close() {
          return null;
        },
      };
    },
    async close() {
      return null;
    },
  };
}

async function waitFor(fn, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

describe("CodeBuddyBulkImportManager", () => {
  beforeEach(() => {
    getProviderConnections.mockResolvedValue([]);
  });

  it("runs bulk GSuite accounts through CodeBuddy polling and saves connections", async () => {
    const saved = [];
    const manager = new CodeBuddyBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({
        device_code: "state-1",
        verification_uri: "https://copilot.tencent.com/login",
      }),
      pollToken: async () => ({
        success: true,
        tokens: {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresIn: 86400,
        },
      }),
      saveConnection: async ({ tokens, email }) => {
        saved.push({ tokens, email });
        return {
          connection: { id: `conn-${email}` },
        };
      },
      googleAutomation: async ({ successPromise }) => ({
        status: "success",
        ...(await successPromise),
      }),
    });

    const startedJob = await manager.startJob({
      accounts: [
        "user1@example.com|pw1",
        "user2@example.com|pw2",
      ],
      concurrency: 2,
    });

    const finishedJob = await waitFor(() => {
      const job = manager.getJob(startedJob.jobId);
      return job && job.status === "completed" ? job : null;
    });

    expect(finishedJob.summary.success).toBe(2);
    expect(saved.map((entry) => entry.email).sort()).toEqual([
      "user1@example.com",
      "user2@example.com",
    ]);
    expect(finishedJob.accounts.every((account) => account.connectionId)).toBe(true);
  });

  it("retries transient CodeBuddy token request failures before saving", async () => {
    let attempts = 0;
    const manager = new CodeBuddyBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({
        device_code: "state-1",
        verification_uri: "https://www.codebuddy.ai/login?platform=CLI&state=state-1",
      }),
      pollToken: async () => {
        attempts += 1;
        if (attempts < 3) {
          return {
            success: false,
            error: "request_failed",
            errorDescription: "temporary 502",
          };
        }
        return {
          success: true,
          tokens: {
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresIn: 86400,
          },
        };
      },
      saveConnection: async ({ email }) => ({
        connection: { id: `conn-${email}` },
      }),
      pollIntervalMs: 10,
      googleAutomation: async ({ successPromise }) => ({
        status: "success",
        ...(await successPromise),
      }),
    });

    const startedJob = await manager.startJob({
      accounts: ["user1@example.com|pw1"],
      concurrency: 1,
    });

    const finishedJob = await waitFor(() => {
      const job = manager.getJob(startedJob.jobId);
      return job && job.status === "completed" ? job : null;
    });

    expect(attempts).toBe(3);
    expect(finishedJob.summary.success).toBe(1);
  });

  it("skips existing CodeBuddy OAuth connections before launching a browser", async () => {
    const browserLauncher = vi.fn(async () => createFakeBrowser());
    getProviderConnections.mockResolvedValue([
      {
        id: "codebuddy-oauth-1",
        provider: "codebuddy",
        authType: "oauth",
        email: "existing@example.com",
        name: "Existing CodeBuddy",
      },
    ]);

    const manager = new CodeBuddyBulkImportManager({ browserLauncher });
    const startedJob = await manager.startJob({
      accounts: [" existing@example.com |pw1"],
      concurrency: 2,
      generateApiKeys: true,
    });

    expect(startedJob.status).toBe("completed");
    expect(startedJob.summary.skipped_duplicate).toBe(1);
    expect(startedJob.accounts[0].status).toBe("skipped_duplicate");
    expect(browserLauncher).not.toHaveBeenCalled();
  });

  it("flags emails that already own 9Router-generated CodeBuddy keys as duplicates before any worker runs", async () => {
    const browserLauncher = vi.fn(async () => createFakeBrowser());
    getProviderConnections.mockResolvedValue([
      {
        id: "old-api-conn-1",
        provider: "codebuddy",
        authType: "apikey",
        email: "replace@example.com",
        name: "9r-replace-old",
        apiKey: "ck_old_secret",
        providerSpecificData: {
          credentialKind: "codebuddy_api_key",
          automation: "apikey-generated",
          apiKeyId: "ck_old_key",
          apiKeyName: "9r-replace-old",
          loginEmail: "replace@example.com",
        },
      },
    ]);

    const manager = new CodeBuddyBulkImportManager({ browserLauncher });
    const startedJob = await manager.startJob({
      accounts: [" replace@example.com |pw1"],
      concurrency: 2,
      generateApiKeys: true,
    });

    expect(startedJob.status).toBe("completed");
    expect(startedJob.summary.skipped_duplicate).toBe(1);
    expect(startedJob.accounts[0].status).toBe("skipped_duplicate");
    expect(browserLauncher).not.toHaveBeenCalled();
  });
});
