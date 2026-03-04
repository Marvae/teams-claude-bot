import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process before imports
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock node:fs/promises before imports
const mockMkdtemp = vi.fn();
const mockRm = vi.fn();
const mockWriteFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  mkdtemp: (...args: unknown[]) => mockMkdtemp(...args),
  rm: (...args: unknown[]) => mockRm(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  parseAudioAttachment,
  downloadAudio,
  convertToWav,
  isFfmpegAvailable,
} from "../src/voice/audio.js";

describe("parseAudioAttachment", () => {
  it("parses Teams audio card with object content", () => {
    const attachment = {
      contentType: "application/vnd.microsoft.card.audio",
      content: {
        duration: "PT13S",
        media: [
          {
            url: "https://eu-api.asm.skype.com/v1/objects/abc123/views/audio",
          },
        ],
      },
    };

    const result = parseAudioAttachment(attachment);

    expect(result).toEqual({
      url: "https://eu-api.asm.skype.com/v1/objects/abc123/views/audio",
      duration: "PT13S",
    });
  });

  it("parses Teams audio card with stringified content", () => {
    const attachment = {
      contentType: "application/vnd.microsoft.card.audio",
      content: JSON.stringify({
        duration: "PT7S",
        media: [
          {
            url: "https://eu-api.asm.skype.com/v1/objects/xyz789/views/audio",
          },
        ],
      }),
    };

    const result = parseAudioAttachment(attachment);

    expect(result).toEqual({
      url: "https://eu-api.asm.skype.com/v1/objects/xyz789/views/audio",
      duration: "PT7S",
    });
  });

  it("returns null for non-audio attachment", () => {
    const attachment = {
      contentType: "application/vnd.microsoft.card.adaptive",
      content: { body: [] },
    };

    expect(parseAudioAttachment(attachment)).toBeNull();
  });

  it("returns null when media array is missing", () => {
    const attachment = {
      contentType: "application/vnd.microsoft.card.audio",
      content: { duration: "PT5S" },
    };

    expect(parseAudioAttachment(attachment)).toBeNull();
  });

  it("returns null when media array is empty", () => {
    const attachment = {
      contentType: "application/vnd.microsoft.card.audio",
      content: { duration: "PT5S", media: [] },
    };

    expect(parseAudioAttachment(attachment)).toBeNull();
  });

  it("returns null when media[0].url is missing", () => {
    const attachment = {
      contentType: "application/vnd.microsoft.card.audio",
      content: { duration: "PT5S", media: [{}] },
    };

    expect(parseAudioAttachment(attachment)).toBeNull();
  });

  it("returns undefined duration when not present", () => {
    const attachment = {
      contentType: "application/vnd.microsoft.card.audio",
      content: {
        media: [
          { url: "https://example.com/audio" },
        ],
      },
    };

    const result = parseAudioAttachment(attachment);

    expect(result).toEqual({
      url: "https://example.com/audio",
      duration: undefined,
    });
  });
});

describe("downloadAudio", () => {
  beforeEach(() => {
    mockMkdtemp.mockReset();
    mockRm.mockReset();
    mockWriteFile.mockReset();
    mockFetch.mockReset();
  });

  it("downloads audio to a temp file and returns path + cleanup", async () => {
    const tmpDir = "/tmp/voice-abc123";
    mockMkdtemp.mockResolvedValue(tmpDir);
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);

    const audioBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF header
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioBytes.buffer),
    });

    const result = await downloadAudio("https://example.com/audio.ogg");

    expect(mockMkdtemp).toHaveBeenCalledWith(expect.stringContaining("voice-"));
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/audio.ogg", {
      headers: {},
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      `${tmpDir}/input`,
      expect.any(Buffer),
    );
    expect(result.path).toBe(`${tmpDir}/input`);

    // cleanup should remove the temp directory
    await result.cleanup();
    expect(mockRm).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true });
  });

  it("passes Bearer auth token when provided", async () => {
    const tmpDir = "/tmp/voice-def456";
    mockMkdtemp.mockResolvedValue(tmpDir);
    mockWriteFile.mockResolvedValue(undefined);

    const audioBytes = new Uint8Array([0x00]);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioBytes.buffer),
    });

    await downloadAudio("https://example.com/audio.ogg", "my-token-123");

    expect(mockFetch).toHaveBeenCalledWith("https://example.com/audio.ogg", {
      headers: { Authorization: "Bearer my-token-123" },
    });
  });

  it("throws when fetch fails", async () => {
    const tmpDir = "/tmp/voice-ghi789";
    mockMkdtemp.mockResolvedValue(tmpDir);
    mockRm.mockResolvedValue(undefined);

    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    await expect(downloadAudio("https://example.com/audio.ogg")).rejects.toThrow(
      "Audio download failed: 403 Forbidden",
    );

    // Should clean up temp dir on failure
    expect(mockRm).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true });
  });
});

describe("convertToWav", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("runs ffmpeg with correct arguments and returns output path", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "", "");
      },
    );

    const result = await convertToWav("/tmp/voice-abc/input", "/tmp/voice-abc");

    expect(result).toBe("/tmp/voice-abc/output.wav");
    expect(mockExecFile).toHaveBeenCalledWith(
      "ffmpeg",
      [
        "-i",
        "/tmp/voice-abc/input",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        "-y",
        "/tmp/voice-abc/output.wav",
      ],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
  });

  it("rejects when ffmpeg fails", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error("ffmpeg: unrecognized format"));
      },
    );

    await expect(
      convertToWav("/tmp/voice-abc/input", "/tmp/voice-abc"),
    ).rejects.toThrow("ffmpeg: unrecognized format");
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

    await expect(
      convertToWav("/tmp/voice-abc/input", "/tmp/voice-abc"),
    ).rejects.toThrow("Command timed out");
  });
});

describe("isFfmpegAvailable", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("returns true when ffmpeg is found in PATH", async () => {
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string) => void,
      ) => {
        cb(null, "/usr/local/bin/ffmpeg\n");
      },
    );

    const result = await isFfmpegAvailable();

    expect(result).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      "which",
      ["ffmpeg"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns false when ffmpeg is not found", async () => {
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

    const result = await isFfmpegAvailable();

    expect(result).toBe(false);
  });
});
