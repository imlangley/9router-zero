/**
 * CodeBuddy API Key Generation Module
 *
 * Creates permanent API keys (ck_xxx) via the CodeBuddy console API
 * using session cookies captured from browser login.
 *
 * Endpoint: POST https://www.codebuddy.ai/console/api/client/v1/api-keys
 * Auth: Cookie-based (session cookies from web login)
 * Response: { code: 0, data: { key: "ck_xxx.yyy", key_id: "ck_xxx", expires_at: "9999-12-30..." } }
 */

const CODEBUDDY_API_KEY_URL = "https://www.codebuddy.ai/console/api/client/v1/api-keys";
const CODEBUDDY_DOMAIN = "www.codebuddy.ai";
const CODEBUDDY_ENTERPRISE_ID = "personal-edition-user-id";
const DEFAULT_KEY_NAME_PREFIX = "9r";

const CODEBUDDY_TRIAL_URL = "https://www.codebuddy.ai/billing/ide/trial";
const CODEBUDDY_BILLING_OPEN_URL = "https://www.codebuddy.ai/billing/pay/get-billing-account-inner";
const CODEBUDDY_AREA_INFO_URL = "https://www.codebuddy.ai/billing/area/get-user-area-info";
const CODEBUDDY_HOME_URL = "https://www.codebuddy.ai/home";
const CODEBUDDY_TRIAL_ALREADY_APPLIED_CODE = 14051;

/**
 * Generate a CodeBuddy API key using session cookies.
 *
 * @param {string} cookieString - Full cookie string (e.g. "session=abc; session_2=def; _TDID_CK=ghi")
 * @param {object} [options]
 * @param {string} [options.name] - Key name (default: "9r-{timestamp}")
 * @param {number} [options.expireInDays] - Expiry in days (-1 = never, default: -1)
 * @param {string} [options.userEnterpriseId] - Enterprise ID (default: "personal-edition-user-id")
 * @param {string} [options.domain] - CodeBuddy domain (default: "www.codebuddy.ai")
 * @returns {Promise<{success: boolean, key?: string, keyId?: string, expiresAt?: string, error?: string}>}
 */
