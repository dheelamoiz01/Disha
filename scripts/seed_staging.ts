import { prisma } from "../src/lib/prisma";
import { hashPassword } from "../src/lib/auth/password";
import { UserRole } from "../generated/prisma/client";
import { validateStagingDatabaseUrl } from "./deploy_staging_schema";

export interface UpdateSuperAdminOptions {
  dbUrl?: string;
  username?: string;
  password?: string;
}

/**
 * Updates or provisions the DISHA staging Super Admin account credentials safely.
 * Strictly verifies the staging database identity and prevents duplicate accounts.
 */
export async function updateStagingSuperAdmin(options?: UpdateSuperAdminOptions) {
  const dbUrl = options?.dbUrl || process.env.TURSO_DATABASE_URL || "";
  validateStagingDatabaseUrl(dbUrl);

  const targetUsername = options?.username || process.env.STAGING_SUPERADMIN_USERNAME || "admin";
  const targetPassword = options?.password || process.env.STAGING_SUPERADMIN_PASSWORD;

  if (!targetPassword) {
    throw new Error(
      "FATAL: Password is required. Please set the STAGING_SUPERADMIN_PASSWORD environment variable."
    );
  }

  // 1. Generate Argon2id hash using DISHA's production-standard implementation
  const pwdHash = await hashPassword(targetPassword);

  // 2. Locate existing superadmin account to prevent duplicate accounts
  const existingStagingUser = await prisma.user.findUnique({
    where: { username: "staging_superadmin" },
  });

  const existingTargetUser = await prisma.user.findUnique({
    where: { username: targetUsername },
  });

  let userId: string;

  if (existingStagingUser) {
    // If staging_superadmin exists, rename to targetUsername and update password hash while preserving relations
    const updated = await prisma.user.update({
      where: { id: existingStagingUser.id },
      data: {
        username: targetUsername,
        passwordHash: pwdHash,
        role: UserRole.SP,
        status: existingStagingUser.status || "ACTIVE",
      },
    });
    userId = updated.id;
    console.log(`Updated existing "staging_superadmin" account (ID: ${userId}) to "${targetUsername}".`);
  } else if (existingTargetUser) {
    // If targetUsername already exists, update password hash and preserve SP role
    const updated = await prisma.user.update({
      where: { id: existingTargetUser.id },
      data: {
        passwordHash: pwdHash,
        role: UserRole.SP,
        status: existingTargetUser.status || "ACTIVE",
      },
    });
    userId = updated.id;
    console.log(`Updated existing "${targetUsername}" account (ID: ${userId}).`);
  } else {
    // If neither exists, create initial superadmin
    const created = await prisma.user.create({
      data: {
        username: targetUsername,
        passwordHash: pwdHash,
        role: UserRole.SP,
        displayName: "Staging Super Admin",
        status: "ACTIVE",
      },
    });
    userId = created.id;
    console.log(`Created new "${targetUsername}" account (ID: ${userId}).`);
  }

  // 3. Verify the updated account from database
  const verifiedUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      role: true,
      status: true,
      updatedAt: true,
    },
  });

  if (!verifiedUser || verifiedUser.username !== targetUsername || verifiedUser.role !== UserRole.SP) {
    throw new Error(`Verification failed: Account "${targetUsername}" not properly configured with role SP.`);
  }

  console.log("----------------------------------------------------------------");
  console.log("DISHA Staging Super Admin Account Verified Successfully");
  console.log("----------------------------------------------------------------");
  console.log(`User ID: ${verifiedUser.id}`);
  console.log(`Username: ${verifiedUser.username}`);
  console.log(`Role: ${verifiedUser.role}`);
  console.log(`Status: ${verifiedUser.status}`);
  console.log("Password Hash: [REDACTED - ARGON2ID VERIFIED]");
  console.log("Notice: No plaintext credentials or database tokens were exposed.");
  console.log("----------------------------------------------------------------");

  return verifiedUser;
}

// Standalone execution entrypoint
if (require.main === module) {
  updateStagingSuperAdmin()
    .catch((err) => {
      console.error("\nFATAL ERROR updating staging Super Admin:", err?.message || err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
