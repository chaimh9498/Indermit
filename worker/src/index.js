import { authenticate, AuthError } from "./auth.js";
import { generateImage, MODEL_CONFIG } from "./providers.js";
import { createCheckoutSession, verifyStripeSignature } from "./stripe.js";
import { base64ToBytes, bytesToBase64, constantTimeEqual, corsHeaders, hmacHex, json, safeErrorCode, sha256Hex } from "./utils.js";

export default {
  async fetch(request, env, context) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      let response;

      if (request.method === "GET" && url.pathname === "/v1/health") {
        response = json({ ok: true, service: "indermit-api", privateBeta: env.PRIVATE_BETA === "true" });
      } else if (request.method === "GET" && url.pathname === "/v1/promotions/signup-bonus") {
        response = await getPublicSignupPromotion(env);
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

async function getPublicSignupPromotion(env) {
  const maximum = positiveInteger(env.SIGNUP_BONUS_USERS, 25);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM signup_credit_grants").first();
  return json({
    available: Number(count?.count || 0) < maximum,
    credits: positiveInteger(env.SIGNUP_BONUS_CREDITS, 2),
  });
}

async function getClerkUserCount(env) {
  if (!env.CLERK_SECRET_KEY) return null;

  try {
    const response = await fetch("https://api.clerk.com/v1/users/count", {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    });
    if (!response.ok) {
      console.error("Clerk user count failed", { status: response.status });
      return null;
    }

    const payload = await response.json();
    const count = Number(payload?.total_count);
    return Number.isFinite(count) ? count : null;
  } catch (error) {
    console.error("Clerk user count failed", { message: error?.message });
    return null;
  }
}

async function handleAuthenticated(request, env, _context, { userId }) {
  const url = new URL(request.url);
  await ensureUser(env, userId);

  if (request.method === "POST" && url.pathname === "/v1/promotions/signup-bonus/acknowledge") {
    await env.DB.prepare(
      "UPDATE signup_credit_grants SET celebration_seen_at = COALESCE(celebration_seen_at, CURRENT_TIMESTAMP) WHERE user_id = ?",
    ).bind(userId).run();
    return json({ acknowledged: true });
  }

  if (request.method === "POST" && url.pathname === "/v1/beta/enroll") {
    return enrollBetaMember(request, env, userId);
  }

  const member = await getBetaMember(env, userId);
  if (request.method === "GET" && url.pathname === "/v1/beta/me") {
    const [capacity, signupPromotion] = await Promise.all([
      getPaidBetaCapacity(env, userId),
      getSignupCreditPromotion(env, userId),
    ]);
    return json({
      enrolled: Boolean(member),
      role: member?.role || null,
      stripeReady: isStripeReady(env),
      stripeMode: env.STRIPE_MODE || "test",
      publicBeta: env.PRIVATE_BETA !== "true",
      ...capacity,
      ...signupPromotion,
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
    await syncCreditBuckets(env, userId);
    const user = await env.DB.prepare(
      "SELECT credit_balance, paid_credit_balance, promo_credit_balance, free_generations_remaining FROM users WHERE user_id = ?",
    ).bind(userId).first();
    return json({
      creditBalance: user?.credit_balance || 0,
      paidCreditBalance: user?.paid_credit_balance || 0,
      promoCreditBalance: user?.promo_credit_balance || 0,
      freeGenerationsRemaining: env.FREE_GENERATIONS_ENABLED === "true" ? user?.free_generations_remaining || 0 : 0,
      role: member?.role || null,
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/billing/checkout") {
    await syncCreditBuckets(env, userId);
    const input = await request.json();
    const account = await env.DB.prepare("SELECT credit_balance FROM users WHERE user_id = ?").bind(userId).first();
    try {
      await requireVerifiedCheckoutEmail(env, userId);
      const session = await beginPaidBetaCheckout(env, userId, input.bundleId, account?.credit_balance || 0);
      return json({ url: session.url });
    } catch (error) {
      return json({ error: error.message || "Checkout is unavailable right now." }, 409);
    }
  }

  if (request.method === "GET" && url.pathname === "/v1/generations") {
    const { results } = await env.DB.prepare(
      `SELECT id, provider, model, prompt, aspect_ratio, credit_cost, operation_type, created_at
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

async function requireVerifiedCheckoutEmail(env, userId) {
  if (!env.CLERK_SECRET_KEY) throw new Error("Email verification for checkout is temporarily unavailable.");
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (!response.ok) throw new Error("Email verification for checkout is temporarily unavailable.");
  const user = await response.json();
  const primaryEmail = user.email_addresses?.find((email) => email.id === user.primary_email_address_id);
  if (primaryEmail?.verification?.status !== "verified") {
    throw new Error("Verify your email address before purchasing credits.");
  }
}

async function enrollBetaMember(request, env, userId) {
  if (env.PRIVATE_BETA !== "true") {
    const existing = await getBetaMember(env, userId);
    if (existing) return json({ enrolled: true, role: existing.role });
    await env.DB.prepare("INSERT OR IGNORE INTO beta_members (user_id, role) VALUES (?, 'tester')").bind(userId).run();
    const capacity = await getPaidBetaCapacity(env, userId);
    return json({ enrolled: true, role: "tester", ...capacity });
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

async function getPaidBetaCapacity(env, userId) {
  const maximum = positiveInteger(env.MAX_PAID_BETA_USERS, 25);
  const [count, slot] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM paid_beta_slots WHERE status = 'paid'").first(),
    env.DB.prepare("SELECT status FROM paid_beta_slots WHERE user_id = ?").bind(userId).first(),
  ]);
  const paidBetaCount = Number(count?.count || 0);
  const hasPaidBetaAccess = slot?.status === "paid";
  return {
    paidBetaCount,
    paidBetaLimit: maximum,
    paidBetaRemaining: Math.max(0, maximum - paidBetaCount),
    hasPaidBetaAccess,
    purchaseEligible: hasPaidBetaAccess || paidBetaCount < maximum,
  };
}

async function getSignupCreditPromotion(env, userId) {
  const maximum = positiveInteger(env.SIGNUP_BONUS_USERS, 25);
  const [count, grant] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM signup_credit_grants").first(),
    env.DB.prepare(
      `SELECT g.credits, g.celebration_seen_at, u.promo_credit_balance
       FROM signup_credit_grants g
       JOIN users u ON u.user_id = g.user_id
       WHERE g.user_id = ?`,
    ).bind(userId).first(),
  ]);
  const claimed = Number(count?.count || 0);
  return {
    signupBonusCredits: positiveInteger(env.SIGNUP_BONUS_CREDITS, 2),
    signupBonusRemaining: Math.max(0, maximum - claimed),
    signupBonusBalance: Number(grant?.promo_credit_balance || 0),
    receivedSignupBonus: Boolean(grant),
    signupBonusCelebrationPending: Boolean(grant && !grant.celebration_seen_at),
  };
}

async function beginPaidBetaCheckout(env, userId, bundleId, creditBalance) {
  if (creditBalance > 5) throw new Error("You can purchase another package when your balance reaches 5 credits or less.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM checkout_locks WHERE expires_at <= CURRENT_TIMESTAMP"),
    env.DB.prepare(
      `DELETE FROM paid_beta_slots WHERE status = 'reserved'
       AND reserved_at <= datetime('now', '-30 minutes')
       AND user_id NOT IN (SELECT user_id FROM checkout_locks)`,
    ),
  ]);

  const activeLock = await env.DB.prepare(
    "SELECT checkout_url FROM checkout_locks WHERE user_id = ? AND expires_at > CURRENT_TIMESTAMP",
  ).bind(userId).first();
  if (activeLock?.checkout_url) return { url: activeLock.checkout_url };

  const maximum = positiveInteger(env.MAX_PAID_BETA_USERS, 25);
  let slot = await env.DB.prepare("SELECT status FROM paid_beta_slots WHERE user_id = ?").bind(userId).first();
  if (!slot) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO paid_beta_slots (user_id, status)
       SELECT ?, 'reserved' WHERE (SELECT COUNT(*) FROM paid_beta_slots) < ?`,
    ).bind(userId, maximum).run();
    slot = await env.DB.prepare("SELECT status FROM paid_beta_slots WHERE user_id = ?").bind(userId).first();
  }
  if (!slot) throw new Error("All 25 public-beta purchasing places have been claimed. More will open after the beta expands.");

  try {
    const session = await createCheckoutSession(env, userId, bundleId, creditBalance);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO checkout_locks (user_id, checkout_session_id, checkout_url, expires_at)
         VALUES (?, ?, ?, datetime('now', '+30 minutes'))`,
      ).bind(userId, session.id, session.url),
      env.DB.prepare(
        "UPDATE paid_beta_slots SET checkout_session_id = ?, reserved_at = CURRENT_TIMESTAMP WHERE user_id = ?",
      ).bind(session.id, userId),
    ]);
    return session;
  } catch (error) {
    if (slot.status === "reserved") {
      await env.DB.prepare("DELETE FROM paid_beta_slots WHERE user_id = ? AND status = 'reserved'").bind(userId).run();
    }
    throw error;
  }
}

async function handleAdmin(request, env, _userId, url) {
  if (request.method === "GET" && url.pathname === "/v1/admin/status") {
    const [clerkUsers, databaseUserRecords, betaMembers, signupBonusUsers, paidUsers, generations, completed, failed, recent, providerUsage] = await Promise.all([
      getClerkUserCount(env),
      env.DB.prepare("SELECT COUNT(*) AS count FROM users").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM beta_members").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM signup_credit_grants").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM paid_beta_slots WHERE status = 'paid'").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM generations").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE status = 'completed'").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE status = 'failed'").first(),
      env.DB.prepare(
      `SELECT id, user_id, provider, model, operation_type, status, credit_cost, provider_cost_usd,
              net_revenue_usd, gross_profit_usd, cost_source, error_code, created_at, completed_at
         FROM generations ORDER BY created_at DESC LIMIT 40`,
      ).all(),
      env.DB.prepare(
        `SELECT provider, model, operation_type,
                COUNT(*) AS attempts,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
                SUM(CASE WHEN status = 'completed' THEN credit_cost ELSE 0 END) AS credits_charged,
                SUM(CASE WHEN status = 'completed' THEN provider_cost_usd ELSE 0 END) AS provider_cost_usd,
                SUM(CASE WHEN status = 'completed' THEN net_revenue_usd ELSE 0 END) AS net_revenue_usd,
                SUM(CASE WHEN status = 'completed' THEN gross_profit_usd ELSE 0 END) AS gross_profit_usd,
                SUM(CASE WHEN created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END) AS today_attempts,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END) AS today_completed,
                SUM(CASE WHEN status = 'failed' AND created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END) AS today_failed,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', 'start of day') THEN credit_cost ELSE 0 END) AS today_credits_charged,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', 'start of day') THEN provider_cost_usd ELSE 0 END) AS today_provider_cost_usd,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', 'start of day') THEN net_revenue_usd ELSE 0 END) AS today_net_revenue_usd,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', 'start of day') THEN gross_profit_usd ELSE 0 END) AS today_gross_profit_usd,
                SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS seven_day_attempts,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS seven_day_completed,
                SUM(CASE WHEN status = 'failed' AND created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS seven_day_failed,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-7 days') THEN credit_cost ELSE 0 END) AS seven_day_credits_charged,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-7 days') THEN provider_cost_usd ELSE 0 END) AS seven_day_provider_cost_usd,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-7 days') THEN net_revenue_usd ELSE 0 END) AS seven_day_net_revenue_usd,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-7 days') THEN gross_profit_usd ELSE 0 END) AS seven_day_gross_profit_usd,
                SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS thirty_day_attempts,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS thirty_day_completed,
                SUM(CASE WHEN status = 'failed' AND created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS thirty_day_failed,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-30 days') THEN credit_cost ELSE 0 END) AS thirty_day_credits_charged,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-30 days') THEN provider_cost_usd ELSE 0 END) AS thirty_day_provider_cost_usd,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-30 days') THEN net_revenue_usd ELSE 0 END) AS thirty_day_net_revenue_usd,
                SUM(CASE WHEN status = 'completed' AND created_at >= datetime('now', '-30 days') THEN gross_profit_usd ELSE 0 END) AS thirty_day_gross_profit_usd
         FROM generations GROUP BY provider, model, operation_type ORDER BY provider, model, operation_type`,
      ).all(),
    ]);
    const providerLimits = {
      OpenAI: positiveInteger(env.OPENAI_DAILY_GENERATION_LIMIT, 1500),
      Google: positiveInteger(env.GOOGLE_DAILY_GENERATION_LIMIT, 1500),
      xAI: positiveInteger(env.XAI_DAILY_GENERATION_LIMIT, 1500),
    };
    const usageDashboard = buildUsageDashboard(providerUsage.results, providerLimits);
    return json({
      summary: {
        clerkUsers: clerkUsers ?? databaseUserRecords?.count ?? 0,
        clerkUsersAvailable: clerkUsers !== null,
        databaseUserRecords: databaseUserRecords?.count || 0,
        betaMembers: betaMembers?.count || 0,
        signupBonusUsers: signupBonusUsers?.count || 0,
        paidBetaUsers: paidUsers?.count || 0,
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
      usage: usageDashboard,
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
    await syncCreditBuckets(env, userId);
    const balances = await env.DB.prepare(
      "SELECT paid_credit_balance, promo_credit_balance FROM users WHERE user_id = ?",
    ).bind(userId).first();
    const promoDeduction = parsedAmount < 0 ? Math.min(-parsedAmount, Number(balances?.promo_credit_balance || 0)) : 0;
    const paidDeduction = parsedAmount < 0 ? -parsedAmount - promoDeduction : 0;
    const result = await env.DB.prepare(
      `UPDATE users SET credit_balance = credit_balance + ?,
       promo_credit_balance = promo_credit_balance + ? - ?, paid_credit_balance = paid_credit_balance - ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND credit_balance + ? >= 0 AND paid_credit_balance >= ?
       AND EXISTS (SELECT 1 FROM beta_members WHERE beta_members.user_id = users.user_id)`,
    ).bind(parsedAmount, Math.max(0, parsedAmount), promoDeduction, paidDeduction, userId, parsedAmount, paidDeduction).run();
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
  const created = await env.DB.prepare(
    "INSERT OR IGNORE INTO users (user_id, free_generations_remaining) VALUES (?, 0)",
  ).bind(userId).run();
  if (!created.meta?.changes) return;

  const maximum = positiveInteger(env.SIGNUP_BONUS_USERS, 25);
  const credits = positiveInteger(env.SIGNUP_BONUS_CREDITS, 2);
  const referenceId = `signup-bonus:${userId}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO signup_credit_grants (user_id, credits)
       SELECT ?, ? WHERE (SELECT COUNT(*) FROM signup_credit_grants) < ?`,
    ).bind(userId, credits, maximum),
    env.DB.prepare(
      `UPDATE users SET credit_balance = credit_balance + ?, promo_credit_balance = promo_credit_balance + ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?
       AND EXISTS (SELECT 1 FROM signup_credit_grants WHERE user_id = ?)
       AND NOT EXISTS (SELECT 1 FROM credit_ledger WHERE reference_id = ?)`,
    ).bind(credits, credits, userId, userId, referenceId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, user_id, amount, kind, reference_id, description)
       SELECT ?, ?, ?, 'adjustment', ?, 'Launch signup bonus' WHERE changes() = 1`,
    ).bind(crypto.randomUUID(), userId, credits, referenceId),
  ]);
}