export async function generateCodeBuddyApiKey(cookieString, options = {}) {
  if (!cookieString || typeof cookieString !== "string") {
    return { success: false, error: "cookieString is required" };
  }

  const {
    name = `${DEFAULT_KEY_NAME_PREFIX}-${Date.now().toString(36)}`,
    expireInDays = -1,
    userEnterpriseId = CODEBUDDY_ENTERPRISE_ID,
    domain = CODEBUDDY_DOMAIN,
  } = options;

  const body = {
    name,
    expire_in_days: expireInDays,
    user_enterprise_id: userEnterpriseId,
  };

  try {
    const response = await fetch(CODEBUDDY_API_KEY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: cookieString,
        "X-Domain": domain,
        "X-Requested-With": "XMLHttpRequest",
        "X-Product": "SaaS",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: `https://${domain}/profile/keys`,
        Origin: `https://${domain}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        success: false,
        error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await response.json();

    if (data.code !== 0 || !data.data?.key) {
      return {
        success: false,
        error: `API error (code=${data.code}): ${data.msg || JSON.stringify(data).slice(0, 200)}`,
      };
    }

    return {
      success: true,
      key: data.data.key,
      keyId: data.data.key_id,
      expiresAt: data.data.expires_at,
      name,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Network error during API key generation",
    };
  }
}

/**
 * Generate a CodeBuddy API key from a Playwright browser context.
 * Extracts cookies from the context and calls generateCodeBuddyApiKey.
 *
 * @param {import('playwright').BrowserContext} context - Playwright browser context
 * @param {object} [options] - Same options as generateCodeBuddyApiKey
 * @returns {Promise<{success: boolean, key?: string, keyId?: string, expiresAt?: string, cookieString?: string, error?: string}>}
 */
export async function generateCodeBuddyApiKeyFromContext(context, options = {}) {
  if (!context?.cookies) {
    return { success: false, error: "Playwright context.cookies not available" };
  }

  try {
    const cookies = await context.cookies([
      "https://www.codebuddy.ai",
      "https://codebuddy.ai",
    ]);

    const usefulCookies = cookies
      .filter((c) => {
        const domain = String(c.domain || "").replace(/^\./, "").toLowerCase();
        return domain === "codebuddy.ai"
          || domain === "www.codebuddy.ai"
          || domain.endsWith(".codebuddy.ai");
      })
      .filter((c) => c.name && c.value);

    if (usefulCookies.length === 0) {
      return {
        success: false,
        error: `No CodeBuddy cookies found in context. Raw: ${cookies.map((c) => `${c.name}@${c.domain}`).join(", ")}`,
      };
    }

    const cookieString = usefulCookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const {
      name = `${DEFAULT_KEY_NAME_PREFIX}-${Date.now().toString(36)}`,
      expireInDays = -1,
      userEnterpriseId = CODEBUDDY_ENTERPRISE_ID,
      domain = CODEBUDDY_DOMAIN,
    } = options;

    const body = {
      name,
      expire_in_days: expireInDays,
      user_enterprise_id: userEnterpriseId,
    };

    // Prefer Playwright's APIRequestContext because it shares the same browser
    // context cookie jar. Manual testing showed restricted accounts can still
    // generate keys when replayed from the browser session, while Node fetch
    // with a hand-built Cookie header may receive 401.
    if (context.request?.post) {
      const response = await context.request.post(CODEBUDDY_API_KEY_URL, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-GB,en;q=0.5",
          "Content-Type": "application/json",
          Origin: `https://${domain}`,
          Referer: `https://${domain}/profile/keys`,
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "Sec-GPC": "1",
        },
        data: body,
        timeout: 30_000,
      });

      const text = await response.text().catch(() => "");
      if (!response.ok()) {
        return {
          success: false,
          error: `HTTP ${response.status()}: ${text.slice(0, 300)}`,
          cookieString,
        };
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return {
          success: false,
          error: `Invalid JSON response: ${text.slice(0, 300)}`,
          cookieString,
        };
      }

      if (data.code !== 0 || !data.data?.key) {
        return {
          success: false,
          error: `API error (code=${data.code}): ${data.msg || JSON.stringify(data).slice(0, 300)}`,
          cookieString,
        };
      }

      return {
        success: true,
        key: data.data.key,
        keyId: data.data.key_id,
        expiresAt: data.data.expires_at,
        name,
        cookieString,
      };
    }

    const result = await generateCodeBuddyApiKey(cookieString, options);
    return { ...result, cookieString };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Failed to extract cookies from context",
    };
  }
}

/**
 * Activate the CodeBuddy free trial for the currently logged-in account.
 *
 * Sequence (mirrors what the real browser does on /home hydration):
 *   1. POST /billing/area/get-user-area-info  -> resolves country from IP
 *   2. POST /billing/ide/trial                -> applies free trial (idempotent)
 *   3. POST /billing/pay/get-billing-account-inner {IsAutoOpenAccount:1} -> opens billing slot
 *
 * Returns rich status so callers can decide whether to issue an API key.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{
 *   success: boolean,
 *   trialStatus: "activated" | "already_applied" | "failed" | "skipped",
 *   billingOpened: boolean,
 *   areaResolved: boolean,
 *   error?: string,
 *   trialResponse?: any,
 *   billingResponse?: any
 * }>}
 */
