import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TurnContext, Attachment } from "botbuilder";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  downloadAttachment,
  processAttachments,
  filterPlatformAttachments,
  type ContentBlock,
} from "../src/bot/attachments.js";

function makeMockCtx(): TurnContext {
  return {
    turnState: { get: () => undefined },
    adapter: {},
  } as unknown as TurnContext;
}

function makeAttachment(
  name: string,
  contentType: string,
  downloadUrl?: string,
): Attachment {
  return {
    name,
    contentType,
    content: downloadUrl ? { downloadUrl } : undefined,
    contentUrl: downloadUrl,
  } as Attachment;
}

function mockFetchResponse(data: Buffer, contentType = "application/octet-stream") {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    headers: new Headers({ "content-type": contentType }),
  });
}

function mockFetchFailure() {
  mockFetch.mockResolvedValueOnce({ ok: false });
}

describe("downloadAttachment", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("downloads from content.downloadUrl", async () => {
    const data = Buffer.from("hello");
    mockFetchResponse(data, "text/plain");

    const att = makeAttachment("test.txt", "application/vnd.microsoft.teams.file.download.info", "https://example.com/file");
    const result = await downloadAttachment(makeMockCtx(), att);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("test.txt");
    expect(result!.data).toEqual(data);
  });

  it("falls back to contentUrl when no downloadUrl", async () => {
    const data = Buffer.from("content");
    mockFetchResponse(data, "text/plain");

    const att = {
      name: "file.txt",
      contentType: "text/plain",
      contentUrl: "https://example.com/file",
    } as Attachment;
    const result = await downloadAttachment(makeMockCtx(), att);

    expect(result).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledWith("https://example.com/file", expect.anything());
  });

  it("returns null when no URL available", async () => {
    const att = { name: "orphan.txt", contentType: "text/plain" } as Attachment;
    const result = await downloadAttachment(makeMockCtx(), att);
    expect(result).toBeNull();
  });

  it("returns null on fetch failure", async () => {
    mockFetchFailure();
    const att = makeAttachment("fail.txt", "text/plain", "https://example.com/fail");
    const result = await downloadAttachment(makeMockCtx(), att);
    expect(result).toBeNull();
  });

  it("infers image/png from .png extension", async () => {
    const data = Buffer.from("fake-png");
    mockFetchResponse(data, "application/octet-stream");

    const att = makeAttachment("screenshot.png", "application/vnd.microsoft.teams.file.download.info", "https://example.com/file");
    const result = await downloadAttachment(makeMockCtx(), att);

    expect(result!.contentType).toBe("image/png");
  });

  it("infers application/pdf from .pdf extension", async () => {
    const data = Buffer.from("fake-pdf");
    mockFetchResponse(data, "application/octet-stream");

    const att = makeAttachment("doc.pdf", "application/vnd.microsoft.teams.file.download.info", "https://example.com/file");
    const result = await downloadAttachment(makeMockCtx(), att);

    expect(result!.contentType).toBe("application/pdf");
  });
});

