import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import {
  validateStagingDatabaseUrl,
  generateSchemaSql,
  parseAndPrepareStatements,
  deployStagingSchema,
} from "../scripts/deploy_staging_schema";

describe("DISHA Staging Schema Deployment Suite", () => {
  const testDbFile = path.resolve(__dirname, "disha-staging-local-test.db");
  const testDbUrl = `file:${testDbFile}`;

  after(() => {
    if (fs.existsSync(testDbFile)) {
      try {
        fs.unlinkSync(testDbFile);
      } catch {}
    }
  });

  test("1. Production Database Protection: Rejects duokarma and disha-roan production targets", () => {
    assert.throws(
      () => validateStagingDatabaseUrl("libsql://duokarma-duokarma.turso.io"),
      /Production database detected/
    );
    assert.throws(
      () => validateStagingDatabaseUrl("libsql://disha-roan-prod.turso.io"),
      /Production database detected/
    );
  });

  test("2. Target Identity Verification: Rejects missing or non-staging URLs", () => {
    assert.throws(
      () => validateStagingDatabaseUrl(""),
      /TURSO_DATABASE_URL environment variable is missing/
    );
    assert.throws(
      () => validateStagingDatabaseUrl("libsql://some-random-db.turso.io"),
      /Target database identity mismatch/
    );
    // Should not throw when targeting disha-staging
    assert.doesNotThrow(() =>
      validateStagingDatabaseUrl("libsql://disha-staging-test.turso.io")
    );
  });

  test("3. Local SQLite Schema Diff Generation: Generates pure SQLite DDL", () => {
    const sql = generateSchemaSql();
    assert.ok(sql.length > 5000, "SQL output should be substantive");
    assert.ok(sql.includes('CREATE TABLE "User"'), "DDL must include User table");
    assert.ok(sql.includes('CREATE TABLE "AppRelease"'), "DDL must include AppRelease table");
    assert.ok(sql.includes('CREATE UNIQUE INDEX "User_username_key"'), "DDL must include User index");
  });

  test("4. Statement Parser: Injects IF NOT EXISTS for tables and indexes", () => {
    const rawSql = `
      -- CreateTable
      CREATE TABLE "TestTable" ("id" TEXT NOT NULL PRIMARY KEY);
      -- CreateIndex
      CREATE UNIQUE INDEX "Test_key" ON "TestTable"("id");
      CREATE INDEX "Test_idx" ON "TestTable"("id");
    `;
    const statements = parseAndPrepareStatements(rawSql);
    assert.equal(statements.length, 3);
    assert.equal(statements[0].type, "table");
    assert.equal(statements[0].name, "TestTable");
    assert.ok(statements[0].sql.includes('CREATE TABLE IF NOT EXISTS "TestTable"'));

    assert.equal(statements[1].type, "index");
    assert.equal(statements[1].name, "Test_key");
    assert.ok(statements[1].sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS "Test_key"'));

    assert.equal(statements[2].type, "index");
    assert.equal(statements[2].name, "Test_idx");
    assert.ok(statements[2].sql.includes('CREATE INDEX IF NOT EXISTS "Test_idx"'));
  });

  test("5. End-to-End Safe Staging Deployment: Deploys all 13 tables, preserves existing data, and is idempotent", async () => {
    if (fs.existsSync(testDbFile)) {
      fs.unlinkSync(testDbFile);
    }

    // First run on fresh database
    const run1 = await deployStagingSchema({ dbUrl: testDbUrl });
    assert.equal(run1.success, true);
    assert.ok(run1.appliedTables.includes("User"));
    assert.ok(run1.appliedTables.includes("AppRelease"));
    assert.equal(run1.appliedTables.length, 13);

    // Insert a dummy record to verify no data loss occurs on subsequent deploy
    const client = createClient({ url: testDbUrl });
    await client.execute({
      sql: `INSERT INTO "User" (id, username, passwordHash, role, updatedAt) VALUES (?, ?, ?, ?, ?);`,
      args: ["test-user-1", "admin_preserve", "hash123", "SP", new Date().toISOString()],
    });

    // Second run: Must be fully idempotent and skip all 13 tables
    const run2 = await deployStagingSchema({ dbUrl: testDbUrl });
    assert.equal(run2.success, true);
    assert.equal(run2.appliedTables.length, 0, "No tables should be recreated on second run");
    assert.equal(run2.existingTables.length, 13, "All 13 tables should be recognized as existing");

    // Verify existing user record is still intact (no --force-reset, no data loss)
    const userRes = await client.execute("SELECT username FROM \"User\" WHERE id = 'test-user-1';");
    assert.equal(userRes.rows.length, 1);
    assert.equal(userRes.rows[0].username, "admin_preserve");

    client.close();
  });
});
