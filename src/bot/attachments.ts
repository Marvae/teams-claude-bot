import { TurnContext, Attachment } from "botbuilder";
import { writeFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

export interface DownloadedAttachment {
  data: Buffer;
  contentType: string;
  name: string;
}

/** Content block types supported by the Anthropic Messages API. */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: string; data: string };
    };

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB — Anthropic API limit
const MAX_INLINE_TEXT_BYTES = 1024 * 1024; // 1 MB — larger text files go to tmp

/** Normalize content type — Teams file downloads often have a generic type. */
function inferMediaType(name: string, responseType: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  };
  return map[ext] ?? responseType;
}

/**
 * Try to decode a buffer as UTF-8 text.
 * Returns the string if it looks like valid text, or null if it appears binary.
 */
function tryReadAsText(data: Buffer): string | null {
  const text = data.toString("utf-8");
  // If there are null bytes, it's almost certainly binary
  if (text.includes("\0")) return null;
  return text;
}

/**
 * Filter out Teams platform-injected HTML attachments (adaptive card renders, etc.)
 * while keeping user-uploaded .html files (which have a downloadUrl or contentUrl).
 */
export function filterPlatformAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter((a) => {
    if (a.contentType === "text/html") {
      const content = a.content as Record<string, unknown> | undefined;
      return !!(content?.downloadUrl ?? a.contentUrl);
    }
    return true;
  });
}

function getBotToken(ctx: TurnContext): string | undefined {
  const connectorClient = ctx.turnState.get(
    ctx.adapter.ConnectorClientKey ?? "ConnectorClient",
  );
  if (connectorClient?.credentials?.token) {
    return connectorClient.credentials.token as string;
  }
  const creds = (ctx.adapter as unknown as Record<string, unknown>)
    .credentials as { token?: string } | undefined;
  return creds?.token;
}

export async function downloadAttachment(
  ctx: TurnContext,
  attachment: Attachment,
): Promise<DownloadedAttachment | null> {
  const content = attachment.content as Record<string, unknown> | undefined;
  const url = (content?.downloadUrl as string) ?? attachment.contentUrl;
  if (!url) return null;

  const headers: Record<string, string> = {};
  const token = getBotToken(ctx);
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const resp = await fetch(url, { headers });
  if (!resp.ok) return null;

  const buffer = Buffer.from(await resp.arrayBuffer());
  const name = attachment.name ?? "attachment";
  const responseType =
    resp.headers.get("content-type") ?? "application/octet-stream";
  // Teams file uploads have a generic contentType — infer from extension.
  // Otherwise trust the HTTP response content-type.
  const isGenericType =
    attachment.contentType ===
      "application/vnd.microsoft.teams.file.download.info" ||
    responseType === "application/octet-stream";
  const contentType = isGenericType
    ? inferMediaType(name, responseType)
    : responseType;

  return { data: buffer, contentType, name };
}

export interface ProcessedAttachments {
  /** Content blocks to send inline (images, PDFs). */
  contentBlocks: ContentBlock[];
  /** File paths saved to tmp (all other file types). */
  savedFiles: string[];
  /** Names of files that failed to download. */
  failed: string[];
}

/**
 * Process all attachments:
 * - Images and PDFs → inline content blocks (sent directly to Claude API)
 * - Other files → saved to tmp (Claude reads via Read tool)
 */
export async function processAttachments(
  ctx: TurnContext,
  attachments: Attachment[],
): Promise<ProcessedAttachments> {
  const contentBlocks: ContentBlock[] = [];
  const savedFiles: string[] = [];
  const failed: string[] = [];
  let dir: string | null = null;

  for (const att of attachments) {
    const downloaded = await downloadAttachment(ctx, att);
    if (!downloaded) {
      failed.push(att.name ?? "unknown file");
      continue;
    }

    const mediaType = downloaded.contentType.split(";")[0].trim();
    if (IMAGE_TYPES.has(mediaType)) {
      if (downloaded.data.length > MAX_IMAGE_BYTES) {
        failed.push(`${downloaded.name} (image exceeds 5 MB limit)`);
        continue;
      }
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: downloaded.data.toString("base64"),
        },
      });
    } else if (mediaType === "application/pdf") {
      contentBlocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: mediaType,
          data: downloaded.data.toString("base64"),
        },
      });
    } else {
      // Try to read as text and send inline; fall back to tmp for large or binary files
      const text =
        downloaded.data.length <= MAX_INLINE_TEXT_BYTES
          ? tryReadAsText(downloaded.data)
          : null;
      if (text !== null) {
        contentBlocks.push({
          type: "text",
          text: `[File: ${downloaded.name}]\n${text}`,
        });
      } else {
        if (!dir) {
          dir = join(tmpdir(), "teams-claude-bot", randomUUID());
          await mkdir(dir, { recursive: true });
        }
        const filePath = join(dir, basename(downloaded.name) || "attachment");
        await writeFile(filePath, downloaded.data);
        savedFiles.push(filePath);
      }
    }
  }

  return { contentBlocks, savedFiles, failed };
}
