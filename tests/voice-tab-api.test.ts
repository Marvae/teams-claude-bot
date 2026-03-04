import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the audio module
const mockConvertToWav = vi.fn();
vi.mock("../src/voice/audio.js", () => ({
  convertToWav: (...args: unknown[]) => mockConvertToWav(...args),
  isFfmpegAvailable: vi.fn().mockResolvedValue(true),
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
const mockWriteFile = vi.fn();
const mockRm = vi.fn();
vi.mock("node:fs/promises", () => ({
  mkdtemp: (...args: unknown[]) => mockMkdtemp(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  rm: (...args: unknown[]) => mockRm(...args),
}));

import { processVoiceUpload } from "../src/voice/tab-api.js";
import { _resetVoiceState } from "../src/voice/index.js";

describe("processVoiceUpload", () => {
  beforeEach(() => {
    _resetVoiceState();
    mockIsAvailable.mockReset();
    mockTranscribe.mockReset();
    mockConvertToWav.mockReset();
    mockMkdtemp.mockReset();
    mockWriteFile.mockReset();
    mockRm.mockReset();
  });

  it("returns error when no audio data provided", async () => {
    const result = await processVoiceUpload({
      audio: "",
      userId: "user-1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No audio data");
  });

  it("returns error when no userId provided", async () => {
    const result = await processVoiceUpload({
      audio: "base64data",
      userId: "",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No user ID");
  });

  it("returns error when voice is not enabled", async () => {
    mockIsAvailable.mockResolvedValue(false);

    const result = await processVoiceUpload({
      audio: "base64data",
      userId: "user-1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  });

  it("processes audio successfully through the full pipeline", async () => {
    // Enable voice
    mockIsAvailable.mockResolvedValue(true);

    // Temp dirs
    mockMkdtemp
      .mockResolvedValueOnce("/tmp/voice-tab-abc")
      .mockResolvedValueOnce("/tmp/voice-tab-wav-abc");
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);

    // Convert + transcribe
    mockConvertToWav.mockResolvedValue("/tmp/voice-tab-wav-abc/output.wav");
    mockTranscribe.mockResolvedValue("Hello from voice tab");

    const audioBase64 = Buffer.from("fake-audio-data").toString("base64");
    const result = await processVoiceUpload({
      audio: audioBase64,
      userId: "user-1",
      userName: "Test User",
    });

    expect(result.success).toBe(true);
    expect(result.transcript).toBe("Hello from voice tab");

    // Verify temp file was written
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/tmp/voice-tab-abc/input",
      expect.any(Buffer),
    );

    // Verify conversion was called
    expect(mockConvertToWav).toHaveBeenCalledWith(
      "/tmp/voice-tab-abc/input",
      "/tmp/voice-tab-wav-abc",
    );

    // Verify transcription was called
    expect(mockTranscribe).toHaveBeenCalledWith(
      "/tmp/voice-tab-wav-abc/output.wav",
    );

    // Verify cleanup
    expect(mockRm).toHaveBeenCalledTimes(2);
  });

  it("returns error when no speech detected (empty transcript)", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockMkdtemp
      .mockResolvedValueOnce("/tmp/voice-tab-abc")
      .mockResolvedValueOnce("/tmp/voice-tab-wav-abc");
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockConvertToWav.mockResolvedValue("/tmp/voice-tab-wav-abc/output.wav");
    mockTranscribe.mockResolvedValue("");

    const result = await processVoiceUpload({
      audio: Buffer.from("data").toString("base64"),
      userId: "user-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No speech detected");
  });

  it("cleans up temp files on conversion failure", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockMkdtemp
      .mockResolvedValueOnce("/tmp/voice-tab-abc")
      .mockResolvedValueOnce("/tmp/voice-tab-wav-abc");
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockConvertToWav.mockRejectedValue(new Error("ffmpeg crashed"));

    const result = await processVoiceUpload({
      audio: Buffer.from("data").toString("base64"),
      userId: "user-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("ffmpeg crashed");

    // Both temp dirs should be cleaned
    expect(mockRm).toHaveBeenCalledWith("/tmp/voice-tab-abc", {
      recursive: true,
      force: true,
    });
    expect(mockRm).toHaveBeenCalledWith("/tmp/voice-tab-wav-abc", {
      recursive: true,
      force: true,
    });
  });

  it("cleans up temp files on transcription failure", async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockMkdtemp
      .mockResolvedValueOnce("/tmp/voice-tab-abc")
      .mockResolvedValueOnce("/tmp/voice-tab-wav-abc");
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockConvertToWav.mockResolvedValue("/tmp/voice-tab-wav-abc/output.wav");
    mockTranscribe.mockRejectedValue(new Error("Whisper died"));

    const result = await processVoiceUpload({
      audio: Buffer.from("data").toString("base64"),
      userId: "user-1",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Whisper died");
    expect(mockRm).toHaveBeenCalledTimes(2);
  });
});
