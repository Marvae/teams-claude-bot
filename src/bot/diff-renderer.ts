import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export const diffDir = join(tmpdir(), "teams-bot-diffs");
mkdirSync(diffDir, { recursive: true });

const DIFF_TTL_MS = 10 * 60 * 1000; // 10 minutes

type BrowserLike = {
  newPage: (opts: unknown) => Promise<unknown>;
  on: (event: string, cb: () => void) => void;
};

type PageLike = {
  setContent: (html: string, opts: unknown) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  screenshot: (opts: unknown) => Promise<Buffer>;
  close: () => Promise<void>;
};

let browserPromise: Promise<BrowserLike> | null = null;

/** Render a diff to PNG, save to temp dir, return the filename. */
export async function renderDiffImage(diff: {
  filePath?: string;
  originalFile: string;
  newString: string;
}): Promise<string> {
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

  if (!browserPromise) {
    const promise = chromium.launch({ headless: true }).then((b) => {
      const browser = b as BrowserLike;
      browser.on("disconnected", () => {
        if (browserPromise === promise) browserPromise = null;
      });
      return browser;
    });
    browserPromise = promise;
  }
  const browser = await browserPromise;
  const page = await browser.newPage({ viewport: { width: 700, height: 500 } }) as PageLike;
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const buffer = await page.screenshot({ fullPage: true });
  await page.close();

  const filename = `${randomUUID()}.png`;
  writeFileSync(join(diffDir, filename), buffer);
  console.log(`[DIFF] Rendered ${filePath} (${buffer.length} bytes) → ${filename}`);
  return filename;
}

/** Remove diff images older than TTL. */
export function cleanupOldDiffs(): void {
  try {
    const now = Date.now();
    for (const file of readdirSync(diffDir)) {
      const fp = join(diffDir, file);
      if (now - statSync(fp).mtimeMs > DIFF_TTL_MS) unlinkSync(fp);
    }
  } catch (err) {
    console.warn(`[DIFF] Cleanup error: ${err}`);
  }
}
