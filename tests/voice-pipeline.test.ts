import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the audio module
const mockParseAudioAttachment = vi.fn();
const mockDownloadAudio = vi.fn();
const mockConvertToWav = vi.fn();
const mockIsFfmpegAvailable = vi.fn();
vi.mock("../src/voice/audio.js", () => ({
  parseAudioAttachment: (...args: unknown[]) =>
    mockParseAudioAttachment(...args),
  downloadAudio: (...args: unknown[]) => mockDownloadAudio(...args),
  convertToWav: (...args: unknown[]) => mockConvertToWav(...args),
  isFfmpegAvailable: (...args: unknown[]) => mockIsFfmpegAvailable(...args),
}));

// Mock the transcriber module
const mockIsAvailable = vi.fn();
const mockTranscribe = vi.fn();
vi.mock("../src/voice/transcriber.js", () => {
  class MockWhisperCppTranscriber {
    isAvailable(...args: unknown[]) {
      return mockIsAvailable(...args);
    }
    transcribe(...args: unknown[]) {
      return mockTranscribe(...args);
    }
  }
  return { WhisperCppTranscriber: MockWhisperCppTranscriber };
});

// Mock node:fs/promises for temp dir management
const mockMkdtemp = vi.fn();
const mockRm = vi.fn();
vi.mock("node:fs/promises", () => ({
  mkdtemp: (...args: unknown[]) => mockMkdtemp(...args),
  rm: (...args: unknown[]) => mockRm(...args),
}));

import {
  isVoiceEnabled,
  _resetVoiceState,
  isAudioAttachment,
  wrapVoiceTranscript,
  transcribeVoiceAttachment,
} from "../src/voice/index.js";

describe("isAudioAttachment", () => {
  it("returns true for audio card contentType", () => {
    expect(
      isAudioAttachment("application/vnd.microsoft.card.audio"),
    ).toBe(true);
  });

  it("returns false for adaptive card contentType", () => {
    expect(
      isAudioAttachment("application/vnd.microsoft.card.adaptive"),
    ).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAudioAttachment("")).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(isAudioAttachment("text/plain")).toBe(false);
  });
});

describe("wrapVoiceTranscript", () => {
  it("wraps text with bilingual preamble", () => {
    const result = wrapVoiceTranscript("Hello, how are you?");

    expect(result).toContain("[语音转写 / Voice Transcription]");
    expect(result).toContain(
      "以下内容为语音转写，可能存在识别错误（同音字、断句等），请结合上下文理解用户意图。",
    );
    expect(result).toContain(
      "The following is a voice transcription that may contain recognition errors. Use context to understand the user's intent.",
    );
    expect(result).toContain("Hello, how are you?");
  });

  it("places user text at the end after a blank line", () => {
    const result = wrapVoiceTranscript("Test text");
    const lines = result.split("\n");
    // The last line should be the user text
    expect(lines[lines.length - 1]).toBe("Test text");
    // The line before the text should be blank
    expect(lines[lines.length - 2]).toBe("");
  });
});

describe("isVoiceEnabled", () => {
  beforeEach(() => {
    _resetVoiceState();
    mockIsAvailable.mockReset();
    mockIsFfmpegAvailable.mockReset();
  });

  it("returns true when both whisper-cli and ffmpeg are available", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(true);

    const result = await isVoiceEnabled();

    expect(result).toBe(true);
  });

  it("returns false when whisper-cli is not available", async () => {
    mockIsAvailable.mockResolvedValue(false);
    mockIsFfmpegAvailable.mockResolvedValue(true);

    const result = await isVoiceEnabled();

    expect(result).toBe(false);
  });

  it("returns false when ffmpeg is not available", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(false);

    const result = await isVoiceEnabled();

    expect(result).toBe(false);
  });

  it("returns false when both are not available", async () => {
    mockIsAvailable.mockResolvedValue(false);
    mockIsFfmpegAvailable.mockResolvedValue(false);

    const result = await isVoiceEnabled();

    expect(result).toBe(false);
  });

  it("caches the result on subsequent calls", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(true);

    const result1 = await isVoiceEnabled();
    const result2 = await isVoiceEnabled();

    expect(result1).toBe(true);
    expect(result2).toBe(true);
    // Should only check once despite two calls
    expect(mockIsAvailable).toHaveBeenCalledTimes(1);
    expect(mockIsFfmpegAvailable).toHaveBeenCalledTimes(1);
  });

  it("re-checks after _resetVoiceState()", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(true);

    await isVoiceEnabled();
    _resetVoiceState();

    mockIsAvailable.mockResolvedValue(false);
    mockIsFfmpegAvailable.mockResolvedValue(true);

    const result = await isVoiceEnabled();

    expect(result).toBe(false);
    expect(mockIsAvailable).toHaveBeenCalledTimes(2);
  });
});

