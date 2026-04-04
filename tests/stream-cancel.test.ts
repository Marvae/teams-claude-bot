import { describe, it, expect, vi } from "vitest";
import { patchStreamCancellation } from "../src/bot/message.js";

type PatchTarget = Parameters<typeof patchStreamCancellation>[0];

function make403Error(message?: string) {
  const err = new Error("403") as Error & {
    response?: { status: number; data?: { message?: string } };
  };
  err.response = {
    status: 403,
    ...(message ? { data: { message } } : {}),
  };
  return err;
}

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
      if (sendCount >= 2) throw make403Error("Content stream was canceled by user");
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

    // Second send triggers 403 → onCancel called with isUserCancel=true
    await expect(stream.send({})).rejects.toThrow();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith(true);
    expect(stream.queue).toEqual([]);

    // emit() becomes no-op after cancellation
    stream.emit("more text");
    expect(originalEmitCalls).toEqual(["hello"]); // unchanged

    // Further send() throws immediately
    await expect(stream.send({})).rejects.toThrow("Stream canceled");
  });

  it("passes isUserCancel=false for non-user-cancel 403s", async () => {
    let sendCount = 0;
    const { stream } = makeMockStream(async () => {
      sendCount++;
      if (sendCount >= 2)
        throw make403Error("Content stream finished due to exceeded streaming time.");
      return { id: "msg-1" };
    });
    const onCancel = vi.fn();

    patchStreamCancellation(stream as unknown as PatchTarget, onCancel);

    await stream.send({});
    await expect(stream.send({})).rejects.toThrow();
    expect(onCancel).toHaveBeenCalledWith(false);
  });

  it("passes isUserCancel=false for Message size too large", async () => {
    let sendCount = 0;
    const { stream } = makeMockStream(async () => {
      sendCount++;
      if (sendCount >= 2) throw make403Error("Message size too large");
      return { id: "msg-1" };
    });
    const onCancel = vi.fn();

    patchStreamCancellation(stream as unknown as PatchTarget, onCancel);

    await stream.send({});
    await expect(stream.send({})).rejects.toThrow();
    expect(onCancel).toHaveBeenCalledWith(false);
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

  it("non-user-cancel 403 triggers handleStreamExpired via callback", async () => {
    // Simulates real usage: caller uses isUserCancel + streamExpired
    // to decide whether to interrupt or expire the stream.
    const streamExpired = false;
    let sendCount = 0;
    const { stream } = makeMockStream(async () => {
      sendCount++;
      if (sendCount >= 2)
        throw make403Error("Content stream finished due to exceeded streaming time.");
      return { id: "msg-1" };
    });
    const interrupt = vi.fn();
    const expire = vi.fn();

    patchStreamCancellation(stream as unknown as PatchTarget, (isUserCancel) => {
      if (isUserCancel && !streamExpired) {
        interrupt();
      } else {
        expire();
      }
    });

    await stream.send({});
    await expect(stream.send({})).rejects.toThrow();

    expect(interrupt).not.toHaveBeenCalled();
    expect(expire).toHaveBeenCalledTimes(1);
  });
});
