import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogoutIntent, validLogoutIntent } from "../lib/logoutIntent";

test("logout returns require the signed cookie and exact provider state within five minutes", () => {
  const now = 1_800_000_000_000;
  const intent = createLogoutIntent("test-secret", now);
  assert.equal(validLogoutIntent(intent.cookie, intent.nonce, "test-secret", now + 1), true);
  for (const [cookie, nonce, secret] of [
    [undefined, intent.nonce, "test-secret"], [intent.cookie, null, "test-secret"],
    [intent.cookie, "other-nonce", "test-secret"], [intent.cookie, intent.nonce, "wrong-secret"],
    [intent.cookie + "tampered", intent.nonce, "test-secret"],
  ] as const) assert.equal(validLogoutIntent(cookie, nonce, secret, now), false);
  assert.equal(validLogoutIntent(intent.cookie, intent.nonce, "test-secret", now + 300_000), false);
  assert.equal(validLogoutIntent(intent.cookie, intent.nonce, "test-secret", now - 30_001), false);
});
