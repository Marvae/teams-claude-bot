/**
 * Voice Tab API handler.
 *
 * Receives base64-encoded audio from the Voice Tab, transcribes it via
 * the existing whisper pipeline, then sends the transcript as a proactive
 * message to the user's chat and injects it into the Claude session.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToWav } from "./audio.js";
import { WhisperCppTranscriber } from "./transcriber.js";
import { isVoiceEnabled, wrapVoiceTranscript } from "./index.js";

const transcriber = new WhisperCppTranscriber();

export interface VoiceRequest {
  /** Base64-encoded audio data. */
  audio: string;
  /** MIME type of the audio (e.g. "audio/wav"). */
  mimeType?: string;
  /** AAD Object ID of the user (from Teams context). */
  userId: string;
  /** Display name of the user. */
  userName?: string;
}

export interface VoiceResult {
  success: boolean;
  transcript?: string;
  error?: string;
}

/**
 * Process a voice recording from the Voice Tab.
 *
 * 1. Decode base64 audio to a temp file
 * 2. Convert to WAV via ffmpeg
 * 3. Transcribe via whisper
 * 4. Return the transcript text (caller handles proactive messaging)
 */
export async function processVoiceUpload(
  req: VoiceRequest,
): Promise<VoiceResult> {
  if (!req.audio) {
    return { success: false, error: "No audio data provided" };
  }

  if (!req.userId) {
    return { success: false, error: "No user ID provided" };
  }

  const enabled = await isVoiceEnabled();
  if (!enabled) {
    return {
      success: false,
      error: "Voice transcription not available. Run: teams-bot setup-voice",
    };
  }

  let tmpDir: string | null = null;
  let wavDir: string | null = null;

  try {
    // Decode base64 audio to temp file
    tmpDir = await mkdtemp(join(tmpdir(), "voice-tab-"));
    const audioPath = join(tmpDir, "input");
    const audioBuffer = Buffer.from(req.audio, "base64");
    await writeFile(audioPath, audioBuffer);

    // Convert to WAV
    wavDir = await mkdtemp(join(tmpdir(), "voice-tab-wav-"));
    const wavPath = await convertToWav(audioPath, wavDir);

    // Transcribe
    const rawText = await transcriber.transcribe(wavPath);

    if (!rawText) {
      return { success: false, error: "No speech detected" };
    }

    return {
      success: true,
      transcript: rawText,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[voice-tab] Processing failed:", msg);
    return { success: false, error: "Transcription failed: " + msg };
  } finally {
    // Clean up temp files
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (wavDir) await rm(wavDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Wrap raw transcript with the bilingual preamble for Claude. */
export { wrapVoiceTranscript };
