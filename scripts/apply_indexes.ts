import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("Checking and applying optimized indexes on Turso...");

  // 1. Index on Location(recordedAt)
  console.log("Creating index Location_recordedAt_idx...");
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "Location_recordedAt_idx" ON "Location"("recordedAt");`
  );

  // 2. Index on LocationEvent(recordedAt)
  console.log("Creating index LocationEvent_recordedAt_idx...");
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "LocationEvent_recordedAt_idx" ON "LocationEvent"("recordedAt");`
  );

  // 3. Index on Heartbeat(recordedAt)
  console.log("Creating index Heartbeat_recordedAt_idx...");
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "Heartbeat_recordedAt_idx" ON "Heartbeat"("recordedAt");`
  );

  // 4. Verify new query plan for purge query
  const plan: any = await prisma.$queryRawUnsafe(
    `EXPLAIN QUERY PLAN SELECT id FROM Location WHERE recordedAt < ? LIMIT 500;`,
    new Date().toISOString()
  );
  console.log("\nNew Query Plan for Location purge (recordedAt < ?):");
  console.log(JSON.stringify(plan, null, 2));

  // 5. Verify new query plan for LocationEvent purge
  const plan2: any = await prisma.$queryRawUnsafe(
    `EXPLAIN QUERY PLAN SELECT id FROM LocationEvent WHERE recordedAt < ? LIMIT 500;`,
    new Date().toISOString()
  );
  console.log("\nNew Query Plan for LocationEvent purge (recordedAt < ?):");
  console.log(JSON.stringify(plan2, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
