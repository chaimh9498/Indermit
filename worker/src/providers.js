import { base64ToBytes } from "./utils.js";

export const MODEL_CONFIG = {
  auto: { provider: "Microsoft", credits: 12 },
  "microsoft-mai": { provider: "Microsoft", credits: 12 },
  "openai-sunburst": { provider: "OpenAI", credits: 30 },
  "google-nano-banana": { provider: "Google", credits: 20 },
  "xai-imagine": { provider: "xAI", credits: 15 },
};

const OPENAI_SIZES = { "1:1": "1024x1024", "16:9": "1536x864", "9:16": "864x1536" };
const AZURE_MAI_SIZES = { "1:1": [1024, 1024], "16:9": [1360, 768], "9:16": [768, 1360] };

export async function generateImage(env, input) {
  if (input.model === "auto" || input.model === "microsoft-mai") return generateMicrosoftMai(env, input);
  if (input.model === "openai-sunburst") return generateOpenAI(env, input);
  if (input.model === "google-nano-banana") return generateGoogle(env, input);
  if (input.model === "xai-imagine") return generateXai(env, input);
  throw new Error("Unsupported model");
}

async function generateMicrosoftMai(env, { prompt, aspectRatio }) {
  if (!env.AZURE_MAI_API_KEY || !env.AZURE_MAI_ENDPOINT || !env.AZURE_MAI_DEPLOYMENT) {
    throw new Error("Microsoft is not configured");
  }
  const [width, height] = AZURE_MAI_SIZES[aspectRatio] || AZURE_MAI_SIZES["1:1"];
  const endpoint = env.AZURE_MAI_ENDPOINT.replace(/\/$/, "");
  const response = await fetch(`${endpoint}/mai/v1/images/generations`, {
    method: "POST",
    headers: {
      "api-key": env.AZURE_MAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.AZURE_MAI_DEPLOYMENT,
      prompt,
      width,
      height,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new ProviderError("Microsoft", result.error?.message || result.message);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new ProviderError("Microsoft", "No image returned");
  return { bytes: base64ToBytes(encoded), mimeType: "image/png" };
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
