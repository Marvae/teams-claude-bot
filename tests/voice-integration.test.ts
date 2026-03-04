import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Attachment, TurnContext } from "botbuilder";

// ---- Mock voice module ----
const mockIsVoiceEnabled = vi.fn();
const mockTranscribeVoiceAttachment = vi.fn();
const mockIsAudioAttachment = vi.fn();

vi.mock("../src/voice/index.js", () => ({
  isVoiceEnabled: (...args: unknown[]) => mockIsVoiceEnabled(...args),
  transcribeVoiceAttachment: (...args: unknown[]) =>
    mockTranscribeVoiceAttachment(...args),
  isAudioAttachment: (...args: unknown[]) => mockIsAudioAttachment(...args),
}));

// ---- Mock fetch for downloadAttachment ----
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { processAttachments } from "../src/bot/attachments.js";

/** Create a minimal TurnContext mock with a bearer token. */
function makeMockCtx(): TurnContext {
  return {
    turnState: {
      get: () => ({ credentials: { token: "test-token" } }),
    },
    adapter: { ConnectorClientKey: "ConnectorClient" },
  } as unknown as TurnContext;
}

/** Create a Teams audio card attachment. */
function makeAudioAttachment(): Attachment {
  return {
    contentType: "application/vnd.microsoft.card.audio",
    content: {
      duration: "PT5S",
      media: [{ url: "https://example.com/voice.ogg" }],
    },
  } as unknown as Attachment;
}

/** Create an image attachment (Teams file download style). */
function makeImageAttachment(name = "photo.png"): Attachment {
  return {
    contentType: "application/vnd.microsoft.teams.file.download.info",
    name,
    content: { downloadUrl: "https://example.com/photo.png" },
  } as unknown as Attachment;
}

/** Create a text file attachment. */
function makeTextAttachment(name = "readme.md"): Attachment {
  return {
    contentType: "application/vnd.microsoft.teams.file.download.info",
    name,
    content: { downloadUrl: "https://example.com/readme.md" },
  } as unknown as Attachment;
}

