import { beforeEach, describe, expect, it, vi } from "vitest";
import { QoderBulkImportManager } from "../../src/lib/oauth/services/qoderBulkImportManager.js";
import { getProviderConnections, getProxyPools } from "../../src/models/index.js";

vi.mock("../../src/models/index.js", () => ({
  getProviderConnections: vi.fn(async () => []),
  getProxyPools: vi.fn(async () => []),
}));

function createFakeBrowser({ contexts = [] } = {}) {
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
    async newContext(options = {}) {
      const context = {
        options,
        async newPage() {
          return fakePage;
        },
        on() {},
        off() {},
        async close() {
          return null;
        },
      };
      contexts.push(context);
      return context;
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

describe("QoderBulkImportManager", () => {
  beforeEach(() => {
    getProviderConnections.mockResolvedValue([]);
    getProxyPools.mockResolvedValue([]);
  });

  it("runs bulk Google accounts through Qoder device polling and saves connections", async () => {
    const saved = [];
    const manager = new QoderBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({
        device_code: "nonce-1",
        codeVerifier: "verifier-1",
        verification_uri_complete: "https://qoder.com/device/selectAccounts?nonce=nonce-1",
        _qoderNonce: "nonce-1",
        _qoderMachineId: "machine-1",
      }),
      pollToken: async (_providerId, deviceCode, codeVerifier, extraData) => ({
        success: true,
        tokens: {
          accessToken: `dt-${deviceCode}`,
          refreshToken: "refresh-1",
          expiresIn: 86400,
          providerSpecificData: {
            authMethod: "device",
            userId: "qoder-user-1",
            machineId: extraData._qoderMachineId,
            verifierSeen: codeVerifier,
          },
        },
      }),
      saveConnection: async ({ tokens }) => {
        saved.push(tokens);
        return {
          connection: { id: `conn-${saved.length}` },
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
    expect(saved).toHaveLength(2);
    expect(saved.every((tokens) => tokens.accessToken === "dt-nonce-1")).toBe(true);
    expect(saved.every((tokens) => tokens.providerSpecificData.machineId === "machine-1")).toBe(true);
    expect(finishedJob.accounts.every((account) => account.connectionId)).toBe(true);
  });

  it("retries transient Qoder poll failures before saving", async () => {
    let attempts = 0;
    const manager = new QoderBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({
        device_code: "nonce-1",
        codeVerifier: "verifier-1",
        verification_uri_complete: "https://qoder.com/device/selectAccounts?nonce=nonce-1",
        _qoderNonce: "nonce-1",
        _qoderMachineId: "machine-1",
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
            accessToken: "dt-token",
            expiresIn: 86400,
          },
        };
      },
      saveConnection: async () => ({ connection: { id: "conn-1" } }),
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

  it("passes the selected HTTP proxy to Qoder token polling", async () => {
    const extraDataSeen = [];
    const manager = new QoderBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      requestDeviceCodeFn: async () => ({
        device_code: "nonce-1",
        codeVerifier: "verifier-1",
        verification_uri_complete: "https://qoder.com/device/selectAccounts?nonce=nonce-1",
        _qoderNonce: "nonce-1",
        _qoderMachineId: "machine-1",
      }),
      pollToken: async (_providerId, _deviceCode, _codeVerifier, extraData) => {
        extraDataSeen.push(extraData);
        return {
          success: true,
          tokens: {
            accessToken: "dt-token",
            expiresIn: 86400,
          },
        };
      },
      saveConnection: async () => ({ connection: { id: "conn-1" } }),
      googleAutomation: async ({ successPromise }) => ({
        status: "success",
        ...(await successPromise),
      }),
    });

    getProxyPools.mockResolvedValue([
      {
        id: "proxy-1",
        name: "Residential 1",
        type: "http",
        isActive: true,
        proxyUrl: "http://user:pass@proxy.example:8080",
      },
    ]);

    const startedJob = await manager.startJob({
      accounts: ["user1@example.com|pw1"],
      concurrency: 1,
      automationProxy: { mode: "selected", proxyPoolId: "proxy-1" },
    });

    const finishedJob = await waitFor(() => {
      const snapshot = manager.getJob(startedJob.jobId);
      return snapshot && snapshot.status === "completed" ? snapshot : null;
    });

    expect(finishedJob.summary.success).toBe(1);
    expect(extraDataSeen[0]._qoderProxyUrl).toBe("http://user:pass@proxy.example:8080/");
  });

  it("keeps a timed-out poll promise handled when browser automation fails first", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const manager = new QoderBulkImportManager({
        browserLauncher: async () => createFakeBrowser(),
        requestDeviceCodeFn: async () => ({
          device_code: "nonce-1",
          codeVerifier: "verifier-1",
          verification_uri_complete: "https://qoder.com/device/selectAccounts?nonce=nonce-1",
          _qoderNonce: "nonce-1",
          _qoderMachineId: "machine-1",
        }),
        pollToken: async () => ({
          success: false,
          pending: true,
          error: "authorization_pending",
        }),
        pollIntervalMs: 10,
        googleAutomation: async () => ({
          status: "failed_timeout",
          error: "Browser flow timed out first",
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

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(finishedJob.summary.failed).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("skips existing Qoder OAuth connections before launching a browser", async () => {
    const browserLauncher = vi.fn(async () => createFakeBrowser());
    getProviderConnections.mockResolvedValue([
      {
        id: "qoder-oauth-1",
        provider: "qoder",
        authType: "oauth",
        email: "existing@example.com",
        name: "Existing Qoder",
      },
    ]);

    const manager = new QoderBulkImportManager({ browserLauncher });
    const startedJob = await manager.startJob({
      accounts: [" existing@example.com |pw1"],
      concurrency: 2,
    });

    expect(startedJob.status).toBe("completed");
    expect(startedJob.summary.skipped_duplicate).toBe(1);
    expect(startedJob.accounts[0].status).toBe("skipped_duplicate");
    expect(browserLauncher).not.toHaveBeenCalled();
  });
});
