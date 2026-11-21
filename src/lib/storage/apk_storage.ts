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
 * Scans paginated release assets to locate any existing duplicate asset by name.
 */
async function findExistingAsset(
  owner: string,
  repo: string,
  releaseId: number,
  assetName: string,
  headers: Record<string, string>
): Promise<{ id: number } | null> {
  let page = 1;
  const maxPages = 5; // Scan up to 500 assets across pages
  while (page <= maxPages) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`,
      { headers }
    );
    if (!res.ok) break;
    const assets = await res.json();
    if (!Array.isArray(assets) || assets.length === 0) break;
    const match = assets.find((a: any) => a.name === assetName);
    if (match?.id) return { id: match.id };
    if (assets.length < 100) break;
    page++;
  }
  return null;
}

/**
 * Uploads an APK binary directly to GitHub Releases via GitHub REST API.
 * Uses an authenticated server-side GITHUB_TOKEN secret.
 * Automatically creates the release tag if not present, and handles duplicate asset replacement.
 */
async function uploadToGitHubReleases(
  assetFileName: string,
  buffer: Buffer | Uint8Array,
  token: string,
  owner: string,
  repo: string,
  tag: string
): Promise<string> {
  const commonHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "DISHA-Storage-Service",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // 1. Fetch existing release by tag
  let releaseData: any = null;
  const getReleaseRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: commonHeaders }
  );

  if (getReleaseRes.ok) {
    releaseData = await getReleaseRes.json();
  } else if (getReleaseRes.status === 404) {
    // 2. Release does not exist yet — create it
    const createReleaseRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases`,
      {
        method: "POST",
        headers: {
          ...commonHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tag_name: tag,
          name: `DISHA Android Releases (${tag})`,
          body: "Automated rolling release for DISHA Android field tracker APK binaries.",
          draft: false,
          prerelease: false,
        }),
      }
    );

    if (!createReleaseRes.ok) {
      const errText = await createReleaseRes.text();
      throw new Error(
        `Failed to create GitHub release tag '${tag}' (${createReleaseRes.status}): ${errText}`
      );
    }
    releaseData = await createReleaseRes.json();
  } else {
    const errText = await getReleaseRes.text();
    throw new Error(
      `Failed to query GitHub release tag '${tag}' (${getReleaseRes.status}): ${errText}`
    );
  }

  // 3. Paginated Duplicate asset handling: If asset with the same name already exists, delete it first
  const existingAsset = await findExistingAsset(
    owner,
    repo,
    releaseData.id,
    assetFileName,
    commonHeaders
  );

  if (existingAsset?.id) {
    const deleteAssetRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/assets/${existingAsset.id}`,
      {
        method: "DELETE",
        headers: commonHeaders,
      }
    );
    if (!deleteAssetRes.ok && deleteAssetRes.status !== 404) {
      console.warn(
        `[ApkStorage] Warning: Failed to delete previous duplicate asset ${existingAsset.id}: ${deleteAssetRes.status}`
      );
    }
  }

  // 4. Upload APK binary asset to GitHub Releases
  const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseData.id}/assets?name=${encodeURIComponent(assetFileName)}`;
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...commonHeaders,
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": buffer.byteLength.toString(),
    },
    body: buffer as any,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(
      `GitHub Releases asset upload failed (${uploadRes.status}): ${errText}`
    );
  }

  const assetData = await uploadRes.json();
  if (!assetData?.browser_download_url) {
    throw new Error("GitHub Releases asset upload succeeded but returned no browser_download_url.");
  }

  return assetData.browser_download_url;
}

/**
 * Saves an uploaded APK file.
 * In production/staging (Cloudflare Workers), uploads directly to GitHub Releases.
 * In local test runners without GITHUB_TOKEN, falls back to local disk for offline testing.
 */
export async function saveApkFile(
  originalName: string,
  buffer: Buffer | Uint8Array
): Promise<ApkSaveResult> {
  // Validate non-empty payload to prevent zero-byte corrupt uploads
  if (!buffer || buffer.byteLength === 0) {
    throw new Error("Cannot upload empty APK file (0 bytes).");
  }

  const safeBaseName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const uniqueKey = `${Date.now()}_${safeBaseName}`;

  // Calculate SHA-256 checksum strictly from the uploaded bytes
  const sha256Checksum = crypto.createHash("sha256").update(buffer).digest("hex").toLowerCase();
  const fileSizeBytes = buffer.byteLength;

  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const owner = process.env.GITHUB_REPO_OWNER?.trim() || "dheelamoiz01";
  const repo = process.env.GITHUB_REPO_NAME?.trim() || "Disha";
  const tag = process.env.GITHUB_RELEASE_TAG?.trim() || "app-releases";

  // If GITHUB_TOKEN is present, upload via GitHub Releases API
  if (githubToken) {
    const downloadUrl = await uploadToGitHubReleases(
      safeBaseName,
      buffer,
      githubToken,
      owner,
      repo,
      tag
    );

    return {
      downloadUrl,
      key: safeBaseName,
      sha256Checksum,
      fileSizeBytes,
      fileName: originalName,
    };
  }

  // If running in a Cloudflare Worker environment and GITHUB_TOKEN is missing, fail explicitly.
  const isWorkerRuntime =
    typeof process === "undefined" ||
    process.env.ENVIRONMENT === "production" ||
    process.env.ENVIRONMENT === "staging" ||
    (typeof process.env.CF_PAGES !== "undefined");

  if (isWorkerRuntime) {
    throw new Error(
      "APK Storage Error: GITHUB_TOKEN secret is not configured in Cloudflare Workers. Local filesystem fallback is disabled in serverless runtime."
    );
  }

  // Safe Fallback: Only permitted in local Node.js test/development environments without GITHUB_TOKEN
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
    throw new Error(`Failed to save APK in local development fallback: ${err?.message}`);
  }
}

/**
 * Retrieves an APK stream for download if stored locally.
 * If downloadUrl is a full external URL (GitHub Releases CDN), the route issues a 302 redirect.
 */
export async function getApkStream(keyOrPath: string): Promise<ApkStreamResult | null> {
  // If external URL (GitHub Releases), caller should redirect
  if (keyOrPath.startsWith("http://") || keyOrPath.startsWith("https://")) {
    return null;
  }

  // Local filesystem stream fallback (only in dev/tests)
  try {
    const fs = await import("fs");
    const path = await import("path");

    const relativeClean = keyOrPath.startsWith("/") ? keyOrPath.substring(1) : keyOrPath;
    const localFilePath = path.join(process.cwd(), "public", relativeClean);

    if (fs.existsSync(localFilePath)) {
      const stat = await fs.promises.stat(localFilePath);
      const fileStream = fs.createReadStream(localFilePath);

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
