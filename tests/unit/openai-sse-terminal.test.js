import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function streamFromText(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function drain(readable) {
  const reader = readable.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("OpenAI-compatible translated SSE terminal framing", () => {
  it("does not inject [DONE] into Claude-to-OpenAI translated streams", async () => {
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
    ].join("");

    const out = await drain(
      streamFromText(upstream).pipeThrough(
        createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "test"),
      ),
    );

    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).not.toContain("data: [DONE]");
  });
});

describe("OpenAI-compatible passthrough SSE terminal framing", () => {
  it("moves upstream [DONE] after late custom-provider chunks", async () => {
    const upstream = [
      'data: {"model":"claude-opus-4-8","choices":[{"index":0,"delta":{"content":"Hey."}}],"object":"chat.completion.chunk","created":1782467929}\n\n',
      "data: [DONE]\n\n",
      'data: {"model":"claude-opus-4-8","choices":[{"index":0,"delta":{"content":"late"}}],"object":"chat.completion.chunk","created":1782467929}\n\n',
    ].join("");

    const out = await drain(
      streamFromText(upstream).pipeThrough(
        createPassthroughStreamWithLogger("test"),
      ),
    );

    expect(out).toContain('"content":"Hey."');
    expect(out).toContain('"content":"late"');
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(out.trim().endsWith("data: [DONE]")).toBe(true);
  });
});