async function syncCreditBuckets(env, userId) {
  const account = await env.DB.prepare(
    "SELECT credit_balance, paid_credit_balance, promo_credit_balance FROM users WHERE user_id = ?",
  ).bind(userId).first();
  if (!account || Number(account.paid_credit_balance || 0) + Number(account.promo_credit_balance || 0) === Number(account.credit_balance || 0)) return;
  const totals = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'purchase' AND amount > 0 THEN amount ELSE 0 END), 0) AS purchased,
       COALESCE(SUM(CASE WHEN kind = 'adjustment' THEN amount ELSE 0 END), 0) AS promotional,
       COALESCE(-SUM(CASE WHEN kind IN ('generation', 'refund') THEN amount ELSE 0 END), 0) AS net_spent
     FROM credit_ledger WHERE user_id = ?`,
  ).bind(userId).first();
  const balance = Number(account.credit_balance || 0);
  const promotionalGranted = Math.max(0, Number(totals?.promotional || 0));
  const netSpent = Math.max(0, Number(totals?.net_spent || 0));
  const promoRemaining = Math.min(balance, Math.max(0, promotionalGranted - netSpent));
  const paidRemaining = Math.max(0, balance - promoRemaining);
  await env.DB.prepare(
    "UPDATE users SET paid_credit_balance = ?, promo_credit_balance = ? WHERE user_id = ?",
  ).bind(paidRemaining, promoRemaining, userId).run();
}

async function createGeneration(request, env, userId, apiOrigin) {
  const parsed = parseGeneration(await request.json());
  if (parsed.error) return parsed.error;
  const { input, prompt, aspectRatio, config, sourceGenerationId, operationType } = parsed;
  const limitError = await checkGenerationLimits(env, userId, config.provider);
  if (limitError) return limitError;
  let { inputImage } = parsed;
  if (sourceGenerationId) {
    const source = await loadGeneratedSource(env, userId, sourceGenerationId);
    if (source.error) return source.error;
    inputImage = source.image;
  }
  await syncCreditBuckets(env, userId);
  const generationId = crypto.randomUUID();
  const account = await env.DB.prepare(
    "SELECT credit_balance, paid_credit_balance, promo_credit_balance, free_generations_remaining FROM users WHERE user_id = ?",
  ).bind(userId).first();
  const freeGenerationsEnabled = env.FREE_GENERATIONS_ENABLED === "true";
  const chargeKind = freeGenerationsEnabled && account.free_generations_remaining > 0 ? "signup_free" : "credits";
  const creditCost = chargeKind === "signup_free" ? 0 : config.credits;
  const promoCreditsUsed = chargeKind === "credits" ? Math.min(config.credits, Number(account.promo_credit_balance || 0)) : 0;
  const paidCreditsUsed = chargeKind === "credits" ? config.credits - promoCreditsUsed : 0;
  const reserved = chargeKind === "signup_free"
    ? await reserveFreeGeneration(env, { generationId, userId, config, input, prompt, aspectRatio, inputImage, sourceGenerationId, operationType })
    : await reserveCreditGeneration(env, { generationId, userId, config, input, prompt, aspectRatio, inputImage, sourceGenerationId, operationType, promoCreditsUsed, paidCreditsUsed });

  if (!reserved) {
    const user = await env.DB.prepare("SELECT credit_balance FROM users WHERE user_id = ?").bind(userId).first();
    return json({ error: `You need ${config.credits} credits. Your balance is ${user?.credit_balance || 0}.` }, 402);
  }

  try {
    await generateAndStore(env, { generationId, userId, config, input, prompt, aspectRatio, inputImage, operationType, paidCreditsUsed });
  } catch (error) {
    await refundGeneration(env, userId, generationId, creditCost, chargeKind, error);
    const publicMessage = error.message?.includes("not configured")
      ? "That model is not available yet. Your generation was returned."
      : "The model could not create this image. Your generation was returned.";
    return json({ error: publicMessage }, 502);
  }

  const row = await env.DB.prepare(
    "SELECT id, provider, model, prompt, aspect_ratio, credit_cost, charge_kind, operation_type, created_at FROM generations WHERE id = ?",
  ).bind(generationId).first();
  const user = await env.DB.prepare(
    "SELECT credit_balance, paid_credit_balance, promo_credit_balance, free_generations_remaining FROM users WHERE user_id = ?",
  ).bind(userId).first();
  return json({
    generation: await serializeGeneration(row, env, apiOrigin),
    creditBalance: user.credit_balance,
    paidCreditBalance: user.paid_credit_balance,
    promoCreditBalance: user.promo_credit_balance,
    freeGenerationsRemaining: env.FREE_GENERATIONS_ENABLED === "true" ? user.free_generations_remaining : 0,
  }, 201);
}

async function checkGenerationLimits(env, userId, provider) {
  const hourlyResetAt = env.HOURLY_LIMIT_RESET_AT || "1970-01-01T00:00:00Z";
  const [processing, globalProcessing, hourly, daily, providerDaily] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE user_id = ? AND status = 'processing'").bind(userId).first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE status = 'processing'").first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM generations WHERE user_id = ? AND status = 'completed'
       AND created_at >= CASE
         WHEN datetime('now', '-1 hour') > datetime(?) THEN datetime('now', '-1 hour')
         ELSE datetime(?)
       END`,
    ).bind(userId, hourlyResetAt, hourlyResetAt).first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE user_id = ? AND status = 'completed' AND created_at >= datetime('now', 'start of day')").bind(userId).first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM generations WHERE provider = ? AND created_at >= datetime('now', 'start of day')").bind(provider).first(),
  ]);
  if ((processing?.count || 0) >= positiveInteger(env.MAX_CONCURRENT_GENERATIONS, 1)) {
    return json({ error: "Wait for your current image to finish before starting another." }, 429);
  }
  if ((globalProcessing?.count || 0) >= positiveInteger(env.MAX_GLOBAL_CONCURRENT_GENERATIONS, 3)) {
    return json({ error: "The beta is busy right now. Please try again in a moment." }, 429);
  }
  if ((hourly?.count || 0) >= positiveInteger(env.MAX_GENERATIONS_PER_HOUR, 20)) {
    return json({ error: "You reached the public-beta hourly limit. Try again later." }, 429);
  }
  if ((daily?.count || 0) >= positiveInteger(env.MAX_GENERATIONS_PER_DAY, 60)) {
    return json({ error: "You reached today's public-beta generation limit." }, 429);
  }
  const providerLimit = provider === "OpenAI"
    ? positiveInteger(env.OPENAI_DAILY_GENERATION_LIMIT, 1500)
    : provider === "xAI"
      ? positiveInteger(env.XAI_DAILY_GENERATION_LIMIT, 1500)
      : positiveInteger(env.GOOGLE_DAILY_GENERATION_LIMIT, 1500);
  if ((providerDaily?.count || 0) >= providerLimit) {
    return json({ error: `${provider} reached today's public-beta capacity. No credits were charged.` }, 503);
  }
  return null;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildUsageDashboard(rows, providerLimits) {
  const modelNames = {
    auto: "Auto (Google)",
    "google-nano-banana": "Nano Banana 2 Lite",
    "openai-sunburst": "GPT Image 2.5 Sunburst Low",
    "xai-imagine": "Grok Imagine 2.0 Low",
  };
  const number = (value) => Number(value || 0);
  const period = (row, prefix = "") => ({
    attempts: number(row[`${prefix}attempts`]),
    completed: number(row[`${prefix}completed`]),
    failed: number(row[`${prefix}failed`]),
    creditsCharged: number(row[`${prefix}credits_charged`]),
    providerCostUsd: money(row[`${prefix}provider_cost_usd`]),
    netRevenueUsd: money(row[`${prefix}net_revenue_usd`]),
    grossProfitUsd: money(row[`${prefix}gross_profit_usd`]),
  });
  const models = rows.map((row) => {
    const allTime = period(row);
    const today = period(row, "today_");
    const sevenDays = period(row, "seven_day_");
    const thirtyDays = period(row, "thirty_day_");
    return {
      provider: row.provider,
      model: row.model,
      modelName: modelNames[row.model] || row.model,
      operationType: row.operation_type || "generation",
      processing: number(row.processing),
      today,
      sevenDays,
      thirtyDays,
      allTime,
    };
  });
  const providers = ["Google", "OpenAI", "xAI"].map((provider) => {
    const providerModels = models.filter((item) => item.provider === provider);
    const totals = (key) => providerModels.reduce((sum, item) => ({
      attempts: sum.attempts + item[key].attempts,
      completed: sum.completed + item[key].completed,
      failed: sum.failed + item[key].failed,
      creditsCharged: sum.creditsCharged + item[key].creditsCharged,
      providerCostUsd: money(sum.providerCostUsd + item[key].providerCostUsd),
      netRevenueUsd: money(sum.netRevenueUsd + item[key].netRevenueUsd),
      grossProfitUsd: money(sum.grossProfitUsd + item[key].grossProfitUsd),
    }), { attempts: 0, completed: 0, failed: 0, creditsCharged: 0, providerCostUsd: 0, netRevenueUsd: 0, grossProfitUsd: 0 });
    return {
      provider,
      dailyLimit: providerLimits[provider],
      processing: providerModels.reduce((sum, item) => sum + item.processing, 0),
      today: totals("today"),
      sevenDays: totals("sevenDays"),
      thirtyDays: totals("thirtyDays"),
      allTime: totals("allTime"),
    };
  });
  const totals = (key) => ({
    providerCostUsd: money(providers.reduce((sum, item) => sum + item[key].providerCostUsd, 0)),
    netRevenueUsd: money(providers.reduce((sum, item) => sum + item[key].netRevenueUsd, 0)),
    grossProfitUsd: money(providers.reduce((sum, item) => sum + item[key].grossProfitUsd, 0)),
  });
  return {
    currency: "USD",
    timezone: "UTC",
    note: "Recorded per completed request. Provider usage is used when returned; fixed or clearly labeled estimates are used otherwise.",
    financials: { today: totals("today"), sevenDays: totals("sevenDays"), thirtyDays: totals("thirtyDays"), allTime: totals("allTime") },
    providers,
    models,
  };
}

