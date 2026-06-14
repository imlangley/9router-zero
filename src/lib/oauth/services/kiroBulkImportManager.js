import { randomUUID } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../dataDir.js";
import { KiroService } from "./kiro.js";
import { createKiroCallbackMonitor, runKiroGoogleAutomation } from "./kiroGoogleAutomation.js";
import { getSettings } from "../../localDb.js";
import { getProxyPools } from "../../../models/index.js";
import { classifyBulkAccountDuplicates, BULK_ACCOUNT_SKIP_STATUSES } from "./bulkAccountDuplicateDetection.js";

export const KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY = 4;
export const KIRO_BULK_IMPORT_MIN_CONCURRENCY = 1;
export const KIRO_BULK_IMPORT_MAX_CONCURRENCY = 8;

const TERMINAL_ACCOUNT_STATUSES = new Set([
  "success",
  "skipped_duplicate",
  "skipped_duplicate_input",
  "failed",
  "failed_invalid_credentials",
  "failed_exchange",
  "failed_timeout",
  "cancelled",
]);

const MAX_ACCOUNT_LOG_ENTRIES = 40;
const MAX_JOB_ACTIVITY_ENTRIES = 80;
const PREVIEW_CAPTURE_INTERVAL_MS = 1500;
const LARGE_JOB_PREVIEW_CAPTURE_INTERVAL_MS = 5000;
const HUGE_JOB_PREVIEW_CAPTURE_INTERVAL_MS = 8000;
const MIN_PERSIST_INTERVAL_MS = 500;
const RECENT_TERMINAL_JOB_WINDOW_MS = 30 * 60_000;
const KIRO_BULK_IMPORT_DIR = path.join(DATA_DIR, "kiro-bulk-import");
const KIRO_BULK_IMPORT_META_FILE = path.join(KIRO_BULK_IMPORT_DIR, "meta.json");
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "needs_manual"]);
const PLAYWRIGHT_PROXY_POOL_TYPES = new Set(["http", "https", "socks", "socks4", "socks5"]);
const PLAYWRIGHT_CACHE_DIR = path.join(DATA_DIR, "..", ".cache", "ms-playwright");
const PLAYWRIGHT_TMP_DIR = path.join(DATA_DIR, "..", ".cache", "tmp");
const PLAYWRIGHT_LIB_DIR = path.join(DATA_DIR, "..", ".playwright-libs");

function nowIso() {
  return new Date().toISOString();
}

function ensurePersistenceDir(dir = KIRO_BULK_IMPORT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

function getJobFile(jobId, dir = KIRO_BULK_IMPORT_DIR) {
  ensurePersistenceDir(dir);
  return path.join(dir, `${jobId}.json`);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  ensurePersistenceDir(path.dirname(filePath));
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempFile, filePath);
}

function readPersistedLatestJobId(metaFile = KIRO_BULK_IMPORT_META_FILE) {
  return readJsonFile(metaFile)?.latestJobId || null;
}

function writePersistedLatestJobId(jobId, metaFile = KIRO_BULK_IMPORT_META_FILE) {
  writeJsonFile(metaFile, {
    latestJobId: jobId || null,
    updatedAt: nowIso(),
  });
}

function clampConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY;
  return Math.min(KIRO_BULK_IMPORT_MAX_CONCURRENCY, Math.max(KIRO_BULK_IMPORT_MIN_CONCURRENCY, parsed));
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeProxyServer(proxyUrl) {
  const raw = normalizeString(proxyUrl);
  if (!raw) return "";
  try {
    new URL(raw);
    return raw;
  } catch {
    return `http://${raw}`;
  }
}

