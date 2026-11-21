import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient, UserRole } from "../generated/prisma/client";
import { hashPassword, verifyPassword } from "../src/lib/auth/password";
import { validateStagingDatabaseUrl } from "../scripts/deploy_staging_schema";

describe("DISHA Staging Super Admin Credential Update Suite", () => {
  const testDbFile = path.resolve(__dirname, "disha-staging-admin-test.db");
  const testDbUrl = `file:${testDbFile}`;

  after(() => {
    if (fs.existsSync(testDbFile)) {
      try {
        fs.unlinkSync(testDbFile);
      } catch {}
    }
  });

  test("1. Production Safeguard: Aborts and rejects production database identities", () => {
    assert.throws(
      () => validateStagingDatabaseUrl("libsql://disha-roan-duokarma.aws-ap-south-1.turso.io"),
      /Production database identity detected/
    );
    assert.throws(
      () => validateStagingDatabaseUrl("libsql://duokarma-duokarma.turso.io"),
      /Production database identity detected/
    );
  });

  test("2. Target Identity Verification: Rejects non-staging databases", () => {
    assert.throws(
      () => validateStagingDatabaseUrl("libsql://production-db.turso.io"),
      /Target database identity mismatch/
    );
    assert.doesNotThrow(() =>
      validateStagingDatabaseUrl("libsql://disha-staging-duokarma.aws-ap-south-1.turso.io")
    );
  });

  test("3. Super Admin Update & Verification: Renames staging_superadmin to admin, hashes password with Argon2id, and avoids duplicate accounts", async () => {
    if (fs.existsSync(testDbFile)) {
      fs.unlinkSync(testDbFile);
    }

    // Set up a local test database with schema
    const client = createClient({ url: testDbUrl });
    await client.execute(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "username" TEXT NOT NULL UNIQUE,
        "passwordHash" TEXT NOT NULL,
        "role" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'ACTIVE',
        "displayName" TEXT,
        "permissions" TEXT DEFAULT '[]',
        "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      );
    `);

    // Insert initial staging_superadmin with old password
    const initialOldHash = await hashPassword("OldRandomPassword_123!");
    await client.execute({
      sql: `INSERT INTO "User" (id, username, passwordHash, role, status, displayName, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      args: ["user_superadmin_orig", "staging_superadmin", initialOldHash, "SP", "ACTIVE", "Original Staging Super Admin", new Date().toISOString()],
    });

    const adapter = new PrismaLibSql({ url: testDbUrl });
    const localPrisma = new PrismaClient({ adapter });

    try {
      const targetUsername = "admin";
      const targetPassword = "admin@123";

      // 1. Hash with exact Argon2id implementation
      const newHash = await hashPassword(targetPassword);

      // 2. Check existing staging_superadmin
      const existingStaging = await localPrisma.user.findUnique({
        where: { username: "staging_superadmin" },
      });
      assert.ok(existingStaging, "staging_superadmin should exist initially");

      // 3. Update existing staging_superadmin (no duplicate account created)
      const updated = await localPrisma.user.update({
        where: { id: existingStaging.id },
        data: {
          username: targetUsername,
          passwordHash: newHash,
          role: UserRole.SP,
        },
      });

      assert.equal(updated.id, "user_superadmin_orig", "Original account ID must be preserved");
      assert.equal(updated.username, "admin", "Username must be updated to admin");
      assert.equal(updated.role, UserRole.SP, "Role must be SP");

      // 4. Verify no duplicate accounts exist
      const allUsers = await localPrisma.user.findMany();
      assert.equal(allUsers.length, 1, "Exactly one user must exist; no duplicate accounts");

      // 5. Verify the password can be verified with exact Argon2id verifyPassword
      const isValid = await verifyPassword(targetPassword, updated.passwordHash);
      assert.equal(isValid, true, "New password admin@123 must verify against the stored hash");

      // 6. Verify incorrect password fails
      const isInvalid = await verifyPassword("wrong_password", updated.passwordHash);
      assert.equal(isInvalid, false, "Wrong password must fail");

      // 7. Verify previous username staging_superadmin no longer exists
      const oldCheck = await localPrisma.user.findUnique({
        where: { username: "staging_superadmin" },
      });
      assert.equal(oldCheck, null, "staging_superadmin must no longer exist");
    } finally {
      await localPrisma.$disconnect();
      client.close();
    }
  });
});