export async function applyCodeBuddyTrial(page) {
  if (!page?.evaluate) {
    return {
      success: false,
      trialStatus: "skipped",
      billingOpened: false,
      areaResolved: false,
      error: "Playwright page.evaluate not available",
    };
  }

  try {
    const currentUrl = page.url();
    if (!currentUrl.startsWith("https://www.codebuddy.ai/")) {
      await page.goto(CODEBUDDY_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }).catch(() => null);
    }

    return await page.evaluate(async (urls) => {
      const TRIAL_ALREADY_APPLIED = 14051;
      const safeJson = async (response) => {
        const text = await response.text().catch(() => "");
        try { return { text, json: JSON.parse(text) }; }
        catch { return { text, json: null }; }
      };

      const result = {
        success: false,
        trialStatus: "failed",
        billingOpened: false,
        areaResolved: false,
        trialResponse: null,
        billingResponse: null,
      };

      // Step 1: resolve user area (best-effort; backend region pin)
      try {
        const areaRes = await fetch(urls.area, {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            Origin: "https://www.codebuddy.ai",
            Referer: "https://www.codebuddy.ai/register/user/complete",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify({ action: "getUserAreaInfo" }),
        });
        const { json: areaJson } = await safeJson(areaRes);
        result.areaResolved = areaRes.ok && areaJson?.code === 0;
      } catch {
        result.areaResolved = false;
      }

      // Step 2: apply trial (idempotent — 14051 means already applied)
      try {
        const trialRes = await fetch(urls.trial, {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            Origin: "https://www.codebuddy.ai",
            Referer: "https://www.codebuddy.ai/home",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
          },
          body: "",
        });
        const { json: trialJson, text: trialText } = await safeJson(trialRes);
        result.trialResponse = trialJson || trialText.slice(0, 200);

        if (trialRes.ok && trialJson?.code === 0) {
          result.trialStatus = "activated";
        } else if (trialJson?.code === TRIAL_ALREADY_APPLIED) {
          result.trialStatus = "already_applied";
        } else {
          result.trialStatus = "failed";
          result.error = `Trial activation failed (code=${trialJson?.code}): ${trialJson?.msg || trialText.slice(0, 200)}`;
          return result;
        }
      } catch (error) {
        result.trialStatus = "failed";
        result.error = `Trial activation network error: ${error.message}`;
        return result;
      }

      // Step 3: auto-open billing slot
      try {
        const billingRes = await fetch(urls.billing, {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            Origin: "https://www.codebuddy.ai",
            Referer: "https://www.codebuddy.ai/home",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify({ IsAutoOpenAccount: 1 }),
        });
        const { json: billingJson, text: billingText } = await safeJson(billingRes);
        result.billingResponse = billingJson || billingText.slice(0, 200);
        const isOpen = Boolean(billingJson?.data?.Response?.IsOpen);
        result.billingOpened = billingRes.ok && billingJson?.code === 0 && isOpen;

        if (!result.billingOpened) {
          result.error = result.error
            || `Billing not opened (code=${billingJson?.code}): ${billingJson?.msg || billingText.slice(0, 200)}`;
        }
      } catch (error) {
        result.error = result.error || `Billing open network error: ${error.message}`;
      }

      result.success = (result.trialStatus === "activated" || result.trialStatus === "already_applied")
        && result.billingOpened;
      return result;
    }, {
      area: CODEBUDDY_AREA_INFO_URL,
      trial: CODEBUDDY_TRIAL_URL,
      billing: CODEBUDDY_BILLING_OPEN_URL,
    });
  } catch (error) {
    return {
      success: false,
      trialStatus: "failed",
      billingOpened: false,
      areaResolved: false,
      error: error.message || "Failed to apply CodeBuddy trial",
    };
  }
}

/**
 * Generate a CodeBuddy API key from inside the active CodeBuddy page.
 * This is closest to the manual DevTools/curl replay: browser origin,
 * browser cookie jar, credentials: include, and same-origin fetch.
 *
 * Now also activates the free trial + opens billing before issuing the
 * key so accounts do not return code:14017 on first chat.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   key?: string,
 *   keyId?: string,
 *   expiresAt?: string,
 *   error?: string,
 *   trialStatus?: "activated" | "already_applied" | "failed" | "skipped",
 *   billingOpened?: boolean
 * }>}
 */