function toPlaywrightProxyConfig(proxyUrl) {
  const server = normalizeProxyServer(proxyUrl);
  if (!server) return null;

  try {
    const parsed = new URL(server);
    const username = decodeURIComponent(parsed.username || "");
    const password = decodeURIComponent(parsed.password || "");
    parsed.username = "";
    parsed.password = "";

    return {
      server: parsed.toString(),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch {
    return { server };
  }
}

function isPlaywrightProxyPool(pool) {
  if (!pool || pool.isActive !== true) return false;
  const proxyUrl = normalizeString(pool.proxyUrl);
  if (!proxyUrl) return false;
  const type = normalizeString(pool.type || "http").toLowerCase();
  return PLAYWRIGHT_PROXY_POOL_TYPES.has(type);
}

function normalizeAutomationProxySelection(selection = {}) {
  const mode = normalizeString(selection.mode || "active-round-robin");
  const proxyPoolId = normalizeString(selection.proxyPoolId);
  if (["none", "profile", "selected", "active-round-robin"].includes(mode)) {
    return { mode, proxyPoolId };
  }
  return { mode: "active-round-robin", proxyPoolId };
}

async function resolveAutomationProxyOptions(selection = {}) {
  const normalizedSelection = normalizeAutomationProxySelection(selection);

  if (normalizedSelection.mode === "none") {
    return { source: "none", proxyPools: [], fallbackProxy: null };
  }

  try {
    const pools = await getProxyPools({ isActive: true });
    const proxyPools = pools
      .filter(isPlaywrightProxyPool)
      .filter((pool) => normalizedSelection.mode !== "selected" || pool.id === normalizedSelection.proxyPoolId)
      .map((pool) => ({
        id: pool.id,
        name: pool.name || pool.id,
        proxy: toPlaywrightProxyConfig(pool.proxyUrl),
      }))
      .filter((pool) => pool.proxy?.server);

    if (proxyPools.length > 0 && normalizedSelection.mode !== "profile") {
      return {
        source: normalizedSelection.mode === "selected" ? "selected-proxy-pool" : "proxy-pool",
        proxyPools,
        fallbackProxy: null,
      };
    }
  } catch (error) {
    console.warn("[BulkImport] Failed to load proxy pools for OAuth automation:", error.message);
  }

  try {
    const settings = await getSettings();
    if (settings?.outboundProxyEnabled === true) {
      const proxy = toPlaywrightProxyConfig(settings.outboundProxyUrl);
      if (proxy?.server) {
        return {
          source: "profile-outbound-proxy",
          proxyPools: [],
          fallbackProxy: {
            id: "profile-outbound-proxy",
            name: "Profile outbound proxy",
            proxy,
          },
        };
      }
    }
  } catch (error) {
    console.warn("[BulkImport] Failed to load profile outbound proxy for OAuth automation:", error.message);
  }

  return { source: "none", proxyPools: [], fallbackProxy: null };
}

export function pickAutomationProxy(job, account) {
  const proxyOptions = job?.automationProxyOptions;
  const pools = proxyOptions?.proxyPools || [];
  if (pools.length > 0) {
    const line = Number.isFinite(Number(account?.line)) ? Number(account.line) : 1;
    return pools[Math.max(0, line - 1) % pools.length];
  }
  return proxyOptions?.fallbackProxy || null;
}

export function parseKiroBulkAccounts(accounts = []) {
  const lines = Array.isArray(accounts) ? accounts : [];
  const parsed = [];
  const invalidLines = [];

  lines.forEach((line, index) => {
    const raw = String(line || "").trim();
    if (!raw) return;

    const [email = "", ...passwordParts] = raw.split("|");
    const normalizedEmail = email.trim();
    const normalizedPassword = passwordParts.join("|").trim();

    if (!normalizedEmail || !normalizedPassword) {
      invalidLines.push(index + 1);
      return;
    }

    parsed.push({
      line: index + 1,
      email: normalizedEmail,
      password: normalizedPassword,
    });
  });

  return {
    parsed,
    invalidLines,
  };
}

function getFailedCount(accounts) {
  return accounts.filter((account) => (
    account.status === "failed"
    || account.status === "failed_invalid_credentials"
    || account.status === "failed_exchange"
    || account.status === "failed_timeout"
  )).length;
}

function getSkippedCount(accounts) {
  return accounts.filter((account) => BULK_ACCOUNT_SKIP_STATUSES.has(account.status)).length;
}

function buildSummary(accounts) {
  const skippedDuplicate = accounts.filter((account) => account.status === "skipped_duplicate").length;
  const skippedDuplicateInput = accounts.filter((account) => account.status === "skipped_duplicate_input").length;
  return {
    total: accounts.length,
    queued: accounts.filter((account) => account.status === "queued").length,
    running: accounts.filter((account) => account.status === "running").length,
    success: accounts.filter((account) => account.status === "success").length,
    failed: getFailedCount(accounts),
    skipped: getSkippedCount(accounts),
    skipped_duplicate: skippedDuplicate,
    skipped_duplicate_input: skippedDuplicateInput,
    needs_manual: accounts.filter((account) => account.status === "needs_manual").length,
  };
}

function createLogEntry(step, message, level = "info") {
  return {
    id: randomUUID(),
    at: nowIso(),
    step,
    message,
    level,
  };
}

function appendAccountLog(account, step, message, level = "info") {
  const entry = createLogEntry(step, message, level);
  account.currentStep = step;
  account.updatedAt = entry.at;
  account.logs = account.logs || [];
  account.logs.push(entry);
  if (account.logs.length > MAX_ACCOUNT_LOG_ENTRIES) {
    account.logs.splice(0, account.logs.length - MAX_ACCOUNT_LOG_ENTRIES);
  }
  return entry;
}

function buildJobActivity(accounts) {
  return accounts
    .flatMap((account) => (account.logs || []).map((entry) => ({
      ...entry,
      email: account.email,
      line: account.line,
      workerId: account.workerId || null,
      status: account.status,
    })))
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))
    .slice(-MAX_JOB_ACTIVITY_ENTRIES);
}

