import {
  KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY,
  KIRO_BULK_IMPORT_MAX_CONCURRENCY,
  KIRO_BULK_IMPORT_MIN_CONCURRENCY,
  KiroBulkImportManager,
  buildLookupResponse,
  createFreshContext,
  parseKiroBulkAccounts,
  pickAutomationProxy,
} from "./kiroBulkImportManager.js";
import { classifyBulkAccountDuplicates } from "./bulkAccountDuplicateDetection.js";
import { runGoogleAccountAutomation } from "./kiroGoogleAutomation.js";

const QODER_PROVIDER_ID = "qoder";
const QODER_LABEL = "Qoder";
const QODER_POLL_TIMEOUT_MS = 3 * 60_000;
const QODER_POLL_INTERVAL_MS = 2_000;
const QODER_MAX_TRANSIENT_POLL_ERRORS = 6;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProxyUrlForServerFetch(proxyEntry) {
  const server = proxyEntry?.proxy?.server;
  if (!server || !/^https?:\/\//i.test(server)) return "";
  try {
    const url = new URL(server);
    if (proxyEntry.proxy.username) url.username = encodeURIComponent(proxyEntry.proxy.username);
    if (proxyEntry.proxy.password) url.password = encodeURIComponent(proxyEntry.proxy.password);
    return url.toString();
  } catch {
    return "";
  }
}

async function defaultRequestDeviceCode(providerId) {
  const { requestDeviceCode } = await import("../providers.js");
  return requestDeviceCode(providerId);
}

async function defaultPollForToken(providerId, deviceCode, codeVerifier, extraData) {
  const { pollForToken } = await import("../providers.js");
  return pollForToken(providerId, deviceCode, codeVerifier, extraData);
}

async function defaultSaveQoderConnection({ tokens }) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const connection = await createProviderConnection({
    provider: QODER_PROVIDER_ID,
    authType: "oauth",
    ...tokens,
    expiresAt: tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : null,
    testStatus: "active",
  });

  return { connection };
}

function createQoderPollPromise({
  deviceData,
  pollToken,
  onStep,
  timeoutMs = QODER_POLL_TIMEOUT_MS,
  pollIntervalMs = QODER_POLL_INTERVAL_MS,
  maxTransientErrors = QODER_MAX_TRANSIENT_POLL_ERRORS,
  proxyUrl = "",
  shouldStop = () => false,
}) {
  return (async () => {
    const startedAt = Date.now();
    let lastStepAt = 0;
    let transientErrors = 0;
    const extraData = {
      _qoderNonce: deviceData._qoderNonce || deviceData.device_code,
      _qoderMachineId: deviceData._qoderMachineId,
      _qoderVerifier: deviceData.codeVerifier,
      _qoderProxyUrl: proxyUrl,
    };

    while (Date.now() - startedAt < timeoutMs) {
      if (shouldStop()) {
        throw new Error("Qoder device-token polling cancelled");
      }
      if (Date.now() - lastStepAt > pollIntervalMs - 100) {
        onStep?.("polling_qoder_token", "Waiting for Qoder device token");
        lastStepAt = Date.now();
      }

      const result = await pollToken(
        QODER_PROVIDER_ID,
        deviceData.device_code,
        deviceData.codeVerifier,
        extraData
      );

      if (result.success) {
        return { tokens: result.tokens };
      }

      if (!result.pending && result.error !== "authorization_pending" && result.error !== "slow_down") {
        if (result.error === "request_failed" && transientErrors < maxTransientErrors) {
          transientErrors += 1;
          onStep?.(
            "qoder_poll_retry",
            `Qoder token poll failed temporarily (${transientErrors}/${maxTransientErrors}); retrying`
          );
          await wait(pollIntervalMs);
          continue;
        }
        throw new Error(result.errorDescription || result.error || "Qoder device-token polling failed");
      }

      await wait(pollIntervalMs);
    }

    throw new Error("Timed out waiting for Qoder device token");
  })();
}

export class QoderBulkImportManager extends KiroBulkImportManager {
  constructor({
    browserLauncher,
    googleAutomation = runGoogleAccountAutomation,
    requestDeviceCodeFn = defaultRequestDeviceCode,
    pollToken = defaultPollForToken,
    saveConnection = defaultSaveQoderConnection,
    pollIntervalMs = QODER_POLL_INTERVAL_MS,
  } = {}) {
    super({
      browserLauncher,
      googleAutomation,
      storageName: "qoder-bulk-import",
    });
    this.requestDeviceCode = requestDeviceCodeFn;
    this.pollToken = pollToken;
    this.saveConnection = saveConnection;
    this.pollIntervalMs = pollIntervalMs;
  }

  async prepareBulkAccounts(parsed, { createdAt } = {}) {
    const decisions = await classifyBulkAccountDuplicates({ providerId: QODER_PROVIDER_ID, accounts: parsed });
    return parsed.map((account, index) => this.buildAccountState(account, createdAt, decisions[index]));
  }

