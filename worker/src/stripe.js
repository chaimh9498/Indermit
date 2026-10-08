import { constantTimeEqual, hmacHex } from "./utils.js";

export const CREDIT_BUNDLES = {
  starter: { name: "Starter credits", credits: 100, cents: 500 },
  creator: { name: "Creator credits", credits: 330, cents: 1500 },
  pro: { name: "Pro credits", credits: 920, cents: 4000 },
};

export async function createCheckoutSession(env, userId, bundleId) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("Payments are not configured yet");
  const bundle = CREDIT_BUNDLES[bundleId];
  if (!bundle) throw new Error("Unknown credit package");
  const params = new URLSearchParams({
    mode: "payment",
    client_reference_id: userId,
    customer_creation: "always",
    success_url: `${env.FRONTEND_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.FRONTEND_URL}/?payment=cancelled`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(bundle.cents),
    "line_items[0][price_data][product_data][name]": `Indermit ${bundle.name}`,
    "metadata[user_id]": userId,
    "metadata[bundle_id]": bundleId,
    "metadata[credits]": String(bundle.credits),
    "payment_intent_data[metadata][user_id]": userId,
    "payment_intent_data[metadata][credits]": String(bundle.credits),
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const result = await response.json();
  if (!response.ok || !result.url) throw new Error(result.error?.message || "Could not start checkout");
  return result;
}

export async function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  const values = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, ...rest] = part.split("=");
      return [key, rest.join("=")];
    }),
  );
  if (!values.t || !values.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(values.t)) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${values.t}.${rawBody}`);
  return constantTimeEqual(expected, values.v1);
}