function money(value) {
  return Number(Number(value || 0).toFixed(4));
}

function parseGeneration(input) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const aspectRatio = ["1:1", "16:9", "9:16"].includes(input.aspectRatio) ? input.aspectRatio : "1:1";
  const config = MODEL_CONFIG[input.model];
  if (!config) return { error: json({ error: "Choose a supported model." }, 400) };
  if (!prompt || prompt.length > 1200) return { error: json({ error: "Prompt must contain 1–1,200 characters." }, 400) };
  const parsedImage = parseInputImage(input.inputImage);
  if (parsedImage?.error) return { error: parsedImage.error };
  const inputImage = parsedImage?.image || null;
  const sourceGenerationId = typeof input.sourceGenerationId === "string" ? input.sourceGenerationId.trim() : "";
  if (inputImage && sourceGenerationId) return { error: json({ error: "Choose either an uploaded image or an existing Indermit image." }, 400) };
  if (sourceGenerationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceGenerationId)) {
    return { error: json({ error: "The selected Indermit image is invalid." }, 400) };
  }
  return { input, prompt, aspectRatio, config, inputImage, sourceGenerationId: sourceGenerationId || null, operationType: inputImage || sourceGenerationId ? "edit" : "generation" };
}

function parseInputImage(value) {
  if (value == null) return null;
  const allowed = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  if (!value || typeof value !== "object" || typeof value.data !== "string" || !allowed[value.mimeType]) {
    return { error: json({ error: "Upload one PNG, JPEG, or WebP image." }, 400) };
  }
  const base64 = value.data.replace(/\s/g, "");
  const maximumBytes = 5 * 1024 * 1024;
  if (!base64 || base64.length > Math.ceil(maximumBytes / 3) * 4 + 4) {
    return { error: json({ error: "Uploaded images must be 5 MB or smaller." }, 413) };
  }
  let bytes;
  try { bytes = base64ToBytes(base64); }
  catch { return { error: json({ error: "The uploaded image could not be read." }, 400) }; }
  if (!bytes.length || bytes.length > maximumBytes || !matchesImageSignature(bytes, value.mimeType)) {
    return { error: json({ error: "The uploaded file is not a valid PNG, JPEG, or WebP image." }, 400) };
  }
  return { image: { base64, bytes, byteLength: bytes.length, mimeType: value.mimeType, extension: allowed[value.mimeType] } };
}

