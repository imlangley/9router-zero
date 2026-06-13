import {
  KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY,
  KIRO_BULK_IMPORT_MAX_CONCURRENCY,
  KIRO_BULK_IMPORT_MIN_CONCURRENCY,
  KiroBulkImportManager,
  buildLookupResponse,
  createFreshContext,
  parseKiroBulkAccounts,
} from "./kiroBulkImportManager.js";
import {
  runGoogleAccountAutomation,
  handleCodeBuddyRegionPage,
  handleProviderOnboarding,
  handleCodeBuddyStartedAuthorization,
  isProviderPage,
} from "./kiroGoogleAutomation.js";
import {
  generateCodeBuddyApiKeyFromPage,
  generateCodeBuddyApiKeyFromContext,
  isValidCodeBuddyApiKey,
} from "./codebuddyApiKey.js";

const CODEBUDDY_PROVIDER_ID = "codebuddy";
const CODEBUDDY_LABEL = "CodeBuddy";
const CODEBUDDY_POLL_TIMEOUT_MS = 15 * 60_000;
const CODEBUDDY_POLL_INTERVAL_MS = 5_000;
const CODEBUDDY_MAX_TRANSIENT_POLL_ERRORS = 6;
const CODEBUDDY_COOKIE_DOMAINS = new Set(["codebuddy.ai", "www.codebuddy.ai"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCodeBuddyAuthUrl(rawUrl, state) {
  if (!rawUrl && !state) return rawUrl;
  const url = rawUrl ? new URL(rawUrl) : new URL("https://www.codebuddy.ai/login");
  const platform = url.searchParams.get("platform") || "CLI";
  const effectiveState = state || url.searchParams.get("state");
  const normalized = new URL("https://www.codebuddy.ai/login");
  normalized.searchParams.set("platform", platform);
  if (effectiveState) normalized.searchParams.set("state", effectiveState);
  return normalized.toString();
}

async function defaultSaveCodeBuddyConnection({ tokens, email }) {
  const { createProviderConnection } = await import("../../../models/index.js");
  const providerSpecificData = {
    ...(tokens.providerSpecificData || {}),
    loginEmail: email,
    automation: "gsuite-bulk",
  };

  if (tokens.webCookie) {
    providerSpecificData.webCookie = tokens.webCookie;
    providerSpecificData.webCookieCapturedAt = tokens.webCookieCapturedAt || new Date().toISOString();
  }

  const connection = await createProviderConnection({
    provider: CODEBUDDY_PROVIDER_ID,
    authType: "oauth",
    ...tokens,
    email,
    providerSpecificData,
    expiresAt: tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : null,
    testStatus: "active",
  });

  return { connection };
}

async function defaultRequestDeviceCode(providerId) {
  const { requestDeviceCode } = await import("../providers.js");
  return requestDeviceCode(providerId);
}

async function defaultPollForToken(providerId, deviceCode) {
  const { pollForToken } = await import("../providers.js");
  return pollForToken(providerId, deviceCode);
}

async function captureCodeBuddyWebCookie(context) {
  if (!context?.cookies) {
    console.warn("[CodeBuddy] captureWebCookie: context.cookies not available");
    return null;
  }

  try {
    const cookies = await context.cookies(["https://www.codebuddy.ai", "https://codebuddy.ai"]);
    console.log(`[CodeBuddy] captureWebCookie: found ${cookies.length} raw cookies from browser context`);

    const usefulCookies = cookies
      .filter((cookie) => {
        const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
        return CODEBUDDY_COOKIE_DOMAINS.has(domain)
          || domain.endsWith(".codebuddy.ai");
      })
      .filter((cookie) => cookie.name && cookie.value)
      .sort((left, right) => String(left.name).localeCompare(String(right.name)));

    if (usefulCookies.length === 0) {
      console.warn("[CodeBuddy] captureWebCookie: no useful cookies after filtering. Raw cookie names:", cookies.map(c => `${c.name}@${c.domain}`).join(", "));
      return null;
    }

    const cookieString = usefulCookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");

    console.log(`[CodeBuddy] captureWebCookie: captured ${usefulCookies.length} cookies (${cookieString.length} chars). Names: ${usefulCookies.map(c => c.name).join(", ")}`);
    return cookieString;
  } catch (error) {
    console.error("[CodeBuddy] captureWebCookie error:", error.message);
    return null;
  }
}

async function attachCodeBuddyWebCookie(context, tokens = {}) {
  const webCookie = await captureCodeBuddyWebCookie(context);
  if (!webCookie) return tokens;

  return {
    ...tokens,
    webCookie,
    webCookieCapturedAt: new Date().toISOString(),
  };
}

function attachLoginProxyMetadata(tokens = {}, job = null) {
  const loginProxyUrl = typeof job?.loginProxyUrl === "string" ? job.loginProxyUrl.trim() : "";
  if (!loginProxyUrl) return tokens;

  return {
    ...tokens,
    providerSpecificData: {
      ...(tokens.providerSpecificData || {}),
      connectionProxyEnabled: true,
      connectionProxyUrl: loginProxyUrl,
      loginProxyUrl,
      loginProxyCapturedAt: new Date().toISOString(),
    },
  };
}

function createCodeBuddyPollPromise({
  deviceCode,
  pollToken,
  onStep,
  timeoutMs = CODEBUDDY_POLL_TIMEOUT_MS,
  pollIntervalMs = CODEBUDDY_POLL_INTERVAL_MS,
  maxTransientErrors = CODEBUDDY_MAX_TRANSIENT_POLL_ERRORS,
}) {
  return (async () => {
    const startedAt = Date.now();
    let lastStepAt = 0;
    let transientErrors = 0;

    while (Date.now() - startedAt < timeoutMs) {
      if (Date.now() - lastStepAt > pollIntervalMs - 100) {
        onStep?.("polling_codebuddy_token", "Waiting for CodeBuddy OAuth token");
        lastStepAt = Date.now();
      }

      const result = await pollToken(CODEBUDDY_PROVIDER_ID, deviceCode);
      if (result.success) {
        return {
          tokens: result.tokens,
        };
      }

      if (!result.pending && result.error !== "authorization_pending" && result.error !== "slow_down") {
        if (result.error === "request_failed" && transientErrors < maxTransientErrors) {
          transientErrors += 1;
          onStep?.(
            "codebuddy_poll_retry",
            `CodeBuddy token poll failed temporarily (${transientErrors}/${maxTransientErrors}); retrying`
          );
          await wait(pollIntervalMs);
          continue;
        }
        throw new Error(result.errorDescription || result.error || "CodeBuddy OAuth polling failed");
      }

      await wait(pollIntervalMs);
    }

    throw new Error("Timed out waiting for CodeBuddy OAuth token");
  })();
}

const CODEBUDDY_DASHBOARD_URL = "https://www.codebuddy.ai/home";
const CODEBUDDY_COMPLETE_REGISTER_TIMEOUT_MS = 30_000;
const CODEBUDDY_COMPLETE_REGISTER_POLL_MS = 1_500;

async function completeCodeBuddyRegistration(page, onStep) {
  const reportStep = (step, message) => onStep?.(step, message);

  try {
    reportStep("navigating_to_dashboard", "Navigating to CodeBuddy to complete registration");
    await page.goto(CODEBUDDY_DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000);

    // Detect /no-permission redirect (errCode=12154 = restricted account)
    // This is a frontend-only block; cookies and OAuth tokens are still valid,
    // so we log the restriction and continue — API key generation may still work.
    const currentUrl = page.url();
    if (currentUrl.includes("/no-permission") || currentUrl.includes("errCode=12154")) {
      reportStep(
        "account_restricted",
        `Account restricted (errCode=12154) — frontend blocked, continuing to API key generation with captured cookies`
      );
      return;
    }

    const startedAt = Date.now();
    let handledAnything = false;
    let loopCount = 0;

    while (Date.now() - startedAt < CODEBUDDY_COMPLETE_REGISTER_TIMEOUT_MS) {
      loopCount += 1;
      if (!isProviderPage(page)) break;

      // Re-check for no-permission after navigation/handling
      const loopUrl = page.url();
      if (loopUrl.includes("/no-permission") || loopUrl.includes("errCode=12154")) {
        reportStep(
          "account_restricted",
          `Account restricted (errCode=12154) — continuing to API key generation with captured cookies`
        );
        return;
      }

      const handledStarted = await handleCodeBuddyStartedAuthorization(page, reportStep);
      if (handledStarted) {
        handledAnything = true;
        await page.waitForTimeout(CODEBUDDY_COMPLETE_REGISTER_POLL_MS);
        continue;
      }

      const handledRegion = await handleCodeBuddyRegionPage(page, reportStep);
      if (handledRegion) {
        handledAnything = true;
        await page.waitForTimeout(CODEBUDDY_COMPLETE_REGISTER_POLL_MS);
        continue;
      }

      const handledOnboarding = await handleProviderOnboarding(page, reportStep, CODEBUDDY_LABEL);
      if (handledOnboarding) {
        handledAnything = true;
        await page.waitForTimeout(CODEBUDDY_COMPLETE_REGISTER_POLL_MS);
        continue;
      }

      // Nothing left to handle — page is stable
      break;
    }

    if (handledAnything) {
      reportStep("complete_register_done", "CodeBuddy registration completed, establishing session");
    }

    // Note: CodeBuddy web console uses Keycloak auth which is separate from the
    // CLI OAuth flow. Web session cookies for quota tracking cannot be obtained
    // from the OAuth token alone. Users can attach a quota cookie manually via
    // Dashboard -> Providers -> CodeBuddy -> Quota Cookie.
  } catch (error) {
    reportStep("complete_register_skipped", `Could not complete registration: ${error.message}`);
  }
}
export class CodeBuddyBulkImportManager extends KiroBulkImportManager {
  constructor({
    browserLauncher,
    googleAutomation = runGoogleAccountAutomation,
    requestDeviceCodeFn = defaultRequestDeviceCode,
    pollToken = defaultPollForToken,
    saveConnection = defaultSaveCodeBuddyConnection,
    pollIntervalMs = CODEBUDDY_POLL_INTERVAL_MS,
    generateApiKeys = false,
  } = {}) {
    super({
      browserLauncher,
      googleAutomation,
      storageName: "codebuddy-bulk-import",
    });
    this.requestDeviceCode = requestDeviceCodeFn;
    this.pollToken = pollToken;
    this.saveConnection = saveConnection;
    this.pollIntervalMs = pollIntervalMs;
    this.generateApiKeys = generateApiKeys;
  }

  async startJob({ accounts, concurrency, generateApiKeys, loginProxyUrl }) {
    const job = await super.startJob({ accounts, concurrency, loginProxyUrl });
    const internalJob = this.jobs.get(job.jobId) || job;
    if (generateApiKeys) {
      internalJob.generateApiKeys = true;
    }

    try {
      const { getProviderConnections } = await import("../../../models/index.js");
      const allConnections = await getProviderConnections();
      const existingEmails = new Set(
        allConnections
          .filter((c) => c?.provider === CODEBUDDY_PROVIDER_ID && c?.email)
          .map((c) => String(c.email).trim().toLowerCase())
      );

      let skipped = 0;
      for (const account of internalJob.accounts) {
        if (account.status !== "queued") continue;
        const emailKey = String(account.email || "").trim().toLowerCase();
        if (emailKey && existingEmails.has(emailKey)) {
          this.finalizeAccount(account, "skipped_duplicate", {
            error: "Email already has a CodeBuddy connection",
            step: "skipped_duplicate",
            message: "Skipped: a CodeBuddy connection already exists for this email",
          });
          skipped += 1;
        }
      }

      if (skipped > 0) {
        await this.persistJobSnapshot(internalJob, { forcePreview: true });
      }
    } catch (error) {
      console.warn("[CodeBuddyBulkImport] dedup pre-check failed:", error.message);
    }

    return job;
  }

  async _generateAndSaveApiKey(context, account, job, email, page = null) {
    this.setAccountStep(account, "generating_api_key", "Generating CodeBuddy API key (ck_xxx)");
    await this.persistJobSnapshot(job, { forcePreview: true });

    const keyOptions = {
      name: `9r-${(email || "acct").split("@")[0].slice(0, 12)}-${Date.now().toString(36)}`,
    };
    const keyResult = page
      ? await generateCodeBuddyApiKeyFromPage(page, keyOptions)
      : await generateCodeBuddyApiKeyFromContext(context, keyOptions);

    if (!keyResult.success || !isValidCodeBuddyApiKey(keyResult.key)) {
      this.setAccountStep(account, "api_key_failed", `API key generation failed: ${keyResult.error || "invalid key"}`);
      await this.persistJobSnapshot(job, { forcePreview: false });
      return null;
    }

    this.setAccountStep(account, "saving_api_key", `Saving API key ${keyResult.keyId}`);
    await this.persistJobSnapshot(job, { forcePreview: true });

    const webCookie = await captureCodeBuddyWebCookie(context);
    const { createProviderConnection } = await import("../../../models/index.js");
    const loginProxyUrl = typeof job?.loginProxyUrl === "string" ? job.loginProxyUrl.trim() : "";
    const apiConnection = await createProviderConnection({
      provider: CODEBUDDY_PROVIDER_ID,
      authType: "apikey",
      name: `CodeBuddy API Key ${keyResult.keyId}`,
      apiKey: keyResult.key,
      accessToken: keyResult.key,
      email,
      providerSpecificData: {
        domain: "www.codebuddy.ai",
        loginEmail: email,
        automation: "apikey-generated",
        credentialKind: "codebuddy_api_key",
        credentialSource: account._oauthConnectionId ? "oauth_then_apikey" : "restricted_cookie_apikey",
        routingAuthHeader: "bearer",
        routingEndpoint: "https://www.codebuddy.ai/v2/chat/completions",
        apiKeyId: keyResult.keyId,
        apiKeyName: keyResult.name,
        apiKeyExpiresAt: keyResult.expiresAt,
        sourceOAuthConnectionId: account._oauthConnectionId || null,
        ...(loginProxyUrl
          ? {
              connectionProxyEnabled: true,
              connectionProxyUrl: loginProxyUrl,
              loginProxyUrl,
              loginProxyCapturedAt: new Date().toISOString(),
            }
          : {}),
        ...(webCookie
          ? {
              webCookie,
              webCookieCapturedAt: new Date().toISOString(),
            }
          : {}),
      },
      testStatus: "active",
    });

    this.setAccountStep(account, "api_key_saved", `API key saved: ${keyResult.keyId}`);
    await this.persistJobSnapshot(job, { forcePreview: false });
    return { connectionId: apiConnection.id, keyId: keyResult.keyId, key: keyResult.key };
  }

  async runManualFollowup(job, account, workerId, context, successPromise) {
    const followupPromise = (async () => {
      try {
        const result = await successPromise;
        if (job.cancelRequested) {
          this.finalizeAccount(account, "cancelled", {
            error: "Job cancelled",
            step: "cancelled",
            message: "Job cancelled while waiting for manual completion",
          });
          await this.persistJobSnapshot(job, { forcePreview: true });
          return;
        }

        const manualPage = account.manualSession?.page;
        if (manualPage) {
          this.setAccountStep(account, "completing_registration", "Completing CodeBuddy registration");
          await this.persistJobSnapshot(job, { forcePreview: true });
          await completeCodeBuddyRegistration(manualPage, (step, message) => {
            this.setAccountStep(account, step, message);
            void this.persistJobSnapshot(job, { forcePreview: false });
          });
        }

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy OAuth connection");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = attachLoginProxyMetadata(
          await attachCodeBuddyWebCookie(context, result.tokens),
          job
        );
        const { connection } = await this.saveConnection({
          tokens: tokensWithCookie,
          email: account.email,
        });
        account._oauthConnectionId = connection.id;

        // Generate ck_xxx API key if enabled (uses cookies from browser context)
        if (this.generateApiKeys || job.generateApiKeys) {
          const apiKeyResult = await this._generateAndSaveApiKey(context, account, job, account.email, manualPage);
          this.finalizeAccount(account, "success", {
            connectionId: connection.id,
            apiKeyConnectionId: apiKeyResult?.connectionId || null,
            apiKeyId: apiKeyResult?.keyId || null,
            authMethod: apiKeyResult ? "oauth_plus_apikey" : "oauth",
            statusDetail: apiKeyResult ? "OAuth and API key saved" : "OAuth saved; API key generation failed",
            step: "api_key_generated",
            message: apiKeyResult
              ? `OAuth + API key saved: ${apiKeyResult.keyId}`
              : "OAuth connection saved (API key generation failed)",
          });
        } else {
          this.finalizeAccount(account, "success", {
            connectionId: connection.id,
            authMethod: "oauth",
            statusDetail: "OAuth connection saved",
            step: "connection_saved",
            message: "CodeBuddy connection saved successfully",
          });
        }
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
            error: error.message || "Manual assist flow failed during token polling.",
            step: "exchange_failed",
            message: error.message || "Manual assist flow failed during token polling.",
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

    const { context, page } = await createFreshContext(job.browser);
    account.runtimeSession = { context, page };

    try {
      this.setAccountStep(account, "preparing_worker", `Worker ${workerId} is preparing a browser context`);
      await this.persistJobSnapshot(job, { forcePreview: true });

      this.setAccountStep(account, "requesting_codebuddy_state", "Requesting CodeBuddy OAuth state");
      const deviceData = await this.requestDeviceCode(CODEBUDDY_PROVIDER_ID);
      const authUrl = normalizeCodeBuddyAuthUrl(deviceData.verification_uri, deviceData.device_code);
      if (!authUrl || !deviceData.device_code) {
        throw new Error("CodeBuddy did not return an OAuth login URL");
      }

      const successPromise = createCodeBuddyPollPromise({
        deviceCode: deviceData.device_code,
        pollToken: this.pollToken,
        pollIntervalMs: this.pollIntervalMs,
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      const automationResult = await this.googleAutomation({
        page,
        authUrl,
        email: account.email,
        password: account.password,
        successPromise,
        serviceLabel: CODEBUDDY_LABEL,
        openingStep: "opening_codebuddy_oauth",
        openingMessage: "Opening CodeBuddy OAuth page",
        successStep: "codebuddy_token_received",
        successMessage: "CodeBuddy OAuth token received",
        onStep: (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        },
      });

      if (automationResult.status === "success") {
        this.setAccountStep(account, "completing_registration", "Completing CodeBuddy registration");
        await this.persistJobSnapshot(job, { forcePreview: true });
        await completeCodeBuddyRegistration(page, (step, message) => {
          this.setAccountStep(account, step, message);
          void this.persistJobSnapshot(job, { forcePreview: false });
        });

        this.setAccountStep(account, "saving_connection", "Saving CodeBuddy OAuth connection");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const tokensWithCookie = attachLoginProxyMetadata(
          await attachCodeBuddyWebCookie(context, automationResult.tokens),
          job
        );
        const { connection } = await this.saveConnection({
          tokens: tokensWithCookie,
          email: account.email,
        });
        account._oauthConnectionId = connection.id;

        // Generate ck_xxx API key if enabled (uses cookies from browser context before closing)
        if (this.generateApiKeys || job.generateApiKeys) {
          const apiKeyResult = await this._generateAndSaveApiKey(context, account, job, account.email, page);
          this.finalizeAccount(account, "success", {
            connectionId: connection.id,
            apiKeyConnectionId: apiKeyResult?.connectionId || null,
            apiKeyId: apiKeyResult?.keyId || null,
            authMethod: apiKeyResult ? "oauth_plus_apikey" : "oauth",
            statusDetail: apiKeyResult ? "OAuth and API key saved" : "OAuth saved; API key generation failed",
            step: apiKeyResult ? "api_key_generated" : "connection_saved",
            message: apiKeyResult
              ? `OAuth + API key saved: ${apiKeyResult.keyId}`
              : "OAuth connection saved (API key generation failed)",
          });
        } else {
          this.finalizeAccount(account, "success", {
            connectionId: connection.id,
            authMethod: "oauth",
            statusDetail: "OAuth connection saved",
            step: "connection_saved",
            message: "CodeBuddy connection saved successfully",
          });
        }
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

      // Special case: frontend shows /no-permission (errCode=12154) but Keycloak
      // device-code polling may still succeed server-side. Wait a short timeout
      // for successPromise — if it resolves, we can still save OAuth + API key
      // using the cookies already captured in the browser context.
      if (automationResult.status === "failed_restricted") {
        const wantsApiKey = this.generateApiKeys || job.generateApiKeys;
        const restrictedPollWaitMs = wantsApiKey ? 8_000 : 90_000;
        this.setAccountStep(
          account,
          "frontend_restricted_waiting",
          wantsApiKey
            ? "Account blocked on CodeBuddy frontend (errCode=12154). Briefly checking OAuth, then using API key fallback..."
            : "Account blocked on CodeBuddy frontend (errCode=12154). Waiting for server-side Keycloak polling to finish..."
        );
        await this.persistJobSnapshot(job, { forcePreview: true });

        let pollResult = null;
        try {
          pollResult = await Promise.race([
            successPromise,
            wait(restrictedPollWaitMs).then(() => {
              throw new Error(`Keycloak polling timed out (${Math.round(restrictedPollWaitMs / 1000)}s) after frontend restriction`);
            }),
          ]);
        } catch (pollError) {
          // Poll failed or timed out — fall through to finalize failed below
          pollResult = null;
        }

        if (pollResult?.tokens) {
          this.setAccountStep(
            account,
            "poll_succeeded_despite_restriction",
            "Keycloak polling succeeded despite frontend restriction — saving connection"
          );
          await this.persistJobSnapshot(job, { forcePreview: true });

          try {
            const tokensWithCookie = attachLoginProxyMetadata(
              await attachCodeBuddyWebCookie(context, pollResult.tokens),
              job
            );
            const { connection } = await this.saveConnection({
              tokens: tokensWithCookie,
              email: account.email,
            });
            account._oauthConnectionId = connection.id;

            if (this.generateApiKeys || job.generateApiKeys) {
              const apiKeyResult = await this._generateAndSaveApiKey(context, account, job, account.email, page);
              this.finalizeAccount(account, "success", {
                connectionId: connection.id,
                apiKeyConnectionId: apiKeyResult?.connectionId || null,
                apiKeyId: apiKeyResult?.keyId || null,
                authMethod: apiKeyResult ? "oauth_plus_apikey" : "oauth",
                statusDetail: apiKeyResult ? "Restricted frontend; OAuth and API key saved" : "Restricted frontend; OAuth saved; API key generation failed",
                step: apiKeyResult ? "api_key_generated" : "connection_saved",
                message: apiKeyResult
                  ? `Frontend restricted but polling succeeded — OAuth + API key: ${apiKeyResult.keyId}`
                  : "Frontend restricted but polling succeeded — OAuth connection saved (API key failed)",
              });
            } else {
              this.finalizeAccount(account, "success", {
                connectionId: connection.id,
                authMethod: "oauth",
                statusDetail: "Restricted frontend; OAuth connection saved",
                step: "connection_saved_despite_restriction",
                message: "Frontend restricted but server-side polling succeeded — connection saved",
              });
            }
            account.runtimeSession = null;
            await context.close().catch(() => null);
            await this.persistJobSnapshot(job, { forcePreview: true });
            return;
          } catch (saveError) {
            // Fall through to finalize failed below
            this.setAccountStep(account, "save_failed", `Save failed: ${saveError.message}`);
          }
        } else {
          this.setAccountStep(
            account,
            "poll_failed_after_restriction",
            "Keycloak polling failed or timed out after frontend restriction — trying cookie-only API key generation"
          );
          await this.persistJobSnapshot(job, { forcePreview: true });

          if (wantsApiKey) {
            const apiKeyResult = await this._generateAndSaveApiKey(context, account, job, account.email, page);

            if (apiKeyResult) {
              this.finalizeAccount(account, "success", {
                connectionId: null,
                apiKeyConnectionId: apiKeyResult.connectionId,
                apiKeyId: apiKeyResult.keyId,
                authMethod: "apikey",
                statusDetail: "Restricted frontend; OAuth failed; API key saved",
                step: "api_key_generated_without_oauth",
                message: `Frontend restricted and OAuth polling failed, but API key was generated: ${apiKeyResult.keyId}`,
              });
              account.runtimeSession = null;
              await context.close().catch(() => null);
              await this.persistJobSnapshot(job, { forcePreview: true });
              return;
            }

            this.finalizeAccount(account, "failed_restricted", {
              error: "Frontend restricted; Keycloak polling failed; cookie-only API key generation failed.",
              authMethod: "none",
              statusDetail: "Restricted frontend; OAuth and API key generation failed",
              step: "api_key_failed_after_restriction",
              message: "Frontend restricted and OAuth polling failed; CodeBuddy API key endpoint also rejected the captured cookies.",
            });
            account.runtimeSession = null;
            await context.close().catch(() => null);
            await this.persistJobSnapshot(job, { forcePreview: true });
            return;
          }
        }
      }

      this.finalizeAccount(account, automationResult.status || "failed", {
        error: automationResult.error || "CodeBuddy Google automation failed.",
        step: automationResult.status || "failed",
        message: automationResult.error || "CodeBuddy Google automation failed.",
      });
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } catch (error) {
      if (job.cancelRequested) {
        this.finalizeAccount(account, "cancelled", {
          error: "Job cancelled",
          step: "cancelled",
          message: "Job cancelled while CodeBuddy automation was running",
        });
      } else {
        this.finalizeAccount(account, "failed", {
          error: error.message || "Unexpected CodeBuddy bulk import failure.",
          step: "failed",
          message: error.message || "Unexpected CodeBuddy bulk import failure.",
        });
      }
      account.runtimeSession = null;
      await context.close().catch(() => null);
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      account.password = undefined;
    }
  }
}

function getSingletonStore() {
  if (!globalThis.__codeBuddyBulkImportSingleton) {
    globalThis.__codeBuddyBulkImportSingleton = {
      manager: new CodeBuddyBulkImportManager(),
    };
  }
  return globalThis.__codeBuddyBulkImportSingleton;
}

export function getCodeBuddyBulkImportManager() {
  return getSingletonStore().manager;
}

export {
  buildLookupResponse,
  KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY as CODEBUDDY_BULK_IMPORT_DEFAULT_CONCURRENCY,
  KIRO_BULK_IMPORT_MAX_CONCURRENCY as CODEBUDDY_BULK_IMPORT_MAX_CONCURRENCY,
  KIRO_BULK_IMPORT_MIN_CONCURRENCY as CODEBUDDY_BULK_IMPORT_MIN_CONCURRENCY,
  parseKiroBulkAccounts as parseCodeBuddyBulkAccounts,
};
