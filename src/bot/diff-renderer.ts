import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface FileDiffInput {
  filePath?: string;
  originalFile: string;
  newString: string;
}

const DIFF_DIR = join(tmpdir(), "teams-bot-diffs");
mkdirSync(DIFF_DIR, { recursive: true });

const DIFF_TTL_MS = 10 * 60 * 1000; // 10 minutes

let browserPromise: Promise<unknown> | null = null;

async function getPage(chromium: { launch: (opts: Record<string, unknown>) => Promise<unknown> }) {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  const browser = await browserPromise as { newPage: (opts: unknown) => Promise<unknown> };
  try {
    return await browser.newPage({ viewport: { width: 700, height: 500 } }) as {
      setContent: (html: string, opts: unknown) => Promise<void>;
      waitForTimeout: (ms: number) => Promise<void>;
      screenshot: (opts: unknown) => Promise<Buffer>;
      close: () => Promise<void>;
    };
  } catch {
    // Browser process died — relaunch
    browserPromise = chromium.launch({ headless: true });
    const fresh = await browserPromise as typeof browser;
    return await fresh.newPage({ viewport: { width: 700, height: 500 } }) as {
      setContent: (html: string, opts: unknown) => Promise<void>;
      waitForTimeout: (ms: number) => Promise<void>;
      screenshot: (opts: unknown) => Promise<Buffer>;
      close: () => Promise<void>;
    };
  }
}

/** Render a diff to PNG, save to temp dir, return the filename. */
export async function renderDiffImage(diff: FileDiffInput): Promise<string> {
  // Dynamic imports — these deps are optional
  const { preloadMultiFileDiff } = await import("@pierre/diffs/ssr");
  const { chromium } = await import("playwright-core");

  const filePath = diff.filePath ?? "file";

  const result = await preloadMultiFileDiff({
    oldFile: { name: filePath, contents: diff.originalFile },
    newFile: { name: filePath, contents: diff.newString },
    options: {
      theme: { light: "pierre-light", dark: "pierre-dark" },
      themeType: "dark",
      diffStyle: "unified",
    },
  });

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>body{margin:0;padding:20px;background:#0d1117;}</style>
</head><body>
<diffs-container><template shadowrootmode="open">${result.prerenderedHTML}</template></diffs-container>
</body></html>`;

  const page = await getPage(chromium);
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const buffer = await page.screenshot({ fullPage: true });
  await page.close();

  const filename = `${randomUUID()}.png`;
  writeFileSync(join(DIFF_DIR, filename), buffer);
  console.log(`[DIFF] Rendered ${filePath} (${buffer.length} bytes) → ${filename}`);

  return filename;
}

export async function closeDiffBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise as { close: () => Promise<void> };
    await browser.close();
    browserPromise = null;
  }
}

/** Directory where diff images are stored. */
export const diffDir = DIFF_DIR;

/** Remove diff images older than TTL. */
export function cleanupOldDiffs(): void {
  try {
    const now = Date.now();
    for (const file of readdirSync(DIFF_DIR)) {
      const fp = join(DIFF_DIR, file);
      const age = now - statSync(fp).mtimeMs;
      if (age > DIFF_TTL_MS) {
        unlinkSync(fp);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}
