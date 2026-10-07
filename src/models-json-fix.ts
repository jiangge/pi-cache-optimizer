import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type FileIdentity, atomicReplaceTextFilePreservingMode, atomicRestoreFileFromBackup, backupTimestamp, hashText, readRegularTextFile, sameFileIdentity, uniqueTempPath, validateAtomicTarget, withModelsJsonTransactionLock, writeFileExclusiveDurable } from "./atomic-fs.ts";
import { LOG_PREFIX, type PiModel, asRecord, getErrorCode } from "./common.ts";
import { findLastExactModelDefinition, resolveEffectiveCompatFromConfig } from "./compat-config.ts";
import { type FixReceiptCompatChange, type FixReceiptPlacement, type ModelsJsonFixReceiptV1, RECEIPT_COMPAT_KEYS, type ReceiptScalar, type ReceiptScalarState, isReceiptTimestamp, isSafeReceiptText, isSha256 } from "./fix-types.ts";
import { type JsonPropertyEdit, type ModelNodeLocation, deepEqualIgnoringKeys, deriveInnerIndent, findExistingCompatKeysInJsonc, findJsonObjectKey, findMatchingBracket, isJsonWhitespace, lineIndentOf, locateJsonPropertyValueSpan, locateModelOverrideInJsonc, locateProviderCompatInJsonc, parseJsonc, readJsonStringLiteral, skipJsonValue, skipJsonWhitespace, stripJsoncComments } from "./jsonc.ts";
import { isAdaptiveGenerationModel, isKimiCodingAdaptiveModel } from "./model-detect.ts";
import { FIX_RECEIPT_PATH, MODELS_JSON_PATH } from "./paths.ts";

export type ExplicitCompatSource = "modelOverride" | "model" | "provider";

export interface ExplicitCompatValue {
  source: ExplicitCompatSource;
  value: unknown;
}

/**
 * Resolve one explicitly configured compat value using Pi's models.json
 * precedence. Built-in model overrides win over custom model definitions,
 * which in turn win over provider defaults.
 */
export function resolveExplicitCompatValue(
  config: unknown,
  providerLabel: string,
  modelId: string,
  compatKey: string,
): ExplicitCompatValue | undefined {
  const providers = asRecord(asRecord(config)?.providers);
  const provider = asRecord(providers?.[providerLabel]);
  if (!provider) return undefined;

  const override = asRecord(asRecord(provider.modelOverrides)?.[modelId]);
  const overrideCompat = asRecord(override?.compat);
  if (overrideCompat && Object.prototype.hasOwnProperty.call(overrideCompat, compatKey)) {
    return { source: "modelOverride", value: overrideCompat[compatKey] };
  }

  const model = findLastExactModelDefinition(
    Array.isArray(provider.models) ? provider.models : undefined,
    modelId,
  );
  const modelCompat = asRecord(model?.compat);
  if (modelCompat && Object.prototype.hasOwnProperty.call(modelCompat, compatKey)) {
    return { source: "model", value: modelCompat[compatKey] };
  }

  const providerCompat = asRecord(provider.compat);
  if (providerCompat && Object.prototype.hasOwnProperty.call(providerCompat, compatKey)) {
    return { source: "provider", value: providerCompat[compatKey] };
  }

  return undefined;
}

export function hasExplicitLongRetentionOptInFromConfig(
  config: unknown,
  providerLabel: string,
  modelId: string,
): boolean {
  return resolveExplicitCompatValue(
    config,
    providerLabel,
    modelId,
    "supportsLongCacheRetention",
  )?.value === true;
}

/**
 * Locate the provider + model entry in raw JSONC text.
 * Returns the positions needed for surgical insertion, or undefined on failure.
 *
 * This is a scan-only pass — no AST build, no regex reliance.
 */
export function locateModelInJsonc(
  text: string,
  providerLabel: string,
  modelId: string,
): ModelNodeLocation | undefined {
  // Clean text of comments first for reliable structural scanning
  const clean = stripJsoncComments(text);

  // Strategy: find `"providers"` as a direct root key, then find the
  // provider key under it, then the provider's direct `"models"` key.
  // All object/value traversal uses the string-aware primitives above so
  // braces, brackets, comment markers, or escaped quotes inside strings do
  // not corrupt offsets.
  const rootBrace = skipJsonWhitespace(clean, 0);
  if (clean[rootBrace] !== "{") return undefined;

  const providersKey = findJsonObjectKey(clean, rootBrace, "providers");
  if (!providersKey || providersKey.count !== 1) return undefined;
  const providersBrace = skipJsonWhitespace(clean, providersKey.valueStart);
  if (clean[providersBrace] !== "{") return undefined;
  const providersEnd = findMatchingBracket(clean, providersBrace);
  if (providersEnd === undefined) return undefined;

  const providerKey = findJsonObjectKey(clean, providersBrace, providerLabel);
  if (!providerKey || providerKey.count !== 1 || providerKey.keyStart > providersEnd) return undefined;
  const providerBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerBrace] !== "{") return undefined;
  const providerEndBrace = findMatchingBracket(clean, providerBrace);
  if (providerEndBrace === undefined || providerEndBrace > providersEnd) return undefined;

  // Provider-level compat is a direct provider child only. Nested model
  // compat objects are intentionally skipped whole by findJsonObjectKey.
  let providerCompatBrace = -1;
  let providerCompatEnd = -1;
  const providerCompatKey = findJsonObjectKey(clean, providerBrace, "compat");
  const providerCompatKeyCount = providerCompatKey?.count ?? 0;
  if (providerCompatKey?.count && providerCompatKey.count > 1) return undefined;
  if (providerCompatKey && providerCompatKey.keyStart < providerEndBrace) {
    const brace = skipJsonWhitespace(clean, providerCompatKey.valueStart);
    if (clean[brace] !== "{") return undefined;
    const end = findMatchingBracket(clean, brace);
    if (end === undefined || end > providerEndBrace) return undefined;
    providerCompatBrace = brace;
    providerCompatEnd = end;
  }

  const modelOverridesKey = findJsonObjectKey(clean, providerBrace, "modelOverrides");
  if (modelOverridesKey?.count && modelOverridesKey.count > 1) return undefined;
  if (modelOverridesKey) {
    const modelOverridesBrace = skipJsonWhitespace(clean, modelOverridesKey.valueStart);
    if (clean[modelOverridesBrace] !== "{") return undefined;
    const modelOverridesEnd = findMatchingBracket(clean, modelOverridesBrace);
    if (modelOverridesEnd === undefined || modelOverridesEnd > providerEndBrace) return undefined;
    const overrideKey = findJsonObjectKey(clean, modelOverridesBrace, modelId);
    if (overrideKey?.count && overrideKey.count > 1) return undefined;
    if (overrideKey) {
      const overrideBrace = skipJsonWhitespace(clean, overrideKey.valueStart);
      if (clean[overrideBrace] !== "{") return undefined;
      const overrideEnd = findMatchingBracket(clean, overrideBrace);
      if (overrideEnd === undefined || overrideEnd > modelOverridesEnd) return undefined;
      const overrideCompatKey = findJsonObjectKey(clean, overrideBrace, "compat");
      if (overrideCompatKey?.count && overrideCompatKey.count > 1) return undefined;
    }
  }

  const overrideLocation = locateModelOverrideInJsonc(text, providerLabel, modelId);
  const modelOverrideObjectBrace = overrideLocation?.modelOverrideObjectBrace ?? -1;
  const modelOverrideObjectEnd = overrideLocation?.modelOverrideObjectEnd ?? -1;
  const modelOverrideCompatBrace = overrideLocation?.modelOverrideCompatBrace ?? -1;
  const modelOverrideCompatEnd = overrideLocation?.modelOverrideCompatEnd ?? -1;

  const modelsKey = findJsonObjectKey(clean, providerBrace, "models");
  if (!modelsKey || modelsKey.count !== 1 || modelsKey.keyStart > providerEndBrace) return undefined;

  let modelsScan = skipJsonWhitespace(clean, modelsKey.valueStart);
  if (clean[modelsScan] !== "[") return undefined;
  const modelsEnd = findMatchingBracket(clean, modelsScan);
  if (modelsEnd === undefined || modelsEnd > providerEndBrace) return undefined;
  modelsScan++; // Skip `[`

  // Scan ALL array elements: collect every model id, and record the target's position
  const allModelIds: string[] = [];
  let modelBrace = -1;
  let modelEndBrace = -1;
  let compatKeyStartClean = -1;
  let compatBrace = -1;
  let compatEndBrace = -1;
  let modelCompatKeyCount = 0;

  while (modelsScan < modelsEnd) {
    modelsScan = skipJsonWhitespace(clean, modelsScan);
    if (clean[modelsScan] === ',') {
      modelsScan++;
      continue;
    }
    if (modelsScan >= modelsEnd || clean[modelsScan] === ']') break;
    if (clean[modelsScan] !== '{') return undefined;

    const elementBrace = modelsScan;
    const elementEnd = findMatchingBracket(clean, elementBrace);
    if (elementEnd === undefined || elementEnd > modelsEnd) return undefined;

    const idKey = findJsonObjectKey(clean, elementBrace, "id");
    if (idKey?.count && idKey.count > 1) return undefined;
    let elementId: string | undefined;
    if (idKey && idKey.keyStart < elementEnd) {
      const idValueStart = skipJsonWhitespace(clean, idKey.valueStart);
      const idLiteral = readJsonStringLiteral(clean, idValueStart);
      if (idLiteral && idLiteral.end <= elementEnd) {
        elementId = idLiteral.value;
      }
    }

    if (elementId !== undefined) {
      allModelIds.push(elementId);
    }

    if (elementId === modelId) {
      // Match Pi's provider composer: later duplicate definitions replace
      // earlier ones. The effective/fix target is therefore the last exact id.
      modelBrace = elementBrace;
      modelEndBrace = elementEnd;
      compatKeyStartClean = -1;
      compatBrace = -1;
      compatEndBrace = -1;

      const compatKey = findJsonObjectKey(clean, modelBrace, "compat");
      modelCompatKeyCount = compatKey?.count ?? 0;
      if (compatKey?.count && compatKey.count > 1) return undefined;
      if (compatKey && compatKey.keyStart < modelEndBrace) {
        compatKeyStartClean = compatKey.keyStart;
        const brace = skipJsonWhitespace(clean, compatKey.valueStart);
        if (clean[brace] !== "{") return undefined;
        const end = findMatchingBracket(clean, brace);
        if (end === undefined || end > modelEndBrace) return undefined;
        compatBrace = brace;
        compatEndBrace = end;
      }
    }

    modelsScan = elementEnd + 1;
  }

  if (modelBrace < 0 || modelEndBrace < 0) return undefined;

  // Derive indentation from the model object's opening `{` line in original text
  // Look backwards to find the line start
  let lineStart = text.lastIndexOf('\n', modelBrace);
  if (lineStart < 0) lineStart = 0;
  const lineBefore = text.slice(lineStart, modelBrace);
  const indentMatch = lineBefore.match(/^(\s*)/);
  const baseIndent = indentMatch ? indentMatch[1] : '  ';
  const indent = baseIndent + '  '; // +2 for one level deeper

  return {
    modelObjectBrace: modelBrace,
    modelObjectEnd: modelEndBrace,
    compatKeyStart: compatKeyStartClean >= 0 ? compatKeyStartClean : -1,
    compatObjectBrace: compatBrace,
    compatObjectEnd: compatEndBrace,
    indent,
    providerObjectBrace: providerBrace,
    providerObjectEnd: providerEndBrace,
    providerCompatBrace,
    providerCompatEnd,
    modelOverrideObjectBrace,
    modelOverrideObjectEnd,
    modelOverrideCompatBrace,
    modelOverrideCompatEnd,
    providerKeyCount: providerKey.count,
    modelOverrideKeyCount: overrideLocation?.modelOverrideKeyCount ?? 0,
    modelCompatKeyCount,
    providerCompatKeyCount,
    allModelIds,
  };
}