function matchesImageSignature(bytes, mimeType) {
  if (mimeType === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

async function loadGeneratedSource(env, userId, sourceGenerationId) {
  const row = await env.DB.prepare(
    `SELECT object_key, mime_type FROM generations
     WHERE id = ? AND user_id = ? AND status = 'completed'`,
  ).bind(sourceGenerationId, userId).first();
  if (!row?.object_key) return { error: json({ error: "That image is no longer available to edit." }, 404) };
  const object = await env.IMAGES.get(row.object_key);
  if (!object) return { error: json({ error: "That image is no longer available to edit." }, 404) };
  const mimeType = row.mime_type || object.httpMetadata?.contentType || "image/png";
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  if (!extensions[mimeType]) return { error: json({ error: "That image format cannot be edited." }, 400) };
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (!bytes.length || !matchesImageSignature(bytes, mimeType)) return { error: json({ error: "The selected image could not be read." }, 400) };
  return { image: { bytes, base64: bytesToBase64(bytes), byteLength: bytes.length, mimeType, extension: extensions[mimeType] } };
}

async function reserveFreeGeneration(env, details) {
  const { generationId, userId, config, input, prompt, aspectRatio, inputImage, sourceGenerationId, operationType } = details;
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET free_generations_remaining = free_generations_remaining - 1 WHERE user_id = ? AND free_generations_remaining > 0",
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO generations (id, user_id, provider, model, prompt, aspect_ratio, credit_cost, charge_kind, operation_type, input_image_count, input_image_bytes, source_generation_id, status)
       SELECT ?, ?, ?, ?, ?, ?, 0, 'signup_free', ?, ?, ?, ?, 'processing' WHERE changes() = 1`,
    ).bind(generationId, userId, config.provider, input.model, prompt, aspectRatio, operationType, inputImage ? 1 : 0, inputImage?.byteLength || 0, sourceGenerationId),
  ]);
  return Boolean(results[1]?.meta?.changes);
}

async function reserveCreditGeneration(env, details) {
  const { generationId, userId, config, input, prompt, aspectRatio, inputImage, sourceGenerationId, operationType, promoCreditsUsed, paidCreditsUsed } = details;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET credit_balance = credit_balance - ?, promo_credit_balance = promo_credit_balance - ?, paid_credit_balance = paid_credit_balance - ?
       WHERE user_id = ? AND credit_balance >= ? AND promo_credit_balance >= ? AND paid_credit_balance >= ?`,
    ).bind(config.credits, promoCreditsUsed, paidCreditsUsed, userId, config.credits, promoCreditsUsed, paidCreditsUsed),
    env.DB.prepare(
      `INSERT INTO generations (id, user_id, provider, model, prompt, aspect_ratio, credit_cost, charge_kind, operation_type,
        input_image_count, input_image_bytes, source_generation_id, paid_credits_used, promo_credits_used, status)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'credits', ?, ?, ?, ?, ?, ?, 'processing' WHERE changes() = 1`,
    ).bind(generationId, userId, config.provider, input.model, prompt, aspectRatio, config.credits, operationType,
      inputImage ? 1 : 0, inputImage?.byteLength || 0, sourceGenerationId, paidCreditsUsed, promoCreditsUsed),
    env.DB.prepare(
      `INSERT INTO credit_ledger (id, user_id, amount, kind, reference_id, description)
       SELECT ?, ?, ?, 'generation', ?, ? WHERE EXISTS (SELECT 1 FROM generations WHERE id = ?)`,
    ).bind(crypto.randomUUID(), userId, -config.credits, `generation:${generationId}`, `${config.provider} image ${operationType}`, generationId),
  ]);
  return Boolean(results[1]?.meta?.changes);
}

