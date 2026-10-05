import { base64UrlToBytes } from "./utils.js";

const jwksCache = new Map();

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

async function getJwk(env, kid) {
  const cacheKey = `${env.CLERK_ISSUER}:${kid}`;
  const cached = jwksCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.jwk;

  const url = env.CLERK_JWKS_URL || `${env.CLERK_ISSUER.replace(/\/$/, "")}/.well-known/jwks.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Unable to load identity keys");
  const { keys } = await response.json();
  const jwk = keys.find((key) => key.kid === kid && key.kty === "RSA");
  if (!jwk) throw new Error("Unknown identity key");
  jwksCache.set(cacheKey, { jwk, expiresAt: Date.now() + 60 * 60 * 1000 });
  return jwk;
}

export async function authenticate(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new AuthError("Sign in required");
  const token = authorization.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("Invalid session token");

  let header;
  let payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    throw new AuthError("Invalid session token");
  }
  if (header.alg !== "RS256" || !header.kid) throw new AuthError("Unsupported session token");

  const jwk = await getJwk(env, header.kid);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AuthError("Invalid session signature");

  const now = Math.floor(Date.now() / 1000);
  const issuer = env.CLERK_ISSUER.replace(/\/$/, "");
  if (payload.iss?.replace(/\/$/, "") !== issuer) throw new AuthError("Invalid token issuer");
  if (!payload.sub || payload.exp <= now || (payload.nbf && payload.nbf > now + 30)) throw new AuthError("Session expired");

  const parties = (env.CLERK_AUTHORIZED_PARTIES || env.FRONTEND_URL).split(",").map((value) => value.trim());
  if (payload.azp && !parties.includes(payload.azp)) throw new AuthError("Invalid authorized party");
  return { userId: payload.sub };
}

export class AuthError extends Error {}
