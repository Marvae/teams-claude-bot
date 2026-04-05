import { describe, it, expect, vi } from "vitest";
import {
  createStreamingProgress,
  createProactiveProgress,
} from "../src/bot/bridge.js";
import type { ProgressEvent } from "../src/claude/agent.js";

// Minimal mock for IStreamer
function mockStreamer() {
  const emitted: unknown[] = [];
  return {
    emit: vi.fn((activity: unknown) => {
      emitted.push(activity);
    }),
    emitted,
  };
}

// Small valid PNG base64 (10x10 red square)
const SMALL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVQYV2P8z8Dwn4EIwDiqEF8oAQBf9AoL/k2CEAAAAABJRU5ErkJggg==";

function makeImageEvent(
  overrides: Partial<Extract<ProgressEvent, { type: "image" }>> = {},
): Extract<ProgressEvent, { type: "image" }> {
  return {
    type: "image",
    base64: SMALL_PNG_B64,
    mimeType: "image/png",
    sizeBytes: 100,
    ...overrides,
  };
}

describe("createStreamingProgress — image handling", () => {
  it("emits inline attachment for small images", () => {
    const stream = mockStreamer();
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const { onProgress } = createStreamingProgress(stream as never, sendFn);

    const event = makeImageEvent({ name: "screenshot.png" });
    onProgress(event);

    expect(stream.emit).toHaveBeenCalledWith({
      type: "message",
      attachments: [
        {
          contentType: "image/png",
          contentUrl: `data:image/png;base64,${SMALL_PNG_B64}`,
          name: "screenshot.png",
        },
      ],
    });
  });

  it("uses default name when name is not provided", () => {
    const stream = mockStreamer();
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const { onProgress } = createStreamingProgress(stream as never, sendFn);

    onProgress(makeImageEvent());

    expect(stream.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ name: "image.png" })],
      }),
    );
  });

  it("emits warning text for images >= 4MB", () => {
    const stream = mockStreamer();
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const { onProgress } = createStreamingProgress(stream as never, sendFn);

    const event = makeImageEvent({ sizeBytes: 5 * 1024 * 1024 });
    onProgress(event);

    // Should NOT emit an attachment
    expect(stream.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachments: expect.anything() }),
    );
  });
});

describe("createProactiveProgress — image handling", () => {
  it("sends inline attachment for small images", () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const { onProgress } = createProactiveProgress(sendFn);

    const event = makeImageEvent({ name: "test.png" });
    onProgress(event);

    expect(sendFn).toHaveBeenCalledTimes(1);
    const activity = sendFn.mock.calls[0][0];
    // MessageActivity wraps attachments — check it was called
    expect(activity).toBeDefined();
  });

  it("sends warning for images >= 4MB", () => {
    const sendFn = vi.fn().mockResolvedValue(undefined);
    const { onProgress } = createProactiveProgress(sendFn);

    const event = makeImageEvent({ sizeBytes: 4 * 1024 * 1024 });
    onProgress(event);

    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("catches send errors without throwing", async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error("send failed"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { onProgress } = createProactiveProgress(sendFn);

    onProgress(makeImageEvent());

    // Give the .catch() time to execute
    await new Promise((r) => setTimeout(r, 10));

    expect(consoleError).toHaveBeenCalledWith(
      "[BRIDGE] image send failed:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