describe("voice integration in processAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAudioAttachment.mockReset();
    mockIsVoiceEnabled.mockReset();
    mockTranscribeVoiceAttachment.mockReset();
    mockFetch.mockReset();
  });

  it("transcribes audio attachment when voice is enabled", async () => {
    mockIsAudioAttachment.mockReturnValue(true);
    mockIsVoiceEnabled.mockResolvedValue(true);
    mockTranscribeVoiceAttachment.mockResolvedValue(
      "[Voice Transcription]\n\nHello, how are you?",
    );

    const ctx = makeMockCtx();
    const result = await processAttachments(ctx, [makeAudioAttachment()]);

    expect(result.textSnippets).toHaveLength(1);
    expect(result.textSnippets[0]).toContain("Hello, how are you?");
    expect(result.hasVoiceTranscript).toBe(true);
    expect(result.unsupported).toHaveLength(0);

    // Verify transcribeVoiceAttachment was called with attachment + token
    expect(mockTranscribeVoiceAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "application/vnd.microsoft.card.audio",
      }),
      "test-token",
    );

    // Should NOT attempt to download the audio via regular downloadAttachment
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("marks unsupported when voice is disabled", async () => {
    mockIsAudioAttachment.mockReturnValue(true);
    mockIsVoiceEnabled.mockResolvedValue(false);

    const ctx = makeMockCtx();
    const result = await processAttachments(ctx, [makeAudioAttachment()]);

    expect(result.textSnippets).toHaveLength(0);
    expect(result.hasVoiceTranscript).toBe(false);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]).toContain("voice message");
    expect(result.unsupported[0]).toContain("setup-voice");

    // Should NOT call transcribe when disabled
    expect(mockTranscribeVoiceAttachment).not.toHaveBeenCalled();
  });

  it("marks unsupported when transcription returns null", async () => {
    mockIsAudioAttachment.mockReturnValue(true);
    mockIsVoiceEnabled.mockResolvedValue(true);
    mockTranscribeVoiceAttachment.mockResolvedValue(null);

    const ctx = makeMockCtx();
    const result = await processAttachments(ctx, [makeAudioAttachment()]);

    expect(result.textSnippets).toHaveLength(0);
    expect(result.hasVoiceTranscript).toBe(false);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]).toBe("voice message");
  });

  it("marks unsupported with error message when transcription throws", async () => {
    mockIsAudioAttachment.mockReturnValue(true);
    mockIsVoiceEnabled.mockResolvedValue(true);
    mockTranscribeVoiceAttachment.mockRejectedValue(
      new Error("Whisper crashed"),
    );

    const ctx = makeMockCtx();
    const result = await processAttachments(ctx, [makeAudioAttachment()]);

    expect(result.textSnippets).toHaveLength(0);
    expect(result.hasVoiceTranscript).toBe(false);
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]).toBe(
      "voice message (transcription failed)",
    );
  });

  it("handles mixed attachments: audio + image", async () => {
    // Audio attachment recognized as audio
    mockIsAudioAttachment.mockImplementation(
      (ct: string) => ct === "application/vnd.microsoft.card.audio",
    );
    mockIsVoiceEnabled.mockResolvedValue(true);
    mockTranscribeVoiceAttachment.mockResolvedValue(
      "[Voice]\n\nTranscribed text",
    );

    // Image attachment: mock fetch for downloadAttachment
    const imageBuffer = Buffer.from("fake-png-data");
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imageBuffer.buffer),
      headers: new Map([["content-type", "image/png"]]),
    });

    const ctx = makeMockCtx();
    const result = await processAttachments(ctx, [
      makeAudioAttachment(),
      makeImageAttachment(),
    ]);

    // Voice was transcribed
    expect(result.textSnippets).toHaveLength(1);
    expect(result.textSnippets[0]).toContain("Transcribed text");
    expect(result.hasVoiceTranscript).toBe(true);

    // Image was processed
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mediaType).toBe("image/png");

    expect(result.unsupported).toHaveLength(0);
  });

  it("handles mixed attachments: audio + text file", async () => {
    mockIsAudioAttachment.mockImplementation(
      (ct: string) => ct === "application/vnd.microsoft.card.audio",
    );
    mockIsVoiceEnabled.mockResolvedValue(true);
    mockTranscribeVoiceAttachment.mockResolvedValue(
      "[Voice]\n\nHello from voice",
    );

    // Text file: mock fetch for downloadAttachment
    const textBuffer = Buffer.from("# README\nHello");
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(textBuffer.buffer),
      headers: new Map([["content-type", "text/plain"]]),
    });

    const ctx = makeMockCtx();
    const result = await processAttachments(ctx, [
      makeAudioAttachment(),
      makeTextAttachment(),
    ]);

    // Voice transcript + text file both in textSnippets
    expect(result.textSnippets).toHaveLength(2);
    expect(result.textSnippets[0]).toContain("Hello from voice");
    expect(result.textSnippets[1]).toContain("readme.md");
    expect(result.textSnippets[1]).toContain("# README");
    expect(result.hasVoiceTranscript).toBe(true);
  });

  it("non-audio attachments are not affected by voice logic", async () => {
    // Nothing is an audio attachment
    mockIsAudioAttachment.mockReturnValue(false);

    // Image download
    const imageBuffer = Buffer.from("fake-png-data");
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imageBuffer.buffer),
      headers: new Map([["content-type", "image/png"]]),
    });

    const ctx = makeMockCtx();
    const result = await processAttachments(ctx, [makeImageAttachment()]);

    expect(result.images).toHaveLength(1);
    expect(result.hasVoiceTranscript).toBe(false);

    // Voice module should not be called for non-audio
    expect(mockIsVoiceEnabled).not.toHaveBeenCalled();
    expect(mockTranscribeVoiceAttachment).not.toHaveBeenCalled();
  });

  it("hasVoiceTranscript defaults to false when no attachments", async () => {
    const ctx = makeMockCtx();
    const result = await processAttachments(ctx, []);

    expect(result.hasVoiceTranscript).toBe(false);
    expect(result.textSnippets).toHaveLength(0);
    expect(result.images).toHaveLength(0);
    expect(result.unsupported).toHaveLength(0);
  });
});
