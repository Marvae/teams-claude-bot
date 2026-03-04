import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAudioAttachment,
  downloadAudio,
  convertToWav,
  isFfmpegAvailable,
} from "./audio.js";
import { WhisperCppTranscriber } from "./transcriber.js";

const transcriber = new WhisperCppTranscriber();

// Cached voice-enabled state: null = not checked yet
let voiceEnabledCache: boolean | null = null;

/**
 * Check and cache whether both whisper-cli and ffmpeg are available.
 *
 * The result is cached so subsequent calls don't re-check.
 */
export async function isVoiceEnabled(): Promise<boolean> {
  if (voiceEnabledCache !== null) {
    return voiceEnabledCache;
  }

  const [whisperOk, ffmpegOk] = await Promise.all([
    transcriber.isAvailable(),
    isFfmpegAvailable(),
  ]);

  voiceEnabledCache = whisperOk && ffmpegOk;

  if (voiceEnabledCache) {
    console.log("[voice] Voice transcription enabled (whisper-cli + ffmpeg found)");
  } else {
    console.log(
      `[voice] Voice transcription disabled — whisper-cli: ${whisperOk ? "ok" : "missing"}, ffmpeg: ${ffmpegOk ? "ok" : "missing"}`,
    );
  }

  return voiceEnabledCache;
}

/** Reset cached voice state (for testing). */
export function _resetVoiceState(): void {
  voiceEnabledCache = null;
}

/** Check if a contentType represents a Teams audio card attachment. */
export function isAudioAttachment(contentType: string): boolean {
  return contentType === "application/vnd.microsoft.card.audio";
}

const VOICE_PREAMBLE = `[语音转写 / Voice Transcription]
以下内容为语音转写，可能存在识别错误（同音字、断句等），请结合上下文理解用户意图。
The following is a voice transcription that may contain recognition errors. Use context to understand the user's intent.`;

/** Wrap transcribed text with a bilingual preamble. */
export function wrapVoiceTranscript(text: string): string {
  return `${VOICE_PREAMBLE}\n\n${text}`;
}

/**
 * Full voice transcription pipeline.
 *
 * Parses the audio attachment, downloads the audio, converts to WAV via
 * ffmpeg, transcribes via whisper, wraps with preamble, and cleans up all
 * temp files.
 *
 * Returns null if voice transcription is not available or the attachment
 * cannot be parsed.
 */
export async function transcribeVoiceAttachment(
  attachment: { contentType: string; content?: unknown },
  authToken?: string,
): Promise<string | null> {
  const enabled = await isVoiceEnabled();
  if (!enabled) {
    return null;
  }

  const parsed = parseAudioAttachment(attachment);
  if (!parsed) {
    return null;
  }

  // Download audio to a temp file
  const downloaded = await downloadAudio(parsed.url, authToken);
  let wavDir: string | null = null;

  try {
    // Create a separate temp dir for WAV conversion output
    wavDir = await mkdtemp(join(tmpdir(), "voice-wav-"));

    const wavPath = await convertToWav(downloaded.path, wavDir);
    const text = await transcriber.transcribe(wavPath);

    return wrapVoiceTranscript(text);
  } finally {
    // Always clean up both temp directories
    await downloaded.cleanup();
    if (wavDir) {
      await rm(wavDir, { recursive: true, force: true });
    }
  }
}
