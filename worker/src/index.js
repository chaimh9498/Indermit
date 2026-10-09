import { authenticate, AuthError } from "./auth.js";
import { generateImage, MODEL_CONFIG } from "./providers.js";
import { createCheckoutSession, verifyStripeSignature } from "./stripe.js";
import { constantTimeEqual, corsHeaders, hmacHex, json, safeErrorCode, sha256Hex } from "./utils.js";

export default {
  async fetch(request, env, context) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      let response;

      if (request.method === "GET" && url.pathname === "/v1/health") {
        response = json({ ok: true, service: "indermit-api", privateBeta: env.PRIVATE_BETA === "true" });
      } else if (request.method === "POST" && url.pathname === "/v1/webhooks/stripe") {
        response = await handleStripeWebhook(request, env);
      } else if (request.method === "GET" && url.pathname.startsWith("/v1/images/")) {
        response = await serveImage(request, env);
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

  if (request.method === "POST" && url.pathname === "/v1/beta/enroll") {
    return enrollBetaMember(request, env, userId);
  }

  const member = await getBetaMember(env, userId);
  if (request.method === "GET" && url.pathname === "/v1/beta/me") {
    return json({
      enrolled: Boolean(member),
      role: member?.role || null,
      stripeReady: isStripeReady(env),
      stripeMode: env.STRIPE_MODE || "test",
      publicBeta: env.PRIVATE_BETA !== "true",
    });
  }

  if (!member) {
    return json({ error: "Join the public beta before continuing." }, 403);
  }

  if (member) {
    await env.DB.prepare("UPDATE beta_members SET last_seen_at = CURRENT_TIMESTAMP WHERE user_id = ?").bind(userId).run();
  }

  if (url.pathname.startsWith("/v1/admin/")) {
    if (member?.role !== "admin") return json({ error: "Owner access required." }, 403);
    return handleAdmin(request, env, userId, url);
  }

  if (request.method === "GET" && url.pathname === "/v1/account") {
    const user = await env.DB.prepare(
      "SELECT credit_balance, free_generations_remaining FROM users WHERE user_id = ?",
    ).bind(userId).first();
    return json({
      creditBalance: user?.credit_balance || 0,
      freeGenerationsRemaining: env.FREE_GENERATIONS_ENABLED === "true" ? user?.free_generations_remaining || 0 : 0,
      role: member?.role || null,
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/billing/checkout") {
    const input = await request.json();
    const account = await env.DB.prepare("SELECT credit_balance FROM users WHERE user_id = ?").bind(userId).first();
    const session = await createCheckoutSession(env, userId, input.bundleId, account?.credit_balance || 0);
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

async function enrollBetaMember(request, env, userId) {
  if (env.PRIVATE_BETA !== "true") {
    const existing = await getBetaMember(env, userId);
    if (existing) return json({ enrolled: true, role: existing.role });
    const maximum = positiveInteger(env.MAX_BETA_MEMBERS, 25);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM beta_members").first();
    if ((count?.count || 0) >= maximum) {
      return json({ error: "Your account is ready, but the first 25 public-beta places are full. More generation and purchasing access will open soon." }, 503);
    }
    await env.DB.prepare("INSERT OR IGNORE INTO beta_members (user_id, role) VALUES (?, 'tester')").bind(userId).run();
    return json({ enrolled: true, role: "tester" });
  }
  const { code = "" } = await request.json();
  if (typeof code !== "string" || code.length < 12 || code.length > 200) {
    return json({ error: "Enter a valid beta access key." }, 400);
  }
  const submittedHash = await sha256Hex(code.trim());
  const isAdmin = Boolean(env.BETA_ADMIN_HASH) && constantTimeEqual(submittedHash, env.BETA_ADMIN_HASH);
  const isTester = Boolean(env.BETA_ACCESS_HASH) && constantTimeEqual(submittedHash, env.BETA_ACCESS_HASH);
  if (!isAdmin && !isTester) return json({ error: "That beta access key is not valid." }, 403);

  const role = isAdmin ? "admin" : "tester";
  await env.DB.prepare(
    `INSERT INTO beta_members (user_id, role) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       role = CASE WHEN excluded.role = 'admin' THEN 'admin' ELSE beta_members.role END,
       last_seen_at = CURRENT_TIMESTAMP`,
  ).bind(userId, role).run();
  const member = await getBetaMember(env, userId);
  return json({ enrolled: true, role: member.role });
}

async function getBetaMember(env, userId) {
  return env.DB.prepare("SELECT role, joined_at, last_seen_at FROM beta_members WHERE user_id = ?").bind(userId).first();
}

async function handleAdmin(request, env, _userId, url) {
  if (request.method === "GET" && url.pathname === "/v1/admin/status") {
    const [users, generations, completed, failed, recent, providerUsage] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM beta_members").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM generations").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE status = 'completed'").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE status = 'failed'").first(),
      env.DB.prepare(
        `SELECT id, user_id, provider, model, status, credit_cost, error_code, created_at, completed_at
         FROM generations ORDER BY created_at DESC LIMIT 40`,
      ).all(),
      env.DB.prepare(
        `SELECT provider, COUNT(*) AS count FROM generations
         WHERE created_at >= datetime('now', 'start of day') GROUP BY provider`,
      ).all(),
    ]);
    const usage = Object.fromEntries(providerUsage.results.map((item) => [item.provider, Number(item.count)]));
    return json({
      summary: {
        betaMembers: users?.count || 0,
        generations: generations?.count || 0,
        completed: completed?.count || 0,
        failed: failed?.count || 0,
      },
      models: [
        { id: "auto", name: "Auto", provider: "Indermit", enabled: Boolean(env.GOOGLE_API_KEY), credits: MODEL_CONFIG.auto.credits },
        { id: "google-nano-banana", name: "Nano Banana 2 Lite", provider: "Google", enabled: Boolean(env.GOOGLE_API_KEY), credits: MODEL_CONFIG["google-nano-banana"].credits },
        { id: "openai-sunburst", name: "GPT Image 2.5 Sunburst Low", provider: "OpenAI", enabled: Boolean(env.OPENAI_API_KEY), credits: MODEL_CONFIG["openai-sunburst"].credits },
        { id: "xai-imagine", name: "Grok Imagine 2.0 Low", provider: "xAI", enabled: Boolean(env.XAI_API_KEY), credits: MODEL_CONFIG["xai-imagine"].credits },
      ],
      stripe: {
        mode: isStripeReady(env) ? env.STRIPE_MODE || "test" : "not configured",
        webhookReady: Boolean(env.STRIPE_WEBHOOK_SECRET),
      },
      providerEconomics: [
        providerEconomics("OpenAI", usage.OpenAI || 0, 0.007, positiveInteger(env.OPENAI_DAILY_GENERATION_LIMIT, 200)),
        providerEconomics("Google", usage.Google || 0, 0.0336, positiveInteger(env.GOOGLE_DAILY_GENERATION_LIMIT, 50)),
        providerEconomics("xAI", usage.xAI || 0, 0.04, positiveInteger(env.XAI_DAILY_GENERATION_LIMIT, 50)),
      ],
      recentGenerations: recent.results.map((item) => ({
        ...item,
        user_id: maskUserId(item.user_id),
      })),
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/members") {
    const { results } = await env.DB.prepare(
      `SELECT b.user_id, b.role, b.joined_at, b.last_seen_at, u.credit_balance
       FROM beta_members b JOIN users u ON u.user_id = b.user_id
       ORDER BY b.joined_at DESC LIMIT 100`,
    ).all();
    return json({ members: results });
  }

  if (request.method === "POST" && url.pathname === "/v1/admin/credits") {
    const { userId, amount } = await request.json();
    const parsedAmount = Number(amount);
    if (typeof userId !== "string" || !Number.isInteger(parsedAmount) || parsedAmount < -10000 || parsedAmount > 10000 || parsedAmount === 0) {
      return json({ error: "Choose a member and enter a whole-number adjustment." }, 400);
    }
    const result = await env.DB.prepare(
      `UPDATE users SET credit_balance = credit_balance + ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND credit_balance + ? >= 0
       AND EXISTS (SELECT 1 FROM beta_members WHERE beta_members.user_id = users.user_id)`,
    ).bind(parsedAmount, userId, parsedAmount).run();
    if (!result.meta.changes) return json({ error: "Member not found or the adjustment would make the balance negative." }, 400);
    await env.DB.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reference_id, description)
       VALUES (?, ?, ?, 'adjustment', ?, 'Private beta owner adjustment')`,
    ).bind(crypto.randomUUID(), userId, parsedAmount, `admin:${crypto.randomUUID()}`).run();
    const account = await env.DB.prepare("SELECT credit_balance FROM users WHERE user_id = ?").bind(userId).first();
    return json({ creditBalance: account.credit_balance });
  }

  return json({ error: "Not found" }, 404);
}

function maskUserId(userId = "") {
  return userId.length > 10 ? `${userId.slice(0, 6)}…${userId.slice(-4)}` : "beta-user";
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
  const limitError = await checkGenerationLimits(env, userId, config.provider);
  if (limitError) return limitError;
  const generationId = crypto.randomUUID();
  const account = await env.DB.prepare(
    "SELECT credit_balance, free_generations_remaining FROM users WHERE user_id = ?",
  ).bind(userId).first();
  const freeGenerationsEnabled = env.FREE_GENERATIONS_ENABLED === "true";
  const chargeKind = freeGenerationsEnabled && account.free_generations_remaining > 0 ? "signup_free" : "credits";
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
    freeGenerationsRemaining: env.FREE_GENERATIONS_ENABLED === "true" ? user.free_generations_remaining : 0,
  }, 201);
}

async function checkGenerationLimits(env, userId, provider) {
  const [processing, globalProcessing, hourly, daily, providerDaily] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE user_id = ? AND status = 'processing'").bind(userId).first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE status = 'processing'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE user_id = ? AND created_at >= datetime('now', '-1 hour')").bind(userId).first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE user_id = ? AND created_at >= datetime('now', 'start of day')").bind(userId).first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE provider = ? AND created_at >= datetime('now', 'start of day')").bind(provider).first(),
  ]);
  if ((processing?.count || 0) >= positiveInteger(env.MAX_CONCURRENT_GENERATIONS, 1)) {
    return json({ error: "Wait for your current image to finish before starting another." }, 429);
  }
  if ((globalProcessing?.count || 0) >= positiveInteger(env.MAX_GLOBAL_CONCURRENT_GENERATIONS, 3)) {
    return json({ error: "The beta is busy right now. Please try again in a moment." }, 429);
  }
  if ((hourly?.count || 0) >= positiveInteger(env.MAX_GENERATIONS_PER_HOUR, 10)) {
    return json({ error: "You reached the public-beta hourly limit. Try again later." }, 429);
  }
  if ((daily?.count || 0) >= positiveInteger(env.MAX_GENERATIONS_PER_DAY, 30)) {
    return json({ error: "You reached today's public-beta generation limit." }, 429);
  }
  const providerLimit = provider === "OpenAI"
    ? positiveInteger(env.OPENAI_DAILY_GENERATION_LIMIT, 200)
    : provider === "xAI"
      ? positiveInteger(env.XAI_DAILY_GENERATION_LIMIT, 50)
      : positiveInteger(env.GOOGLE_DAILY_GENERATION_LIMIT, 50);
  if ((providerDaily?.count || 0) >= providerLimit) {
    return json({ error: `${provider} reached today's public-beta capacity. No credits were charged.` }, 503);
  }
  return null;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function providerEconomics(provider, attempts, estimatedUnitCostUsd, dailyLimit) {
  return {
    provider,
    attempts,
    dailyLimit,
    estimatedUnitCostUsd,
    estimatedSpendUsd: Number((attempts * estimatedUnitCostUsd).toFixed(4)),
  };
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
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Payments are not configured yet" }, 503);
  if (!await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET)) {
    return json({ error: "Invalid webhook signature" }, 400);
  }
  const event = JSON.parse(rawBody);
  if ((env.STRIPE_MODE === "live") !== (event.livemode === true)) {
    return json({ error: "Stripe event mode does not match this deployment" }, 400);
  }
  const paymentEvents = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];
  if (!paymentEvents.includes(event.type)) return json({ received: true });
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

function isStripeReady(env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return false;
  const prefixes = env.STRIPE_MODE === "live" ? ["sk_live_", "rk_live_"] : ["sk_test_", "rk_test_"];
  return prefixes.some((prefix) => env.STRIPE_SECRET_KEY.startsWith(prefix));
}
