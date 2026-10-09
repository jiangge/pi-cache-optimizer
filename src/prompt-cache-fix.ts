import { type PiModel, asRecord } from "./common.ts";
import { deriveInnerIndent, findJsonObjectKey, findMatchingBracket, isJsonWhitespace, lineIndentOf, locateModelOverrideInJsonc, parseJsonc, skipJsonWhitespace, stripJsoncComments } from "./jsonc.ts";
import { isValidModelsConfigForEffectiveCompat } from "./model-identity.ts";
import { locateModelInJsonc } from "./models-json-fix.ts";
import { suggestedPromptCacheLifetimes } from "./cache-warming.ts";
import { type PromptCacheLifetimes, isValidPromptCacheLifetimes, samePromptCacheLifetimes } from "./fix-types.ts";

/**
 * `/cache-optimizer fix prompt-cache`: write Pi's model-level `promptCache`
 * lifetimes into models.json so native cache warming can run.
 *
 * Only lifetimes this extension can stand behind are written (the same values
 * Pi ships for its built-in Anthropic models): `{ short: 300, long: 3600 }` on
 * the Anthropic Messages API, and `{ short: 300 }` elsewhere. When the
 * retention tier in use has no documented lifetime, the fix refuses instead of
 * guessing. The edit is a single new `promptCache` property; an existing
 * `promptCache` object is never merged or overwritten.
 */

export type { PromptCacheLifetimes };
export { isValidPromptCacheLifetimes, samePromptCacheLifetimes };

export type PromptCachePlacement = "model" | "modelOverride";

export type PromptCacheFixPlan = {
  modifiedText: string;
  placement: PromptCachePlacement;
  /** Whether the model object or modelOverrides entry existed before the fix. */
  targetExistedBefore: boolean;
  promptCache: PromptCacheLifetimes;
  locationLabel: string;
};

/**
 * Lifetimes to write for the active retention tier, or the reason none can be
 * written. `tier` is "long" when the extension requests 1h retention.
 */
export function choosePromptCacheLifetimes(
  model: PiModel,
  tier: "short" | "long",
): { promptCache: PromptCacheLifetimes } | { error: string } {
  const suggested = suggestedPromptCacheLifetimes(model);
  if (tier === "long" && suggested.long === undefined) {
    return {
      error: `No documented long-retention lifetime is known for the ${model.api ?? "unknown"} API, so the fix will not guess one. ` +
        "Add promptCache.long manually from your provider's documentation (use the conservative end of any range).",
    };
  }
  // Pi merges override lifetimes over the model's own, so write only the tiers
  // the model does not declare yet; a built-in short lifetime stays as is.
  const declared = asRecord(asRecord(model as unknown)?.promptCache);
  const isDeclared = (key: "short" | "long"): boolean => typeof declared?.[key] === "number" && (declared[key] as number) > 0;
  const promptCache: PromptCacheLifetimes = {};
  if (!isDeclared("short")) promptCache.short = suggested.short;
  if (suggested.long !== undefined && !isDeclared("long")) promptCache.long = suggested.long;
  if (Object.keys(promptCache).length === 0) return { error: "The model already declares every lifetime the fix would write." };
  return { promptCache };
}

/** Pretty-print `value` so its continuation lines sit at `indent`. */
function formatJsonValue(value: unknown, indent: string, unit: string, eol: string): string {
  const raw = JSON.stringify(value, null, unit);
  return raw.split("\n").map((line, index) => (index === 0 ? line : indent + line)).join(eol);
}

/**
 * Insert `"key": value` as the last direct member of the object spanning
 * `brace`..`end` (offsets valid in both `text` and its comment-stripped form).
 * Comments and formatting elsewhere are untouched.
 */
