import { DefaultExecutor } from "./default.js";
import { resolveXiaomiTokenplanBaseUrl } from "../config/providers.js";

export class XiaomiTokenplanExecutor extends DefaultExecutor {
  constructor() {
    super("xiaomi-tokenplan");
  }

  // Token Plan keys are region-specific — always OpenAI-compatible /chat/completions
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const baseUrl = resolveXiaomiTokenplanBaseUrl(credentials);
    return `${baseUrl}/chat/completions`;
  }
}
