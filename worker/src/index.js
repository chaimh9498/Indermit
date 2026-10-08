import { authenticate, AuthError } from "./auth.js";
import { generateImage, MODEL_CONFIG } from "./providers.js";
import { createCheckoutSession, verifyStripeSignature } from "./stripe.js";
import { constantTimeEqual, corsHeaders, hmacHex, json, safeErrorCode } from "./utils.js";

export default {
  async fetch(request, env, context) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      let response;

      if (request.method === "GET" && url.pathname === "/v1/health") {
        response = json({ ok: true, service: "indermit-api" });
      } else if (request.method === "POST" && url.pathname === "/v1/webhooks/stripe") {
        response = await handleStripeWebhook(request, env);
      } else if (request.method === "GET" && url.pathname.startsWith("/v1/images/")) {
        response = await serveImage(request, env);
      } else if (request.method === "POST" && url.pathname === "/v1/anonymous/generations") {
        response = await createAnonymousGeneration(request, env, url.origin);
      } else {
        const session = await authenticate(request, env);
        response = await handleAuthenticated(request, env, context, session);
      }

      Object.entries(cors).forEach(([key, value]) => response.headers.set(key, value));
      response.headers.set("x-content-type-options", "nosniff");
      return response;
    } catch (error) {
      const status = error instanceof AuthError ? 401 : 500;
      const message = error instanceof AuthError ? error.message : "Something went wrong. Please try again.";
      console.error("Request failed", { name: error?.name, message: error?.message, stack: error?.stack });
      return json({ error: message }, status, cors);
    }
  },
};

async function handleAuthenticated(request, env, _context, { userId }) {
  const url = new URL(request.url);
  await ensureUser(env, userId);

  if (request.method === "GET" && url.pathname === "/v1/account") {
    const user = await env.DB.prepare(
      "SELECT credit_balance, free_generations_remaining FROM users WHERE user_id = ?",
    ).bind(userId).first();
    return json({
      creditBalance: user?.credit_balance || 0,
      freeGenerationsRemaining: user?.free_generations_remaining || 0,
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/billing/checkout") {
    const input = await request.json();
    const session = await createCheckoutSession(env, userId, input.bundleId);
    return json({ url: session.url });
  }

  if (request.method === "GET" && url.pathname === "/v1/generations") {
    const { results } = await env.DB.prepare(
      `SELECT id, provider, model, prompt, aspect_ratio, credit_cost, created_at
       FROM generations WHERE user_id = ? AND status = 'completed'
       ORDER BY created_at DESC LIMIT 60`,
    ).bind(userId).all();
    const generations = await Promise.all(results.map((item) => serializeGeneration(item, env, url.origin)));
    return json({ generations });
  }

  if (request.method === "POST" && url.pathname === "/v1/generations") {
    return createGeneration(request, env, userId, url.origin);
  }

  return json({ error: "Not found" }, 404);
}

async function ensureUser(env, userId) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (user_id, free_generations_remaining) VALUES (?, 5)",
  ).bind(userId).run();
}

async function createGeneration(request, env, userId, apiOrigin) {
  const parsed = parseGeneration(await request.json());
  if (parsed.error) return parsed.error;
  const { input, prompt, aspectRatio, config } = parsed;
  const generationId = crypto.randomUUID();
  const account = await env.DB.prepare(
    "SELECT credit_balance, free_generations_remaining FROM users WHERE user_id = ?",
  ).bind(userId).first();
  const chargeKind = account.free_generations_remaining > 0 ? "signup_free" : "credits";
  const creditCost = chargeKind === "signup_free" ? 0 : config.credits;
  const reserved = chargeKind === "signup_free"
    ? await reserveFreeGeneration(env, { generationId, userId, config, input, prompt, aspectRatio })
    : await reserveCreditGeneration(env, { generationId, userId, config, input, prompt, aspectRatio });

  if (!reserved) {
    const user = await env.DB.prepare("SELECT credit_balance FROM users WHERE user_id = ?").bind(userId).first();
    return json({ error: `You need ${config.credits} credits. Your balance is ${user?.credit_balance || 0}.` }, 402);
  }

  try {
    await generateAndStore(env, { generationId, userId, config, input, prompt, aspectRatio });
  } catch (error) {
    await refundGeneration(env, userId, generationId, creditCost, chargeKind, error);
    const publicMessage = error.message?.includes("not configured")
      ? "That model is not available yet. Your generation was returned."
      : "The model could not create this image. Your generation was returned.";
    return json({ error: publicMessage }, 502);
  }

  const row = await env.DB.prepare(
    "SELECT id, provider, model, prompt, aspect_ratio, credit_cost, charge_kind, created_at FROM generations WHERE id = ?",
  ).bind(generationId).first();
  const user = await env.DB.prepare(
    "SELECT credit_balance, free_generations_remaining FROM users WHERE user_id = ?",
  ).bind(userId).first();
  return json({
    generation: await serializeGeneration(row, env, apiOrigin),
    creditBalance: user.credit_balance,
    freeGenerationsRemaining: user.free_generations_remaining,
  }, 201);
}

