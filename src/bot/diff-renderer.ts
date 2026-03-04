export interface FileDiffInput {
  filePath?: string;
  originalFile: string;
  newString: string;
}

let browserPromise: Promise<unknown> | null = null;

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

  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  const browser = await browserPromise as { newPage: (opts: unknown) => Promise<unknown> };
  const page = await browser.newPage({ viewport: { width: 700, height: 500 } }) as {
    setContent: (html: string, opts: unknown) => Promise<void>;
    waitForTimeout: (ms: number) => Promise<void>;
    screenshot: (opts: unknown) => Promise<Buffer>;
    close: () => Promise<void>;
  };
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const buffer = await page.screenshot({ fullPage: true });
  await page.close();

  return buffer.toString("base64");
}

export async function closeDiffBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise as { close: () => Promise<void> };
    await browser.close();
    browserPromise = null;
  }
}
