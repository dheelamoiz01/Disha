import crypto from "crypto";

export interface ApkSaveResult {
  downloadUrl: string;
  key: string;
  sha256Checksum: string;
  fileSizeBytes: number;
  fileName: string;
}

export interface ApkStreamResult {
  stream: ReadableStream;
  size?: number;
  sha256Checksum?: string;
  contentType: string;
}

/**
 * Safely accesses the Cloudflare R2 bucket binding if running within the Cloudflare Workers runtime.
 */
function getCloudflareR2Bucket(): any | null {
  try {
    // Dynamic access to avoid build-time failures outside of Cloudflare
    const openNext = require("@opennextjs/cloudflare");
    const ctx = openNext.getCloudflareContext?.();
    if (ctx?.env?.APK_BUCKET) {
      return ctx.env.APK_BUCKET;
    }
  } catch {
    // Running in standard Node.js or test environment
  }

  // Also check globalThis or process.env binding if directly attached
  const g = globalThis as any;
  if (g?.APK_BUCKET) {
    return g.APK_BUCKET;
  }
  if (typeof process !== "undefined" && (process.env as any)?.APK_BUCKET) {
    return (process.env as any).APK_BUCKET;
  }

  return null;
}

/**
 * Saves an uploaded APK file.
 * Prioritizes Cloudflare R2 storage if available.
 * Falls back to local filesystem storage in Node.js / dev environments.
 */
export async function saveApkFile(
  originalName: string,
  buffer: Buffer | Uint8Array
): Promise<ApkSaveResult> {
  const safeBaseName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const uniqueKey = `${Date.now()}_${safeBaseName}`;

  // Calculate SHA-256 checksum
  const sha256Checksum = crypto.createHash("sha256").update(buffer).digest("hex").toLowerCase();
  const fileSizeBytes = buffer.byteLength;

  const r2Bucket = getCloudflareR2Bucket();
  if (r2Bucket) {
    // Store in Cloudflare R2 bucket
    await r2Bucket.put(uniqueKey, buffer, {
      httpMetadata: {
        contentType: "application/vnd.android.package-archive",
        cacheControl: "public, max-age=86400, immutable",
      },
      customMetadata: {
        sha256: sha256Checksum,
        originalName: safeBaseName,
      },
    });

    // If an external R2 public domain is configured, use it directly; otherwise use the app's download endpoint
    const r2PublicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");
    const downloadUrl = r2PublicUrl
      ? `${r2PublicUrl}/${uniqueKey}`
      : `/api/app/release/download/${uniqueKey}`;

    return {
      downloadUrl,
      key: uniqueKey,
      sha256Checksum,
      fileSizeBytes,
      fileName: originalName,
    };
  }

  // Fallback: Node.js filesystem (used in local development or standalone tests)
  try {
    const fs = await import("fs");
    const path = await import("path");
    const targetDir = path.join(process.cwd(), "public", "downloads", "apk");
    await fs.promises.mkdir(targetDir, { recursive: true });

    const filePath = path.join(targetDir, uniqueKey);
    await fs.promises.writeFile(filePath, buffer);

    return {
      downloadUrl: `/downloads/apk/${uniqueKey}`,
      key: uniqueKey,
      sha256Checksum,
      fileSizeBytes,
      fileName: originalName,
    };
  } catch (err: any) {
    console.error("[ApkStorage] Failed to save APK to filesystem fallback:", err?.message);
    throw new Error(
      "Storage provider unavailable: Please configure Cloudflare R2 (APK_BUCKET) or ensure a writable filesystem is present."
    );
  }
}

/**
 * Retrieves an APK file as a web ReadableStream for download.
 * Checks Cloudflare R2 first, then local filesystem fallback.
 */
export async function getApkStream(keyOrPath: string): Promise<ApkStreamResult | null> {
  // 1. Try Cloudflare R2
  const r2Bucket = getCloudflareR2Bucket();
  if (r2Bucket) {
    const cleanKey = keyOrPath.replace(/^(\/downloads\/apk\/|\/api\/app\/release\/download\/)/, "");
    const r2Object = await r2Bucket.get(cleanKey);
    if (r2Object) {
      return {
        stream: r2Object.body,
        size: r2Object.size,
        sha256Checksum: r2Object.customMetadata?.sha256,
        contentType: "application/vnd.android.package-archive",
      };
    }
  }

  // 2. Try Node.js filesystem fallback
  try {
    const fs = await import("fs");
    const path = await import("path");

    const relativeClean = keyOrPath.startsWith("/") ? keyOrPath.substring(1) : keyOrPath;
    const localFilePath = path.join(process.cwd(), "public", relativeClean);

    if (fs.existsSync(localFilePath)) {
      const stat = await fs.promises.stat(localFilePath);
      const fileStream = fs.createReadStream(localFilePath);

      // Convert Node ReadStream to Web ReadableStream
      const webStream = new ReadableStream({
        start(controller) {
          fileStream.on("data", (chunk) => controller.enqueue(chunk));
          fileStream.on("end", () => controller.close());
          fileStream.on("error", (err) => controller.error(err));
        },
      });

      return {
        stream: webStream,
        size: stat.size,
        contentType: "application/vnd.android.package-archive",
      };
    }
  } catch {
    // Filesystem not accessible in edge/worker environment
  }

  return null;
}
