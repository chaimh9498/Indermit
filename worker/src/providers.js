import { base64ToBytes } from "./utils.js";

export const MODEL_CONFIG = {
  auto: { provider: "Google", credits: 2 },
  "openai-sunburst": { provider: "OpenAI", credits: 1 },
  "google-nano-banana": { provider: "Google", credits: 2 },
  "xai-imagine": { provider: "xAI", credits: 2 },
};

const OPENAI_SIZES = { "1:1": "1024x1024", "16:9": "1536x864", "9:16": "864x1536" };
const AZURE_MAI_SIZES = { "1:1": [1024, 1024], "16:9": [1360, 768], "9:16": [768, 1360] };

export async function generateImage(env, input) {
  if (input.model === "auto" || input.model === "google-nano-banana") return generateGoogle(env, input);
  if (input.model === "openai-sunburst") return generateOpenAI(env, input);
  if (input.model === "xai-imagine") return generateXai(env, input);
  throw new Error("Unsupported model");
}

const million = 1_000_000;

function modalityTokens(items = [], modality) {
  return Number(items.find((item) => item.modality === modality)?.tokens || 0);
}

function googleUsage(result, editing) {
  const usage = result.usage || {};
  const textInput = modalityTokens(usage.input_tokens_by_modality, "text");
  const imageInput = modalityTokens(usage.input_tokens_by_modality, "image");
  const imageOutput = modalityTokens(usage.output_tokens_by_modality, "image") || 1120;
  const textOutput = modalityTokens(usage.output_tokens_by_modality, "text");
  const thoughtTokens = Number(usage.total_thought_tokens || 0);
  const hasProviderUsage = Boolean(result.usage);
  const fallbackTextInput = Math.ceil(100);
  const fallbackImageInput = editing ? 1032 : 0;
  const inputTextTokens = hasProviderUsage ? textInput : fallbackTextInput;
  const inputImageTokens = hasProviderUsage ? imageInput : fallbackImageInput;
  const costUsd = ((inputTextTokens + inputImageTokens) * 0.25
    + imageOutput * 30
    + (textOutput + thoughtTokens) * 1.5) / million;
  return {
    inputTextTokens,
    inputImageTokens,
    outputImageTokens: imageOutput,
    costUsd,
    costSource: hasProviderUsage ? "provider_usage" : "estimated",
  };
}

function openAIUsage(result, editing) {
  const usage = result.usage || {};
  const details = usage.input_tokens_details || {};
  const outputDetails = usage.output_tokens_details || {};
  const hasProviderUsage = Boolean(result.usage);
  const inputTextTokens = hasProviderUsage ? Number(details.text_tokens || 0) : 100;
  const inputImageTokens = hasProviderUsage ? Number(details.image_tokens || 0) : editing ? 1229 : 0;
  const outputImageTokens = hasProviderUsage
    ? Number(outputDetails.image_tokens || usage.output_tokens || 0)
    : 196;
  const costUsd = (inputTextTokens * 5 + inputImageTokens * 8 + outputImageTokens * 30) / million;
  return {
    inputTextTokens,
    inputImageTokens,
    outputImageTokens,
    costUsd,
    costSource: hasProviderUsage ? "provider_usage" : "estimated",
  };
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

async function generateOpenAI(env, { prompt, aspectRatio, inputImage }) {
  if (!env.OPENAI_API_KEY) throw new Error("OpenAI is not configured");
  const model = env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst";
  let response;
  if (inputImage) {
    const form = new FormData();
    form.append("model", model);
    form.append("image[]", new Blob([inputImage.bytes], { type: inputImage.mimeType }), `source.${inputImage.extension}`);
    form.append("prompt", prompt);
    form.append("size", OPENAI_SIZES[aspectRatio]);
    form.append("quality", "low");
    form.append("output_format", "webp");
    form.append("output_compression", "90");
    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
  } else {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        size: OPENAI_SIZES[aspectRatio],
        quality: "low",
        output_format: "webp",
        output_compression: 90,
      }),
    });
  }
  const result = await response.json();
  if (!response.ok) throw new ProviderError("OpenAI", result.error?.message);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new ProviderError("OpenAI", "No image returned");
  return { bytes: base64ToBytes(encoded), mimeType: "image/webp", usage: openAIUsage(result, Boolean(inputImage)) };
}

async function generateGoogle(env, { prompt, aspectRatio, inputImage }) {
  if (!env.GOOGLE_API_KEY) throw new Error("Google is not configured");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": env.GOOGLE_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.GOOGLE_IMAGE_MODEL || "gemini-3.1-flash-lite-image",
      input: inputImage ? [
        { type: "text", text: prompt },
        { type: "image", mime_type: inputImage.mimeType, data: inputImage.base64 },
      ] : prompt,
      response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: aspectRatio, image_size: "1K" },
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new ProviderError("Google", result.error?.message);
  const direct = result.output_image;
  const block = result.steps?.flatMap((step) => step.content || []).find((item) => item.type === "image");
  const encoded = direct?.data || block?.data;
  if (!encoded) throw new ProviderError("Google", "No image returned");
  return {
    bytes: base64ToBytes(encoded),
    mimeType: direct?.mime_type || block?.mime_type || "image/jpeg",
    usage: googleUsage(result, Boolean(inputImage)),
  };
}

async function generateXai(env, { prompt, aspectRatio, inputImage }) {
  if (!env.XAI_API_KEY) throw new Error("xAI is not configured");
  const endpoint = inputImage
    ? "https://api.x.ai/v1/images/edits"
    : env.XAI_IMAGE_ENDPOINT || "https://api.x.ai/v1/images/generations";
  const body = {
    model: env.XAI_IMAGE_MODEL || "grok-imagine-image-2.0",
    prompt,
    aspect_ratio: aspectRatio,
    resolution: "1k",
    quality: "low",
    response_format: "b64_json",
  };
  if (inputImage) body.image = { url: `data:${inputImage.mimeType};base64,${inputImage.base64}`, type: "image_url" };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new ProviderError("xAI", result.error?.message);
  const item = result.data?.[0];
  const billedCostTicks = Number(result.usage?.cost_in_usd_ticks);
  const hasBilledCost = Number.isFinite(billedCostTicks) && billedCostTicks >= 0;
  const usage = {
    inputTextTokens: 0,
    inputImageTokens: 0,
    outputImageTokens: 0,
    costUsd: hasBilledCost ? billedCostTicks / 10_000_000_000 : inputImage ? 0.05 : 0.04,
    costSource: hasBilledCost ? "provider_usage" : "provider_fixed",
  };
  if (item?.b64_json) return { bytes: base64ToBytes(item.b64_json), mimeType: "image/png", usage };
  if (item?.url) {
    const imageResponse = await fetch(item.url);
    if (!imageResponse.ok) throw new ProviderError("xAI", "Could not retrieve generated image");
    return { bytes: new Uint8Array(await imageResponse.arrayBuffer()), mimeType: imageResponse.headers.get("content-type") || "image/png", usage };
  }
  throw new ProviderError("xAI", "No image returned");
}

export class ProviderError extends Error {
  constructor(provider, message = "Generation failed") {
    super(`${provider} generation failed: ${message}`);
    this.name = `${provider}ProviderError`;
  }
}
