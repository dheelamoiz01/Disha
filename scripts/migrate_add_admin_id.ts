import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("Checking if adminId column exists in Personnel table...");
  const tableInfo: any[] = await prisma.$queryRawUnsafe("PRAGMA table_info(Personnel);");
  const hasAdminId = tableInfo.some((col) => col.name === "adminId");

  if (!hasAdminId) {
    console.log("Adding adminId column to Personnel table...");
    await prisma.$executeRawUnsafe(`ALTER TABLE "Personnel" ADD COLUMN "adminId" TEXT REFERENCES "User"("id");`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Personnel_adminId_idx" ON "Personnel"("adminId");`);
    console.log("adminId column and index created successfully!");
  } else {
    console.log("adminId column already exists.");
  }

  // Backfill existing personnel based on AuditLog records
  console.log("Backfilling ownership for existing personnel from AuditLog...");
  const staffLogs: any[] = await prisma.auditLog.findMany({
    where: { action: "CREATE_STAFF" },
    select: { actorId: true, targetId: true, createdAt: true },
    orderBy: { createdAt: "asc" }
  });

  const admins: any[] = await prisma.user.findMany({
    where: { role: { in: ["CONTROL_ROOM_OFFICER", "DYSP", "SP"] } },
    select: { id: true, username: true, role: true }
  });
  const adminMap = new Map(admins.map((a) => [a.id, a]));

  let updatedCount = 0;
  for (const log of staffLogs) {
    if (!log.targetId || !log.actorId) continue;
    const admin = adminMap.get(log.actorId);
    if (!admin) continue;

    // Only assign if target personnel exists
    const person = await prisma.personnel.findUnique({
      where: { id: log.targetId },
      select: { id: true, name: true, adminId: true }
    });

    if (person && !person.adminId) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Personnel" SET "adminId" = ? WHERE "id" = ?;`,
        admin.id,
        person.id
      );
      console.log(`Assigned staff '${person.name}' (${person.id}) -> Admin '${admin.username}' (${admin.id}, role: ${admin.role})`);
      updatedCount++;
    }
  }

  console.log(`Backfill complete. Updated ${updatedCount} personnel records.`);

  // Verify all personnel status
  const allPersonnel: any[] = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.name, p.personnelCode, p.adminId, u.username as adminUsername, u.role as adminRole 
     FROM "Personnel" p 
     LEFT JOIN "User" u ON p.adminId = u.id;`
  );
  console.log("Current Personnel Ownership State:");
  console.table(allPersonnel);
}

main().catch(console.error).finally(() => process.exit(0));
