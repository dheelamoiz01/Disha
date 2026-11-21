import test from "node:test";
import assert from "node:assert";
import { saveApkFile } from "../src/lib/storage/apk_storage";

test("GitHub Releases APK Storage Unit & Error Test Suite", async (t) => {
  const dummyApkBuffer = Buffer.from("PK\x03\x04DummyApkBinaryContentForTestingOnly2026");
  const originalFetch = globalThis.fetch;

  t.afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_TOKEN;
    delete process.env.ENVIRONMENT;
  });

  await t.test("1. Fails with clear error in Worker runtime if GITHUB_TOKEN is missing", async () => {
    process.env.ENVIRONMENT = "production";
    delete process.env.GITHUB_TOKEN;

    await assert.rejects(
      async () => {
        await saveApkFile("disha-test.apk", dummyApkBuffer);
      },
      /GITHUB_TOKEN secret is not configured in Cloudflare Workers/
    );
  });

  await t.test("2. Handles GitHub API 401 Unauthorized (invalid/expired token)", async () => {
    process.env.GITHUB_TOKEN = "ghp_invalid_token_test";
    process.env.GITHUB_REPO_OWNER = "dheelamoiz01";
    process.env.GITHUB_REPO_NAME = "Disha";

    globalThis.fetch = (async (url: any) => {
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await assert.rejects(
      async () => {
        await saveApkFile("disha-test.apk", dummyApkBuffer);
      },
      /Failed to query GitHub release tag.*401/
    );
  });

  await t.test("3. Handles GitHub API 404 Repo Not Found during release lookup & creation failure", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token";
    process.env.GITHUB_REPO_OWNER = "dheelamoiz01";
    process.env.GITHUB_REPO_NAME = "NonExistentRepo";

    globalThis.fetch = (async (url: any, init: any) => {
      const urlStr = url.toString();
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    await assert.rejects(
      async () => {
        await saveApkFile("disha-test.apk", dummyApkBuffer);
      },
      /Failed to create GitHub release tag.*404/
    );
  });

  await t.test("4. Handles GitHub API upload asset error (e.g. 422 Unprocessable)", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token";
    process.env.GITHUB_REPO_OWNER = "dheelamoiz01";
    process.env.GITHUB_REPO_NAME = "Disha";

    globalThis.fetch = (async (url: any, init: any) => {
      const urlStr = url.toString();
      if (urlStr.includes("/releases/tags/")) {
        return new Response(JSON.stringify({ id: 12345, assets: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("uploads.github.com")) {
        return new Response(JSON.stringify({ message: "Validation Failed", errors: ["Asset upload error"] }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    await assert.rejects(
      async () => {
        await saveApkFile("disha-test.apk", dummyApkBuffer);
      },
      /GitHub Releases asset upload failed \(422\)/
    );
  });

  await t.test("5. Successfully uploads APK and deletes duplicate existing asset", async () => {
    process.env.GITHUB_TOKEN = "ghp_valid_test_token";
    process.env.GITHUB_REPO_OWNER = "dheelamoiz01";
    process.env.GITHUB_REPO_NAME = "Disha";
    process.env.GITHUB_RELEASE_TAG = "app-releases";

    let deletedOldAssetId: number | null = null;
    let uploadedAssetUrl: string | null = null;

    globalThis.fetch = (async (url: any, init: any) => {
      const urlStr = url.toString();

      // 1. Tag lookup returns existing release with duplicate asset
      if (urlStr.includes("/releases/tags/app-releases")) {
        return new Response(
          JSON.stringify({
            id: 998877,
            assets: [
              {
                id: 5544,
                name: "duplicate-to-be-overwritten.apk",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // 2. Asset delete endpoint
      if (init?.method === "DELETE" && urlStr.includes("/assets/5544")) {
        deletedOldAssetId = 5544;
        return new Response(null, { status: 204 });
      }

      // 3. Asset upload endpoint
      if (urlStr.includes("uploads.github.com")) {
        uploadedAssetUrl = urlStr;
        return new Response(
          JSON.stringify({
            id: 778899,
            name: "disha-tracker.apk",
            browser_download_url:
              "https://github.com/dheelamoiz01/Disha/releases/download/app-releases/disha-tracker.apk",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not Found", { status: 404 });
    }) as any;

    const result = await saveApkFile("duplicate-to-be-overwritten.apk", dummyApkBuffer);

    assert.strictEqual(deletedOldAssetId, 5544, "Must delete prior duplicate asset");
    assert.strictEqual(
      result.downloadUrl,
      "https://github.com/dheelamoiz01/Disha/releases/download/app-releases/disha-tracker.apk"
    );
    assert.ok(result.sha256Checksum.length === 64);
    assert.strictEqual(result.fileSizeBytes, dummyApkBuffer.byteLength);
    assert.strictEqual(result.fileName, "duplicate-to-be-overwritten.apk");
  });
});