function parseGeneration(input) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const aspectRatio = ["1:1", "16:9", "9:16"].includes(input.aspectRatio) ? input.aspectRatio : "1:1";
  const config = MODEL_CONFIG[input.model];
  if (!config) return { error: json({ error: "Choose a supported model." }, 400) };
  if (!prompt || prompt.length > 1200) return { error: json({ error: "Prompt must contain 1–1,200 characters." }, 400) };
  return { input, prompt, aspectRatio, config };
}

async function reserveFreeGeneration(env, details) {
  const { generationId, userId, config, input, prompt, aspectRatio } = details;
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET free_generations_remaining = free_generations_remaining - 1 WHERE user_id = ? AND free_generations_remaining > 0",
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO generations (id, user_id, provider, model, prompt, aspect_ratio, credit_cost, charge_kind, status)
       SELECT ?, ?, ?, ?, ?, ?, 0, 'signup_free', 'processing' WHERE changes() = 1`,
    ).bind(generationId, userId, config.provider, input.model, prompt, aspectRatio),
  ]);
  return Boolean(results[1]?.meta?.changes);
}

async function reserveCreditGeneration(env, details) {
  const { generationId, userId, config, input, prompt, aspectRatio } = details;
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET credit_balance = credit_balance - ? WHERE user_id = ? AND credit_balance >= ?",
    ).bind(config.credits, userId, config.credits),
    env.DB.prepare(
      `INSERT INTO generations (id, user_id, provider, model, prompt, aspect_ratio, credit_cost, charge_kind, status)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'credits', 'processing' WHERE changes() = 1`,
    ).bind(generationId, userId, config.provider, input.model, prompt, aspectRatio, config.credits),
    env.DB.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reference_id, description)
       SELECT ?, ?, ?, 'generation', ?, ? WHERE EXISTS (SELECT 1 FROM generations WHERE id = ?)`,
    ).bind(crypto.randomUUID(), userId, -config.credits, `generation:${generationId}`, `${config.provider} image generation`, generationId),
  ]);
  return Boolean(results[1]?.meta?.changes);
}

async function generateAndStore(env, details) {
  const { generationId, userId, config, input, prompt, aspectRatio } = details;
  const generated = await generateImage(env, { model: input.model, prompt, aspectRatio });
  const extension = generated.mimeType.includes("webp") ? "webp" : generated.mimeType.includes("jpeg") ? "jpg" : "png";
  const objectKey = `${userId}/${generationId}.${extension}`;
  await env.IMAGES.put(objectKey, generated.bytes, {
    httpMetadata: { contentType: generated.mimeType, cacheControl: "private, max-age=31536000, immutable" },
    customMetadata: { userId, generationId, provider: config.provider },
  });
  const completed = await env.DB.prepare(
    `UPDATE generations SET status = 'completed', object_key = ?, mime_type = ?, completed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'processing'`,
  ).bind(objectKey, generated.mimeType, generationId, userId).run();
  if (!completed.meta.changes) {
    await env.IMAGES.delete(objectKey);
    throw new Error("Generation could not be finalized");
  }
}