export function insertJsonProperty(text: string, brace: number, end: number, key: string, value: unknown): string {
  const clean = stripJsoncComments(text);
  if (clean[brace] !== "{" || clean[end] !== "}") throw new Error("invalid object span");
  const outerIndent = lineIndentOf(text, brace);
  const innerIndent = deriveInnerIndent(text, brace, end);
  const unit = innerIndent.startsWith(outerIndent) && innerIndent.length > outerIndent.length
    ? innerIndent.slice(outerIndent.length)
    : "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const property = `${JSON.stringify(key)}: ${formatJsonValue(value, innerIndent, unit, eol)}`;

  let last = end - 1;
  while (last > brace && isJsonWhitespace(clean[last])) last--;
  if (last === brace) {
    // Empty object. Keep any comment inside it, and put the closing brace on
    // its own line when the object held only whitespace.
    if (text.slice(brace + 1, end).trim() === "") {
      return `${text.slice(0, brace + 1)}${eol}${innerIndent}${property}${eol}${outerIndent}${text.slice(end)}`;
    }
    return `${text.slice(0, brace + 1)}${eol}${innerIndent}${property}${text.slice(brace + 1)}`;
  }

  const needsComma = clean[last] !== ",";
  // A trailing line comment on the last member stays on that member's line.
  let insertAt = last + 1;
  // Only a line comment qualifies: a block comment can span the newline, and
  // inserting there would put the property inside the comment.
  let newline = text.indexOf("\n", last + 1);
  if (newline > 0 && text[newline - 1] === "\r") newline--;
  if (newline >= 0 && newline < end && clean.slice(last + 1, newline).trim() === "" && !text.slice(last + 1, newline).includes("/*")) {
    insertAt = newline;
  }
  const insertion = `${eol}${innerIndent}${property}`;
  if (!needsComma) return text.slice(0, insertAt) + insertion + text.slice(insertAt);
  return text.slice(0, last + 1) + "," + text.slice(last + 1, insertAt) + insertion + text.slice(insertAt);
}

function objectSpanForKey(clean: string, parentBrace: number, parentEnd: number, key: string): { brace: number; end: number } | "absent" | "ambiguous" {
  const property = findJsonObjectKey(clean, parentBrace, key);
  if (!property || property.keyStart >= parentEnd) return "absent";
  if (property.count !== 1) return "ambiguous";
  const brace = skipJsonWhitespace(clean, property.valueStart);
  if (clean[brace] !== "{") return "ambiguous";
  const end = findMatchingBracket(clean, brace);
  if (end === undefined || end > parentEnd) return "ambiguous";
  return { brace, end };
}

function hasDirectKey(clean: string, brace: number, end: number, key: string): boolean {
  const property = findJsonObjectKey(clean, brace, key);
  return property !== undefined && property.keyStart < end;
}

/** Read the promptCache value at a receipt target, `undefined` when absent. */
export function readTargetPromptCache(parsed: unknown, provider: string, modelId: string, placement: PromptCachePlacement): unknown {
  const providerRecord = asRecord(asRecord(asRecord(parsed)?.providers)?.[provider]);
  if (!providerRecord) return undefined;
  if (placement === "modelOverride") {
    return asRecord(asRecord(providerRecord.modelOverrides)?.[modelId])?.promptCache;
  }
  const models = Array.isArray(providerRecord.models) ? providerRecord.models : [];
  const matches = models.filter((entry) => asRecord(entry)?.id === modelId);
  return asRecord(matches[matches.length - 1])?.promptCache;
}

/**
 * Remove exactly what the plan added from a parsed copy of the modified file:
 * the promptCache property, plus any modelOverrides entry or object the plan
 * created. The result must equal the parsed original.
 */
function revertPlanInParsed(parsed: unknown, provider: string, modelId: string, plan: Pick<PromptCacheFixPlan, "placement" | "targetExistedBefore">, createdOverrides: boolean): unknown {
  const clone = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  const providerRecord = asRecord(asRecord(clone.providers)?.[provider]);
  if (!providerRecord) return clone;
  if (plan.placement === "model") {
    const models = Array.isArray(providerRecord.models) ? providerRecord.models : [];
    const matches = models.filter((entry) => asRecord(entry)?.id === modelId);
    const target = asRecord(matches[matches.length - 1]);
    if (target) delete target.promptCache;
    return clone;
  }
  const overrides = asRecord(providerRecord.modelOverrides);
  if (!overrides) return clone;
  if (!plan.targetExistedBefore) {
    delete overrides[modelId];
    if (createdOverrides) delete providerRecord.modelOverrides;
  } else {
    const entry = asRecord(overrides[modelId]);
    if (entry) delete entry.promptCache;
  }
  return clone;
}

/**
 * Plan the models.json edit. Custom models defined under `models[]` get the
 * property on their own object; other models (built-in or proxied) get it on
 * `providers[provider].modelOverrides[modelId]`. A provider with no
 * models.json entry is refused, because creating one could change how Pi
 * loads that provider.
 */