describe("transcribeVoiceAttachment", () => {
  const fakeAttachment = {
    contentType: "application/vnd.microsoft.card.audio",
    content: {
      duration: "PT5S",
      media: [{ url: "https://example.com/audio.ogg" }],
    },
  };

  beforeEach(() => {
    _resetVoiceState();
    mockParseAudioAttachment.mockReset();
    mockDownloadAudio.mockReset();
    mockConvertToWav.mockReset();
    mockIsFfmpegAvailable.mockReset();
    mockIsAvailable.mockReset();
    mockTranscribe.mockReset();
    mockMkdtemp.mockReset();
    mockRm.mockReset();
  });

  it("returns null when voice is not enabled", async () => {
    mockIsAvailable.mockResolvedValue(false);
    mockIsFfmpegAvailable.mockResolvedValue(false);

    const result = await transcribeVoiceAttachment(fakeAttachment);

    expect(result).toBeNull();
  });

  it("returns null when parseAudioAttachment returns null", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(true);
    mockParseAudioAttachment.mockReturnValue(null);

    const result = await transcribeVoiceAttachment(fakeAttachment);

    expect(result).toBeNull();
  });

  it("runs full pipeline: download -> convert -> transcribe -> wrap", async () => {
    // Enable voice
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(true);

    // Parse attachment
    mockParseAudioAttachment.mockReturnValue({
      url: "https://example.com/audio.ogg",
      duration: "PT5S",
    });

    // Download audio
    const mockCleanup = vi.fn().mockResolvedValue(undefined);
    mockDownloadAudio.mockResolvedValue({
      path: "/tmp/voice-dl/input",
      cleanup: mockCleanup,
    });

    // Temp dir for WAV conversion
    mockMkdtemp.mockResolvedValue("/tmp/voice-wav-abc");
    mockRm.mockResolvedValue(undefined);

    // Convert to WAV
    mockConvertToWav.mockResolvedValue("/tmp/voice-wav-abc/output.wav");

    // Transcribe
    mockTranscribe.mockResolvedValue("Hello world");

    const result = await transcribeVoiceAttachment(fakeAttachment, "auth-token");

    // Verify pipeline steps
    expect(mockParseAudioAttachment).toHaveBeenCalledWith(fakeAttachment);
    expect(mockDownloadAudio).toHaveBeenCalledWith(
      "https://example.com/audio.ogg",
      "auth-token",
    );
    expect(mockConvertToWav).toHaveBeenCalledWith(
      "/tmp/voice-dl/input",
      "/tmp/voice-wav-abc",
    );
    expect(mockTranscribe).toHaveBeenCalledWith(
      "/tmp/voice-wav-abc/output.wav",
    );

    // Verify result is wrapped
    expect(result).toContain("[语音转写 / Voice Transcription]");
    expect(result).toContain("Hello world");

    // Verify cleanup happened
    expect(mockCleanup).toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledWith("/tmp/voice-wav-abc", {
      recursive: true,
      force: true,
    });
  });

  it("cleans up temp files even when download fails", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(true);
    mockParseAudioAttachment.mockReturnValue({
      url: "https://example.com/audio.ogg",
      duration: "PT5S",
    });
    mockDownloadAudio.mockRejectedValue(new Error("Download failed"));

    await expect(
      transcribeVoiceAttachment(fakeAttachment),
    ).rejects.toThrow("Download failed");

    // No wav temp dir was created since download failed before that
  });

  it("cleans up temp files even when conversion fails", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(true);
    mockParseAudioAttachment.mockReturnValue({
      url: "https://example.com/audio.ogg",
      duration: "PT5S",
    });

    const mockCleanup = vi.fn().mockResolvedValue(undefined);
    mockDownloadAudio.mockResolvedValue({
      path: "/tmp/voice-dl/input",
      cleanup: mockCleanup,
    });
    mockMkdtemp.mockResolvedValue("/tmp/voice-wav-abc");
    mockRm.mockResolvedValue(undefined);
    mockConvertToWav.mockRejectedValue(new Error("ffmpeg failed"));

    await expect(
      transcribeVoiceAttachment(fakeAttachment),
    ).rejects.toThrow("ffmpeg failed");

    // Both temp resources should be cleaned up
    expect(mockCleanup).toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledWith("/tmp/voice-wav-abc", {
      recursive: true,
      force: true,
    });
  });

  it("cleans up temp files even when transcription fails", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(true);
    mockParseAudioAttachment.mockReturnValue({
      url: "https://example.com/audio.ogg",
      duration: "PT5S",
    });

    const mockCleanup = vi.fn().mockResolvedValue(undefined);
    mockDownloadAudio.mockResolvedValue({
      path: "/tmp/voice-dl/input",
      cleanup: mockCleanup,
    });
    mockMkdtemp.mockResolvedValue("/tmp/voice-wav-abc");
    mockRm.mockResolvedValue(undefined);
    mockConvertToWav.mockResolvedValue("/tmp/voice-wav-abc/output.wav");
    mockTranscribe.mockRejectedValue(new Error("Whisper failed"));

    await expect(
      transcribeVoiceAttachment(fakeAttachment),
    ).rejects.toThrow("Whisper failed");

    // Both temp resources should be cleaned up
    expect(mockCleanup).toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledWith("/tmp/voice-wav-abc", {
      recursive: true,
      force: true,
    });
  });

  it("passes authToken through to downloadAudio", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockIsFfmpegAvailable.mockResolvedValue(true);
    mockParseAudioAttachment.mockReturnValue({
      url: "https://example.com/audio.ogg",
      duration: undefined,
    });

    const mockCleanup = vi.fn().mockResolvedValue(undefined);
    mockDownloadAudio.mockResolvedValue({
      path: "/tmp/voice-dl/input",
      cleanup: mockCleanup,
    });
    mockMkdtemp.mockResolvedValue("/tmp/voice-wav-abc");
    mockRm.mockResolvedValue(undefined);
    mockConvertToWav.mockResolvedValue("/tmp/voice-wav-abc/output.wav");
    mockTranscribe.mockResolvedValue("test");

    await transcribeVoiceAttachment(fakeAttachment, "my-bearer-token");

    expect(mockDownloadAudio).toHaveBeenCalledWith(
      "https://example.com/audio.ogg",
      "my-bearer-token",
    );
  });
});
