import { base64ToBytes } from "./utils.js";

export const MODEL_CONFIG = {
  auto: { provider: "OpenRouter", credits: 3 },
  "openrouter-muse": { provider: "Meta via OpenRouter", credits: 3 },
  "openai-sunburst": { provider: "OpenAI", credits: 30 },
  "google-nano-banana": { provider: "Google", credits: 20 },
  "xai-imagine": { provider: "xAI", credits: 15 },
};

const OPENAI_SIZES = { "1:1": "1024x1024", "16:9": "1536x864", "9:16": "864x1536" };

export async function generateImage(env, input) {
  if (input.model === "auto" || input.model === "openrouter-muse") return generateOpenRouterMuse(env, input);
  if (input.model === "openai-sunburst") return generateOpenAI(env, input);
  if (input.model === "google-nano-banana") return generateGoogle(env, input);
  if (input.model === "xai-imagine") return generateXai(env, input);
  throw new Error("Unsupported model");
}

async function generateOpenRouterMuse(env, { prompt, aspectRatio }) {
  if (!env.OPENROUTER_API_KEY) throw new Error("OpenRouter is not configured");
  const response = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.FRONTEND_URL || "https://indermit.com",
      "X-Title": "Indermit",
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MUSE_MODEL || "meta/muse-image",
      prompt,
      aspect_ratio: aspectRatio,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new ProviderError("OpenRouter", result.error?.message);
  const image = result.data?.[0];
  if (!image?.b64_json) throw new ProviderError("OpenRouter", "No image returned");
  return { bytes: base64ToBytes(image.b64_json), mimeType: image.media_type || "image/png" };
}

async function generateOpenAI(env, { prompt, aspectRatio }) {
  if (!env.OPENAI_API_KEY) throw new Error("OpenAI is not configured");
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
      prompt,
      size: OPENAI_SIZES[aspectRatio],
      quality: "low",
      output_format: "webp",
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new ProviderError("OpenAI", result.error?.message);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new ProviderError("OpenAI", "No image returned");
  return { bytes: base64ToBytes(encoded), mimeType: "image/webp" };
}

async function generateGoogle(env, { prompt, aspectRatio }) {
  if (!env.GOOGLE_API_KEY) throw new Error("Google is not configured");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": env.GOOGLE_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.GOOGLE_IMAGE_MODEL || "gemini-3.1-flash-image",
      input: prompt,
      response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: aspectRatio, image_size: "1K" },
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new ProviderError("Google", result.error?.message);
  const direct = result.output_image;
  const block = result.steps?.flatMap((step) => step.content || []).find((item) => item.type === "image");
  const encoded = direct?.data || block?.data;
  if (!encoded) throw new ProviderError("Google", "No image returned");
  return { bytes: base64ToBytes(encoded), mimeType: direct?.mime_type || block?.mime_type || "image/jpeg" };
}

async function generateXai(env, { prompt, aspectRatio }) {
  if (!env.XAI_API_KEY) throw new Error("xAI is not configured");
  const response = await fetch(env.XAI_IMAGE_ENDPOINT || "https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.XAI_IMAGE_MODEL || "grok-imagine-image-2.0",
      prompt,
      aspect_ratio: aspectRatio,
      resolution: "1k",
      quality: "low",
      response_format: "b64_json",
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new ProviderError("xAI", result.error?.message);
  const item = result.data?.[0];
  if (item?.b64_json) return { bytes: base64ToBytes(item.b64_json), mimeType: "image/png" };
  if (item?.url) {
    const imageResponse = await fetch(item.url);
    if (!imageResponse.ok) throw new ProviderError("xAI", "Could not retrieve generated image");
    return { bytes: new Uint8Array(await imageResponse.arrayBuffer()), mimeType: imageResponse.headers.get("content-type") || "image/png" };
  }
  throw new ProviderError("xAI", "No image returned");
}

export class ProviderError extends Error {
  constructor(provider, message = "Generation failed") {
    super(`${provider} generation failed: ${message}`);
    this.name = `${provider}ProviderError`;
  }
}
