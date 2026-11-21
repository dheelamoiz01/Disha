import test from "node:test";
import assert from "node:assert";
import { hashPassword, verifyPassword } from "../src/lib/auth/password";

test("Argon2id concurrency and memory safety test", async (t) => {
  const password = "TestPassword#Concurrency2026!";
  const hash = await hashPassword(password);

  await t.test("Simulate 5 concurrent password verification requests", async () => {
    // Launch 5 simultaneous verification requests
    const promises = Array.from({ length: 5 }, (_, i) => {
      const pwd = i % 2 === 0 ? password : "WrongPassword123!";
      const expected = i % 2 === 0;
      return verifyPassword(pwd, hash).then((result) => {
        assert.strictEqual(result, expected);
      });
    });

    // All must complete successfully without crashing or throwing Out-Of-Memory
    await Promise.all(promises);
  });
});
