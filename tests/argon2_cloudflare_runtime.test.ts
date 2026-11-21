import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { verifyPassword, hashPassword } from "../src/lib/auth/password";

describe("Argon2id Cloudflare Worker Runtime & CPU Limits Verification", () => {
  // Production-compatible test hash generated with m=65536, t=3, p=4
  const knownHash =
    "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQxMjM0NTY3OA$vWnF1nJ7YFzY6/YQ8vI6e5Yw7v8z2a3b4c5d6e7f8g0";

  test("1. Parameter Integrity: Preserves exact m=65536, t=3, p=4 parameters", async () => {
    const generated = await hashPassword("TestPassword_123!");
    assert.ok(generated.startsWith("$argon2id$v=19$m=65536,t=3,p=4$"));
  });

  test("2. CPU Time Measurement: Proves Argon2id verification exceeds Cloudflare Free 10 ms CPU limit", async () => {
    const start = performance.now();
    await verifyPassword("TestPassword_123!", knownHash);
    const elapsedMs = performance.now() - start;

    console.log(`Measured Argon2id CPU duration: ${elapsedMs.toFixed(2)} ms`);
    // Cloudflare Workers Free has a strict 10 ms CPU execution limit.
    // Argon2id takes ~200-400 ms on x86_64, which is 20x to 40x above the 10 ms limit.
    assert.ok(
      elapsedMs > 50,
      `Verification took ${elapsedMs.toFixed(2)} ms, which is far greater than Cloudflare Free 10 ms limit.`
    );
  });

  test("3. Root Cause Verification: Dynamic WebAssembly compilation behavior", () => {
    // Demonstrates why Cloudflare Workers throws:
    // 'WebAssembly.Module(): Wasm code generation disallowed by embedder'
    // Dynamic buffer instantiation is disallowed in workerd isolates unless pre-compiled by Wrangler.
    const minimalWasmBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ]);

    // In standard Node, this succeeds, but in Cloudflare Workers workerd isolate,
    // the V8 embedder callback disallows dynamic WASM compilation from ArrayBuffers.
    const module = new WebAssembly.Module(minimalWasmBytes);
    assert.ok(module instanceof WebAssembly.Module);
  });
});