/**
 * Scan produced by `analyzeModelsJsonForMissingEntry` when
 * `locateModelInJsonc` cannot find the target provider/model.
 */
export type MissingEntryDiagnosis =
  | { scenario: "provider_missing"; providersBrace: number; providersEnd: number }
  | { scenario: "model_missing"; modelsEnd: number; providerBrace: number; providerEndBrace: number }
  | { scenario: "provider_without_models"; providerBrace: number; providerEndBrace: number };

/**
 * Light second-pass scan that determines *why* `locateModelInJsonc` failed.
 * Returns structured diagnostic so the fix handler can compose targeted
 * guidance and an optional surgical insertion for API-logged-in models
 * (e.g. opencode go) that never appear in `models.json`.
 */
export function analyzeModelsJsonForMissingEntry(
  text: string,
  providerLabel: string,
  modelId: string,
): MissingEntryDiagnosis | undefined {
  const clean = stripJsoncComments(text);
  const rootBrace = skipJsonWhitespace(clean, 0);
  if (clean[rootBrace] !== "{") return undefined;

  const providersKey = findJsonObjectKey(clean, rootBrace, "providers");
  if (!providersKey || providersKey.count !== 1) {
    // Root has no unique "providers" key — we don't auto-create or guess
    // among duplicate definitions.
    return undefined;
  }
  const providersBrace = skipJsonWhitespace(clean, providersKey.valueStart);
  if (clean[providersBrace] !== "{") return undefined;
  const providersEnd = findMatchingBracket(clean, providersBrace);
  if (providersEnd === undefined) return undefined;

  const providerKey = findJsonObjectKey(clean, providersBrace, providerLabel);
  if (!providerKey) {
    return { scenario: "provider_missing", providersBrace, providersEnd };
  }
  if (providerKey.count !== 1 || providerKey.keyStart > providersEnd) return undefined;

  // Provider exists. Check for a models array so we know where to append.
  const providerBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerBrace] !== "{") return undefined;
  const providerEndBrace = findMatchingBracket(clean, providerBrace);
  if (providerEndBrace === undefined || providerEndBrace > providersEnd) return undefined;

  const modelsKey = findJsonObjectKey(clean, providerBrace, "models");
  if (modelsKey?.count && modelsKey.count > 1) return undefined;
  if (modelsKey && modelsKey.keyStart < providerEndBrace) {
    const mScan = skipJsonWhitespace(clean, modelsKey.valueStart);
    if (clean[mScan] !== "[") return undefined;
    const modelsEnd = findMatchingBracket(clean, mScan);
    if (modelsEnd === undefined || modelsEnd > providerEndBrace) return undefined;

    // Confirm that the target really is absent before offering an insertion.
    // This second pass also refuses malformed/ambiguous existing entries, so
    // a scanner failure can never turn into a duplicate model definition.
    let modelScan = mScan + 1;
    let targetFound = false;
    while (modelScan < modelsEnd) {
      modelScan = skipJsonWhitespace(clean, modelScan);
      if (clean[modelScan] === ",") {
        modelScan++;
        continue;
      }
      if (modelScan >= modelsEnd || clean[modelScan] === "]") break;
      if (clean[modelScan] !== "{") return undefined;
      const elementEnd = findMatchingBracket(clean, modelScan);
      if (elementEnd === undefined || elementEnd > modelsEnd) return undefined;
      const idKey = findJsonObjectKey(clean, modelScan, "id");
      if (!idKey || idKey.count !== 1) return undefined;
      const idStart = skipJsonWhitespace(clean, idKey.valueStart);
      const idLiteral = readJsonStringLiteral(clean, idStart);
      if (!idLiteral || idLiteral.end > elementEnd) return undefined;
      if (idLiteral.value === modelId) {
        targetFound = true;
        const compatKey = findJsonObjectKey(clean, modelScan, "compat");
        if (compatKey?.count && compatKey.count > 1) return undefined;
      }
      modelScan = elementEnd + 1;
    }
    if (targetFound) return undefined;
    return { scenario: "model_missing", modelsEnd, providerBrace, providerEndBrace };
  }

  // Provider exists, but there's no discoverable models array — treat as
  // a provider that needs one.
  return { scenario: "provider_without_models", providerBrace, providerEndBrace };
}

/**
 * Build a copyable manual-edit snippet for the missing entry. Used when the
 * terminal is non-interactive or the user chooses to edit by hand.
 * Returns a complete provider→model→compat JSON block that the user can
 * paste into `models.json` under `providers`.
 */
