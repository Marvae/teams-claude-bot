import { describe, it, expect, vi } from "vitest";
import { patchStreamCancellation } from "../src/bot/message.js";

type PatchTarget = Parameters<typeof patchStreamCancellation>[0];

function makeMockStream(sendImpl?: () => Promise<unknown>) {
  let sendCount = 0;
  const originalEmitCalls: unknown[] = [];
  return {
    stream: {
      emit: (activity: unknown) => {
        originalEmitCalls.push(activity);
      },
      send: sendImpl ?? (async () => ({ id: `msg-${++sendCount}` })),
      queue: [1, 2, 3],
    },
    originalEmitCalls,
  };
}

describe("patchStreamCancellation", () => {
  it("calls onCancel when send() returns 403, then blocks further emit/send", async () => {
    let sendCount = 0;
    const { stream, originalEmitCalls } = makeMockStream(async () => {
      sendCount++;
      if (sendCount >= 2) {
        const err = new Error("403") as Error & {
          response?: { status: number };
        };
        err.response = { status: 403 };
        throw err;
      }
      return { id: "msg-1" };
    });
    const onCancel = vi.fn();

    patchStreamCancellation(stream as unknown as PatchTarget, onCancel);

    // First send succeeds
    await stream.send({});
    expect(onCancel).not.toHaveBeenCalled();

    // Emit works before cancellation
    stream.emit("hello");
    expect(originalEmitCalls).toEqual(["hello"]);

    // Second send triggers 403 → onCancel called
    await expect(stream.send({})).rejects.toThrow();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(stream.queue).toEqual([]);

    // emit() becomes no-op after cancellation
    stream.emit("more text");
    expect(originalEmitCalls).toEqual(["hello"]); // unchanged

    // Further send() throws immediately
    await expect(stream.send({})).rejects.toThrow("Stream canceled by user");
  });

  it("ignores non-403 errors", async () => {
    const { stream } = makeMockStream(async () => {
      throw new Error("network timeout");
    });
    const onCancel = vi.fn();

    patchStreamCancellation(stream as unknown as PatchTarget, onCancel);

    await expect(stream.send({})).rejects.toThrow("network timeout");
    expect(onCancel).not.toHaveBeenCalled();

    // emit still works
    stream.emit("text");
  });

  it("does nothing when stream is undefined", () => {
    expect(() => patchStreamCancellation(undefined, vi.fn())).not.toThrow();
  });

  it("does nothing when stream has no internal send()", () => {
    const stream = { emit: vi.fn() };
    expect(() =>
      patchStreamCancellation(stream as unknown as PatchTarget, vi.fn()),
    ).not.toThrow();
    // emit still works as original
    stream.emit("test");
    expect(stream.emit).toHaveBeenCalledWith("test");
  });
});