  async runManualFollowup(job, account, workerId, context, successPromise) {
    const followupPromise = (async () => {
      try {
        const result = await successPromise;
        if (job.cancelRequested) {
          this.finalizeAccount(account, "cancelled", {
            error: "Job cancelled",
            step: "cancelled",
            message: "Job cancelled while waiting for manual Qoder authorization",
          });
          await this.persistJobSnapshot(job, { forcePreview: true });
          return;
        }

        this.setAccountStep(account, "saving_connection", "Saving Qoder OAuth connection");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const { connection } = await this.saveConnection({ tokens: result.tokens });
        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          authMethod: "oauth",
          statusDetail: "Qoder device token saved",
          step: "connection_saved",
          message: "Qoder connection saved successfully",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
      } catch (error) {
        if (job.cancelRequested) {
          this.finalizeAccount(account, "cancelled", {
            error: "Job cancelled",
            step: "cancelled",
            message: "Job cancelled while waiting for manual Qoder authorization",
          });
        } else {
          this.finalizeAccount(account, "failed_exchange", {
            error: error.message || "Manual Qoder flow failed during token polling.",
            step: "exchange_failed",
            message: error.message || "Manual Qoder flow failed during token polling.",
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

    const proxyEntry = pickAutomationProxy(job, account);
    const { context, page } = await createFreshContext(job.browser, proxyEntry);
    const pollState = { cancelled: false };
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

      this.setAccountStep(account, "requesting_qoder_device_flow", "Requesting Qoder device authorization URL");
      const deviceData = await this.requestDeviceCode(QODER_PROVIDER_ID);
      const authUrl = deviceData.verification_uri_complete;
      if (!authUrl || !deviceData.device_code || !deviceData.codeVerifier) {
        throw new Error("Qoder did not return a complete device authorization URL");
      }

      const successPromise = createQoderPollPromise({
        deviceData,
        pollToken: this.pollToken,
        pollIntervalMs: this.pollIntervalMs,
        proxyUrl: buildProxyUrlForServerFetch(proxyEntry),
        shouldStop: () => job.cancelRequested || pollState.cancelled,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });
      successPromise.catch(() => null);

      const automationResult = await this.googleAutomation({
        page,
        authUrl,
        email: account.email,
        password: account.password,
        successPromise,
        serviceLabel: QODER_LABEL,
        openingStep: "opening_qoder_device_login",
        openingMessage: "Opening Qoder device login page",
        successStep: "qoder_token_received",
        successMessage: "Qoder device token received",
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      if (automationResult.status === "success") {
        this.setAccountStep(account, "saving_connection", "Saving Qoder OAuth connection");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const { connection } = await this.saveConnection({ tokens: automationResult.tokens });
        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          authMethod: "oauth",
          statusDetail: "Qoder device token saved",
          step: "connection_saved",
          message: "Qoder connection saved successfully",
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
        await this.runManualFollowup(job, account, workerId, context, successPromise);
        return;
      }

      this.finalizeAccount(account, automationResult.status || "failed", {
        error: automationResult.error || "Qoder Google automation failed.",
        step: automationResult.status || "failed",
        message: automationResult.error || "Qoder Google automation failed.",
      });
      pollState.cancelled = true;
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } catch (error) {
      // If the browser/login path fails before the device-token poll resolves,
      // stop the poll loop and keep its rejection handled. This prevents noisy
      // process-level unhandledRejection logs after cancel/timeout.
      pollState.cancelled = true;
      if (job.cancelRequested) {
        this.finalizeAccount(account, "cancelled", {
          error: "Job cancelled",
          step: "cancelled",
          message: "Job cancelled while Qoder automation was running",
        });
      } else {
        this.finalizeAccount(account, "failed", {
          error: error.message || "Unexpected Qoder bulk import failure.",
          step: "failed",
          message: error.message || "Unexpected Qoder bulk import failure.",
        });
      }
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      pollState.cancelled = true;
      account.password = undefined;
    }
  }
}

function getSingletonStore() {
  if (!globalThis.__qoderBulkImportSingleton) {
    globalThis.__qoderBulkImportSingleton = {
      manager: new QoderBulkImportManager(),
    };
  }
  return globalThis.__qoderBulkImportSingleton;
}

export function getQoderBulkImportManager() {
  return getSingletonStore().manager;
}

export {
  buildLookupResponse,
  KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY as QODER_BULK_IMPORT_DEFAULT_CONCURRENCY,
  KIRO_BULK_IMPORT_MAX_CONCURRENCY as QODER_BULK_IMPORT_MAX_CONCURRENCY,
  KIRO_BULK_IMPORT_MIN_CONCURRENCY as QODER_BULK_IMPORT_MIN_CONCURRENCY,
  parseKiroBulkAccounts as parseQoderBulkAccounts,
};

export const __test__ = {
  createQoderPollPromise,
  defaultSaveQoderConnection,
};
