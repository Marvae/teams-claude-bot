import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process before imports
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { WhisperCppTranscriber } from "../src/voice/transcriber.js";

describe("WhisperCppTranscriber", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  describe("isAvailable", () => {
    it("returns true when whisper-cli is found in PATH", async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string) => void,
        ) => {
          cb(null, "/usr/local/bin/whisper-cli\n");
        },
      );

      const transcriber = new WhisperCppTranscriber();
      const result = await transcriber.isAvailable();

      expect(result).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        "which",
        ["whisper-cli"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("returns false when whisper-cli is not found", async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null) => void,
        ) => {
          cb(new Error("not found"));
        },
      );

      const transcriber = new WhisperCppTranscriber();
      const result = await transcriber.isAvailable();

      expect(result).toBe(false);
    });
  });

  describe("transcribe", () => {
    it("calls whisper-cli with correct args and returns trimmed stdout", async () => {
      const expectedModel = `${process.env.HOME}/.local/share/whisper.cpp/models/ggml-base.bin`;

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string) => void,
        ) => {
          cb(null, "  Hello, this is a test transcription.  \n");
        },
      );

      const transcriber = new WhisperCppTranscriber();
      const result = await transcriber.transcribe("/tmp/audio.wav");

      expect(result).toBe("Hello, this is a test transcription.");
      expect(mockExecFile).toHaveBeenCalledWith(
        "whisper-cli",
        [
          "-m",
          expectedModel,
          "-f",
          "/tmp/audio.wav",
          "--no-timestamps",
          "-l",
          "auto",
          "--output-txt",
        ],
        expect.objectContaining({ timeout: 120_000 }),
        expect.any(Function),
      );
    });

    it("uses custom model path from constructor", async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string) => void,
        ) => {
          cb(null, "transcribed text\n");
        },
      );

      const transcriber = new WhisperCppTranscriber(
        "/custom/path/model.bin",
      );
      await transcriber.transcribe("/tmp/audio.wav");

      expect(mockExecFile).toHaveBeenCalledWith(
        "whisper-cli",
        expect.arrayContaining(["-m", "/custom/path/model.bin"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("rejects on whisper-cli error", async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null) => void,
        ) => {
          cb(new Error("whisper-cli failed: model not found"));
        },
      );

      const transcriber = new WhisperCppTranscriber();
      await expect(
        transcriber.transcribe("/tmp/audio.wav"),
      ).rejects.toThrow("whisper-cli failed: model not found");
    });

    it("rejects on timeout", async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null) => void,
        ) => {
          const err = new Error("Command timed out");
          (err as NodeJS.ErrnoException).code = "ERR_CHILD_PROCESS_TIMEOUT";
          cb(err);
        },
      );

      const transcriber = new WhisperCppTranscriber();
      await expect(
        transcriber.transcribe("/tmp/audio.wav"),
      ).rejects.toThrow("Command timed out");
    });
  });
});
