import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import {
  checkFallbackError,
  isCodeBuddyTrialNotActivatedError,
} from "../../open-sse/services/accountFallback.js";

describe("CodeBuddy runtime mitigation", () => {
  it("sends generated API keys as both Bearer and X-Api-Key", () => {
    const executor = new DefaultExecutor("codebuddy");
    const headers = executor.buildHeaders({
      authType: "apikey",
      apiKey: "ck_test.secret",
      providerSpecificData: { domain: "www.codebuddy.ai" },
    }, true);

    expect(headers.Authorization).toBe("Bearer ck_test.secret");
    expect(headers["X-Api-Key"]).toBe("ck_test.secret");
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["X-Domain"]).toBe("www.codebuddy.ai");
  });

  it("detects CodeBuddy trial-not-activated responses as terminal account failures", () => {
    const errorText = '{"error":{"data":{"code":14017,"msg":"The trial version is not yet activated."}}}';

    expect(isCodeBuddyTrialNotActivatedError(429, errorText)).toBe(true);

    const fallback = checkFallbackError(429, errorText, 2);
    expect(fallback.shouldFallback).toBe(true);
    expect(fallback.terminalReason).toBe("codebuddy_trial_not_activated");
    expect(fallback.cooldownMs).toBeGreaterThan(30 * 24 * 60 * 60 * 1000);
  });
});
