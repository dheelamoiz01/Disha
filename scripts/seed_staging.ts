import crypto from "crypto";
import { prisma } from "../src/lib/prisma";
import { hashPassword } from "../src/lib/auth/password";
import { UserRole } from "../generated/prisma/client";
import { validateStagingDatabaseUrl } from "./deploy_staging_schema";

async function seedStaging() {
  const dbUrl = process.env.TURSO_DATABASE_URL || "";

  try {
    validateStagingDatabaseUrl(dbUrl);
  } catch (err: any) {
    console.error(err?.message || err);
    process.exit(1);
  }

  // Generate a cryptographically random one-time temporary password (high entropy, 16 chars)
  const tempPassword = `Staging_${crypto.randomBytes(12).toString("base64url")}!`;
  const pwdHash = await hashPassword(tempPassword);

  const user = await prisma.user.upsert({
    where: { username: "staging_superadmin" },
    update: {
      passwordHash: pwdHash,
      status: "ACTIVE",
    },
    create: {
      username: "staging_superadmin",
      passwordHash: pwdHash,
      role: UserRole.SP,
      displayName: "Staging Super Admin",
      status: "ACTIVE",
    },
  });

  console.log("----------------------------------------------------------------");
  console.log("DISHA Staging Synthetic Super Admin Provisioned Successfully");
  console.log("----------------------------------------------------------------");
  console.log(`Username: ${user.username}`);
  console.log(`Temporary Password: ${tempPassword}`);
  console.log("Role: SP (Super Admin)");
  console.log("Notice: No database tokens, GitHub tokens, or secrets were exposed.");
  console.log("----------------------------------------------------------------");
}

seedStaging()
  .catch((err) => {
    console.error("Failed to seed staging database:", err?.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
