import { argon2id, argon2Verify } from "hash-wasm";

function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

/**
 * Sequential execution guard within the isolate to prevent concurrent 64 MB WASM
 * allocations from exceeding the 128 MB per-isolate Cloudflare memory limit.
 */
let isolateArgon2Lock = Promise.resolve();

async function runWithMemoryGuard<T>(fn: () => Promise<T>): Promise<T> {
  const previousLock = isolateArgon2Lock;
  let release: () => void;
  isolateArgon2Lock = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await previousLock;
    return await fn();
  } finally {
    release!();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = generateSalt();
  return runWithMemoryGuard(async () => {
    return await argon2id({
      password,
      salt,
      iterations: 3,
      memorySize: 65536,
      parallelism: 4,
      hashLength: 32,
      outputType: "encoded",
    });
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return runWithMemoryGuard(async () => {
    try {
      return await argon2Verify({
        password,
        hash,
      });
    } catch {
      return false;
    }
  });
}
