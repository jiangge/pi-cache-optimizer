import { type PiModel, asRecord, lower } from "./common.ts";

export const ASSISTANT_MESSAGE_MODEL_TOKEN_KEYS = ["model", "name"];

export function getModelIdNameTokenValues(model: PiModel | undefined): string[] {
  if (!model) return [];
  return [model.id, model.name].map(lower).filter(Boolean);
}

export function getAssistantMessageModelTokenValues(message: unknown): string[] {
  const record = asRecord(message);
  if (!record) return [];

  return ASSISTANT_MESSAGE_MODEL_TOKEN_KEYS.map((key) => lower(record[key])).filter(Boolean);
}

export function hasAnyTokenContaining(tokens: string[], needles: string[]): boolean {
  return tokens.some((token) => needles.some((needle) => token.includes(needle)));
}

export function modelOrAssistantMessageHas(message: unknown, model: PiModel | undefined, needles: string[]): boolean {
  return hasAnyTokenContaining([...getModelIdNameTokenValues(model), ...getAssistantMessageModelTokenValues(message)], needles);
}

// ── Adaptive generation model detection ────────────────────────────

/**
 * Check whether the model id uses Anthropic's adaptive generation (thinking)
 * that requires `forceAdaptiveThinking: true` in compat.
 *
 * Adaptive-generation models (from pi-ai built-in catalog) include:
 *   claude-opus-4-6, claude-opus-4-7, claude-opus-4-8 (also dotted 4.6/4.7/4.8)
 *   claude-sonnet-4-6, claude-sonnet-5
 *   claude-fable-5
 *   claude-haiku-5-5 (Pi 1.1.0+)
 *
 * We match broadly: opus >= 4-6, sonnet >= 4-6, fable >= 5, haiku >= 5
 * (Pi's own Bedrock/Anthropic detection treats every haiku-5* as adaptive).
 * Ids may carry date-stamp or size suffixes like "[1M]".
 */
export const ADAPTIVE_OPUS_PATTERN = /(^|[\/\s:_-])(opus-4[.-][6-9]|opus-4-[1-9][0-9]|opus-([5-9]|[1-9][0-9]))($|[-_.:\/\s\[])/i;

export const ADAPTIVE_SONNET_PATTERN = /(^|[\/\s:_-])(sonnet-4[.-][6-9]|sonnet-4-[1-9][0-9]|sonnet-([5-9]|[1-9][0-9]))($|[-_.:\/\s\[])/i;

export const ADAPTIVE_FABLE_PATTERN = /(^|[\/\s:_-])fable-([5-9]|[1-9][0-9])($|[-_.:\/\s\[])/i;

export const ADAPTIVE_HAIKU_PATTERN = /(^|[\/\s:_-])haiku-([5-9]|[1-9][0-9])($|[-_.:\/\s\[])/i;

export function isAdaptiveGenerationModel(model: PiModel | undefined): boolean {
  if (!model) return false;
  const tokens = getModelIdNameTokenValues(model);
  return tokens.some((t) => ADAPTIVE_OPUS_PATTERN.test(t) || ADAPTIVE_SONNET_PATTERN.test(t) || ADAPTIVE_FABLE_PATTERN.test(t) || ADAPTIVE_HAIKU_PATTERN.test(t));
}

export function isKimiCodingAdaptiveModel(model: PiModel | undefined): boolean {
  if (!model) return false;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl);
  const isKimiCodingChannel = provider.includes("kimi-coding") || baseUrl.includes("api.kimi.com/coding");
  if (!isKimiCodingChannel) return false;

  const tokens = getModelIdNameTokenValues(model);
  return tokens.some((token) =>
    token === "k3"
    || token.includes("kimi-k3")
    || token.includes("kimi k3")
    || token.includes("kimi-for-coding")
    || token.includes("kimi for coding")
  );
}
