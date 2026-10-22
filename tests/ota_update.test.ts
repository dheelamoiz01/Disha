import test from "node:test";
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import {
  publishRelease,
  getLatestActiveRelease,
  checkAppUpdate,
  getAllReleases,
} from "../src/services/release/release_service";

test("Disha In-App OTA Update System Test Suite", async (t) => {
  const testVersionCode1 = 9001;
  const testVersionCode2 = 9002;
  const dummySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  await t.test("Cleanup pre-existing test releases", async () => {
    await prisma.appRelease.deleteMany({
      where: {
        versionCode: { in: [testVersionCode1, testVersionCode2] },
      },
    });
  });

  await t.test("1. Input validation for publishRelease", async () => {
    // Invalid versionCode
    await assert.rejects(
      async () => {
        await publishRelease({
          versionCode: 0,
          versionName: "1.0.0",
          releaseNotes: "Initial",
          downloadUrl: "/downloads/apk/app.apk",
          sha256Checksum: dummySha256,
        });
      },
      /versionCode must be a positive integer/
    );

    // Empty versionName
    await assert.rejects(
      async () => {
        await publishRelease({
          versionCode: testVersionCode1,
          versionName: "",
          releaseNotes: "Initial",
          downloadUrl: "/downloads/apk/app.apk",
          sha256Checksum: dummySha256,
        });
      },
      /versionName cannot be empty/
    );

    // Invalid SHA-256 (too short or non-hex)
    await assert.rejects(
      async () => {
        await publishRelease({
          versionCode: testVersionCode1,
          versionName: "1.0.0",
          releaseNotes: "Initial",
          downloadUrl: "/downloads/apk/app.apk",
          sha256Checksum: "invalid-hash-123",
        });
      },
      /sha256Checksum must be a 64-character hexadecimal string/
    );
  });

  await t.test("2. Publish release v1 (optional update)", async () => {
    const release = await publishRelease({
      versionCode: testVersionCode1,
      versionName: "9.0.1",
      releaseNotes: "Test release v9.0.1 with 24x7 tracking",
      downloadUrl: "/downloads/apk/disha-test-9.0.1.apk",
      sha256Checksum: dummySha256,
      fileSizeBytes: 10485760, // 10 MB
      minSupportedVersionCode: 9000,
      isMandatory: false,
    });

    assert.ok(release.id);
    assert.strictEqual(release.versionCode, testVersionCode1);
    assert.strictEqual(release.versionName, "9.0.1");
    assert.strictEqual(release.isMandatory, false);
    assert.strictEqual(release.minSupportedVersionCode, 9000);
  });

  await t.test("3. checkAppUpdate for device on older version", async () => {
    // 8999 is below minSupportedVersionCode (9000), so update is mandatory
    const result = await checkAppUpdate(8999);
    assert.strictEqual(result.updateAvailable, true);
    assert.ok(result.latestRelease);
    assert.strictEqual(result.latestRelease.versionCode, testVersionCode1);
    // Device is below minSupportedVersionCode (9000), so it should be mandatory
    assert.strictEqual(result.latestRelease.isMandatory, true);
  });

  await t.test("4. checkAppUpdate for device within supported version range", async () => {
    const result = await checkAppUpdate(9000);
    assert.strictEqual(result.updateAvailable, true);
    assert.ok(result.latestRelease);
    // Current version is 9000 >= minSupported (9000) and release is not mandatory
    assert.strictEqual(result.latestRelease.isMandatory, false);
  });

  await t.test("5. checkAppUpdate for device already on latest version", async () => {
    const result = await checkAppUpdate(testVersionCode1);
    assert.strictEqual(result.updateAvailable, false);
    assert.strictEqual(result.latestRelease, null);
  });

  await t.test("6. Publish release v2 (explicit mandatory update)", async () => {
    const release = await publishRelease({
      versionCode: testVersionCode2,
      versionName: "9.0.2",
      releaseNotes: "Critical security patch",
      downloadUrl: "/downloads/apk/disha-test-9.0.2.apk",
      sha256Checksum: dummySha256,
      fileSizeBytes: 10500000,
      minSupportedVersionCode: testVersionCode2,
      isMandatory: true,
    });

    assert.ok(release.id);
    assert.strictEqual(release.versionCode, testVersionCode2);
    assert.strictEqual(release.isMandatory, true);

    const latest = await getLatestActiveRelease();
    assert.ok(latest);
    assert.strictEqual(latest.versionCode, testVersionCode2);

    // Device on testVersionCode1 should now see updateAvailable = true, isMandatory = true
    const checkResult = await checkAppUpdate(testVersionCode1);
    assert.strictEqual(checkResult.updateAvailable, true);
    assert.ok(checkResult.latestRelease);
    assert.strictEqual(checkResult.latestRelease.versionCode, testVersionCode2);
    assert.strictEqual(checkResult.latestRelease.isMandatory, true);
  });

  await t.test("7. Update existing release in-place", async () => {
    const updated = await publishRelease({
      versionCode: testVersionCode2,
      versionName: "9.0.2-revised",
      releaseNotes: "Revised release notes",
      downloadUrl: "/downloads/apk/disha-test-9.0.2-revised.apk",
      sha256Checksum: dummySha256,
      minSupportedVersionCode: testVersionCode2,
      isMandatory: true,
    });

    assert.strictEqual(updated.versionName, "9.0.2-revised");
    assert.strictEqual(updated.releaseNotes, "Revised release notes");

    // Ensure no duplicate records created
    const all = await getAllReleases();
    const matches = all.filter((r) => r.versionCode === testVersionCode2);
    assert.strictEqual(matches.length, 1);
  });

  await t.test("8. Cleanup test releases", async () => {
    await prisma.appRelease.deleteMany({
      where: {
        versionCode: { in: [testVersionCode1, testVersionCode2] },
      },
    });
  });
});