describe("processAttachments", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("converts image to inline image content block", async () => {
    const pngData = Buffer.from("fake-png-data");
    mockFetchResponse(pngData, "image/png");

    const attachments = [makeAttachment("photo.png", "image/png", "https://example.com/photo.png")];
    const result = await processAttachments(makeMockCtx(), attachments);

    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks[0]).toMatchObject({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: pngData.toString("base64"),
      },
    });
    expect(result.savedFiles).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it("converts PDF to inline document content block", async () => {
    const pdfData = Buffer.from("%PDF-1.0 fake");
    mockFetchResponse(pdfData, "application/pdf");

    const attachments = [makeAttachment("report.pdf", "application/pdf", "https://example.com/report.pdf")];
    const result = await processAttachments(makeMockCtx(), attachments);

    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks[0]).toMatchObject({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdfData.toString("base64"),
      },
    });
  });

  it("converts text file to inline text content block", async () => {
    const tsContent = 'export const foo = "bar";';
    mockFetchResponse(Buffer.from(tsContent), "application/octet-stream");

    const attachments = [makeAttachment("index.ts", "application/octet-stream", "https://example.com/index.ts")];
    const result = await processAttachments(makeMockCtx(), attachments);

    expect(result.contentBlocks).toHaveLength(1);
    const block = result.contentBlocks[0] as Extract<ContentBlock, { type: "text" }>;
    expect(block.type).toBe("text");
    expect(block.text).toContain("index.ts");
    expect(block.text).toContain(tsContent);
    expect(result.savedFiles).toHaveLength(0);
  });

  it("saves binary file to tmp", async () => {
    // Binary data with null bytes
    const binaryData = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    mockFetchResponse(binaryData, "application/zip");

    const attachments = [makeAttachment("archive.zip", "application/zip", "https://example.com/archive.zip")];
    const result = await processAttachments(makeMockCtx(), attachments);

    expect(result.contentBlocks).toHaveLength(0);
    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]).toContain("archive.zip");
  });

  it("reports failed downloads", async () => {
    mockFetchFailure();

    const attachments = [makeAttachment("broken.png", "image/png", "https://example.com/broken")];
    const result = await processAttachments(makeMockCtx(), attachments);

    expect(result.contentBlocks).toHaveLength(0);
    expect(result.savedFiles).toHaveLength(0);
    expect(result.failed).toEqual(["broken.png"]);
  });

  it("processes user-uploaded HTML files (with downloadUrl)", async () => {
    const htmlContent = "<html><body>Hello</body></html>";
    mockFetchResponse(Buffer.from(htmlContent), "text/html");

    const attachments = [
      makeAttachment("page.html", "text/html", "https://example.com/page.html"),
    ];
    const result = await processAttachments(makeMockCtx(), attachments);

    // HTML is text, so it should become an inline text content block
    expect(result.contentBlocks).toHaveLength(1);
    const block = result.contentBlocks[0] as Extract<ContentBlock, { type: "text" }>;
    expect(block.type).toBe("text");
    expect(block.text).toContain("page.html");
    expect(block.text).toContain(htmlContent);
  });

  it("handles mixed attachment types", async () => {
    const imgData = Buffer.from("image-data");
    const pdfData = Buffer.from("pdf-data");
    const txtData = Buffer.from("hello world");
    const binData = Buffer.from([0x00, 0x01, 0x02]);

    mockFetchResponse(imgData, "image/jpeg");
    mockFetchResponse(pdfData, "application/pdf");
    mockFetchResponse(txtData, "text/plain");
    mockFetchResponse(binData, "application/octet-stream");
    mockFetchFailure();

    const attachments = [
      makeAttachment("photo.jpg", "image/jpeg", "https://example.com/1"),
      makeAttachment("doc.pdf", "application/pdf", "https://example.com/2"),
      makeAttachment("notes.txt", "text/plain", "https://example.com/3"),
      makeAttachment("data.bin", "application/octet-stream", "https://example.com/4"),
      makeAttachment("broken.png", "image/png", "https://example.com/5"),
    ];
    const result = await processAttachments(makeMockCtx(), attachments);

    // image + pdf + text = 3 content blocks
    expect(result.contentBlocks).toHaveLength(3);
    expect(result.contentBlocks[0]).toMatchObject({ type: "image" });
    expect(result.contentBlocks[1]).toMatchObject({ type: "document" });
    expect(result.contentBlocks[2]).toMatchObject({ type: "text" });

    // binary → saved to tmp
    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]).toContain("data.bin");

    // broken → failed
    expect(result.failed).toEqual(["broken.png"]);
  });

  it("rejects images over 5 MB", async () => {
    const bigImage = Buffer.alloc(5 * 1024 * 1024 + 1, 0x42); // just over 5 MB
    mockFetchResponse(bigImage, "image/png");

    const attachments = [makeAttachment("huge.png", "image/png", "https://example.com/huge")];
    const result = await processAttachments(makeMockCtx(), attachments);

    expect(result.contentBlocks).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toContain("huge.png");
    expect(result.failed[0]).toContain("5 MB");
  });

  it("accepts images at exactly 5 MB", async () => {
    const exactImage = Buffer.alloc(5 * 1024 * 1024, 0x42);
    mockFetchResponse(exactImage, "image/jpeg");

    const attachments = [makeAttachment("big.jpg", "image/jpeg", "https://example.com/big")];
    const result = await processAttachments(makeMockCtx(), attachments);

    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks[0]).toMatchObject({ type: "image" });
    expect(result.failed).toHaveLength(0);
  });

  it("handles all supported image types", async () => {
    const types = [
      { name: "a.jpg", mime: "image/jpeg" },
      { name: "b.png", mime: "image/png" },
      { name: "c.gif", mime: "image/gif" },
      { name: "d.webp", mime: "image/webp" },
    ];

    for (const t of types) {
      mockFetchResponse(Buffer.from(`data-${t.name}`), t.mime);
    }

    const attachments = types.map((t) => makeAttachment(t.name, t.mime, `https://example.com/${t.name}`));
    const result = await processAttachments(makeMockCtx(), attachments);

    expect(result.contentBlocks).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(result.contentBlocks[i]).toMatchObject({
        type: "image",
        source: { media_type: types[i].mime },
      });
    }
  });
});

describe("filterPlatformAttachments", () => {
  it("removes Teams platform HTML (no URL)", () => {
    const attachments = [
      // Platform-injected HTML — no downloadUrl or contentUrl
      { name: "card", contentType: "text/html", content: "<div>adaptive card</div>" } as Attachment,
      // Normal file
      makeAttachment("file.txt", "text/plain", "https://example.com/file.txt"),
    ];
    const result = filterPlatformAttachments(attachments);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("file.txt");
  });

  it("keeps user-uploaded HTML files (with contentUrl)", () => {
    const attachments = [
      { name: "page.html", contentType: "text/html", contentUrl: "https://example.com/page.html" } as Attachment,
    ];
    const result = filterPlatformAttachments(attachments);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("page.html");
  });

  it("keeps user-uploaded HTML files (with downloadUrl in content)", () => {
    const attachments = [
      {
        name: "index.html",
        contentType: "text/html",
        content: { downloadUrl: "https://example.com/index.html" },
      } as Attachment,
    ];
    const result = filterPlatformAttachments(attachments);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("index.html");
  });

  it("passes through non-HTML attachments unchanged", () => {
    const attachments = [
      makeAttachment("photo.png", "image/png", "https://example.com/photo"),
      makeAttachment("doc.pdf", "application/pdf", "https://example.com/doc"),
      { name: "nourl.bin", contentType: "application/octet-stream" } as Attachment,
    ];
    const result = filterPlatformAttachments(attachments);
    expect(result).toHaveLength(3);
  });
});
