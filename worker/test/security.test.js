import test from "node:test";
import assert from "node:assert/strict";
import { constantTimeEqual, hmacHex } from "../src/utils.js";
import { createCheckoutSession, verifyStripeSignature } from "../src/stripe.js";

test("constantTimeEqual compares complete strings", () => {
  assert.equal(constantTimeEqual("abc123", "abc123"), true);
  assert.equal(constantTimeEqual("abc123", "abc124"), false);
  assert.equal(constantTimeEqual("short", "longer"), false);
});

test("Stripe signatures accept authentic recent payloads", async () => {
  const body = JSON.stringify({ id: "evt_test", type: "checkout.session.completed" });
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = "whsec_test_secret";
  const signature = await hmacHex(secret, `${timestamp}.${body}`);
  assert.equal(await verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, secret), true);
  assert.equal(await verifyStripeSignature(`${body}x`, `t=${timestamp},v1=${signature}`, secret), false);
});

test("Stripe signatures reject stale events", async () => {
  const body = "{}";
  const timestamp = Math.floor(Date.now() / 1000) - 1000;
  const secret = "whsec_test_secret";
  const signature = await hmacHex(secret, `${timestamp}.${body}`);
  assert.equal(await verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, secret), false);
});

test("private beta refuses a live Stripe key", async () => {
  await assert.rejects(
    createCheckoutSession({ PRIVATE_BETA: "true", STRIPE_SECRET_KEY: "sk_live_do_not_use" }, "user_123", "starter"),
    /requires Stripe test mode/,
  );
});