function sanitizeAccount(account) {
  return {
    email: account.email,
    status: account.status,
    error: account.error || null,
    connectionId: account.connectionId || null,
    apiKeyConnectionId: account.apiKeyConnectionId || null,
    apiKeyId: account.apiKeyId || null,
    authMethod: account.authMethod || null,
    statusDetail: account.statusDetail || null,
    trialStatus: account.trialStatus || null,
    billingOpened: account.billingOpened === true ? true : null,
    workerId: account.workerId || null,
    line: account.line,
    currentStep: account.currentStep || null,
    updatedAt: account.updatedAt || null,
    logs: (account.logs || []).slice(-8),
    manualSessionAvailable: Boolean(account.manualSession?.page) && account.status === "needs_manual",
    manualSessionOpened: Boolean(account.manualSession?.opened),
  };
}

function sanitizeJob(job, extras = {}) {
  return {
    jobId: job.jobId,
    status: job.status,
    summary: buildSummary(job.accounts),
    concurrency: job.concurrency,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    accounts: job.accounts.map(sanitizeAccount),
    activity: buildJobActivity(job.accounts),
    error: job.error || null,
    preview: extras.preview || null,
  };
}

function buildPersistedSnapshot(job) {
  return sanitizeJob(job, {
    preview: job.lastPreview || null,
  });
}

function isRecentTerminalJob(job) {
  if (!job || ACTIVE_JOB_STATUSES.has(job.status)) return false;
  const finishedAtMs = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
  if (!Number.isFinite(finishedAtMs)) return false;
  return (Date.now() - finishedAtMs) <= RECENT_TERMINAL_JOB_WINDOW_MS;
}

function getPreviewCaptureInterval(job) {
  const total = job?.accounts?.length || 0;
  if (total >= 300) return HUGE_JOB_PREVIEW_CAPTURE_INTERVAL_MS;
  if (total >= 100) return LARGE_JOB_PREVIEW_CAPTURE_INTERVAL_MS;
  return PREVIEW_CAPTURE_INTERVAL_MS;
}

export function buildLookupResponse(job, extras = {}) {
  if (!job) {
    return {
      found: false,
      stale: Boolean(extras.stale),
      recoverable: false,
      job: null,
    };
  }

  return {
    found: true,
    stale: false,
    recoverable: ACTIVE_JOB_STATUSES.has(job.status) || isRecentTerminalJob(job),
    job,
  };
}

async function defaultBrowserLauncher() {
  fs.mkdirSync(PLAYWRIGHT_TMP_DIR, { recursive: true });
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= PLAYWRIGHT_CACHE_DIR;
  process.env.TMPDIR ||= PLAYWRIGHT_TMP_DIR;
  if (fs.existsSync(PLAYWRIGHT_LIB_DIR)) {
    const existing = process.env.LD_LIBRARY_PATH || "";
    const paths = existing.split(path.delimiter).filter(Boolean);
    if (!paths.includes(PLAYWRIGHT_LIB_DIR)) {
      process.env.LD_LIBRARY_PATH = [PLAYWRIGHT_LIB_DIR, ...paths].join(path.delimiter);
    }
  }

  const { chromium } = await import("playwright");

  return await chromium.launch({
    headless: true,
  });
}

async function defaultSocialExchange(args) {
  const { exchangeAndSaveKiroSocialConnection } = await import("./kiroConnections.js");
  return exchangeAndSaveKiroSocialConnection(args);
}

