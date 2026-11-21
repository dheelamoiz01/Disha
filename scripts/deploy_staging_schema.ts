import { createClient } from "@libsql/client";
import { execFileSync } from "child_process";
import path from "path";

export interface DeployResult {
  success: boolean;
  appliedTables: string[];
  appliedIndexes: string[];
  existingTables: string[];
  existingIndexes: string[];
  totalStatements: number;
}

/**
 * Validates the database URL strictly for staging safety.
 * Throws an error if URL points to production or does not match staging.
 */
export function validateStagingDatabaseUrl(url: string): void {
  const normalized = (url || "").trim().toLowerCase();

  if (!normalized) {
    throw new Error("FATAL: TURSO_DATABASE_URL environment variable is missing.");
  }

  // 1. Explicitly reject known production databases
  if (normalized.includes("duokarma") || normalized.includes("disha-roan")) {
    throw new Error("FATAL: Production database detected. Refusing to deploy schema to production.");
  }

  // 2. Strictly require the staging database identity ('disha-staging')
  if (!normalized.includes("disha-staging")) {
    throw new Error(
      "FATAL: Target database identity mismatch. TURSO_DATABASE_URL must explicitly target 'disha-staging'."
    );
  }
}

/**
 * Generates SQL DDL using Prisma's official schema-diff command against the SQLite datamodel.
 */
export function generateSchemaSql(): string {
  const prismaPkg = require.resolve("prisma/package.json");
  const prismaBin = path.join(path.dirname(prismaPkg), "build/index.js");
  const schemaPath = path.resolve(__dirname, "../prisma/schema.prisma");

  const output = execFileSync(
    process.execPath,
    [prismaBin, "migrate", "diff", "--from-empty", "--to-schema", schemaPath, "--script"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );

  return output;
}

/**
 * Parses raw DDL script into individual clean statements and adds IF NOT EXISTS for idempotency.
 */
export function parseAndPrepareStatements(rawSql: string): {
  type: "table" | "index" | "other";
  name: string;
  sql: string;
}[] {
  const rawStatements = rawSql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const parsed: { type: "table" | "index" | "other"; name: string; sql: string }[] = [];

  for (const raw of rawStatements) {
    const lines = raw.split("\n");
    const uncommented = lines
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("--") && l.length > 0)
      .join(" ");

    if (!uncommented) continue;

    // Table creation
    const tableMatch = uncommented.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z0-9_]+)"?/i);
    if (tableMatch) {
      const tableName = tableMatch[1];
      const safeSql = uncommented.replace(
        /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
        "CREATE TABLE IF NOT EXISTS "
      );
      parsed.push({ type: "table", name: tableName, sql: safeSql });
      continue;
    }

    // Unique or standard index creation
    const indexMatch = uncommented.match(
      /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z0-9_]+)"?/i
    );
    if (indexMatch) {
      const isUnique = !!indexMatch[1];
      const indexName = indexMatch[2];
      const prefix = isUnique ? "CREATE UNIQUE INDEX IF NOT EXISTS " : "CREATE INDEX IF NOT EXISTS ";
      const safeSql = uncommented.replace(
        /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
        prefix
      );
      parsed.push({ type: "index", name: indexName, sql: safeSql });
      continue;
    }

    parsed.push({ type: "other", name: "statement", sql: uncommented });
  }

  return parsed;
}

/**
 * Deploys the Prisma schema to the verified remote Turso staging database.
 */
export async function deployStagingSchema(options?: {
  dbUrl?: string;
  authToken?: string;
  skipPrismaVerification?: boolean;
}): Promise<DeployResult> {
  const dbUrl = options?.dbUrl || process.env.TURSO_DATABASE_URL || "";
  const authToken = options?.authToken || process.env.TURSO_AUTH_TOKEN || "";

  // 1. Strict Target Validation
  validateStagingDatabaseUrl(dbUrl);

  // 2. Generate local SQLite schema diff
  const rawSql = generateSchemaSql();
  const statements = parseAndPrepareStatements(rawSql);

  // 3. Connect via @libsql/client
  const client = createClient({
    url: dbUrl,
    authToken: authToken || undefined,
  });

  const result: DeployResult = {
    success: false,
    appliedTables: [],
    appliedIndexes: [],
    existingTables: [],
    existingIndexes: [],
    totalStatements: statements.length,
  };

  try {
    // 4. Inspect current schema on remote Turso
    const currentTablesRes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
    );
    const existingTableNames = new Set(currentTablesRes.rows.map((r) => String(r.name)));

    const currentIndexesRes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';"
    );
    const existingIndexNames = new Set(currentIndexesRes.rows.map((r) => String(r.name)));

    result.existingTables = Array.from(existingTableNames);
    result.existingIndexes = Array.from(existingIndexNames);

    console.log("----------------------------------------------------------------");
    console.log("DISHA Staging Turso Schema Deployment");
    console.log("Verified Target: disha-staging database");
    console.log(`Discovered Remote State: ${existingTableNames.size} tables, ${existingIndexNames.size} indexes`);
    console.log(`Prisma Target Statements: ${statements.length}`);
    console.log("----------------------------------------------------------------");

    // 5. Apply statements idempotently without data reset
    for (const stmt of statements) {
      if (stmt.type === "table" && existingTableNames.has(stmt.name)) {
        console.log(`[PRESERVED] Table "${stmt.name}" already exists. Preserving data.`);
        continue;
      }

      if (stmt.type === "index" && existingIndexNames.has(stmt.name)) {
        console.log(`[PRESERVED] Index "${stmt.name}" already exists.`);
        continue;
      }

      try {
        await client.execute(stmt.sql);
        if (stmt.type === "table") {
          result.appliedTables.push(stmt.name);
          console.log(`[CREATED] Table "${stmt.name}" created successfully.`);
        } else if (stmt.type === "index") {
          result.appliedIndexes.push(stmt.name);
          console.log(`[CREATED] Index "${stmt.name}" created successfully.`);
        } else {
          console.log(`[EXECUTED] Statement executed.`);
        }
      } catch (err: any) {
        throw new Error(`Failed executing DDL for ${stmt.type} "${stmt.name}": ${err?.message || err}`);
      }
    }

    // 6. Verify Resulting Remote Schema
    const finalTablesRes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
    );
    const finalTableNames = finalTablesRes.rows.map((r) => String(r.name));

    const expectedTables = [
      "User",
      "Personnel",
      "Device",
      "DeviceCredential",
      "Session",
      "AuditLog",
      "DutySession",
      "Location",
      "LocationEvent",
      "SOSEvent",
      "Alert",
      "Heartbeat",
      "AppRelease",
    ];

    const missingTables = expectedTables.filter((t) => !finalTableNames.includes(t));
    if (missingTables.length > 0) {
      throw new Error(`Verification failed! Missing expected tables: ${missingTables.join(", ")}`);
    }

    console.log("----------------------------------------------------------------");
    console.log("DEPLOYMENT VERIFICATION SUCCESSFUL");
    console.log(`Total Tables Verified in Staging: ${finalTableNames.length} / ${expectedTables.length}`);
    console.log(`Tables: ${finalTableNames.join(", ")}`);
    console.log("Notice: No production database was touched. No credentials were leaked.");
    console.log("----------------------------------------------------------------");

    result.success = true;
    return result;
  } finally {
    client.close();
  }
}

// Direct execution entrypoint
if (require.main === module) {
  deployStagingSchema()
    .catch((err) => {
      console.error("\nFATAL ERROR during schema deployment:", err?.message || err);
      process.exit(1);
    });
}