async function generateAndStore(env, details) {
  const { generationId, userId, config, input, prompt, aspectRatio, inputImage, operationType, paidCreditsUsed } = details;
  const generated = await generateImage(env, { model: input.model, prompt, aspectRatio, inputImage });
  const extension = generated.mimeType.includes("webp") ? "webp" : generated.mimeType.includes("jpeg") ? "jpg" : "png";
  const objectKey = `${userId}/${generationId}.${extension}`;
  const usage = generated.usage || fallbackProviderUsage(config.provider, operationType);
  const providerCostUsd = money(usage.costUsd);
  const revenuePerPaidCredit = nonNegativeNumber(env.NET_REVENUE_PER_PAID_CREDIT_USD, 0.04505);
  const netRevenueUsd = money(paidCreditsUsed * revenuePerPaidCredit);
  const grossProfitUsd = money(netRevenueUsd - providerCostUsd);
  await env.IMAGES.put(objectKey, generated.bytes, {
    httpMetadata: { contentType: generated.mimeType, cacheControl: "private, max-age=31536000, immutable" },
    customMetadata: { userId, generationId, provider: config.provider, operationType },
  });
  const completed = await env.DB.prepare(
    `UPDATE generations SET status = 'completed', object_key = ?, mime_type = ?, input_text_tokens = ?, input_image_tokens = ?,
       output_image_tokens = ?, provider_cost_usd = ?, cost_source = ?, net_revenue_usd = ?, gross_profit_usd = ?, completed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'processing'`,
  ).bind(objectKey, generated.mimeType, usage.inputTextTokens || 0, usage.inputImageTokens || 0,
    usage.outputImageTokens || 0, providerCostUsd, usage.costSource || "estimated", netRevenueUsd, grossProfitUsd,
    generationId, userId).run();
  if (!completed.meta.changes) {
    await env.IMAGES.delete(objectKey);
    throw new Error("Generation could not be finalized");
  }
}

