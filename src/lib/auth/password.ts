import { argon2id, argon2Verify } from "hash-wasm";

function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = generateSalt();
  return await argon2id({
    password,
    salt,
    iterations: 3,
    memorySize: 65536,
    parallelism: 4,
    hashLength: 32,
    outputType: "encoded",
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({
      password,
      hash,
    });
  } catch {
    return false;
  }
}
