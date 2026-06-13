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
 * Validate that a ck_xxx key looks correct.
 * @param {string} key
 * @returns {boolean}
 */
export function isValidCodeBuddyApiKey(key) {
  return typeof key === "string" && key.startsWith("ck_") && key.length > 10;
}
