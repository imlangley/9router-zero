import { describe, expect, it } from "vitest";

import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function drain(readable) {
  const reader = readable.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

function streamFromText(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function assertOpenAISSETerminalInvariants(out) {
  const frames = out.split("\n\n").filter(Boolean);
  expect(frames.every((frame) => frame.startsWith("data: "))).toBe(true);
  const payloads = frames.map((frame) => frame.slice("data: ".length));
  const doneIndexes = payloads
    .map((payload, index) => payload === "[DONE]" ? index : -1)
    .filter((index) => index !== -1);

  expect(doneIndexes).toHaveLength(1);
  expect(doneIndexes[0]).toBe(payloads.length - 1);
  expect(out).not.toMatch(/data: \[DONE\]\n(?:\{|data: \{)/);

  for (const payload of payloads.slice(0, -1)) {
    expect(() => JSON.parse(payload)).not.toThrow();
  }
}

describe("OpenAI-compatible SSE terminal framing", () => {
  it("passthrough emits one terminal [DONE] after all JSON chunks", async () => {
    const upstream = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
    ].join("");

    const out = await drain(streamFromText(upstream).pipeThrough(createPassthroughStreamWithLogger("test")));

    expect(out).not.toContain("late");
    assertOpenAISSETerminalInvariants(out);
  });

  it("translated OpenAI streams ignore chunks after upstream [DONE]", async () => {
    const upstream = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
    ].join("");

    const out = await drain(
      streamFromText(upstream).pipeThrough(
        createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI, "test")
      )
    );

    expect(out).not.toContain("late");
    assertOpenAISSETerminalInvariants(out);
  });

  it("translated streams flush final JSON chunks before client [DONE]", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_1", model: "claude-opus-4-8" } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const upstream = [
      ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
      "data: [DONE]\n\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"late"}}\n\n',
    ].join("");

    const out = await drain(
      streamFromText(upstream).pipeThrough(
        createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "test")
      )
    );

    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).not.toContain("late");
    assertOpenAISSETerminalInvariants(out);
  });
});