async function refundGeneration(env, userId, generationId, credits, chargeKind, error) {
  const statements = chargeKind === "signup_free"
    ? [env.DB.prepare(
      `UPDATE users SET free_generations_remaining = free_generations_remaining + 1
       WHERE user_id = ? AND EXISTS (SELECT 1 FROM generations WHERE id = ? AND status = 'processing')`,
    ).bind(userId, generationId)]
    : [
      env.DB.prepare(
        `UPDATE users SET credit_balance = credit_balance + ?
         WHERE user_id = ? AND EXISTS (SELECT 1 FROM generations WHERE id = ? AND status = 'processing')`,
      ).bind(credits, userId, generationId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO credit_ledger (id, user_id, amount, kind, reference_id, description)
         SELECT ?, ?, ?, 'refund', ?, 'Automatic refund for failed generation' WHERE changes() = 1`,
      ).bind(crypto.randomUUID(), userId, credits, `refund:${generationId}`),
    ];
  statements.push(env.DB.prepare(
    `UPDATE generations SET status = 'failed', error_code = ?, completed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'processing'`,
  ).bind(safeErrorCode(error), generationId, userId));
  await env.DB.batch(statements);
}

async function createAnonymousGeneration(request, env, apiOrigin) {
  const parsed = parseGeneration(await request.json());
  if (parsed.error) return parsed.error;
  const { input, prompt, aspectRatio, config } = parsed;
  const rawIp = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await hmacHex(env.IMAGE_SIGNING_SECRET, `anonymous:${rawIp}`);
  const generationId = crypto.randomUUID();
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO anonymous_usage (ip_hash, generation_id) VALUES (?, ?)",
  ).bind(ipHash, generationId).run();
  if (!claim.meta.changes) return json({ error: "Your free image has already been used. Sign up to get 5 more generations." }, 429);

  const userId = `anonymous:${generationId}`;
  await env.DB.prepare("INSERT INTO users (user_id, free_generations_remaining) VALUES (?, 0)").bind(userId).run();
  await env.DB.prepare(
    `INSERT INTO generations (id, user_id, provider, model, prompt, aspect_ratio, credit_cost, charge_kind, status)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'anonymous_free', 'processing')`,
  ).bind(generationId, userId, config.provider, input.model, prompt, aspectRatio).run();
  try {
    await generateAndStore(env, { generationId, userId, config, input, prompt, aspectRatio });
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM anonymous_usage WHERE ip_hash = ?").bind(ipHash),
      env.DB.prepare("UPDATE generations SET status = 'failed', error_code = ? WHERE id = ?").bind(safeErrorCode(error), generationId),
    ]);
    return json({ error: "The model could not create this image. Please try again." }, 502);
  }
  const row = await env.DB.prepare(
    "SELECT id, provider, model, prompt, aspect_ratio, credit_cost, charge_kind, created_at FROM generations WHERE id = ?",
  ).bind(generationId).first();
  return json({ generation: await serializeGeneration(row, env, apiOrigin) }, 201);
}

async function serializeGeneration(row, env, apiOrigin) {
  const token = await hmacHex(env.IMAGE_SIGNING_SECRET, row.id);
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    aspectRatio: row.aspect_ratio,
    creditCost: row.credit_cost,
    createdAt: row.created_at,
    imageUrl: `${apiOrigin}/v1/images/${row.id}?token=${token}`,
    downloadUrl: `${apiOrigin}/v1/images/${row.id}?token=${token}&download=1`,
  };
}

async function serveImage(request, env) {
  const url = new URL(request.url);
  const id = url.pathname.split("/").pop();
  const token = url.searchParams.get("token") || "";
  const expected = await hmacHex(env.IMAGE_SIGNING_SECRET, id);
  if (!constantTimeEqual(token, expected)) return json({ error: "Not found" }, 404);
  const row = await env.DB.prepare(
    "SELECT object_key, mime_type FROM generations WHERE id = ? AND status = 'completed'",
  ).bind(id).first();
  if (!row?.object_key) return json({ error: "Not found" }, 404);
  const object = await env.IMAGES.get(row.object_key);
  if (!object) return json({ error: "Not found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-type", row.mime_type || "image/webp");
  headers.set("cache-control", "private, max-age=86400");
  if (url.searchParams.get("download") === "1") headers.set("content-disposition", `attachment; filename="indermit-${id}.webp"`);
  return new Response(object.body, { headers });
}

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature") || "";
  if (!await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET)) {
    return json({ error: "Invalid webhook signature" }, 400);
  }
  const event = JSON.parse(rawBody);
  if (event.type !== "checkout.session.completed") return json({ received: true });
  const session = event.data?.object;
  if (session?.payment_status !== "paid") return json({ received: true });

  const userId = session.metadata?.user_id || session.client_reference_id;
  const credits = Number(session.metadata?.credits);
  if (!userId || !Number.isInteger(credits) || credits <= 0 || credits > 100000) {
    return json({ error: "Invalid checkout metadata" }, 400);
  }

  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO users (user_id, stripe_customer_id) VALUES (?, ?)").bind(userId, session.customer || null),
    env.DB.prepare("INSERT OR IGNORE INTO stripe_events (event_id, event_type) VALUES (?, ?)").bind(event.id, event.type),
    env.DB.prepare(
      `UPDATE users SET credit_balance = credit_balance + ?, stripe_customer_id = COALESCE(?, stripe_customer_id), updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND changes() = 1`,
    ).bind(credits, session.customer || null, userId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, user_id, amount, kind, reference_id, description)
       SELECT ?, ?, ?, 'purchase', ?, 'Stripe credit purchase' WHERE changes() = 1`,
    ).bind(crypto.randomUUID(), userId, credits, `stripe:${event.id}`),
  ]);
  return json({ received: true });
}