export async function createFreshContext(browser, proxyEntry = null) {
  const context = await browser.newContext({
    ...(proxyEntry?.proxy ? { proxy: proxyEntry.proxy } : {}),
  });
  const page = await context.newPage();
  return { context, page };
}

async function revealBrowserWindow(page) {
  if (!page) return false;

  try {
    const context = page.context?.();
    if (!context?.newCDPSession) {
      await page.bringToFront?.().catch(() => null);
      return true;
    }

    const session = await context.newCDPSession(page);
    let windowId = null;

    try {
      const targetInfo = await session.send("Target.getTargetInfo");
      const targetId = targetInfo?.targetInfo?.targetId;
      const windowInfo = await session.send("Browser.getWindowForTarget", targetId ? { targetId } : {});
      windowId = windowInfo?.windowId ?? null;
    } catch {
      windowId = null;
    }

    if (windowId != null) {
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          windowState: "normal",
          left: 80,
          top: 80,
          width: 1280,
          height: 960,
        },
      }).catch(() => null);
    }

    await page.bringToFront?.().catch(() => null);
    await session.detach?.().catch(() => null);
    return true;
  } catch {
    await page.bringToFront?.().catch(() => null);
    return true;
  }
}

export class KiroBulkImportManager {
  constructor({
    browserLauncher = defaultBrowserLauncher,
    googleAutomation = runKiroGoogleAutomation,
    socialExchange = defaultSocialExchange,
    kiroServiceFactory = () => new KiroService(),
    storageName = "kiro-bulk-import",
  } = {}) {
    this.browserLauncher = browserLauncher;
    this.googleAutomation = googleAutomation;
    this.socialExchange = socialExchange;
    this.kiroServiceFactory = kiroServiceFactory;
    this.storageDir = path.join(DATA_DIR, storageName);
    this.metaFile = path.join(this.storageDir, "meta.json");
    this.jobs = new Map();
    this.latestJobId = readPersistedLatestJobId(this.metaFile);
  }

  async startJob({ accounts, concurrency, automationProxy, extraJobFields = {} }) {
    const { parsed, invalidLines } = parseKiroBulkAccounts(accounts);
    if (!parsed.length) {
      const error = invalidLines.length > 0
        ? "Invalid account format. Use one account per line: gmail@example.com|password"
        : "At least one account entry is required";
      const response = { error };
      if (invalidLines.length > 0) response.invalidLines = invalidLines;
      throw Object.assign(new Error(error), response);
    }

    if (invalidLines.length > 0) {
      const error = "Invalid account format. Use one account per line: gmail@example.com|password";
      throw Object.assign(new Error(error), { error, invalidLines });
    }

    const jobId = randomUUID();
    const createdAt = nowIso();
    const preparedAccounts = await this.prepareBulkAccounts(parsed, { createdAt });
    const job = {
      jobId,
      status: "running",
      concurrency: clampConcurrency(concurrency),
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      error: null,
      cancelRequested: false,
      browser: null,
      automationProxySelection: normalizeAutomationProxySelection(automationProxy),
      automationProxyOptions: null,
      nextIndex: 0,
      manualFollowups: new Set(),
      persistPromise: Promise.resolve(),
      lastPreview: null,
      lastPreviewCapturedAt: 0,
      accounts: preparedAccounts,
      ...extraJobFields,
    };

    this.jobs.set(jobId, job);
    this.latestJobId = jobId;
    writePersistedLatestJobId(jobId, this.metaFile);
    await this.persistJobSnapshot(job, { forcePreview: false });
    if (this.getQueuedAccounts(job).length === 0) {
      job.status = "completed";
      job.finishedAt = nowIso();
      await this.persistJobSnapshot(job, { forcePreview: true });
    } else {
      void this.runJob(jobId);
    }
    return sanitizeJob(job);
  }

  buildAccountState(account, createdAt, decision = { status: "queued" }) {
    const status = decision.status || "queued";
    const isSkipped = BULK_ACCOUNT_SKIP_STATUSES.has(status);
    return {
      line: account.line,
      email: account.email,
      password: isSkipped ? undefined : account.password,
      status,
      error: decision.error || null,
      connectionId: null,
      workerId: null,
      manualSession: null,
      runtimeSession: null,
      currentStep: decision.step || status,
      updatedAt: createdAt,
      existingConnectionIds: decision.existingConnectionIds || null,
      existingConnectionNames: decision.existingConnectionNames || null,
      duplicateOfLine: decision.duplicateOfLine || null,
      logs: [createLogEntry(decision.step || status, decision.message || "Queued and waiting for an available worker")],
    };
  }