export function formatMissingEntryManualSnippet(
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
): string {
  const lines: string[] = [];
  const sorted = Object.entries(compatKeys).sort(([a], [b]) => a.localeCompare(b));
  const compatItems = sorted.map(([k, v]) => `          ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  lines.push(`${JSON.stringify(providerLabel)}: {`);
  lines.push(`    "modelOverrides": {`);
  lines.push(`      ${JSON.stringify(modelId)}: {`);
  lines.push(`        "compat": {`);
  lines.push(compatItems.join(",\n"));
  lines.push(`        }`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`  }`);
  return lines.join("\n");
}

/**
 * Insert or repair a modelOverrides entry without creating a custom models[]
 * definition. This is the safest representation for built-in/API-login models
 * and has the same highest precedence Pi applies at runtime.
 */
export function composeModelOverrideInsertion(
  originalText: string,
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
): { modifiedText: string; placementLabel: string } | undefined {
  const location = locateModelOverrideInJsonc(originalText, providerLabel, modelId);

  if (location?.modelOverrideObjectBrace !== undefined && location.modelOverrideObjectBrace >= 0) {
    const modelLocation: ModelNodeLocation = {
      providerKeyCount: location.providerKeyCount,
      modelObjectBrace: -1,
      modelObjectEnd: -1,
      compatKeyStart: -1,
      compatObjectBrace: -1,
      compatObjectEnd: -1,
      indent: "",
      providerObjectBrace: location.providerObjectBrace,
      providerObjectEnd: location.providerObjectEnd,
      providerCompatBrace: -1,
      providerCompatEnd: -1,
      modelOverrideObjectBrace: location.modelOverrideObjectBrace,
      modelOverrideObjectEnd: location.modelOverrideObjectEnd,
      modelOverrideCompatBrace: location.modelOverrideCompatBrace,
      modelOverrideCompatEnd: location.modelOverrideCompatEnd,
      modelOverrideKeyCount: location.modelOverrideKeyCount,
      modelCompatKeyCount: 0,
      providerCompatKeyCount: 0,
      allModelIds: [],
    };
    return {
      modifiedText: composeFixInsertion(originalText, modelLocation, compatKeys, "modelOverride"),
      placementLabel: `providers["${providerLabel}"] -> modelOverrides["${modelId}"] -> compat`,
    };
  }

  const sortedEntries = Object.entries(compatKeys).sort(([a], [b]) => a.localeCompare(b));
  const formatOverrideEntry = (keyIndent: string, unit: string): string => {
    const propertyIndent = keyIndent + unit;
    const compatIndent = propertyIndent + unit;
    const compatLines = sortedEntries
      .map(([key, value]) => `${compatIndent}${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(",\n");
    return `${keyIndent}${JSON.stringify(modelId)}: {\n` +
      `${propertyIndent}"compat": {\n${compatLines}\n${propertyIndent}}\n${keyIndent}}`;
  };
  const previousTokenNeedsComma = (clean: string, closeBrace: number): boolean => {
    let pos = closeBrace - 1;
    while (pos >= 0 && isJsonWhitespace(clean[pos])) pos--;
    return clean[pos] !== "{" && clean[pos] !== ",";
  };

  if (location) {
    const clean = stripJsoncComments(originalText);
    if (location.modelOverridesObjectBrace >= 0) {
      const containerIndent = lineIndentOf(originalText, location.modelOverridesObjectBrace);
      const keyIndent = deriveInnerIndent(
        originalText,
        location.modelOverridesObjectBrace,
        location.modelOverridesObjectEnd,
      );
      const unit = keyIndent.length > containerIndent.length
        ? keyIndent.slice(containerIndent.length)
        : "  ";
      const comma = previousTokenNeedsComma(clean, location.modelOverridesObjectEnd) ? "," : "";
      const insertion = `${comma}\n${formatOverrideEntry(keyIndent, unit)}\n${containerIndent}`;
      return {
        modifiedText: originalText.slice(0, location.modelOverridesObjectEnd) + insertion + originalText.slice(location.modelOverridesObjectEnd),
        placementLabel: `providers["${providerLabel}"] -> modelOverrides -> (new entry "${modelId}")`,
      };
    }

    const providerIndent = lineIndentOf(originalText, location.providerObjectBrace);
    const propertyIndent = deriveInnerIndent(originalText, location.providerObjectBrace, location.providerObjectEnd);
    const unit = propertyIndent.length > providerIndent.length
      ? propertyIndent.slice(providerIndent.length)
      : "  ";
    const entryIndent = propertyIndent + unit;
    const block = `\n${propertyIndent}"modelOverrides": {\n` +
      `${formatOverrideEntry(entryIndent, unit)}\n${propertyIndent}},`;
    return {
      modifiedText: originalText.slice(0, location.providerObjectBrace + 1) + block + originalText.slice(location.providerObjectBrace + 1),
      placementLabel: `providers["${providerLabel}"] -> (new modelOverrides entry "${modelId}")`,
    };
  }

  const diagnosis = analyzeModelsJsonForMissingEntry(originalText, providerLabel, modelId);
  if (!diagnosis || diagnosis.scenario !== "provider_missing") return undefined;
  const clean = stripJsoncComments(originalText);
  const providersIndent = lineIndentOf(originalText, diagnosis.providersEnd);
  const providerIndent = deriveInnerIndent(originalText, diagnosis.providersBrace, diagnosis.providersEnd);
  const unit = providerIndent.length > providersIndent.length
    ? providerIndent.slice(providersIndent.length)
    : "  ";
  const overridesIndent = providerIndent + unit;
  const entryIndent = overridesIndent + unit;
  const comma = previousTokenNeedsComma(clean, diagnosis.providersEnd) ? "," : "";
  const block = `${comma}\n${providerIndent}${JSON.stringify(providerLabel)}: {\n` +
    `${overridesIndent}"modelOverrides": {\n${formatOverrideEntry(entryIndent, unit)}\n` +
    `${overridesIndent}}\n${providerIndent}}\n${providersIndent}`;
  return {
    modifiedText: originalText.slice(0, diagnosis.providersEnd) + block + originalText.slice(diagnosis.providersEnd),
    placementLabel: `providers -> (new modelOverrides-only entry "${providerLabel}/${modelId}")`,
  };
}

/**
 * Surgically insert the missing provider/model entry into the original
 * JSONC text. Returns the modified text and placement descriptor.
 *
 * Handles three scenarios:
 * - `model_missing`: append a new model object to the provider's `models` array.
 * - `provider_missing`: append a new provider block to the root `providers` object.
 * - `provider_without_models`: inject a `"models": [...]` key into the existing provider.
 */
export function composeMissingEntryInsertion(
  originalText: string,
  diagnosis: MissingEntryDiagnosis,
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
): { modifiedText: string; placementLabel: string } {
  // Comments preserve length when stripped (`stripJsoncComments` replaces
  // comment bytes 1-for-1 with spaces), so offsets derived from the
  // comment-stripped text map cleanly back to the original. However,
  // `lastIndexOf("{", pos)` / `lastIndexOf("[", pos)` must NOT be run
  // against the raw original: a comment like `// add [more] here with a {
  // brace` would surface `[` / `{` bytes that have no structural meaning,
  // contaminating the `hasExisting`/`hasExistingElements` decision below
  // and producing a stray leading comma. Run the structural searches
  // against the comment-stripped version; keep the indentation lookups
  // (which only care about newlines + leading whitespace) on the
  // original since comments never contain forward-scan-relevant bytes.
  const cleanText = stripJsoncComments(originalText);

  // Resolve a sensible indentation step from an arbitrary byte offset in
  // the original file.
  const indentUnitAt = (offset: number): string => {
    const ls = originalText.lastIndexOf("\n", offset);
    const line = originalText.slice(ls < 0 ? 0 : ls + 1, offset);
    const m = line.match(/^(\s+)/);
    return m ? m[1] : "  ";
  };

  // Figure out the base indent from the insertion point's own line.
  // Then derive inner indents (+1 and +2 levels).
  const sorted = Object.entries(compatKeys).sort(([a], [b]) => a.localeCompare(b));
  const formatCompactCompat = (indent: string): string => {
    // Single-line compact when there's only one key, multi-line otherwise.
    if (sorted.length === 1) {
      const [k, v] = sorted[0];
      return `{ ${JSON.stringify(k)}: ${JSON.stringify(v)} }`;
    }
    return (
      "{\n" +
      sorted.map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") +
      "\n" +
      indent.slice(0, -2) +
      "}"
    );
  };

  if (diagnosis.scenario === "model_missing") {
    // Append to the provider's models array, right before `]`.
    const unit = indentUnitAt(diagnosis.modelsEnd);
    const inner0 = unit + unit; // indent of model object's own keys
    const inner1 = inner0 + unit; // indent of compat keys inside the model
    const inner2 = inner1 + unit; // indent of compat values

    // Determine whether the array is empty (need to skip the leading comma).
    // Search for the models `[` on the comment-stripped text so a `[` inside
    // a comment cannot be mistaken for the array opener.
    const arrayInterior = cleanText.slice(
      cleanText.lastIndexOf("[", diagnosis.modelsEnd) + 1,
      diagnosis.modelsEnd,
    ).trim();
    const hasExistingElements = arrayInterior.length > 0;

    const compatBlock = formatCompactCompat(inner2);
    const modelBlock = [
      hasExistingElements ? "," : "",
      inner0 + "{",
      inner1 + `"id": ${JSON.stringify(modelId)},`,
      inner1 + `"compat": ` + compatBlock,
      inner0 + "}",
      unit,
    ].filter(Boolean).join("\n");

    const insertionPoint = diagnosis.modelsEnd;
    const prefix = originalText.slice(0, insertionPoint);
    const suffix = originalText.slice(insertionPoint); // starts with `]`
    return {
      modifiedText: prefix + modelBlock + suffix,
      placementLabel: `providers["${providerLabel}"] -> models -> (new entry for "${modelId}")`,
    };
  }

  if (diagnosis.scenario === "provider_missing") {
    // Append a new provider entry to the root `providers` object, right
    // before its closing `}`.
    const unit = indentUnitAt(diagnosis.providersEnd);
    const inner0 = unit + unit;
    const inner1 = inner0 + unit;
    const inner2 = inner1 + unit;
    const inner3 = inner2 + unit;

    const compatBlock = formatCompactCompat(inner3);
    // Search for the providers `{` on the comment-stripped text so a `{`
    // inside a comment cannot be mistaken for the providers object opener.
    const providersInterior = cleanText.slice(
      cleanText.lastIndexOf("{", diagnosis.providersEnd) + 1,
      diagnosis.providersEnd,
    ).trim();
    const hasExisting = providersInterior.length > 0;

    const providerBlock = [
      hasExisting ? "," : "",
      inner0 + `"${providerLabel}": {`,
      inner1 + `"models": [`,
      inner2 + "{",
      inner3 + `"id": ${JSON.stringify(modelId)},`,
      inner3 + `"compat": ` + compatBlock,
      inner2 + "}",
      inner1 + "]",
      inner0 + "}",
      unit,
    ].filter(Boolean).join("\n");

    const insertionPoint = diagnosis.providersEnd;
    const prefix = originalText.slice(0, insertionPoint);
    const suffix = originalText.slice(insertionPoint);
    return {
      modifiedText: prefix + providerBlock + suffix,
      placementLabel: `providers -> (new entry "${providerLabel}")`,
    };
  }

  // `provider_without_models`: inject a models array key into the
  // existing provider block, right after the provider's opening `{`.
  const unit = indentUnitAt(diagnosis.providerBrace);
  const inner0 = unit + unit;
  const inner1 = inner0 + unit;
  const inner2 = inner1 + unit;

  const compatBlock = formatCompactCompat(inner2);
  const afterBrace = diagnosis.providerBrace + 1;
  const modelsBlock = [
    "",
    inner0 + `"models": [`,
    inner1 + "{",
    inner2 + `"id": ${JSON.stringify(modelId)},`,
    inner2 + `"compat": ` + compatBlock,
    inner1 + "}",
    inner0 + "],",
    unit,
  ].join("\n");

  return {
    modifiedText: originalText.slice(0, afterBrace) + modelsBlock + originalText.slice(afterBrace),
    placementLabel: `providers["${providerLabel}"] -> (new "models" array with "${modelId}")`,
  };
}

/**
 * Lightweight self-check for a newly inserted model or modelOverrides entry.
 * Parses the modified text as JSONC and confirms:
 *   1. The target exists under models[] or modelOverrides.
 *   2. Every compat key has the expected effective provider/model/runtime/
 *      modelOverride value.
 * Returns null on success, an error string on failure.
 */
export function selfCheckMissingEntryInsertion(
  originalText: string,
  modifiedText: string,
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
  runtimeModel?: PiModel,
): string | null {
  try {
    const origParsed = parseJsonc(originalText);
    const modParsed = parseJsonc(modifiedText);
    const providers = asRecord(asRecord(modParsed)?.providers);
    if (!providers) return "Modified file: providers object missing or invalid";
    const provider = asRecord(providers[providerLabel]);
    if (!provider) return `Modified file: provider "${providerLabel}" not found`;
    const models = provider.models;
    const targetModel = Array.isArray(models)
      ? models.find((m: unknown) => asRecord(m)?.id === modelId)
      : undefined;
    const targetOverride = asRecord(asRecord(provider.modelOverrides)?.[modelId]);
    if (!targetModel && !targetOverride) {
      return `Modified file: model or modelOverrides entry "${modelId}" not found in provider after insertion`;
    }

    const effectiveCompat = runtimeModel
      ? resolveEffectiveCompatFromConfig(runtimeModel, modParsed)
      : undefined;
    for (const [k, v] of Object.entries(compatKeys)) {
      if (effectiveCompat) {
        if (!Object.prototype.hasOwnProperty.call(effectiveCompat, k)) {
          return `Modified file: effective compat.${k} not found`;
        }
        if ((effectiveCompat as Record<string, unknown>)[k] !== v) {
          return `Modified file: effective compat.${k} wrong value: expected ${JSON.stringify(v)}, got ${JSON.stringify((effectiveCompat as Record<string, unknown>)[k])}`;
        }
        continue;
      }
      const effective = resolveExplicitCompatValue(modParsed, providerLabel, modelId, k);
      if (!effective) return `Modified file: effective compat.${k} not found`;
      if (effective.value !== v) {
        return `Modified file: effective compat.${k} wrong value: expected ${JSON.stringify(v)}, got ${JSON.stringify(effective.value)} from ${effective.source}`;
      }
    }

    // Normalize only the intended override edit back to its original shape,
    // then require the complete parsed structure to match. This catches data
    // loss while allowing legitimate shorter repairs such as false -> true.
    const normalized = JSON.parse(JSON.stringify(modParsed)) as Record<string, unknown>;
    const origProviders = asRecord(asRecord(origParsed)?.providers);
    const origProvider = asRecord(origProviders?.[providerLabel]);
    const normalizedProviders = asRecord(normalized.providers);
    if (!normalizedProviders) return "Modified file: normalized providers object missing";

    if (!origProvider) {
      delete normalizedProviders[providerLabel];
    } else if (targetOverride) {
      const normalizedProvider = asRecord(normalizedProviders[providerLabel]);
      const normalizedOverrides = asRecord(normalizedProvider?.modelOverrides);
      const origOverrides = asRecord(origProvider.modelOverrides);
      const origOverride = asRecord(origOverrides?.[modelId]);

      if (!normalizedProvider || !normalizedOverrides) {
        return `Modified file: modelOverrides["${modelId}"] missing during structure validation`;
      }
      if (!origOverride) {
        delete normalizedOverrides[modelId];
        if (!origOverrides) delete normalizedProvider.modelOverrides;
      } else {
        const normalizedOverride = asRecord(normalizedOverrides[modelId]);
        if (!normalizedOverride) return `Modified file: modelOverrides["${modelId}"] invalid`;
        const origCompat = asRecord(origOverride.compat);
        const normalizedCompat = asRecord(normalizedOverride.compat);
        if (!origCompat) {
          delete normalizedOverride.compat;
        } else {
          if (!normalizedCompat) return `Modified file: modelOverrides["${modelId}"].compat invalid`;
          for (const key of Object.keys(compatKeys)) {
            if (Object.prototype.hasOwnProperty.call(origCompat, key)) {
              normalizedCompat[key] = origCompat[key];
            } else {
              delete normalizedCompat[key];
            }
          }
        }
      }
    } else {
      // Backward-compatible validation for the legacy models[] insertion
      // helper retained in __internals_for_tests.
      const normalizedProvider = asRecord(normalizedProviders[providerLabel]);
      const normalizedModels = normalizedProvider?.models;
      const origModels = origProvider.models;
      if (!normalizedProvider || !Array.isArray(normalizedModels)) {
        return `Modified file: provider "${providerLabel}".models missing during structure validation`;
      }
      normalizedProvider.models = normalizedModels.filter(
        (entry: unknown) => asRecord(entry)?.id !== modelId,
      );
      if (!Array.isArray(origModels)) delete normalizedProvider.models;
    }

    if (!deepEqualIgnoringKeys(normalized, origParsed, [])) {
      return "Modified file: original structure was altered (data loss detected)";
    }

    const modClean = stripJsoncComments(modifiedText);
    const rootStart = skipJsonWhitespace(modClean, 0);
    const rootEnd = findMatchingBracket(modClean, rootStart);
    if (rootEnd === undefined) return "Modified file: root bracket mismatch";
    if (skipJsonWhitespace(modClean, rootEnd + 1) !== modClean.length)
      return "Modified file: trailing content after root object";

    return null;
  } catch (e) {
    return `Self-check error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Compose the fix: produce the modified text with compat keys inserted.
 *
 * Strategy:
 * - If compat object exists: replace its interior (between `{` and `}`)
 *   with new keys + existing content, preserving surrounding bytes.
 * - If compat doesn't exist: insert `"compat": { keys }` after model `{`.
 *
 * Uses the raw original text; only the inserted/compat region changes.
 */
/**
 * Compat keys that describe CHANNEL capabilities (routing, endpoint features).
 * These are always safe at the provider level because they do not change
 * per-model request semantics.
 */
export const PROVIDER_LEVEL_SAFE_COMPAT_KEYS = new Set<string>([
  "sendSessionAffinityHeaders",
  "supportsLongCacheRetention",
]);

export function syntheticModelForId(providerLabel: string, id: string): PiModel {
  return { provider: providerLabel, id, name: id } as PiModel;
}

/**
 * Decide whether the fix should write provider-level or model-level compat.
 *
 * Strategy (auto-detect, prefer provider level when safe):
 * - Channel-capability keys (session affinity / long retention) are normally
 *   provider-safe; runtime-observed model failures explicitly override this
 *   default through chooseFixPlacement(..., forceModelLevel=true).
 * - Model-behavior keys (forceAdaptiveThinking, allowEmptySignature,
 *   thinkingFormat, ...) are provider-safe ONLY when every sibling model in
 *   the provider also matches the same detection (all adaptive-generation /
 *   Kimi Coding adaptive / DeepSeek-like).
 * - Single-model providers: provider level is equivalent — prefer it.
 * - Any unsafe key → fall back to model level (single write, smallest blast radius).
 */
export function decideFixPlacement(
  compatKeys: Record<string, unknown>,
  providerLabel: string,
  allModelIds: string[],
): { placement: "provider" | "model"; reason: string } {
  const siblings = allModelIds.filter(Boolean);

  if (siblings.length <= 1) {
    return {
      placement: "provider",
      reason: "this provider has only one model — provider-level compat is equivalent and easier to maintain",
    };
  }

  const unsafeKeys: string[] = [];
  for (const key of Object.keys(compatKeys)) {
    if (PROVIDER_LEVEL_SAFE_COMPAT_KEYS.has(key)) continue;

    if (key === "forceAdaptiveThinking") {
      const allAdaptive = siblings.every((id) => {
        const sibling = syntheticModelForId(providerLabel, id);
        return isAdaptiveGenerationModel(sibling) || isKimiCodingAdaptiveModel(sibling);
      });
      if (!allAdaptive) unsafeKeys.push(key);
      continue;
    }
    if (key === "allowEmptySignature") {
      const allKimiCodingAdaptive = siblings.every((id) => isKimiCodingAdaptiveModel(syntheticModelForId(providerLabel, id)));
      if (!allKimiCodingAdaptive) unsafeKeys.push(key);
      continue;
    }
    if (key === "thinkingFormat" || key === "requiresReasoningContentOnAssistantMessages") {
      // Reasoning wire/replay behavior is model-specific. Sibling ids do not
      // prove that they use the same protocol, so never broaden this repair to
      // provider scope based on a shared DeepSeek name alone.
      unsafeKeys.push(key);
      continue;
    }
    // Unknown model-behavior key — be conservative, keep it model-scoped.
    unsafeKeys.push(key);
  }

  if (unsafeKeys.length === 0) {
    return {
      placement: "provider",
      reason: `all ${siblings.length} models in this provider are compatible with these flags`,
    };
  }
  return {
    placement: "model",
    reason: `${unsafeKeys.join(", ")} could break sibling models in this provider (${siblings.length} models total) — scoping to this model only`,
  };
}

export function chooseFixPlacement(
  original: string,
  location: ModelNodeLocation,
  compatKeys: Record<string, unknown>,
  providerLabel: string,
  forceModelLevel = false,
): { placement: "provider" | "model" | "modelOverride"; reason: string } {
  if (location.modelOverrideObjectBrace >= 0) {
    return {
      placement: "modelOverride",
      reason: "an existing modelOverrides entry has Pi's highest precedence — repairing it directly",
    };
  }

  if (forceModelLevel) {
    return {
      placement: "modelOverride",
      reason: "runtime-observed provider/model failure — using Pi's highest-precedence model override",
    };
  }

  const decision = decideFixPlacement(compatKeys, providerLabel, location.allModelIds);
  const existingModelKeys = findExistingCompatKeysInJsonc(
    original,
    location.compatObjectBrace,
    location.compatObjectEnd,
    Object.keys(compatKeys),
  );

  // Provider-level writes cannot override a model-level compat key because Pi's
  // merge order is provider.compat then model.compat. If the active model already
  // has one of the keys we need to repair (e.g. thinkingFormat: "legacy"), write
  // at model level even when the key would otherwise be provider-safe.
  if (decision.placement === "provider" && existingModelKeys.length > 0) {
    return {
      placement: "model",
      reason: `model-level compat already contains ${existingModelKeys.join(", ")} — repairing the active model override directly`,
    };
  }

  return decision;
}

export type CompatInsertionLocation = Pick<ModelNodeLocation,
  | "modelObjectBrace"
  | "compatObjectBrace"
  | "compatObjectEnd"
  | "providerObjectBrace"
  | "providerCompatBrace"
  | "providerCompatEnd"
  | "modelOverrideObjectBrace"
  | "modelOverrideCompatBrace"
  | "modelOverrideCompatEnd"
>;

export function composeProviderAffinityInsertion(
  original: string,
  providerLabel: string,
): { modifiedText: string; placementLabel: string } | undefined {
  const location = locateProviderCompatInJsonc(original, providerLabel);
  if (!location) return undefined;
  const node: CompatInsertionLocation = {
    modelObjectBrace: -1,
    compatObjectBrace: -1,
    compatObjectEnd: -1,
    providerObjectBrace: location.providerObjectBrace,
    providerCompatBrace: location.providerCompatBrace,
    providerCompatEnd: location.providerCompatEnd,
    modelOverrideObjectBrace: -1,
    modelOverrideCompatBrace: -1,
    modelOverrideCompatEnd: -1,
  };
  return {
    modifiedText: composeFixInsertion(original, node, { sendSessionAffinityHeaders: true }, "provider"),
    placementLabel: `providers["${providerLabel}"] -> compat (provider level)`,
  };
}

export function composeFixInsertion(
  original: string,
  location: CompatInsertionLocation,
  compatKeys: Record<string, unknown>,
  placement: "provider" | "model" | "modelOverride" = "model",
): string {
  // Resolve the target compat object and its container based on placement.
  const targetCompatBrace = placement === "provider"
    ? location.providerCompatBrace
    : placement === "modelOverride"
      ? location.modelOverrideCompatBrace
      : location.compatObjectBrace;
  const targetCompatEnd = placement === "provider"
    ? location.providerCompatEnd
    : placement === "modelOverride"
      ? location.modelOverrideCompatEnd
      : location.compatObjectEnd;
  const containerBrace = placement === "provider"
    ? location.providerObjectBrace
    : placement === "modelOverride"
      ? location.modelOverrideObjectBrace
      : location.modelObjectBrace;

  // Helper: format key/value pairs as lines with the given indent,
  // alphabetically sorted for stable previews and deterministic edits.
  const sortedEntries = Object.entries(compatKeys).sort(([a], [b]) => a.localeCompare(b));
  const formatEntries = (indent: string, entries: Array<[string, unknown]>): string =>
    entries
      .map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(',\n');

  // Helper: line-start indentation of the line containing `offset` in `original`.
  const lineIndentAt = (offset: number): string => {
    let ls = original.lastIndexOf('\n', offset);
    if (ls < 0) ls = -1;
    const line = original.slice(ls + 1, offset);
    const m = line.match(/^(\s*)/);
    return m ? m[1] : '';
  };

  if (targetCompatBrace >= 0 && targetCompatEnd > targetCompatBrace) {
    // ── Existing compat object: insert absent keys and surgically replace
    // direct existing keys whose value is wrong (e.g. thinkingFormat: "legacy").
    // Unrelated interior bytes/comments/key order are preserved.
    const interiorStart = targetCompatBrace + 1;
    const interior = original.slice(interiorStart, targetCompatEnd);
    const hasContent = interior.trim().length > 0;
    const clean = stripJsoncComments(original);

    // Indent for inserted key lines: copy the first existing key line's indent,
    // else derive one level deeper than the compat brace's own line.
    const braceLineIndent = lineIndentAt(targetCompatBrace);
    const innerMatch = interior.match(/\r?\n([ \t]+)\S/);
    const innerIndent = innerMatch ? innerMatch[1] : braceLineIndent + '  ';

    const edits: Array<{ start: number; end: number; text: string }> = [];
    const missingEntries: Array<[string, unknown]> = [];

    for (const [key, value] of sortedEntries) {
      const existing = findJsonObjectKey(clean, targetCompatBrace, key);
      if (existing && existing.keyStart < targetCompatEnd) {
        const valueStart = skipJsonWhitespace(clean, existing.valueStart);
        const valueEnd = skipJsonValue(clean, valueStart);
        if (valueEnd !== undefined && valueEnd <= targetCompatEnd) {
          const nextValue = JSON.stringify(value);
          if (original.slice(valueStart, valueEnd) !== nextValue) {
            edits.push({ start: valueStart, end: valueEnd, text: nextValue });
          }
          continue;
        }
      }
      missingEntries.push([key, value]);
    }

    if (missingEntries.length > 0) {
      const keysFormatted = formatEntries(innerIndent, missingEntries);
      if (hasContent) {
        edits.push({ start: interiorStart, end: interiorStart, text: `\n${keysFormatted},` });
      } else {
        edits.push({ start: interiorStart, end: targetCompatEnd, text: `\n${keysFormatted}\n${braceLineIndent}` });
      }
    }

    // Apply later edits first so earlier offsets remain valid.
    return edits
      .sort((a, b) => b.start - a.start)
      .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), original);
  }

  // ── No compat object yet: create one right after the container `{`. ──
  // Everything after the brace (including the next line's indentation) is
  // preserved byte-for-byte; we only prepend a complete `"compat": {...},` block.
  const afterBrace = containerBrace + 1;
  const suffix = original.slice(afterBrace);

  // Key indent: copy the first sibling key line's indent from the suffix,
  // else one level deeper than the container brace's line.
  const containerLineIndent = lineIndentAt(containerBrace);
  const siblingMatch = suffix.match(/^\r?\n([ \t]+)\S/);
  const keyIndent = siblingMatch ? siblingMatch[1] : containerLineIndent + '  ';

  // One more level for keys inside compat: reuse the file's own indent unit.
  const unit = keyIndent.startsWith(containerLineIndent) && keyIndent.length > containerLineIndent.length
    ? keyIndent.slice(containerLineIndent.length)
    : '  ';
  const innerIndent = keyIndent + unit;

  const compatBlock = `\n${keyIndent}"compat": {\n${formatEntries(innerIndent, sortedEntries)}\n${keyIndent}},`;
  return original.slice(0, afterBrace) + compatBlock + suffix;
}

/**
 * Self-check after compose: parse original and modified as JSONC,
 * assert target compat flags exist in the right path, and remaining structure
 * is deep-equal (ignoring the inserted keys).
 * Returns null on success, error message on failure.
 */
export function selfCheckFix(
  original: string,
  modified: string,
  providerLabel: string,
  modelId: string,
  compatKeys: Record<string, unknown>,
  placement: "provider" | "model" | "modelOverride" = "model",
  runtimeModel?: PiModel,
): string | null {
  try {
    // Step 1: Parse both versions as JSONC (comments + trailing commas allowed).
    const origParsed = parseJsonc(original);
    const modParsed = parseJsonc(modified);

    // Step 2: Validate modified file has correct structure
    const providers = asRecord(asRecord(modParsed)?.providers);
    if (!providers) {
      return "Modified file: providers object missing or invalid";
    }
    const provider = asRecord(providers[providerLabel]);
    if (!provider) {
      return `Modified file: provider "${providerLabel}" not found`;
    }

    // Step 3: Validate models array structure
    const models = provider.models;
    if (!Array.isArray(models)) {
      return `Modified file: provider "${providerLabel}".models is not an array`;
    }
    if (models.length === 0) {
      return `Modified file: provider "${providerLabel}".models is empty`;
    }

    // Step 4: Find and validate target model
    const targetModel = models.find((m: Record<string, unknown>) => m.id === modelId);
    if (!targetModel || typeof targetModel !== 'object') {
      return `Modified file: model "${modelId}" not found in provider`;
    }

    // Locate the corresponding original provider/model objects. The structure
    // preservation check below may allow repaired compat values to differ, but
    // only on these exact target/provider compat objects — never on siblings.
    const origProviders = asRecord(asRecord(origParsed)?.providers);
    const origProvider = asRecord(origProviders?.[providerLabel]);
    const origModels = Array.isArray(origProvider?.models) ? origProvider.models : undefined;
    const origTargetModel = origModels?.find((m: unknown) => asRecord(m)?.id === modelId);
    const origTargetModelRecord = asRecord(origTargetModel);
    if (!origProvider || !origTargetModelRecord) {
      return `Original file: provider/model "${providerLabel}/${modelId}" not found`;
    }

    // Step 5: Compute the EFFECTIVE merged compat using Pi's precedence:
    // provider, custom model, runtime model, then modelOverrides. The fix may
    // have written any persistent level, so validation must check what Pi will
    // actually use.
    const provCompatRaw = (provider as Record<string, unknown>).compat;
    const provCompat = (provCompatRaw && typeof provCompatRaw === 'object' && !Array.isArray(provCompatRaw))
      ? provCompatRaw as Record<string, unknown>
      : {};
    const modelCompatRaw = (targetModel as Record<string, unknown>).compat;
    if (modelCompatRaw !== undefined && (typeof modelCompatRaw !== 'object' || modelCompatRaw === null || Array.isArray(modelCompatRaw))) {
      return `Modified file: model "${modelId}" compat is not an object`;
    }
    const mdlCompat = (modelCompatRaw ?? {}) as Record<string, unknown>;
    const override = asRecord(asRecord(provider.modelOverrides)?.[modelId]);
    const overrideCompatRaw = override?.compat;
    if (overrideCompatRaw !== undefined && !asRecord(overrideCompatRaw)) {
      return `Modified file: modelOverrides["${modelId}"].compat is not an object`;
    }
    const overrideCompat = asRecord(overrideCompatRaw) ?? {};
    const mergedCompat: Record<string, unknown> = runtimeModel
      ? resolveEffectiveCompatFromConfig(runtimeModel, modParsed) as Record<string, unknown>
      : { ...provCompat, ...mdlCompat, ...overrideCompat };

    // Step 6: Validate all inserted keys are effective in the merged compat
    for (const [k, v] of Object.entries(compatKeys)) {
      if (!(k in mergedCompat)) {
        return `Modified file: compat.${k} not found at provider or model level (insertion failed)`;
      }
      if (mergedCompat[k] !== v) {
        return `Modified file: effective compat.${k} has wrong value: expected ${JSON.stringify(v)}, got ${JSON.stringify(mergedCompat[k])}`;
      }
    }

    // Step 7: Validate that the parsed document is unchanged except for the
    // explicitly requested scalar keys in the compat object we edited. A
    // one-way subset check is not sufficient here: it would accept accidental
    // additions such as credentials or unrelated provider fields.
    const editedCompatContainer = (value: Record<string, unknown>): boolean =>
      (placement === "provider" && value === origProvider) ||
      (placement === "model" && value === origTargetModelRecord) ||
      (placement === "modelOverride" && value === asRecord(asRecord(origProvider.modelOverrides)?.[modelId]));

    function sameCompatObject(
      originalCompatValue: unknown,
      modifiedCompatValue: unknown,
    ): boolean {
      const originalCompat = originalCompatValue === undefined
        ? {}
        : asRecord(originalCompatValue);
      const modifiedCompat = asRecord(modifiedCompatValue);
      if (!originalCompat || !modifiedCompat) return false;

      const allowedKeys = new Set([...Object.keys(originalCompat), ...Object.keys(compatKeys)]);
      const modifiedKeys = Object.keys(modifiedCompat);
      if (modifiedKeys.length !== allowedKeys.size || modifiedKeys.some((key) => !allowedKeys.has(key))) {
        return false;
      }

      for (const key of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(compatKeys, key)) {
          if (!Object.prototype.hasOwnProperty.call(modifiedCompat, key) || modifiedCompat[key] !== compatKeys[key]) {
            return false;
          }
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(originalCompat, key) ||
            !sameDocumentValue(originalCompat[key], modifiedCompat[key])) {
          return false;
        }
      }
      return true;
    }

    function sameDocumentValue(originalValue: unknown, modifiedValue: unknown): boolean {
      if (originalValue === modifiedValue) return true;
      if (typeof originalValue !== typeof modifiedValue || originalValue === null || modifiedValue === null) return false;
      if (Array.isArray(originalValue) || Array.isArray(modifiedValue)) {
        if (!Array.isArray(originalValue) || !Array.isArray(modifiedValue) || originalValue.length !== modifiedValue.length) return false;
        return originalValue.every((value, index) => sameDocumentValue(value, modifiedValue[index]));
      }
      if (typeof originalValue !== "object") return false;

      const originalObject = originalValue as Record<string, unknown>;
      const modifiedObject = modifiedValue as Record<string, unknown>;
      const originalKeys = Object.keys(originalObject);
      const modifiedKeys = Object.keys(modifiedObject);
      if (originalKeys.length !== modifiedKeys.length || modifiedKeys.some((key) => !Object.prototype.hasOwnProperty.call(originalObject, key))) {
        return false;
      }
      return originalKeys.every((key) => sameDocumentValue(originalObject[key], modifiedObject[key]));
    }

    function sameDocumentExceptEditedCompat(originalValue: unknown, modifiedValue: unknown): boolean {
      if (originalValue === modifiedValue) return true;
      if (typeof originalValue !== typeof modifiedValue || originalValue === null || modifiedValue === null) return false;
      if (Array.isArray(originalValue) || Array.isArray(modifiedValue)) {
        if (!Array.isArray(originalValue) || !Array.isArray(modifiedValue) || originalValue.length !== modifiedValue.length) return false;
        return originalValue.every((value, index) => sameDocumentExceptEditedCompat(value, modifiedValue[index]));
      }
      if (typeof originalValue !== "object") return false;

      const originalObject = originalValue as Record<string, unknown>;
      const modifiedObject = modifiedValue as Record<string, unknown>;
      if (editedCompatContainer(originalObject)) {
        const originalKeys = Object.keys(originalObject).filter((key) => key !== "compat");
        const modifiedKeys = Object.keys(modifiedObject).filter((key) => key !== "compat");
        if (originalKeys.length !== modifiedKeys.length || modifiedKeys.some((key) => !Object.prototype.hasOwnProperty.call(originalObject, key))) {
          return false;
        }
        for (const key of originalKeys) {
          if (!sameDocumentExceptEditedCompat(originalObject[key], modifiedObject[key])) return false;
        }
        return sameCompatObject(originalObject.compat, modifiedObject.compat);
      }

      const originalKeys = Object.keys(originalObject);
      const modifiedKeys = Object.keys(modifiedObject);
      if (originalKeys.length !== modifiedKeys.length || modifiedKeys.some((key) => !Object.prototype.hasOwnProperty.call(originalObject, key))) {
        return false;
      }
      return originalKeys.every((key) => sameDocumentExceptEditedCompat(originalObject[key], modifiedObject[key]));
    }

    if (!sameDocumentExceptEditedCompat(origParsed, modParsed)) {
      return "Modified file: original structure was altered (data loss detected)";
    }

    // Note: we intentionally do NOT enforce `modified.length >= original.length`.
    // The surgical editor may replace an existing compat value with a shorter one
    // (e.g. `false` -> `true`), which legitimately shrinks the file by a byte.
    // Real data loss / truncation is already caught by Step 7's isSubset
    // (every original key still present) and Step 8's root-bracket integrity
    // check below — a surviving length heuristic would false-positive on every
    // such value repair. (Tracked: the mofas glm-5.2 self-check failure path.)

    // Step 8: Validate root bracket integrity with the same string/comment-aware
    // scanner used for edits. Do not count raw braces: comments or strings may
    // legitimately contain unmatched `{` / `}` bytes.
    const modifiedClean = stripJsoncComments(modified);
    const rootStart = skipJsonWhitespace(modifiedClean, 0);
    const rootEnd = findMatchingBracket(modifiedClean, rootStart);
    if (rootEnd === undefined) {
      return "Modified file: root bracket mismatch";
    }
    if (skipJsonWhitespace(modifiedClean, rootEnd + 1) !== modifiedClean.length) {
      return "Modified file: trailing non-whitespace content after root object";
    }

    return null;
  } catch (e) {
    return `Self-check error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Serialize a compat suggestion to the JSON text that will be inserted.
 * Returns the exact key-value pairs as a formatted JSON string without outer braces.
 */
export function formatCompatKeysForInsertion(compatKeys: Record<string, unknown>): string {
  return Object.entries(compatKeys)
    .map(([k, v]) => {
      return `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
    })
    .join(',\n');
}

export type ModelsJsonFixTransactionResult =
  | { ok: true }
  | { ok: false; postCheckError: string };

export type ModelsJsonFixReceiptSnapshot = {
  receipt: ModelsJsonFixReceiptV1;
  receiptPath: string;
  hash: string;
  identity: FileIdentity;
};

export type ModelsJsonFixTransactionOptions = {
  onCommitted?: (writtenText: string) => Promise<void>;
  expectedCurrentHash?: string;
  /** Access mode captured by a preview, used to reject mode races. */
  expectedCurrentMode?: number;
  /** Hash of the transaction backup, used to revalidate a guarded restore. */
  expectedBackupHash?: string;
  /** Receipt identity captured before a rollback preview. */
  receiptGuard?: ModelsJsonFixReceiptSnapshot;
  purpose?: string;
};

export async function assertModelsJsonFixReceiptSnapshotUnchanged(
  snapshot: ModelsJsonFixReceiptSnapshot,
): Promise<void> {
  const info = await lstat(snapshot.receiptPath);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    !sameFileIdentity(snapshot.identity, info)
  ) {
    throw new Error("fix receipt changed since the rollback preview");
  }
  const text = await readFile(snapshot.receiptPath, "utf8");
  const afterRead = await lstat(snapshot.receiptPath);
  if (
    afterRead.isSymbolicLink() ||
    !afterRead.isFile() ||
    !sameFileIdentity(info, afterRead) ||
    hashText(text) !== snapshot.hash
  ) {
    throw new Error("fix receipt changed since the rollback preview");
  }
}

export async function applyModelsJsonFixTransactionUnderLock(
  modifiedText: string,
  backupPath: string,
  validateWrittenText: (writtenText: string) => string | null,
  options: ModelsJsonFixTransactionOptions = {},
): Promise<ModelsJsonFixTransactionResult> {
  if (options.receiptGuard) {
    await assertModelsJsonFixReceiptSnapshotUnchanged(options.receiptGuard);
  }
  const targetInfo = await lstat(MODELS_JSON_PATH);
  if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
    throw new Error("models.json is not a regular file; no changes were made");
  }
  const originalMode = targetInfo.mode & 0o7777;
  const transactionName = options.purpose === "rollback" ? "rollback" : "fix";
  if (options.expectedCurrentMode !== undefined && options.expectedCurrentMode !== originalMode) {
    throw new Error(`models.json access mode changed since the ${transactionName} preview; no changes were made`);
  }
  const initialTargetText = await readFile(MODELS_JSON_PATH, "utf8");
  const transactionInitialHash = hashText(initialTargetText);
  const expectedCurrentHash = options.expectedCurrentHash ?? transactionInitialHash;
  const expectedBackupHash = options.expectedBackupHash ?? expectedCurrentHash;
  const assertCurrentTargetUnchanged = async (): Promise<void> => {
    const currentInfo = await lstat(MODELS_JSON_PATH);
    if (
      currentInfo.isSymbolicLink() ||
      !currentInfo.isFile() ||
      !sameFileIdentity(targetInfo, currentInfo) ||
      (currentInfo.mode & 0o7777) !== originalMode
    ) {
      throw new Error(`models.json changed during ${transactionName}; no changes were made`);
    }
    const currentText = await readFile(MODELS_JSON_PATH, "utf8");
    if (hashText(currentText) !== expectedCurrentHash) {
      throw new Error(`models.json changed since the ${transactionName} preview; no changes were made`);
    }
  };
  const assertBackupUnchanged = async (): Promise<void> => {
    const backupInfo = await lstat(backupPath);
    if (backupInfo.isSymbolicLink() || !backupInfo.isFile()) {
      throw new Error(`models.json ${transactionName} backup is not a regular file; no changes were made`);
    }
    if (expectedBackupHash !== undefined) {
      const backupText = await readFile(backupPath, "utf8");
      if (hashText(backupText) !== expectedBackupHash) {
        throw new Error(`models.json ${transactionName} backup changed during preparation; no changes were made`);
      }
    }
  };

  await assertCurrentTargetUnchanged();
  await copyFile(MODELS_JSON_PATH, backupPath, fsConstants.COPYFILE_EXCL);
  const createdBackupInfo = await lstat(backupPath);
  if (createdBackupInfo.isSymbolicLink() || !createdBackupInfo.isFile()) {
    throw new Error(`models.json ${transactionName} backup is not a regular file; no changes were made`);
  }
  await chmod(backupPath, originalMode);
  const chmodBackupInfo = await lstat(backupPath);
  if (
    chmodBackupInfo.isSymbolicLink() ||
    !chmodBackupInfo.isFile() ||
    !sameFileIdentity(createdBackupInfo, chmodBackupInfo)
  ) {
    throw new Error(`models.json ${transactionName} backup changed during preparation; no changes were made`);
  }
  await assertBackupUnchanged();

  const expectedModifiedHash = hashText(modifiedText);
  let targetReplaced = false;
  const restoreTargetIfUnchanged = async (): Promise<void> => {
    const currentInfo = await lstat(MODELS_JSON_PATH);
    if (
      currentInfo.isSymbolicLink() ||
      !currentInfo.isFile() ||
      (currentInfo.mode & 0o7777) !== originalMode
    ) {
      throw new Error(`models.json changed after ${transactionName} replacement; refusing to overwrite user changes`);
    }
    const currentText = await readFile(MODELS_JSON_PATH, "utf8");
    if (hashText(currentText) !== expectedModifiedHash) {
      throw new Error(`models.json changed after ${transactionName} replacement; refusing to overwrite user changes`);
    }
    await assertBackupUnchanged();
    await atomicRestoreFileFromBackup(backupPath, MODELS_JSON_PATH, originalMode, {
      identity: currentInfo,
      hash: expectedModifiedHash,
      mode: originalMode,
      backupHash: expectedBackupHash,
    });
    const restoredInfo = await lstat(MODELS_JSON_PATH);
    if (restoredInfo.isSymbolicLink() || !restoredInfo.isFile()) {
      throw new Error(`models.json restore produced a non-regular file`);
    }
    const restoredText = await readFile(MODELS_JSON_PATH, "utf8");
    if (expectedBackupHash !== undefined && hashText(restoredText) !== expectedBackupHash) {
      throw new Error(`models.json restore did not match the transaction backup`);
    }
  };

  try {
    await assertCurrentTargetUnchanged();
    await atomicReplaceTextFilePreservingMode(
      MODELS_JSON_PATH,
      modifiedText,
      originalMode,
      options.purpose ?? "fix",
      {
        identity: targetInfo,
        hash: expectedCurrentHash,
        mode: originalMode,
      },
    );
    targetReplaced = true;

    const writtenInfo = await lstat(MODELS_JSON_PATH);
    if (writtenInfo.isSymbolicLink() || !writtenInfo.isFile()) {
      throw new Error(`models.json became a non-regular file during ${transactionName} replacement`);
    }
    const writtenText = await readFile(MODELS_JSON_PATH, "utf8");
    const postCheckError = validateWrittenText(writtenText);
    const writtenMode = writtenInfo.mode & 0o7777;
    const writeHashError = hashText(writtenText) === expectedModifiedHash
      ? null
      : `models.json changed during ${transactionName} replacement`;
    const modeError = writtenMode === originalMode
      ? null
      : `models.json access mode changed from ${originalMode.toString(8)} to ${writtenMode.toString(8)}`;
    const effectiveError = postCheckError ?? writeHashError ?? modeError;
    if (effectiveError !== null) {
      await restoreTargetIfUnchanged();
      targetReplaced = false;
      return { ok: false, postCheckError: effectiveError };
    }

    // Re-check immediately before committing receipt metadata. If a caller
    // changed the replacement after validation, do not mark the transaction
    // successful and do not restore over that caller's change.
    await validateAtomicTarget(MODELS_JSON_PATH, {
      identity: writtenInfo,
      hash: expectedModifiedHash,
      mode: originalMode,
    });

    // A receipt is part of a successful fix transaction. If its atomic write
    // fails, the catch path restores the models file from the transaction
    // backup instead of leaving an un-recoverable configuration change.
    if (options.receiptGuard) {
      await assertModelsJsonFixReceiptSnapshotUnchanged(options.receiptGuard);
    }
    await options.onCommitted?.(writtenText);
    return { ok: true };
  } catch (error) {
    if (targetReplaced) {
      try {
        await restoreTargetIfUnchanged();
        targetReplaced = false;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "models.json fix failed and the atomic backup restore also failed",
        );
      }
    }
    throw error;
  }
}

export async function applyModelsJsonFixTransaction(
  modifiedText: string,
  backupPath: string,
  validateWrittenText: (writtenText: string) => string | null,
  options: ModelsJsonFixTransactionOptions = {},
): Promise<ModelsJsonFixTransactionResult> {
  return withModelsJsonTransactionLock(() =>
    applyModelsJsonFixTransactionUnderLock(modifiedText, backupPath, validateWrittenText, options)
  );
}

export function isReceiptScalar(value: unknown): value is ReceiptScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

export function isReceiptScalarState(value: unknown): value is ReceiptScalarState {
  const record = asRecord(value);
  if (!record || record.present === undefined) return false;
  if (record.present === false) return Object.keys(record).every((key) => key === "present");
  return record.present === true && isReceiptScalar(record.value) && Object.keys(record).every((key) => key === "present" || key === "value");
}

export function sameReceiptScalarState(left: ReceiptScalarState, right: ReceiptScalarState): boolean {
  if (left.present !== right.present) return false;
  return !left.present || left.value === (right as { present: true; value: ReceiptScalar }).value;
}

export function isFixReceiptPlacement(value: unknown): value is FixReceiptPlacement {
  return value === "provider" || value === "model" || value === "modelOverride";
}

export function hasReceiptReasoningProtocolChange(receipt: ModelsJsonFixReceiptV1): boolean {
  return [
    "thinkingFormat",
    "supportsReasoningEffort",
    "requiresReasoningContentOnAssistantMessages",
  ].some((key) => Object.prototype.hasOwnProperty.call(receipt.changedKeys, key));
}

export function isActionableModelsJsonFixReceipt(receipt: ModelsJsonFixReceiptV1 | undefined): receipt is ModelsJsonFixReceiptV1 {
  return receipt !== undefined && receipt.status === undefined;
}

export function createRollbackBackupPath(modelsPath: string = MODELS_JSON_PATH): string {
  return `${modelsPath}.backup-cache-optimizer-rollback-${backupTimestamp()}`;
}

export function parseModelsJsonFixReceipt(value: unknown): ModelsJsonFixReceiptV1 | undefined {
  const record = asRecord(value);
  if (!record || record.version !== 1 || record.kind !== "pi-cache-optimizer-fix-receipt") return undefined;
  const allowedKeys = new Set([
    "version", "kind", "transactionId", "provider", "modelId", "placement",
    "targetExistedBefore", "changedKeys", "beforeHash", "afterHash", "backupFile",
    "createdAt", "appliedAt", "status", "rolledBackAt",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return undefined;
  if (!isSafeReceiptText(record.transactionId) || !isSafeReceiptText(record.provider) || !isSafeReceiptText(record.modelId)) return undefined;
  if (!isFixReceiptPlacement(record.placement) || typeof record.targetExistedBefore !== "boolean") return undefined;
  if (!isSha256(record.beforeHash) || !isSha256(record.afterHash) || record.beforeHash === record.afterHash) return undefined;
  if (!isSafeReceiptText(record.backupFile) || basename(record.backupFile) !== record.backupFile || record.backupFile.includes("..")) return undefined;
  if (!/^models\.json\.backup-cache-optimizer-/.test(record.backupFile)) return undefined;
  const beforeHash = typeof record.beforeHash === "string" ? record.beforeHash.toLowerCase() : "";
  const afterHash = typeof record.afterHash === "string" ? record.afterHash.toLowerCase() : "";
  if (beforeHash === afterHash) return undefined;
  if (!isReceiptTimestamp(record.createdAt) || !isReceiptTimestamp(record.appliedAt) || record.appliedAt < record.createdAt) return undefined;
  const changedKeys = asRecord(record.changedKeys);
  if (!changedKeys || Object.keys(changedKeys).length === 0) return undefined;

  const parsedChanges: Record<string, FixReceiptCompatChange> = {};
  for (const [key, rawChange] of Object.entries(changedKeys)) {
    if (!RECEIPT_COMPAT_KEYS.has(key)) return undefined;
    const change = asRecord(rawChange);
    if (!change || !isReceiptScalarState(change.before) || !isReceiptScalarState(change.after)) return undefined;
    if (sameReceiptScalarState(change.before, change.after)) return undefined;
    parsedChanges[key] = {
      before: change.before,
      after: change.after,
    };
  }

  if (record.status !== undefined && record.status !== "rolled_back") return undefined;
  if (record.status === "rolled_back" && (!isReceiptTimestamp(record.rolledBackAt) || record.rolledBackAt < record.appliedAt)) return undefined;
  if (record.status === undefined && record.rolledBackAt !== undefined) return undefined;

  return {
    version: 1,
    kind: "pi-cache-optimizer-fix-receipt",
    transactionId: record.transactionId.trim(),
    provider: record.provider.trim(),
    modelId: record.modelId.trim(),
    placement: record.placement,
    targetExistedBefore: record.targetExistedBefore,
    changedKeys: parsedChanges,
    beforeHash,
    afterHash,
    backupFile: record.backupFile,
    createdAt: Number(record.createdAt),
    appliedAt: Number(record.appliedAt),
    ...(record.status === "rolled_back" ? { status: "rolled_back", rolledBackAt: Number(record.rolledBackAt) } : {}),
  };
}

export function receiptBackupPath(receipt: ModelsJsonFixReceiptV1, receiptPath: string = FIX_RECEIPT_PATH): string {
  return join(dirname(receiptPath), receipt.backupFile);
}

export async function writeModelsJsonFixReceipt(
  receipt: ModelsJsonFixReceiptV1,
  receiptPath: string = FIX_RECEIPT_PATH,
  expectedSnapshot?: ModelsJsonFixReceiptSnapshot,
  /** Test-only race injector; production callers leave this undefined. */
  beforeRename?: () => Promise<void>,
): Promise<void> {
  if (!parseModelsJsonFixReceipt(receipt)) throw new Error("invalid fix receipt");
  if (expectedSnapshot) {
    if (expectedSnapshot.receiptPath !== receiptPath) throw new Error("fix receipt path changed since the rollback preview");
    await assertModelsJsonFixReceiptSnapshotUnchanged(expectedSnapshot);
  }
  await mkdir(dirname(receiptPath), { recursive: true });
  let existingReceiptInfo: { dev: number; ino: number } | undefined;
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("invalid fix receipt path");
    existingReceiptInfo = info;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") throw error;
  }
  const mode = 0o600;

  const tempPath = uniqueTempPath(receiptPath, "receipt");
  try {
    await writeFileExclusiveDurable(tempPath, JSON.stringify(receipt, null, 2) + "\n", mode);
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) throw new Error("invalid temporary fix receipt");
    await chmod(tempPath, mode);
    if (expectedSnapshot) {
      await assertModelsJsonFixReceiptSnapshotUnchanged(expectedSnapshot);
    }
    const assertReceiptDestinationUnchanged = async (): Promise<void> => {
      try {
        const currentReceiptInfo = await lstat(receiptPath);
        if (!existingReceiptInfo || !sameFileIdentity(existingReceiptInfo, currentReceiptInfo)) {
          throw new Error("fix receipt changed during atomic write");
        }
      } catch (error) {
        if (getErrorCode(error) === "ENOENT" && !existingReceiptInfo) {
          // The destination was absent both before and immediately before the
          // rename. The atomic rename will create it safely.
        } else {
          throw error;
        }
      }
      if (expectedSnapshot) await assertModelsJsonFixReceiptSnapshotUnchanged(expectedSnapshot);
    };
    await assertReceiptDestinationUnchanged();
    if (beforeRename) await beforeRename();
    await assertReceiptDestinationUnchanged();
    if (existingReceiptInfo) {
      await rename(tempPath, receiptPath);
    } else {
      await link(tempPath, receiptPath);
      await unlink(tempPath).catch((cleanupError) => {
        console.warn(`${LOG_PREFIX}: committed fix receipt but failed to remove its temporary hard link`, cleanupError);
      });
    }
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (getErrorCode(cleanupError) !== "ENOENT") console.warn(`${LOG_PREFIX}: failed to remove temporary fix receipt`, cleanupError);
    }
    throw error;
  }
}

export async function readModelsJsonFixReceiptSnapshot(
  receiptPath: string = FIX_RECEIPT_PATH,
): Promise<ModelsJsonFixReceiptSnapshot | undefined> {
  try {
    const info = await lstat(receiptPath);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    const text = await readFile(receiptPath, "utf8");
    const afterRead = await lstat(receiptPath);
    if (
      afterRead.isSymbolicLink() ||
      !afterRead.isFile() ||
      !sameFileIdentity(info, afterRead)
    ) return undefined;
    const receipt = parseModelsJsonFixReceipt(JSON.parse(text));
    if (!receipt) return undefined;
    return {
      receipt,
      receiptPath,
      hash: hashText(text),
      identity: afterRead,
    };
  } catch {
    return undefined;
  }
}

export async function readModelsJsonFixReceipt(
  receiptPath: string = FIX_RECEIPT_PATH,
): Promise<ModelsJsonFixReceiptV1 | undefined> {
  return (await readModelsJsonFixReceiptSnapshot(receiptPath))?.receipt;
}

export async function markModelsJsonFixReceiptRolledBack(
  snapshot: ModelsJsonFixReceiptSnapshot,
): Promise<void> {
  const receipt = snapshot.receipt;
  await writeModelsJsonFixReceipt({
    ...receipt,
    status: "rolled_back",
    rolledBackAt: Date.now(),
  }, snapshot.receiptPath, snapshot);
}

export type ReceiptCompatTarget = {
  targetExists: boolean;
  compatBrace: number;
  compatEnd: number;
};

export function locateReceiptCompatTarget(
  text: string,
  provider: string,
  modelId: string,
  placement: FixReceiptPlacement,
): ReceiptCompatTarget | undefined {
  if (placement === "modelOverride") {
    const location = locateModelOverrideInJsonc(text, provider, modelId);
    if (
      !location ||
      location.providerKeyCount !== 1 ||
      location.modelOverridesKeyCount > 1 ||
      location.modelOverrideKeyCount > 1 ||
      location.modelOverrideCompatKeyCount > 1
    ) return undefined;
    return {
      targetExists: location.modelOverrideObjectBrace >= 0,
      compatBrace: location.modelOverrideCompatBrace,
      compatEnd: location.modelOverrideCompatEnd,
    };
  }

  if (placement === "provider") {
    const location = locateProviderCompatInJsonc(text, provider);
    if (!location) return undefined;
    return {
      targetExists: true,
      compatBrace: location.providerCompatBrace,
      compatEnd: location.providerCompatEnd,
    };
  }
  const location = locateModelInJsonc(text, provider, modelId);
  if (!location || location.providerKeyCount !== 1) return undefined;
  // A changed-file model-scoped rollback cannot tell which duplicate model
  // object was the receipt's target. Refuse that ambiguity instead of touching
  // a later user-added definition. Provider-level receipts returned above do
  // not depend on model-array identity.
  if (location.allModelIds.filter((id) => id === modelId).length !== 1) return undefined;
  if (location.modelCompatKeyCount > 1) return undefined;
  return {
    targetExists: location.modelObjectBrace >= 0,
    compatBrace: location.compatObjectBrace,
    compatEnd: location.compatObjectEnd,
  };
}

export function readReceiptCompatScalarState(
  text: string,
  target: ReceiptCompatTarget | undefined,
  key: string,
): ReceiptScalarState | undefined {
  if (!target || target.compatBrace < 0 || target.compatEnd <= target.compatBrace) {
    return { present: false };
  }
  const clean = stripJsoncComments(text);
  const property = findJsonObjectKey(clean, target.compatBrace, key);
  if (!property || property.keyStart >= target.compatEnd) return { present: false };
  if (property.count !== 1) return undefined;
  const valueStart = skipJsonWhitespace(clean, property.valueStart);
  const valueEnd = skipJsonValue(clean, valueStart);
  if (valueEnd === undefined || valueEnd > target.compatEnd) return undefined;
  try {
    const value = parseJsonc(text.slice(valueStart, valueEnd));
    return isReceiptScalar(value) ? { present: true, value } : undefined;
  } catch {
    return undefined;
  }
}

export function createModelsJsonFixReceipt(
  originalText: string,
  modifiedText: string,
  provider: string,
  modelId: string,
  placement: FixReceiptPlacement,
  compatKeys: Record<string, unknown>,
  targetExistedBefore: boolean,
  backupPath: string,
  now: number = Date.now(),
): ModelsJsonFixReceiptV1 | undefined {
  const backupFile = basename(backupPath);
  if (!/^models\.json\.backup-cache-optimizer-/.test(backupFile)) return undefined;
  const beforeTarget = locateReceiptCompatTarget(originalText, provider, modelId, placement);
  const afterTarget = locateReceiptCompatTarget(modifiedText, provider, modelId, placement);
  if (targetExistedBefore && !beforeTarget?.targetExists) return undefined;
  if (!afterTarget?.targetExists) return undefined;

  const changedKeys: Record<string, FixReceiptCompatChange> = {};
  for (const [key, afterValue] of Object.entries(compatKeys)) {
    if (!isReceiptScalar(afterValue)) return undefined;
    const before = readReceiptCompatScalarState(originalText, beforeTarget, key);
    const after = readReceiptCompatScalarState(modifiedText, afterTarget, key);
    if (!before || !after || !sameReceiptScalarState(after, { present: true, value: afterValue })) return undefined;
    if (!sameReceiptScalarState(before, after)) changedKeys[key] = { before, after };
  }
  if (Object.keys(changedKeys).length === 0) return undefined;

  const receipt: ModelsJsonFixReceiptV1 = {
    version: 1,
    kind: "pi-cache-optimizer-fix-receipt",
    transactionId: randomUUID(),
    provider,
    modelId,
    placement,
    targetExistedBefore,
    changedKeys,
    beforeHash: hashText(originalText),
    afterHash: hashText(modifiedText),
    backupFile,
    createdAt: now,
    appliedAt: now,
  };
  return parseModelsJsonFixReceipt(receipt);
}

export function composeModelsJsonReceiptRollback(
  currentText: string,
  receipt: ModelsJsonFixReceiptV1,
): { modifiedText: string; changed: boolean } | { error: string } {
  if (!receipt.targetExistedBefore) {
    return { error: "the fix created a new target entry and the file changed; refusing to remove user changes automatically" };
  }

  const target = locateReceiptCompatTarget(currentText, receipt.provider, receipt.modelId, receipt.placement);
  if (!target?.targetExists) {
    return { error: "the original target entry is missing or no longer safely locatable" };
  }
  if (target.compatBrace < 0 || target.compatEnd <= target.compatBrace) {
    return { error: "the target compat object is missing or no longer safely locatable" };
  }

  const edits: JsonPropertyEdit[] = [];
  for (const [key, change] of Object.entries(receipt.changedKeys)) {
    const current = readReceiptCompatScalarState(currentText, target, key);
    if (!current || !sameReceiptScalarState(current, change.after)) {
      return { error: `receipt-owned compat.${key} was changed after the fix; refusing to overwrite it` };
    }
    const property = locateJsonPropertyValueSpan(currentText, target.compatBrace, target.compatEnd, key);
    if (!property) return { error: `receipt-owned compat.${key} is no longer safely locatable` };
    if (change.before.present) {
      edits.push({
        start: property.valueStart,
        end: property.valueEnd,
        text: JSON.stringify(change.before.value),
      });
    } else {
      edits.push(property.removal);
    }
  }

  const modifiedText = edits
    .sort((left, right) => right.start - left.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), currentText);
  return { modifiedText, changed: modifiedText !== currentText };
}

export function validateModelsJsonRollback(
  writtenText: string,
  receipt: ModelsJsonFixReceiptV1,
  expectedHash?: string,
): string | null {
  if (expectedHash !== undefined && hashText(writtenText) !== expectedHash) {
    return "rollback result hash did not match the expected pre-fix file";
  }
  try {
    parseJsonc(writtenText);
  } catch {
    return "rollback result is not valid JSONC";
  }
  // An exact hash check proves the complete pre-fix document, including a
  // newly created target entry (which intentionally did not exist before).
  if (expectedHash !== undefined) return null;

  const target = locateReceiptCompatTarget(writtenText, receipt.provider, receipt.modelId, receipt.placement);
  if (!target?.targetExists) return "rollback result lost the original target entry";
  for (const [key, change] of Object.entries(receipt.changedKeys)) {
    const state = readReceiptCompatScalarState(writtenText, target, key);
    if (!state || !sameReceiptScalarState(state, change.before)) return `rollback result did not restore compat.${key}`;
  }
  return null;
}

export type ModelsJsonRollbackPlan = {
  receiptSnapshot: ModelsJsonFixReceiptSnapshot;
  receipt: ModelsJsonFixReceiptV1;
  currentHash: string;
  modifiedText: string;
  expectedResultHash?: string;
  mode: "exact" | "surgical";
  fileMode: number;
  originalBackupPath: string;
  rollbackBackupPath: string;
};

export async function prepareModelsJsonRollback(
  receiptSnapshot: ModelsJsonFixReceiptSnapshot | undefined,
  modelsPath: string = MODELS_JSON_PATH,
): Promise<ModelsJsonRollbackPlan | { error: string }> {
  const receipt = receiptSnapshot?.receipt;
  if (!receiptSnapshot || !isActionableModelsJsonFixReceipt(receipt)) {
    return { error: "No unapplied /cache-optimizer fix receipt was found." };
  }

  let current: { text: string; mode: number };
  try {
    current = await readRegularTextFile(modelsPath);
  } catch {
    return { error: "models.json is missing or is not a regular file; no changes were made." };
  }
  const currentHash = hashText(current.text);
  const originalBackupPath = join(dirname(modelsPath), receipt.backupFile);
  const rollbackBackupPath = createRollbackBackupPath(modelsPath);

  if (currentHash === receipt.afterHash) {
    let backup: { text: string; mode: number };
    try {
      backup = await readRegularTextFile(originalBackupPath);
    } catch {
      return { error: "The receipt backup is missing or is not a regular file; refusing to overwrite models.json." };
    }
    if (hashText(backup.text) !== receipt.beforeHash) {
      return { error: "The receipt backup hash does not match the recorded pre-fix file; refusing to overwrite models.json." };
    }
    try {
      parseJsonc(backup.text);
    } catch {
      return { error: "The receipt backup is not valid JSONC; refusing to overwrite models.json." };
    }
    return {
      receiptSnapshot,
      receipt,
      currentHash,
      modifiedText: backup.text,
      expectedResultHash: receipt.beforeHash,
      mode: "exact",
      fileMode: current.mode,
      originalBackupPath,
      rollbackBackupPath,
    };
  }

  if (!receipt.targetExistedBefore) {
    return {
      error: "models.json changed after the fix, and the fix created the target entry. Refusing to remove or overwrite unrelated user changes; use the recorded backup for manual guidance.",
    };
  }

  // A changed file is eligible only for a scalar, receipt-owned surgical
  // rollback. Validate the current document before showing a confirmation;
  // malformed JSONC must never be replaced by an edit derived from offsets.
  try {
    parseJsonc(current.text);
  } catch {
    return { error: "models.json changed after the fix and is not valid JSONC; refusing to overwrite user changes. Use the recorded backup for manual guidance." };
  }

  const surgical = composeModelsJsonReceiptRollback(current.text, receipt);
  if ("error" in surgical) {
    return {
      error: `models.json changed after the fix. ${surgical.error}. Use the recorded backup for manual guidance.`,
    };
  }
  if (!surgical.changed) {
    return { error: "No receipt-owned change remains to roll back." };
  }

  return {
    receiptSnapshot,
    receipt,
    currentHash,
    modifiedText: surgical.modifiedText,
    mode: "surgical",
    fileMode: current.mode,
    originalBackupPath,
    rollbackBackupPath,
  };
}
