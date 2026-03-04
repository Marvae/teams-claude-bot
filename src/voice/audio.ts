import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Parsed audio attachment info. */
export interface AudioAttachment {
  url: string;
  duration: string | undefined;
}

/**
 * Parse a Teams audio card attachment.
 *
 * Teams voice messages arrive as `application/vnd.microsoft.card.audio` with
 * content containing `{ duration, media: [{ url }] }`. The content field may
 * be a JSON string or an already-parsed object.
 *
 * Returns `{ url, duration }` or `null` if the attachment is not a valid
 * audio card.
 */
export function parseAudioAttachment(attachment: {
  contentType: string;
  content?: unknown;
}): AudioAttachment | null {
  if (attachment.contentType !== "application/vnd.microsoft.card.audio") {
    return null;
  }

  let content: Record<string, unknown>;
  if (typeof attachment.content === "string") {
    try {
      content = JSON.parse(attachment.content) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (
    typeof attachment.content === "object" &&
    attachment.content !== null
  ) {
    content = attachment.content as Record<string, unknown>;
  } else {
    return null;
  }

  const media = content.media;
  if (!Array.isArray(media) || media.length === 0) {
    return null;
  }

  const first = media[0] as Record<string, unknown> | undefined;
  const url = first?.url;
  if (typeof url !== "string") {
    return null;
  }

  const duration = typeof content.duration === "string"
    ? content.duration
    : undefined;

  return { url, duration };
}

/** Result of downloading audio to a temp file. */
export interface DownloadedAudio {
  /** Path to the downloaded audio file. */
  path: string;
  /** Remove the temp directory and its contents. */
  cleanup: () => Promise<void>;
}

/**
 * Download audio from a URL to a temp file.
 *
 * Creates a temp directory, fetches the audio, and writes it to `input`
 * inside that directory. The returned `cleanup` function removes the
 * entire temp directory.
 */
export async function downloadAudio(
  url: string,
  authToken?: string,
): Promise<DownloadedAudio> {
  const tmpDir = await mkdtemp(join(tmpdir(), "voice-"));

  const cleanup = async () => {
    await rm(tmpDir, { recursive: true, force: true });
  };

  try {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`Audio download failed: ${resp.status} ${resp.statusText}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const filePath = join(tmpDir, "input");
    await writeFile(filePath, buffer);

    return { path: filePath, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Convert audio to 16 kHz mono WAV via ffmpeg.
 *
 * Runs `ffmpeg -i input -ar 16000 -ac 1 -f wav -y output.wav` with a 30 s
 * timeout. Returns the path to the output WAV file.
 */
export function convertToWav(
  inputPath: string,
  outputDir: string,
): Promise<string> {
  const outputPath = join(outputDir, "output.wav");
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", "-y", outputPath],
      { timeout: 30_000 },
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(outputPath);
      },
    );
  });
}

/** Check if ffmpeg is available in PATH. */
export function isFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", ["ffmpeg"], { timeout: 5_000 }, (err) => {
      resolve(!err);
    });
  });
}
