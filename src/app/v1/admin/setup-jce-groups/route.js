import { NextResponse } from "next/server";
import { buildModelsList } from "@/app/api/v1/models/route";
import { getCombos, createCombo, updateCombo, getSettings, updateSettings, validateApiKey } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const RAW_GROUPS = {
  "leaf-qd-fallback": { strategy: "fallback", models: ["qd/qmodel_latest", "kr/auto-thinking", "kr/auto"] },
  "leaf-cx-fallback": { strategy: "fallback", models: ["cx/gpt-5.5-review", "cx/gpt-5.5", "cx/gpt-5.4-review", "cx/gpt-5.4", "cx/gpt-5.4-mini-review", "cx/gpt-5.4-mini"] },
  "leaf-kr-deep-fallback": { strategy: "fallback", models: ["kr/claude-sonnet-4.5-thinking-agentic", "kr/claude-sonnet-4.5-thinking", "kr/claude-sonnet-4.5-agentic", "kr/claude-sonnet-4.5", "kr/glm-5-thinking-agentic", "kr/glm-5-agentic", "kr/glm-5"] },
  "leaf-fast-fallback": { strategy: "fallback", models: ["cx/gpt-5.4-mini-review", "cx/gpt-5.4-mini", "kr/glm-5-agentic", "kr/glm-5", "kr/claude-haiku-4.5-agentic", "kr/claude-haiku-4.5", "ag/gemini-3.5-flash-low", "ag/gemini-3.5-flash-extra-low"] },
  "leaf-multimodal-capacity": { strategy: "capacity", models: ["qd/qmodel_latest", "original/gpt-5.5-image", "original/gpt-5.4-image", "original/gpt-5.3-image", "cx/gpt-5.5", "kr/auto-thinking", "kr/auto"] },
  "leaf-longctx-capacity": { strategy: "capacity", models: ["qd/qmodel_latest", "kr/auto-thinking", "kr/auto", "cx/gpt-5.5-review", "cx/gpt-5.5", "kr/claude-sonnet-4.5-thinking-agentic", "kr/glm-5-thinking-agentic"] },
  "fusion-balanced": { strategy: "fusion", models: ["leaf-qd-fallback", "leaf-cx-fallback", "leaf-kr-deep-fallback"], judge: "cx/gpt-5.5-review" },
  "fusion-code": { strategy: "fusion", models: ["leaf-qd-fallback", "leaf-cx-fallback", "kr/qwen3-coder-next-agentic", "kr/glm-5-agentic"], judge: "cx/gpt-5.5-review" },
  "fusion-review-security": { strategy: "fusion", models: ["leaf-cx-fallback", "leaf-qd-fallback", "kr/claude-sonnet-4.5-thinking", "kr/glm-5-thinking-agentic"], judge: "cx/gpt-5.5-review" },
  "jce-default-cheaper": { strategy: "fallback", models: ["leaf-qd-fallback", "leaf-cx-fallback", "leaf-kr-deep-fallback", "leaf-fast-fallback"] },
  "jce-hard": { strategy: "fallback", models: ["fusion-balanced", "fusion-code", "leaf-qd-fallback", "leaf-cx-fallback", "leaf-kr-deep-fallback"] },
  "jce-media": { strategy: "capacity", models: ["leaf-multimodal-capacity", "leaf-qd-fallback", "leaf-cx-fallback"] },
  "jce-review": { strategy: "fallback", models: ["fusion-review-security", "leaf-cx-fallback", "leaf-qd-fallback", "leaf-kr-deep-fallback"] },
  "jce-load-rr": { strategy: "round-robin", models: ["qd/qmodel_latest", "cx/gpt-5.5", "cx/gpt-5.4-review", "kr/glm-5-agentic", "kr/claude-haiku-4.5", "cx/gpt-5.4-mini"] },
};

const GROUP_NAMES = new Set(Object.keys(RAW_GROUPS));
const isForbidden = (id) => id.startsWith("router/") || id.startsWith("account/");
const keyFrom = (request) => request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || request.headers.get("x-api-key") || "";

function validateDag(groups) {
  const errors = [];
  for (const [name, def] of Object.entries(groups)) {
    if (name.startsWith("leaf-") && def.models.some((m) => GROUP_NAMES.has(m))) errors.push(`${name}: leaf contains group`);
    if (name.startsWith("fusion-") && def.models.some((m) => m.startsWith("jce-"))) errors.push(`${name}: fusion contains jce group`);
  }
  const visit = (name, stack = []) => {
    if (stack.includes(name)) errors.push(`cycle: ${[...stack, name].join(" -> ")}`);
    for (const child of groups[name]?.models || []) if (groups[child]) visit(child, [...stack, name]);
  };
  for (const name of Object.keys(groups)) visit(name);
  return errors;
}

export async function POST(request) {
  const apiKey = keyFrom(request);
  if (!apiKey || !(await validateApiKey(apiKey))) return NextResponse.json({ error: "Invalid API key" }, { status: 401 });

  const available = new Set((await buildModelsList(["llm"])).map((m) => m.id));
  const skipped = [];
  const groups = {};
  for (const [name, def] of Object.entries(RAW_GROUPS)) {
    groups[name] = { ...def, models: def.models.filter((model) => {
      if (GROUP_NAMES.has(model)) return true;
      if (isForbidden(model)) { skipped.push({ group: name, model, reason: "router/account models are forbidden" }); return false; }
      if (!available.has(model)) { skipped.push({ group: name, model, reason: "missing from /v1/models" }); return false; }
      return true;
    }) };
    if (groups[name].judge && !available.has(groups[name].judge)) {
      skipped.push({ group: name, model: groups[name].judge, reason: "judge missing from /v1/models" });
      groups[name].judge = groups[name].models.find((m) => !GROUP_NAMES.has(m)) || "";
    }
  }

  const errors = validateDag(groups);
  if (errors.length) return NextResponse.json({ error: "DAG validation failed", errors }, { status: 400 });

  const existing = await getCombos();
  const changed = [];
  for (const [name, def] of Object.entries(groups)) {
    const found = existing.find((c) => c.name === name);
    const data = { name, kind: null, models: def.models };
    if (found) { await updateCombo(found.id, data); changed.push({ name, action: "updated", models: def.models }); }
    else { await createCombo(data); changed.push({ name, action: "created", models: def.models }); }
  }

  const settings = await getSettings();
  const comboStrategies = { ...(settings.comboStrategies || {}) };
  for (const [name, def] of Object.entries(groups)) {
    if (def.strategy === "fusion") comboStrategies[name] = { fallbackStrategy: "fusion", judgeModel: def.judge };
    else if (def.strategy === "round-robin") comboStrategies[name] = { fallbackStrategy: "round-robin" };
    else delete comboStrategies[name];
  }
  await updateSettings({ comboStrategies, comboStickyRoundRobinLimit: 1 });

  return NextResponse.json({ changed, skipped, validation: { ok: true, errors: [] }, recommended: { default: "jce-default-cheaper", hard: "jce-hard", media: "jce-media", review: "jce-review" } });
}
