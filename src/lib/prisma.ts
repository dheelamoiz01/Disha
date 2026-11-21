import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../../generated/prisma/client";

// Ensure local environment variables are populated when running CLI test runners
if (typeof process !== "undefined" && !process.env.TURSO_DATABASE_URL) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("dotenv/config");
  } catch {
    // In Cloudflare Workers, secrets are bound directly to env
  }
}

/**
 * Resilient fetch wrapper for Turso over HTTP.
 * Automatically retries transient DNS lookup failures (ENOTFOUND) and socket disconnects.
 * Bounded by an 8-second request timeout to prevent indefinite socket stalls.
 */
const resilientFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const maxAttempts = 3;
  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const req = input instanceof Request ? input.clone() : input;
      const timeoutSignal = AbortSignal.timeout(8000);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      return await fetch(req, { ...init, signal });
    } catch (err: any) {
      lastError = err;
      const isTransient =
        err?.name === "TimeoutError" ||
        err?.name === "AbortError" ||
        err?.code === "ENOTFOUND" ||
        err?.cause?.code === "ENOTFOUND" ||
        err?.message?.includes("ENOTFOUND") ||
        err?.message?.includes("fetch failed") ||
        err?.code === "ECONNRESET" ||
        err?.code === "ETIMEDOUT";

      if (isTransient && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        continue;
      }
      throw err;
    }
  }

  throw lastError;
};

/**
 * Resolves database credentials dynamically from either process.env or Cloudflare Worker context.
 */
function getDatabaseConfig(): { url: string; authToken?: string } {
  let url = process.env.TURSO_DATABASE_URL;
  let authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getCloudflareContext } = require("@opennextjs/cloudflare");
      const ctx = getCloudflareContext();
      if (ctx?.env?.TURSO_DATABASE_URL) {
        url = ctx.env.TURSO_DATABASE_URL;
        authToken = ctx.env.TURSO_AUTH_TOKEN;
      }
    } catch {
      // Ignored if not in Cloudflare Worker context
    }
  }

  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set. Ensure TURSO_DATABASE_URL is defined in .env or as a Cloudflare Worker secret."
    );
  }

  return { url, authToken };
}

let _prismaInstance: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prismaInstance) {
    const { url, authToken } = getDatabaseConfig();
    const adapter = new PrismaLibSql({
      url,
      authToken,
      fetch: resilientFetch,
    });
    _prismaInstance = new PrismaClient({
      adapter,
    });
  }
  return _prismaInstance;
}

/**
 * Lazy Prisma client proxy that defers initialization until first query,
 * ensuring Cloudflare Worker environment variables and secrets are populated.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrisma();
    const value = (client as any)[prop];
    if (typeof value === "function") {
      return value.bind(client);
    }
    return value;
  },
});
