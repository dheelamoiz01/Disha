import { prisma } from "@/lib/prisma";
import { randomBytes, createHash } from "crypto";
import { tursoBudgetTracker } from "@/lib/turso/budget";

interface CachedDeviceToken {
  device: any;
  cachedAt: number;
}

const deviceTokenCache = new Map<string, CachedDeviceToken>();
const TOKEN_CACHE_TTL_MS = 45_000; // 45 seconds safe TTL

export function invalidateDeviceTokenCache(tokenHash?: string) {
  if (tokenHash) {
    deviceTokenCache.delete(tokenHash);
  } else {
    deviceTokenCache.clear();
  }
}

export async function generateDeviceCredential(deviceId: string) {
  // Invalidate in-memory cached credentials for this device
  invalidateDeviceTokenCache();

  // Generate a cryptographically random token
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");

  // Invalidate any existing active credentials for this device
  await prisma.deviceCredential.updateMany({
    where: { deviceId, isActive: true },
    data: { isActive: false },
  });

  // Store the new hashed credential
  await prisma.deviceCredential.create({
    data: {
      deviceId,
      tokenHash,
      isActive: true,
    },
  });

  // Return the raw token (only shown once)
  return token;
}

export async function verifyDeviceToken(token: string) {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();

  const isTest =
    process.env.NODE_ENV === "test" ||
    process.env.DISABLE_CACHE === "1" ||
    process.argv.some((a) => a.includes("test"));

  // 1. Fast-path: Check safe in-memory cache
  if (!isTest) {
    const cached = deviceTokenCache.get(tokenHash);
    if (cached && now - cached.cachedAt < TOKEN_CACHE_TTL_MS) {
      return cached.device;
    }
  }

  tursoBudgetTracker.recordQuery("auth_session", 2); // credential + relation
  const credential = await prisma.deviceCredential.findUnique({
    where: { tokenHash },
    include: {
      device: {
        include: { personnel: true },
      },
    },
  });

  if (!credential || !credential.isActive) {
    return null;
  }

  // Device and Personnel must be active
  if (credential.device.status !== "ACTIVE" || !credential.device.personnel.active) {
    return null;
  }

  // Throttle lastUsedAt updates: only write once every 5 minutes to prevent DB churn
  const lastUsed = credential.lastUsedAt ? credential.lastUsedAt.getTime() : 0;
  if (now - lastUsed > 5 * 60 * 1000) {
    prisma.deviceCredential
      .update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});
  }

  if (!isTest) {
    deviceTokenCache.set(tokenHash, {
      device: credential.device,
      cachedAt: now,
    });
  }

  return credential.device;
}
