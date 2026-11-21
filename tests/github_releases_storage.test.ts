import test from "node:test";
import assert from "node:assert";
import crypto from "crypto";
import { saveApkFile } from "../src/lib/storage/apk_storage";

test("GitHub Releases APK Storage Unit & Integrity Test Suite", async (t) => {
  // Generate a non-empty sample binary buffer (64 KB) simulating an Android APK zip archive
  const sampleApkBuffer = Buffer.alloc(65536);
  for (let i = 0; i < sampleApkBuffer.length; i++) {
    sampleApkBuffer[i] = (i * 31 + 17) % 256;
  }
  // Standard zip/apk magic header
  sampleApkBuffer.write("PK\x03\x04", 0);

  const expectedSha256 = crypto
    .createHash("sha256")
    .update(sampleApkBuffer)
    .digest("hex")
    .toLowerCase();

  const originalFetch = globalThis.fetch;

  t.afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_TOKEN;
    delete process.env.ENVIRONMENT;
  });

  await t.test("1. Rejects 0-byte / empty buffer upload to prevent corrupt releases", async () => {
    const emptyBuffer = Buffer.alloc(0);
    await assert.rejects(
      async () => {
        await saveApkFile("empty.apk", emptyBuffer);
      },
      /Cannot upload empty APK file \(0 bytes\)/
    );
  });

  await t.test("2. Fails with clear error in Worker runtime if GITHUB_TOKEN is missing", async () => {
    process.env.ENVIRONMENT = "production";
    delete process.env.GITHUB_TOKEN;

    await assert.rejects(
      async () => {
        await saveApkFile("disha-test.apk", sampleApkBuffer);
      },
      /GITHUB_TOKEN secret is not configured in Cloudflare Workers/
    );
  });

  await t.test("3. Handles GitHub API 401 Unauthorized (invalid/expired token)", async () => {
    process.env.GITHUB_TOKEN = "ghp_invalid_token_test";
    process.env.GITHUB_REPO_OWNER = "dheelamoiz01";
    process.env.GITHUB_REPO_NAME = "Disha";

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await assert.rejects(
      async () => {
        await saveApkFile("disha-test.apk", sampleApkBuffer);
      },
      /Failed to query GitHub release tag.*401/
    );
  });

  await t.test("4. Handles GitHub API 404 Repo Not Found during release lookup & creation", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token";
    process.env.GITHUB_REPO_OWNER = "dheelamoiz01";
    process.env.GITHUB_REPO_NAME = "NonExistentRepo";

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await assert.rejects(
      async () => {
        await saveApkFile("disha-test.apk", sampleApkBuffer);
      },
      /Failed to create GitHub release tag.*404/
    );
  });

  await t.test("5. Handles GitHub API upload asset error (e.g. 422 Unprocessable)", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token";
    process.env.GITHUB_REPO_OWNER = "dheelamoiz01";
    process.env.GITHUB_REPO_NAME = "Disha";

    globalThis.fetch = (async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.startsWith("https://uploads.github.com")) {
        return new Response(
          JSON.stringify({ message: "Validation Failed", errors: ["Asset upload error"] }),
          { status: 422, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("/releases/tags/")) {
        return new Response(JSON.stringify({ id: 12345, assets: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/releases/12345/assets")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    await assert.rejects(
      async () => {
        await saveApkFile("disha-test.apk", sampleApkBuffer);
      },
      /GitHub Releases asset upload failed \(422\)/
    );
  });

  await t.test("6. End-to-End Integrity: Uploaded bytes SHA-256 strictly matches downloaded asset SHA-256", async () => {
    process.env.GITHUB_TOKEN = "ghp_valid_test_token";
    process.env.GITHUB_REPO_OWNER = "dheelamoiz01";
    process.env.GITHUB_REPO_NAME = "Disha";
    process.env.GITHUB_RELEASE_TAG = "app-releases";

    let capturedUploadedBytes: Buffer | null = null;
    let paginatedPageRequested = 0;
    let deletedDuplicateAssetId: number | null = null;

    globalThis.fetch = (async (url: any, init: any) => {
      const urlStr = url.toString();

      // Check upload endpoint FIRST
      if (urlStr.startsWith("https://uploads.github.com")) {
        capturedUploadedBytes = Buffer.from(init.body);
        return new Response(
          JSON.stringify({
            id: 990011,
            name: "disha-tracker.apk",
            browser_download_url:
              "https://github.com/dheelamoiz01/Disha/releases/download/app-releases/disha-tracker.apk",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }

      // Duplicate asset deletion
      if (init?.method === "DELETE" && urlStr.includes("/assets/8877")) {
        deletedDuplicateAssetId = 8877;
        return new Response(null, { status: 204 });
      }

      // Paginated Asset Discovery (Duplicate search across pages)
      if (urlStr.includes("/releases/998877/assets")) {
        paginatedPageRequested++;
        if (urlStr.includes("&page=1")) {
          // Page 1: 100 unrelated assets
          const dummyAssets = Array.from({ length: 100 }, (_, i) => ({
            id: 1000 + i,
            name: `other-release-v${i}.apk`,
          }));
          return new Response(JSON.stringify(dummyAssets), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("&page=2")) {
          // Page 2: Contains target duplicate asset
          return new Response(
            JSON.stringify([
              {
                id: 8877,
                name: "disha-tracker.apk",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }

      // Release Tag Lookup
      if (urlStr.includes("/releases/tags/app-releases")) {
        return new Response(JSON.stringify({ id: 998877 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    }) as any;

    const result = await saveApkFile("disha-tracker.apk", sampleApkBuffer);

    // Assertions
    assert.strictEqual(deletedDuplicateAssetId, 8877, "Must locate and delete duplicate asset across pages");
    assert.strictEqual(paginatedPageRequested, 2, "Must paginate through assets to find target duplicate");
    assert.ok(capturedUploadedBytes != null, "Must upload non-empty binary payload to GitHub");

    // Exact byte-level verification
    const uploadedSha256 = crypto
      .createHash("sha256")
      .update(capturedUploadedBytes!)
      .digest("hex")
      .toLowerCase();

    assert.strictEqual(
      result.sha256Checksum,
      expectedSha256,
      "Result checksum must match the source sample APK"
    );
    assert.strictEqual(
      uploadedSha256,
      expectedSha256,
      "Uploaded binary SHA-256 must match exactly"
    );
    assert.strictEqual(
      result.fileSizeBytes,
      sampleApkBuffer.byteLength,
      "Uploaded file size must match byte length exactly"
    );
    assert.strictEqual(
      result.downloadUrl,
      "https://github.com/dheelamoiz01/Disha/releases/download/app-releases/disha-tracker.apk"
    );
  });
});
