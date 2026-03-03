import { TurnContext, Attachment } from "botbuilder";

export interface DownloadedAttachment {
  data: Buffer;
  contentType: string;
  name: string;
}

export interface ImageBlock {
  mediaType: string;
  data: string;
}

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".kt",
  ".sh",
  ".bash",
  ".zsh",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".sql",
  ".graphql",
  ".env",
  ".ini",
  ".cfg",
  ".conf",
  ".log",
  ".csv",
]);

export function isImage(contentType: string): boolean {
  return IMAGE_TYPES.has(contentType.toLowerCase().split(";")[0].trim());
}

function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function getBotToken(ctx: TurnContext): string | undefined {
  // The connector client stores the token used for auth
  const connectorClient = ctx.turnState.get(
    ctx.adapter.ConnectorClientKey ?? "ConnectorClient",
  );
  if (connectorClient?.credentials?.token) {
    return connectorClient.credentials.token as string;
  }
  // Fallback: try getting from the adapter's credentials
  const creds = (ctx.adapter as unknown as Record<string, unknown>)
    .credentials as { token?: string } | undefined;
  return creds?.token;
}

function inferContentType(name: string, fallback: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return map[ext] ?? fallback;
}

export async function downloadAttachment(
  ctx: TurnContext,
  attachment: Attachment,
): Promise<DownloadedAttachment | null> {
  // Teams file attachments store the download URL in content.downloadUrl
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
  const respType =
    resp.headers.get("content-type") ?? "application/octet-stream";
  // Teams file attachments have a generic contentType, so infer from file extension
  const contentType =
    attachment.contentType ===
    "application/vnd.microsoft.teams.file.download.info"
      ? inferContentType(name, respType)
      : (attachment.contentType ?? respType);

  return { data: buffer, contentType, name };
}

export interface ProcessedAttachments {
  images: ImageBlock[];
  textSnippets: string[];
  unsupported: string[];
}

export async function processAttachments(
  ctx: TurnContext,
  attachments: Attachment[],
): Promise<ProcessedAttachments> {
  const result: ProcessedAttachments = {
    images: [],
    textSnippets: [],
    unsupported: [],
  };

  for (const att of attachments) {
    // Skip inline HTML images Teams adds for adaptive cards, etc.
    if (att.contentType === "text/html") continue;

    const downloaded = await downloadAttachment(ctx, att);
    if (!downloaded) {
      result.unsupported.push(att.name ?? "unknown file");
      continue;
    }

    if (isImage(downloaded.contentType)) {
      result.images.push({
        mediaType: downloaded.contentType.split(";")[0].trim(),
        data: downloaded.data.toString("base64"),
      });
    } else if (isTextFile(downloaded.name)) {
      const text = downloaded.data.toString("utf-8");
      result.textSnippets.push(
        `--- ${downloaded.name} ---\n\`\`\`\n${text}\n\`\`\``,
      );
    } else {
      result.unsupported.push(downloaded.name);
    }
  }

  return result;
}