export async function generateCodeBuddyApiKeyFromPage(page, options = {}) {
  if (!page?.evaluate) {
    return { success: false, error: "Playwright page.evaluate not available" };
  }

  const {
    name = `${DEFAULT_KEY_NAME_PREFIX}-${Date.now().toString(36)}`,
    expireInDays = -1,
    userEnterpriseId = CODEBUDDY_ENTERPRISE_ID,
    skipTrialActivation = false,
  } = options;

  let trialResult = { trialStatus: "skipped", billingOpened: false };

  try {
    const currentUrl = page.url();
    if (!currentUrl.startsWith("https://www.codebuddy.ai/")) {
      await page.goto("https://www.codebuddy.ai/no-permission?errCode=12154", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }).catch(() => null);
    }

    if (!skipTrialActivation) {
      trialResult = await applyCodeBuddyTrial(page);
    }

    const keyResult = await page.evaluate(async ({ requestUrl, requestBody, keyName }) => {
      const response = await fetch(requestUrl, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify(requestBody),
      });

      const text = await response.text();
      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${text.slice(0, 300)}`,
        };
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return {
          success: false,
          error: `Invalid JSON response: ${text.slice(0, 300)}`,
        };
      }

      if (data.code !== 0 || !data.data?.key) {
        return {
          success: false,
          error: `API error (code=${data.code}): ${data.msg || JSON.stringify(data).slice(0, 300)}`,
        };
      }

      return {
        success: true,
        key: data.data.key,
        keyId: data.data.key_id,
        expiresAt: data.data.expires_at,
        name: keyName,
      };
    }, {
      requestUrl: CODEBUDDY_API_KEY_URL,
      requestBody: {
        name,
        expire_in_days: expireInDays,
        user_enterprise_id: userEnterpriseId,
      },
      keyName: name,
    });

    return {
      ...keyResult,
      trialStatus: trialResult.trialStatus || "skipped",
      billingOpened: Boolean(trialResult.billingOpened),
      trialError: trialResult.error || null,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Failed to generate API key from browser page",
      trialStatus: trialResult.trialStatus || "skipped",
      billingOpened: Boolean(trialResult.billingOpened),
      trialError: trialResult.error || null,
    };
  }
}

/**
 * Delete a known CodeBuddy API key from the active browser session.
 * Best-effort cleanup for 9Router-generated keys before re-adding the same
 * account. It intentionally only accepts key IDs (ck_xxx), not full secrets.
 *
 * @param {import('playwright').Page} page
 * @param {string} keyId
 * @param {object} [options]
 * @param {string} [options.userEnterpriseId]
 * @returns {Promise<{success: boolean, skipped?: boolean, error?: string, code?: number}>}
 */
export async function deleteCodeBuddyApiKeyFromPage(page, keyId, options = {}) {
  if (!page?.evaluate) {
    return { success: false, error: "Playwright page.evaluate not available" };
  }

  const normalizedKeyId = typeof keyId === "string" ? keyId.trim() : "";
  if (!normalizedKeyId || !normalizedKeyId.startsWith("ck_")) {
    return { success: false, skipped: true, error: "CodeBuddy key id is missing or invalid" };
  }

  const { userEnterpriseId = CODEBUDDY_ENTERPRISE_ID } = options;
  const deleteUrl = `${CODEBUDDY_API_KEY_URL}/${encodeURIComponent(normalizedKeyId)}/delete`;

  try {
    const currentUrl = page.url();
    if (!currentUrl.startsWith("https://www.codebuddy.ai/")) {
      await page.goto("https://www.codebuddy.ai/profile/keys", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      }).catch(() => null);
    }

    return await page.evaluate(async ({ requestUrl, requestBody }) => {
      const response = await fetch(requestUrl, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Origin: "https://www.codebuddy.ai",
          Referer: "https://www.codebuddy.ai/profile/keys",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify(requestBody),
      });

      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
      }
      if (data && data.code !== 0) {
        return { success: false, code: data.code, error: data.msg || text.slice(0, 300) };
      }
      return { success: true, code: data?.code ?? 0 };
    }, {
      requestUrl: deleteUrl,
      requestBody: { user_enterprise_id: userEnterpriseId },
    });
  } catch (error) {
    return { success: false, error: error.message || "Failed to delete CodeBuddy API key" };
  }
}

/**
 * Validate that a ck_xxx key looks correct.
 * @param {string} key
 * @returns {boolean}
 */
export function isValidCodeBuddyApiKey(key) {
  return typeof key === "string" && key.startsWith("ck_") && key.length > 10;
}