function fallbackProviderUsage(provider, operationType) {
  const editing = operationType === "edit";
  if (provider === "xAI") return { inputTextTokens: 0, inputImageTokens: 0, outputImageTokens: 0, costUsd: editing ? 0.05 : 0.04, costSource: "provider_fixed" };
  if (provider === "OpenAI") return { inputTextTokens: 100, inputImageTokens: editing ? 1229 : 0, outputImageTokens: 196, costUsd: editing ? 0.016212 : 0.00638, costSource: "estimated" };
  return { inputTextTokens: 100, inputImageTokens: editing ? 1032 : 0, outputImageTokens: 1120, costUsd: editing ? 0.033883 : 0.033625, costSource: "estimated" };
}

async function refundGeneration(env, userId, generationId, credits, chargeKind, error) {
  const statements = chargeKind === "signup_free"
    ? [env.DB.prepare(
      `UPDATE users SET free_generations_remaining = free_generations_remaining + 1
       WHERE user_id = ? AND EXISTS (SELECT 1 FROM generations WHERE id = ? AND status = 'processing')`,
    ).bind(userId, generationId)]
    : [
      env.DB.prepare(
        `UPDATE users SET credit_balance = credit_balance + ?,
         paid_credit_balance = paid_credit_balance + COALESCE((SELECT paid_credits_used FROM generations WHERE id = ?), 0),
         promo_credit_balance = promo_credit_balance + COALESCE((SELECT promo_credits_used FROM generations WHERE id = ?), 0)
         WHERE user_id = ? AND EXISTS (SELECT 1 FROM generations WHERE id = ? AND status = 'processing')`,
      ).bind(credits, generationId, generationId, userId, generationId),
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
    operationType: row.operation_type || "generation",
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
      `UPDATE users SET credit_balance = credit_balance + ?, paid_credit_balance = paid_credit_balance + ?,
       stripe_customer_id = COALESCE(?, stripe_customer_id), updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND changes() = 1`,
    ).bind(credits, credits, session.customer || null, userId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, user_id, amount, kind, reference_id, description)
       SELECT ?, ?, ?, 'purchase', ?, 'Stripe credit purchase' WHERE changes() = 1`,
    ).bind(crypto.randomUUID(), userId, credits, `stripe:${event.id}`),
    env.DB.prepare(
      `INSERT INTO paid_beta_slots (user_id, status, checkout_session_id, paid_at)
       VALUES (?, 'paid', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET status = 'paid', checkout_session_id = excluded.checkout_session_id,
       paid_at = COALESCE(paid_beta_slots.paid_at, CURRENT_TIMESTAMP)`,
    ).bind(userId, session.id),
    env.DB.prepare("DELETE FROM checkout_locks WHERE user_id = ?").bind(userId),
  ]);
  return json({ received: true });
}

function isStripeReady(env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return false;
  const prefixes = env.STRIPE_MODE === "live" ? ["sk_live_", "rk_live_"] : ["sk_test_", "rk_test_"];
  return prefixes.some((prefix) => env.STRIPE_SECRET_KEY.startsWith(prefix));
}