export function planPromptCacheFix(
  originalText: string,
  provider: string,
  modelId: string,
  promptCache: PromptCacheLifetimes,
): PromptCacheFixPlan | { error: string } {
  let parsedOriginal: unknown;
  try {
    parsedOriginal = parseJsonc(originalText);
  } catch {
    return { error: "models.json is not valid JSONC" };
  }
  if (!isValidModelsConfigForEffectiveCompat(parsedOriginal)) {
    return { error: "models.json does not match Pi's model configuration schema" };
  }
  const clean = stripJsoncComments(originalText);

  let plan: PromptCacheFixPlan | undefined;
  let createdOverrides = false;
  const modelLocation = locateModelInJsonc(originalText, provider, modelId);
  if (modelLocation && modelLocation.modelObjectBrace >= 0) {
    if (modelLocation.providerKeyCount !== 1 || modelLocation.allModelIds.filter((id) => id === modelId).length !== 1) {
      return { error: `models.json defines ${provider}/${modelId} more than once` };
    }
    if (hasDirectKey(clean, modelLocation.modelObjectBrace, modelLocation.modelObjectEnd, "promptCache")) {
      return { error: "the model entry already has a promptCache object; edit it manually" };
    }
    plan = {
      modifiedText: insertJsonProperty(originalText, modelLocation.modelObjectBrace, modelLocation.modelObjectEnd, "promptCache", promptCache),
      placement: "model",
      targetExistedBefore: true,
      promptCache,
      locationLabel: `providers[${JSON.stringify(provider)}].models[id=${JSON.stringify(modelId)}].promptCache`,
    };
  } else {
    const overrideLocation = locateModelOverrideInJsonc(originalText, provider, modelId);
    if (!overrideLocation) {
      return { error: `models.json has no single "${provider}" provider entry to hold a modelOverrides entry` };
    }
    if (overrideLocation.providerKeyCount !== 1 || overrideLocation.modelOverridesKeyCount > 1 || overrideLocation.modelOverrideKeyCount > 1) {
      return { error: "the provider's modelOverrides entry is ambiguous (duplicate keys)" };
    }
    const locationLabel = `providers[${JSON.stringify(provider)}].modelOverrides[${JSON.stringify(modelId)}].promptCache`;
    if (overrideLocation.modelOverrideObjectBrace >= 0) {
      if (hasDirectKey(clean, overrideLocation.modelOverrideObjectBrace, overrideLocation.modelOverrideObjectEnd, "promptCache")) {
        return { error: "the modelOverrides entry already has a promptCache object; edit it manually" };
      }
      plan = {
        modifiedText: insertJsonProperty(originalText, overrideLocation.modelOverrideObjectBrace, overrideLocation.modelOverrideObjectEnd, "promptCache", promptCache),
        placement: "modelOverride",
        targetExistedBefore: true,
        promptCache,
        locationLabel,
      };
    } else if (overrideLocation.modelOverridesObjectBrace >= 0) {
      plan = {
        modifiedText: insertJsonProperty(originalText, overrideLocation.modelOverridesObjectBrace, overrideLocation.modelOverridesObjectEnd, modelId, { promptCache }),
        placement: "modelOverride",
        targetExistedBefore: false,
        promptCache,
        locationLabel,
      };
    } else {
      const overrides = objectSpanForKey(clean, overrideLocation.providerObjectBrace, overrideLocation.providerObjectEnd, "modelOverrides");
      if (overrides !== "absent") return { error: "the provider's modelOverrides value is not a single object" };
      createdOverrides = true;
      plan = {
        modifiedText: insertJsonProperty(originalText, overrideLocation.providerObjectBrace, overrideLocation.providerObjectEnd, "modelOverrides", { [modelId]: { promptCache } }),
        placement: "modelOverride",
        targetExistedBefore: false,
        promptCache,
        locationLabel,
      };
    }
  }

  const checkError = selfCheckPromptCacheFix(originalText, plan, provider, modelId, createdOverrides);
  if (checkError) return { error: `self-check failed: ${checkError}` };
  return plan;
}

export function selfCheckPromptCacheFix(
  originalText: string,
  plan: PromptCacheFixPlan,
  provider: string,
  modelId: string,
  createdOverrides: boolean,
): string | null {
  let original: unknown;
  let modified: unknown;
  try {
    original = parseJsonc(originalText);
    modified = parseJsonc(plan.modifiedText);
  } catch {
    return "the edited file is not valid JSONC";
  }
  if (!isValidModelsConfigForEffectiveCompat(modified)) return "the edited file does not match Pi's model configuration schema";
  if (!samePromptCacheLifetimes(readTargetPromptCache(modified, provider, modelId, plan.placement), plan.promptCache)) {
    return "promptCache was not written at the target";
  }
  const reverted = revertPlanInParsed(modified, provider, modelId, plan, createdOverrides);
  if (JSON.stringify(reverted) !== JSON.stringify(original)) return "unrelated configuration was altered";
  return null;
}

/** Validate a file written by the fix transaction (same checks, re-read from disk). */
export function validateWrittenPromptCacheFix(writtenText: string, plan: PromptCacheFixPlan): string | null {
  if (writtenText !== plan.modifiedText) return "models.json content differs from the previewed edit";
  try {
    parseJsonc(writtenText);
  } catch {
    return "the written file is not valid JSONC";
  }
  return null;
}
