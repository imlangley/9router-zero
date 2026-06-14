import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  __test__,
  KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY,
  KIRO_BULK_IMPORT_MAX_CONCURRENCY,
  KIRO_BULK_IMPORT_MIN_CONCURRENCY,
  KiroBulkImportManager,
  createFreshContext,
} from "../../src/lib/oauth/services/kiroBulkImportManager.js";
import { getProviderConnections } from "../../src/models/index.js";

vi.mock("../../src/models/index.js", () => ({
  getProviderConnections: vi.fn(async () => []),
  getProxyPools: vi.fn(async () => []),
}));

function createFakeBrowser() {
  const contextOptions = [];
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
    contextOptions,
    async newContext(options = {}) {
      contextOptions.push(options);
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

describe("kiro bulk import manager helpers", () => {
  it("parses gmail|password lines and reports invalid lines", () => {
    const { parsed, invalidLines } = __test__.parseKiroBulkAccounts([
      "user1@gmail.com|pw1",
      "broken-line",
      "user2@gmail.com|pw2",
      "",
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].email).toBe("user1@gmail.com");
    expect(parsed[1].password).toBe("pw2");
    expect(invalidLines).toEqual([2]);
  });

  it("clamps concurrency to configured min/max with default fallback", () => {
    expect(__test__.clampConcurrency(undefined)).toBe(KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY);
    expect(__test__.clampConcurrency("0")).toBe(KIRO_BULK_IMPORT_MIN_CONCURRENCY);
    expect(__test__.clampConcurrency("999")).toBe(KIRO_BULK_IMPORT_MAX_CONCURRENCY);
    expect(__test__.clampConcurrency("3")).toBe(3);
  });
});

describe("KiroBulkImportManager", () => {
  beforeEach(() => {
    getProviderConnections.mockResolvedValue([]);
  });

  it("processes accounts once and completes with saved connections", async () => {
    const processed = [];
    const manager = new KiroBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      kiroServiceFactory: () => ({
        createSocialAuthorization() {
          return {
            authUrl: "https://example.com",
            codeVerifier: "verifier",
          };
        },
      }),
      googleAutomation: async ({ email }) => {
        processed.push(email);
        return {
          status: "success",
          code: `code-${email}`,
        };
      },
      socialExchange: async ({ code }) => ({
        connection: {
          id: `conn-${code}`,
        },
      }),
    });

    const startedJob = await manager.startJob({
      accounts: [
        "user1@gmail.com|pw1",
        "user2@gmail.com|pw2",
      ],
      concurrency: 4,
    });

    const finishedJob = await waitFor(() => {
      const job = manager.getJob(startedJob.jobId);
      return job && job.status === "completed" ? job : null;
    });

    expect(processed.sort()).toEqual(["user1@gmail.com", "user2@gmail.com"]);
    expect(finishedJob.summary.success).toBe(2);
    expect(finishedJob.summary.failed).toBe(0);
    expect(finishedJob.accounts.every((account) => account.connectionId)).toBe(true);
  });

  it("cancels queued work and marks the job cancelled", async () => {
    const manager = new KiroBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      kiroServiceFactory: () => ({
        createSocialAuthorization() {
          return {
            authUrl: "https://example.com",
            codeVerifier: "verifier",
          };
        },
      }),
      googleAutomation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          status: "success",
          code: "code",
        };
      },
      socialExchange: async () => ({
        connection: { id: "conn-1" },
      }),
    });

    const startedJob = await manager.startJob({
      accounts: [
        "user1@gmail.com|pw1",
        "user2@gmail.com|pw2",
        "user3@gmail.com|pw3",
      ],
      concurrency: 1,
    });

    manager.cancelJob(startedJob.jobId);

    const finishedJob = await waitFor(() => {
      const job = manager.getJob(startedJob.jobId);
      return job && job.status === "cancelled" ? job : null;
    });

    expect(finishedJob.status).toBe("cancelled");
    expect(
      finishedJob.accounts.some((account) => account.status === "cancelled")
    ).toBe(true);
  });

  it("opens a manual session for a blocked worker", async () => {
    const manager = new KiroBulkImportManager();
    const manualPage = {
      bringToFront: async () => null,
      context() {
        return {};
      },
    };

    manager.jobs.set("job-manual", {
      jobId: "job-manual",
      status: "running",
      concurrency: 1,
      createdAt: "2026-06-08T00:00:00.000Z",
      startedAt: "2026-06-08T00:00:01.000Z",
      finishedAt: null,
      error: null,
      accounts: [{
        line: 1,
        email: "user@gmail.com",
        status: "needs_manual",
        error: "Manual assist required",
        connectionId: null,
        workerId: 1,
        manualSession: {
          page: manualPage,
          opened: false,
          openedAt: null,
        },
      }],
    });

    const result = await manager.openManualSession("job-manual", 1);

    expect(result.ok).toBe(true);
    expect(result.account.manualSessionAvailable).toBe(true);
    expect(result.account.manualSessionOpened).toBe(true);
  });

  it("passes selected automation proxy config into browser contexts", async () => {
    const fakeBrowser = createFakeBrowser();
    const { context } = await createFreshContext(fakeBrowser, {
      id: "proxy-1",
      name: "Test proxy",
      proxy: {
        server: "http://127.0.0.1:8080/",
        username: "user",
        password: "pass",
      },
    });

    expect(fakeBrowser.contextOptions[0]).toEqual({
      proxy: {
        server: "http://127.0.0.1:8080/",
        username: "user",
        password: "pass",
      },
    });
    await context.close();
  });

  it("completes immediately without launching a browser when every account is skipped", async () => {
    const browserLauncher = vi.fn(async () => createFakeBrowser());
    getProviderConnections.mockResolvedValue([
      {
        id: "kiro-existing-1",
        provider: "kiro",
        authType: "oauth",
        email: "existing@gmail.com",
        name: "Existing Kiro",
      },
    ]);

    const manager = new KiroBulkImportManager({ browserLauncher });
    const startedJob = await manager.startJob({
      accounts: [
        " Existing@Gmail.com |pw1",
        "existing@gmail.com|pw2",
      ],
      concurrency: 4,
    });

    expect(startedJob.status).toBe("completed");
    expect(startedJob.summary.skipped).toBe(2);
    expect(startedJob.summary.skipped_duplicate).toBe(1);
    expect(startedJob.summary.skipped_duplicate_input).toBe(1);
    expect(startedJob.accounts.map((account) => account.status)).toEqual([
      "skipped_duplicate",
      "skipped_duplicate_input",
    ]);
    expect(startedJob.accounts.every((account) => account.logs.length > 0)).toBe(true);
    expect(browserLauncher).not.toHaveBeenCalled();
  });

  it("launches workers only for queued accounts when duplicates are preflight-skipped", async () => {
    const processed = [];
    getProviderConnections.mockResolvedValue([
      {
        id: "kiro-existing-1",
        provider: "kiro",
        authType: "oauth",
        email: "existing@gmail.com",
        name: "Existing Kiro",
      },
    ]);

    const manager = new KiroBulkImportManager({
      browserLauncher: async () => createFakeBrowser(),
      kiroServiceFactory: () => ({
        createSocialAuthorization() {
          return {
            authUrl: "https://example.com",
            codeVerifier: "verifier",
          };
        },
      }),
      googleAutomation: async ({ email }) => {
        processed.push(email);
        return {
          status: "success",
          code: `code-${email}`,
        };
      },
      socialExchange: async ({ code }) => ({
        connection: {
          id: `conn-${code}`,
        },
      }),
    });

    const startedJob = await manager.startJob({
      accounts: [
        "existing@gmail.com|pw1",
        "new@gmail.com|pw2",
        "NEW@gmail.com|pw3",
      ],
      concurrency: 4,
    });

    const finishedJob = await waitFor(() => {
      const job = manager.getJob(startedJob.jobId);
      return job && job.status === "completed" ? job : null;
    });

    expect(processed).toEqual(["new@gmail.com"]);
    expect(finishedJob.summary.success).toBe(1);
    expect(finishedJob.summary.skipped).toBe(2);
    expect(finishedJob.accounts.map((account) => account.status)).toEqual([
      "skipped_duplicate",
      "success",
      "skipped_duplicate_input",
    ]);
  });

  it("restores only active latest jobs by default", async () => {
    const manager = new KiroBulkImportManager();

    manager.latestJobId = "job-terminal";
    manager.jobs.set("job-terminal", {
      jobId: "job-terminal",
      status: "failed",
      concurrency: 1,
      createdAt: "2026-06-08T00:00:00.000Z",
      startedAt: "2026-06-08T00:00:01.000Z",
      finishedAt: new Date().toISOString(),
      error: "failed",
      lastPreview: null,
      lastPreviewCapturedAt: 0,
      accounts: [],
      persistPromise: Promise.resolve(),
    });

    const activeOnly = await manager.getLatestJobWithPreview();
    const withRecentTerminal = await manager.getLatestJobWithPreview({ includeRecentTerminal: true });

    expect(activeOnly).toBeNull();
    expect(withRecentTerminal?.jobId).toBe("job-terminal");
  });
});