  async prepareBulkAccounts(parsed, { createdAt } = {}) {
    const decisions = await classifyBulkAccountDuplicates({ providerId: "kiro", accounts: parsed });
    return parsed.map((account, index) => this.buildAccountState(account, createdAt, decisions[index]));
  }

  getQueuedAccounts(job) {
    return (job?.accounts || []).filter((account) => account.status === "queued");
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job) return sanitizeJob(job, { preview: job.lastPreview || null });
    return readJsonFile(getJobFile(jobId, this.storageDir));
  }

  async getJobWithPreview(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return readJsonFile(getJobFile(jobId, this.storageDir));
    const preview = await this.capturePreview(job);
    job.lastPreview = preview || job.lastPreview || null;
    await this.persistJobSnapshot(job, { forcePreview: false });
    return sanitizeJob(job, { preview: job.lastPreview || null });
  }

  async getLatestJobWithPreview({ includeRecentTerminal = false } = {}) {
    const latestJobId = this.latestJobId || readPersistedLatestJobId(this.metaFile);
    if (!latestJobId) return null;
    const job = await this.getJobWithPreview(latestJobId);
    if (!job) return null;
    if (ACTIVE_JOB_STATUSES.has(job.status)) {
      return job;
    }
    if (includeRecentTerminal && isRecentTerminalJob(job)) {
      return job;
    }
    return null;
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return readJsonFile(getJobFile(jobId, this.storageDir));

    job.cancelRequested = true;
    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = nowIso();
      job.accounts.forEach((account) => {
        if (account.status === "queued") account.status = "cancelled";
      });
    }

    if (job.browser) {
      void job.browser.close().catch(() => null);
      job.browser = null;
    }

    void this.persistJobSnapshot(job, { forcePreview: true });

    return sanitizeJob(job);
  }

  async openManualSession(jobId, workerId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    const numericWorkerId = Number.parseInt(workerId, 10);
    const account = job.accounts.find((entry) => (
      entry.workerId === numericWorkerId
      && entry.status === "needs_manual"
      && entry.manualSession?.page
    ));

    if (!account) {
      return {
        ok: false,
        error: "Manual session not found for this worker",
        job: sanitizeJob(job),
      };
    }

    const opened = await revealBrowserWindow(account.manualSession.page);
    account.manualSession.opened = opened;
    account.manualSession.openedAt = opened
      ? (account.manualSession.openedAt || nowIso())
      : account.manualSession.openedAt || null;
    await this.persistJobSnapshot(job, { forcePreview: true });

    return {
      ok: true,
      job: sanitizeJob(job),
      account: sanitizeAccount(account),
    };
  }

  dequeueAccount(job, workerId) {
    while (job.nextIndex < job.accounts.length) {
      const account = job.accounts[job.nextIndex];
      job.nextIndex += 1;
      if (account.status !== "queued") continue;
      account.status = "running";
      account.workerId = workerId;
      account.error = null;
      appendAccountLog(account, "worker_assigned", `Worker ${workerId} picked up this account`);
      void this.persistJobSnapshot(job, { forcePreview: false });
      return account;
    }
    return null;
  }

  finalizeAccount(account, status, extras = {}) {
    account.status = status;
    account.error = extras.error || null;
    account.connectionId = extras.connectionId || null;
    if (extras.apiKeyConnectionId !== undefined) account.apiKeyConnectionId = extras.apiKeyConnectionId || null;
    if (extras.apiKeyId !== undefined) account.apiKeyId = extras.apiKeyId || null;
    if (extras.authMethod !== undefined) account.authMethod = extras.authMethod || null;
    if (extras.statusDetail !== undefined) account.statusDetail = extras.statusDetail || null;
    if (extras.trialStatus !== undefined) account.trialStatus = extras.trialStatus || null;
    if (extras.billingOpened !== undefined) account.billingOpened = Boolean(extras.billingOpened);
    if (extras.step || extras.message) {
      appendAccountLog(
        account,
        extras.step || status,
        extras.message || extras.error || status.replaceAll("_", " ")
      );
    }
    return account;
  }

  setAccountStep(account, step, message, level = "info") {
    appendAccountLog(account, step, message, level);
  }

  async persistJobSnapshot(job, { forcePreview = false } = {}) {
    if (!job) return;
    const now = Date.now();
    if (!forcePreview && job.lastSnapshotWrittenAt && now - job.lastSnapshotWrittenAt < MIN_PERSIST_INTERVAL_MS) {
      return;
    }

    const runPersist = async () => {
      const previewInterval = getPreviewCaptureInterval(job);
      const shouldCapturePreview = Date.now() - (job.lastPreviewCapturedAt || 0) >= previewInterval;
      if (shouldCapturePreview) {
        const preview = await this.capturePreview(job);
        if (preview) {
          job.lastPreview = preview;
        }
        job.lastPreviewCapturedAt = Date.now();
      }

      writeJsonFile(getJobFile(job.jobId, this.storageDir), buildPersistedSnapshot(job));
      job.lastSnapshotWrittenAt = Date.now();
    };

    job.persistPromise = Promise.resolve(job.persistPromise).catch(() => null).then(runPersist);
    await job.persistPromise;
  }

  async capturePreview(job) {
    const previewAccount = job.accounts.find((account) => account.status === "running" && account.runtimeSession?.page)
      || job.accounts.find((account) => account.status === "needs_manual" && account.manualSession?.page);

    if (!previewAccount) return null;

    const page = previewAccount.runtimeSession?.page || previewAccount.manualSession?.page;
    if (!page) return null;

    try {
      const screenshot = await page.screenshot({
        type: "jpeg",
        quality: 55,
        fullPage: false,
        animations: "disabled",
        caret: "hide",
      });

      return {
        email: previewAccount.email,
        workerId: previewAccount.workerId || null,
        status: previewAccount.status,
        step: previewAccount.currentStep || null,
        updatedAt: previewAccount.updatedAt || nowIso(),
        imageData: `data:image/jpeg;base64,${screenshot.toString("base64")}`,
      };
    } catch {
      return {
        email: previewAccount.email,
        workerId: previewAccount.workerId || null,
        status: previewAccount.status,
        step: previewAccount.currentStep || null,
        updatedAt: previewAccount.updatedAt || nowIso(),
        imageData: null,
      };
    }
  }

  async runManualFollowup(job, account, workerId, context, callbackPromise, codeVerifier) {
    const followupPromise = (async () => {
      try {
        const callback = await callbackPromise;
        if (job.cancelRequested) {
          this.finalizeAccount(account, "cancelled", {
            error: "Job cancelled",
            step: "cancelled",
            message: "Job cancelled while waiting for manual completion",
          });
          await this.persistJobSnapshot(job, { forcePreview: true });
          return;
        }

        this.setAccountStep(account, "exchanging_tokens", "Exchanging Kiro callback for OAuth tokens");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const { connection } = await this.socialExchange({
          code: callback.code,
          codeVerifier,
          provider: "google",
        });

        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "Kiro connection saved successfully",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
      } catch (error) {
        if (job.cancelRequested) {
          this.finalizeAccount(account, "cancelled", {
            error: "Job cancelled",
            step: "cancelled",
            message: "Job cancelled while waiting for manual completion",
          });
        } else {
          this.finalizeAccount(account, "failed_exchange", {
            error: error.message || "Manual assist flow failed during token exchange.",
            step: "exchange_failed",
            message: error.message || "Manual assist flow failed during token exchange.",
          });
        }
        await this.persistJobSnapshot(job, { forcePreview: true });
      } finally {
        account.manualSession = null;
        account.runtimeSession = null;
        await context.close().catch(() => null);
        job.manualFollowups.delete(followupPromise);
        await this.persistJobSnapshot(job, { forcePreview: true });
      }
    })();

    job.manualFollowups.add(followupPromise);
  }

  async processAccount(job, account, workerId) {
    if (job.cancelRequested || !job.browser) {
      this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
      return;
    }

    const kiroService = this.kiroServiceFactory();
    const socialAuth = kiroService.createSocialAuthorization("google");
    const proxyEntry = pickAutomationProxy(job, account);
    const { context, page } = await createFreshContext(job.browser, proxyEntry);
    const callbackPromise = createKiroCallbackMonitor(context, page);
    account.runtimeSession = { context, page };

    try {
      this.setAccountStep(
        account,
        "preparing_worker",
        proxyEntry
          ? `Worker ${workerId} is preparing a browser context via proxy ${proxyEntry.name}`
          : `Worker ${workerId} is preparing a browser context`
      );
      await this.persistJobSnapshot(job, { forcePreview: true });
      const automationResult = await this.googleAutomation({
        page,
        authUrl: socialAuth.authUrl,
        email: account.email,
        password: account.password,
        callbackPromise,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      if (automationResult.status === "success") {
        this.setAccountStep(account, "exchanging_tokens", "Exchanging Kiro callback for OAuth tokens");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const { connection } = await this.socialExchange({
          code: automationResult.code,
          codeVerifier: socialAuth.codeVerifier,
          provider: "google",
        });
        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: "Kiro connection saved successfully",
        });
        account.runtimeSession = null;
        await context.close().catch(() => null);
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      if (automationResult.status === "needs_manual") {
        account.manualSession = {
          context,
          page,
          opened: false,
          openedAt: null,
        };
        this.setAccountStep(account, "awaiting_manual", "Waiting for manual completion in the browser session");
        this.finalizeAccount(account, "needs_manual", {
          error: automationResult.error,
          step: "awaiting_manual",
          message: automationResult.error,
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        await this.runManualFollowup(
          job,
          account,
          workerId,
          context,
          callbackPromise,
          socialAuth.codeVerifier
        );
        return;
      }

      const terminalStatus = TERMINAL_ACCOUNT_STATUSES.has(automationResult.status)
        ? automationResult.status
        : "failed";
      this.finalizeAccount(account, terminalStatus, {
        error: automationResult.error || "Kiro Google automation failed.",
        step: terminalStatus,
        message: automationResult.error || "Kiro Google automation failed.",
      });
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } catch (error) {
      this.finalizeAccount(account, "failed", {
        error: error.message || "Unexpected Kiro bulk import failure.",
        step: "failed",
        message: error.message || "Unexpected Kiro bulk import failure.",
      });
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      account.password = undefined;
    }
  }

  async runWorker(job, workerId) {
    while (!job.cancelRequested) {
      const account = this.dequeueAccount(job, workerId);
      if (!account) return;
      await this.processAccount(job, account, workerId);
    }
  }

  async runJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    try {
      const queuedAccounts = this.getQueuedAccounts(job);
      if (queuedAccounts.length === 0) {
        job.status = "completed";
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      job.automationProxyOptions = await resolveAutomationProxyOptions(job.automationProxySelection);
      job.browser = await this.browserLauncher();
      job.accounts.forEach((account) => {
        if (account.status === "queued" && (account.logs || []).length === 1) {
          this.setAccountStep(account, "waiting_for_worker", "Waiting for a free worker");
        }
      });
      await this.persistJobSnapshot(job, { forcePreview: false });
      const workerCount = Math.min(job.concurrency, queuedAccounts.length);
      const workers = Array.from({ length: workerCount }, (_, index) => this.runWorker(job, index + 1));

      await Promise.allSettled(workers);

      if (job.manualFollowups.size > 0) {
        await Promise.allSettled([...job.manualFollowups]);
      }

      if (job.cancelRequested) {
        job.status = "cancelled";
        job.accounts.forEach((account) => {
          if (account.status === "queued" || account.status === "running") {
            this.finalizeAccount(account, "cancelled", {
              error: "Job cancelled",
              step: "cancelled",
              message: "Job cancelled before completion",
            });
          }
        });
      } else {
        job.status = "completed";
      }
      await this.persistJobSnapshot(job, { forcePreview: true });
    } catch (error) {
      job.status = "failed";
      job.error = error.message || "Failed to start Kiro bulk import job.";
      job.accounts.forEach((account) => {
        if (account.status === "queued" || account.status === "running") {
          this.finalizeAccount(account, "failed", {
            error: job.error,
            step: "failed",
            message: job.error,
          });
          account.password = undefined;
        }
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      if (job.browser) {
        await job.browser.close().catch(() => null);
        job.browser = null;
      }
      job.finishedAt = nowIso();
      await this.persistJobSnapshot(job, { forcePreview: true });
    }
  }
}

function getSingletonStore() {
  if (!globalThis.__kiroBulkImportSingleton) {
    globalThis.__kiroBulkImportSingleton = {
      manager: new KiroBulkImportManager(),
    };
  }
  return globalThis.__kiroBulkImportSingleton;
}

export function getKiroBulkImportManager() {
  return getSingletonStore().manager;
}

export const __test__ = {
  clampConcurrency,
  parseKiroBulkAccounts,
  sanitizeJob,
  buildSummary,
  isRecentTerminalJob,
  buildLookupResponse,
};
