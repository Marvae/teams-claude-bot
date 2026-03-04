import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Transcribes audio files to text. */
export interface Transcriber {
  /** Check if the transcription backend is available. */
  isAvailable(): Promise<boolean>;
  /** Transcribe a WAV audio file to text. */
  transcribe(audioPath: string): Promise<string>;
}

const DEFAULT_MODEL_PATH = join(
  homedir(),
  ".local/share/whisper.cpp/models/ggml-base.bin",
);

/** Transcriber backed by whisper.cpp's `whisper-cli` binary. */
export class WhisperCppTranscriber implements Transcriber {
  private readonly modelPath: string;

  constructor(modelPath?: string) {
    this.modelPath = modelPath ?? DEFAULT_MODEL_PATH;
  }

  /** Returns true if `whisper-cli` is found in PATH. */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile("which", ["whisper-cli"], { timeout: 5_000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /** Runs whisper-cli on the given audio file, returns the transcribed text. */
  async transcribe(audioPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "whisper-cli",
        [
          "-m",
          this.modelPath,
          "-f",
          audioPath,
          "--no-timestamps",
          "-l",
          "auto",
          "--output-txt",
        ],
        { timeout: 120_000 },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
  }
}
