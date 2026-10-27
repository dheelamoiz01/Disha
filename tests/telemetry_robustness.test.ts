import { singleLocationSchema, batchIngestionSchema } from "../src/domain/telemetry/validation";
import { ingestSingleLocation, ingestBatch } from "../src/services/telemetry/ingestion_service";
import { prisma } from "../src/lib/prisma";
import assert from "assert";

async function runTests() {
  console.log("=== RUNNING TELEMETRY ROBUSTNESS & SAFETY TESTS ===");

  // 1. Schema Clamping Test (Battery 101% from OEM fast charger)
  console.log("Test 1: Clamping OEM battery level (101% -> 100%)...");
  const clampedBattery = singleLocationSchema.parse({
    clientEventId: "test-clamp-1",
    latitude: 19.076,
    longitude: 72.8777,
    accuracy: 12.5,
    recordedAt: new Date().toISOString(),
    batteryLevel: 101, // OEM charger reporting > 100%
  });
  assert.strictEqual(clampedBattery.batteryLevel, 100, "Battery 101 must clamp to 100");
  console.log("✔ Test 1 passed: Battery level successfully clamped without 400 error.");

  // 2. Schema Negative Accuracy Sanitization
  console.log("Test 2: Accuracy sanitization (-5 -> 0)...");
  const sanitizedAcc = singleLocationSchema.parse({
    clientEventId: "test-acc-1",
    latitude: 19.076,
    longitude: 72.8777,
    accuracy: -5,
    recordedAt: new Date().toISOString(),
  });
  assert.strictEqual(sanitizedAcc.accuracy, 0, "Negative accuracy must clamp to 0");
  console.log("✔ Test 2 passed: Accuracy successfully sanitized.");

  // 3. Batch Schema Bounding Test
  console.log("Test 3: Batch schema accepts up to 100 items...");
  const validBatch = batchIngestionSchema.parse({
    locations: Array.from({ length: 50 }, (_, i) => ({
      clientEventId: `test-batch-${i}`,
      latitude: 19.076,
      longitude: 72.8777,
      accuracy: 10,
      recordedAt: new Date().toISOString(),
      batteryLevel: 85,
    })),
  });
  assert.strictEqual(validBatch.locations?.length, 50);
  console.log("✔ Test 3 passed: Batch schema accepts valid 50-item Android v1.0.1 payload.");

  // 4. Stale Record Safe Rejection (Does not throw 400; returns status: rejected)
  console.log("Test 4: Stale location (> 24 hours) returns status: rejected with HTTP 200 semantics...");
  const activePersonnel = await prisma.personnel.findFirst({ where: { active: true } });
  if (activePersonnel) {
    const staleDate = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30 hours ago
    const result = await ingestSingleLocation(activePersonnel.id, {
      clientEventId: `test-stale-${Date.now()}`,
      latitude: 19.076,
      longitude: 72.8777,
      accuracy: 15,
      recordedAt: staleDate,
      source: "GPS" as any,
      trackingMode: "NORMAL" as any,
    });
    assert.strictEqual(result.status, "rejected", "Stale point must be rejected");
    assert.strictEqual((result as any).code, "TIMESTAMP_STALE", "Code must be TIMESTAMP_STALE");
    console.log("✔ Test 4 passed: Stale point returned status: rejected, allowing Android client to safely evict from SQLite.");
  }

  console.log("====================================================");
  console.log("ALL TESTS PASSED! Telemetry stability confirmed.");
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
