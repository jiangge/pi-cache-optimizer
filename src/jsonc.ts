
// ── String-aware JSONC scanning primitives ─────────────────────────
//
// These operate on comment-stripped text produced by stripJsoncComments()
// (which preserves byte offsets), so every offset they return is also valid
// in the original text. All scanning skips string literals, so braces or
// brackets inside string values (e.g. apiKeyCommand shell snippets) cannot
// corrupt depth tracking.

export function isJsonWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

export function skipJsonWhitespace(text: string, pos: number): number {
  while (pos < text.length && isJsonWhitespace(text[pos])) pos++;
  return pos;
}

/**
 * Read a JSON string literal starting at `pos` (which must be `"`).
 * Returns the decoded value and the offset just past the closing quote,
 * or undefined when the literal is unterminated/malformed.
 */
export function readJsonStringLiteral(text: string, pos: number): { value: string; end: number } | undefined {
  if (text[pos] !== '"') return undefined;
  let i = pos + 1;
  let value = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) return undefined;
      if (next === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        if (next === "n") value += "\n";
        else if (next === "t") value += "\t";
        else if (next === "r") value += "\r";
        else if (next === "b") value += "\b";
        else if (next === "f") value += "\f";
        else value += next; // ", \\, / and lenient passthrough
        i += 2;
      }
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    value += ch;
    i++;
  }
  return undefined;
}

/**
 * Find the offset of the `}` / `]` matching the opener at `openPos`,
 * skipping string literals. Returns undefined on imbalance.
 */
export function findMatchingBracket(text: string, openPos: number): number | undefined {
  const open = text[openPos];
  if (open !== "{" && open !== "[") return undefined;
  let depth = 0;
  let i = openPos;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const str = readJsonStringLiteral(text, i);
      if (!str) return undefined;
      i = str.end;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return undefined;
}

/** Skip one JSON value starting at/after `pos`; returns the offset just past it. */
export function skipJsonValue(text: string, pos: number): number | undefined {
  pos = skipJsonWhitespace(text, pos);
  const ch = text[pos];
  if (ch === '"') {
    const str = readJsonStringLiteral(text, pos);
    return str?.end;
  }
  if (ch === "{" || ch === "[") {
    const end = findMatchingBracket(text, pos);
    return end === undefined ? undefined : end + 1;
  }
  let i = pos;
  while (i < text.length && !",}]".includes(text[i]) && !isJsonWhitespace(text[i])) i++;
  return i > pos ? i : undefined;
}

/**
 * Find a top-level key in the object whose `{` is at `openBracePos`.
 * Only direct children are considered (nested values are skipped whole).
 * When duplicate keys exist, return the last one so scanning follows
 * JSON.parse/Pi's effective last-definition-wins behavior. `count` lets
 * callers refuse an ambiguous surgical edit rather than silently selecting a
 * user-added duplicate. Return undefined when the key is absent or the object
 * is malformed.
 */
export function findJsonObjectKey(
  text: string,
  openBracePos: number,
  targetKey: string,
): { keyStart: number; valueStart: number; count: number } | undefined {
  if (text[openBracePos] !== "{") return undefined;
  let i = openBracePos + 1;
  let found: { keyStart: number; valueStart: number; count: number } | undefined;
  let count = 0;
  while (i < text.length) {
    i = skipJsonWhitespace(text, i);
    if (i >= text.length) return undefined;
    if (text[i] === "}") return found;
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] !== '"') return undefined; // unexpected token — refuse to guess
    const keyStart = i;
    const key = readJsonStringLiteral(text, i);
    if (!key) return undefined;
    i = skipJsonWhitespace(text, key.end);
    if (text[i] !== ":") return undefined;
    i = skipJsonWhitespace(text, i + 1);
    if (key.value === targetKey) {
      count++;
      found = { keyStart, valueStart: i, count };
    }
    const after = skipJsonValue(text, i);
    if (after === undefined) return undefined;
    i = after;
  }
  return undefined;
}

/** Leading whitespace of the line containing offset `pos` (up to `pos`). */
export function lineIndentOf(text: string, pos: number): string {
  let lineStart = text.lastIndexOf("\n", pos - 1);
  lineStart = lineStart < 0 ? 0 : lineStart + 1;
  const m = text.slice(lineStart, pos).match(/^[ \t]*/);
  return m ? m[0] : "";
}

/**
 * Indentation used by the first line inside the object spanning
 * `openBrace`..`closeBrace` in the ORIGINAL text. Falls back to the
 * opener's line indent plus two spaces for single-line objects.
 */
export function deriveInnerIndent(text: string, openBrace: number, closeBrace: number): string {
  const nl = text.indexOf("\n", openBrace + 1);
  if (nl >= 0 && nl < closeBrace) {
    let i = nl + 1;
    let ws = "";
    while (i < text.length && (text[i] === " " || text[i] === "\t")) {
      ws += text[i];
      i++;
    }
    if (ws.length > 0) return ws;
  }
  return lineIndentOf(text, openBrace) + "  ";
}

/**
 * Strip JSONC comments from text, replacing them with spaces.
 * Handles string literals, escaped quotes, // line comments, /* block comments *\/.
 * Returns the cleaned text with same line/column positions.
 */
export function stripJsoncComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      // String literal — copy byte-for-byte until the closing quote.
      // Escaped quotes/slashes must not be mistaken for comment delimiters.
      out.push(ch);
      i++;
      while (i < text.length) {
        const sc = text[i];
        out.push(sc);
        i++;
        if (sc === '\\' && i < text.length) {
          out.push(text[i]);
          i++;
        } else if (sc === '"') {
          break;
        }
      }
      continue;
    }

    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      // Line comment — replace BOTH slashes and every comment byte with
      // spaces, but leave the newline to be copied by the normal path.
      out.push(' ', ' ');
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }

    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      // Block comment — replace every byte with a space except newlines.
      // This deliberately preserves text.length and all structural offsets.
      out.push(' ', ' ');
      i += 2;
      while (i < text.length) {
        if (text[i] === '*' && i + 1 < text.length && text[i + 1] === '/') {
          out.push(' ', ' ');
          i += 2;
          break;
        }
        out.push(text[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }

    out.push(ch);
    i++;
  }
  return out.join('');
}

/**
 * Remove JSONC trailing commas from already comment-stripped text.
 * The returned text stays length-preserving (commas become spaces), which
 * gives JSON.parse a tolerant JSONC surface without affecting diagnostics.
 */
export function stripJsoncTrailingCommas(text: string): string {
  const chars = text.split("");
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '"') {
      const str = readJsonStringLiteral(text, i);
      if (!str) break;
      i = str.end;
      continue;
    }

    if (chars[i] === ',') {
      let j = i + 1;
      while (j < chars.length && isJsonWhitespace(chars[j])) j++;
      if (chars[j] === '}' || chars[j] === ']') chars[i] = ' ';
    }
    i++;
  }
  return chars.join('');
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(text)));
}

/**
 * JSONC scanner: locate the provider block and model entry in models.json text.
 * Returns the byte offsets for surgical insertion, or undefined if ambiguous.
 */
export interface ModelNodeLocation {
  /** Number of exact provider keys found in the root providers object. */
  providerKeyCount: number;
  /** Offset of the model object's opening `{` */
  modelObjectBrace: number;
  /** Offset of the model object's closing `}` */
  modelObjectEnd: number;
  /** Offset of the "compat" key start (the `"`), or -1 if compat doesn't exist */
  compatKeyStart: number;
  /** Offset of the compat object's opening `{`, or -1 if compat doesn't exist */
  compatObjectBrace: number;
  /** Offset of the compat object's closing `}`, or -1 */
  compatObjectEnd: number;
  /** Indentation string to use for inserted lines (derived from surrounding context) */
  indent: string;
  /** Offset of the provider object's opening `{` */
  providerObjectBrace: number;
  /** Offset of the provider object's closing `}` */
  providerObjectEnd: number;
  /** Offset of the provider-level compat object's opening `{`, or -1 if absent */
  providerCompatBrace: number;
  /** Offset of the provider-level compat object's closing `}`, or -1 if absent */
  providerCompatEnd: number;
  /** Offset of the target modelOverrides entry's opening `{`, or -1 if absent */
  modelOverrideObjectBrace: number;
  /** Offset of the target modelOverrides entry's closing `}`, or -1 if absent */
  modelOverrideObjectEnd: number;
  /** Offset of the target override compat object's opening `{`, or -1 if absent */
  modelOverrideCompatBrace: number;
  /** Offset of the target override compat object's closing `}`, or -1 if absent */
  modelOverrideCompatEnd: number;
  /** Number of exact modelOverrides keys for this model id. */
  modelOverrideKeyCount: number;
  /** Number of exact compat keys in the selected model object. */
  modelCompatKeyCount: number;
  /** Number of exact provider compat keys. */
  providerCompatKeyCount: number;
  /** All model ids found in this provider's models array (for placement safety analysis) */
  allModelIds: string[];
}

export interface ModelOverrideNodeLocation {
  providerKeyCount: number;
  modelOverridesKeyCount: number;
  modelOverrideKeyCount: number;
  modelOverrideCompatKeyCount: number;
  providerObjectBrace: number;
  providerObjectEnd: number;
  modelOverridesObjectBrace: number;
  modelOverridesObjectEnd: number;
  modelOverrideObjectBrace: number;
  modelOverrideObjectEnd: number;
  modelOverrideCompatBrace: number;
  modelOverrideCompatEnd: number;
}

export interface ProviderCompatNodeLocation {
  providerObjectBrace: number;
  providerObjectEnd: number;
  providerCompatBrace: number;
  providerCompatEnd: number;
}

/** Locate a unique provider and its direct compat object without requiring models[]. */
export function locateProviderCompatInJsonc(
  text: string,
  providerLabel: string,
): ProviderCompatNodeLocation | undefined {
  const clean = stripJsoncComments(text);
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
  const providerObjectBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerObjectBrace] !== "{") return undefined;
  const providerObjectEnd = findMatchingBracket(clean, providerObjectBrace);
  if (providerObjectEnd === undefined || providerObjectEnd > providersEnd) return undefined;

  for (const key of ["models", "modelOverrides"]) {
    const child = findJsonObjectKey(clean, providerObjectBrace, key);
    if (child?.count && child.count > 1) return undefined;
  }
  const compatKey = findJsonObjectKey(clean, providerObjectBrace, "compat");
  if (compatKey?.count && compatKey.count > 1) return undefined;
  if (!compatKey) {
    return { providerObjectBrace, providerObjectEnd, providerCompatBrace: -1, providerCompatEnd: -1 };
  }
  const providerCompatBrace = skipJsonWhitespace(clean, compatKey.valueStart);
  if (clean[providerCompatBrace] !== "{") return undefined;
  const providerCompatEnd = findMatchingBracket(clean, providerCompatBrace);
  if (providerCompatEnd === undefined || providerCompatEnd > providerObjectEnd) return undefined;
  return { providerObjectBrace, providerObjectEnd, providerCompatBrace, providerCompatEnd };
}

/** Locate a provider and optional modelOverrides entry without requiring models[]. */
export function locateModelOverrideInJsonc(
  text: string,
  providerLabel: string,
  modelId: string,
): ModelOverrideNodeLocation | undefined {
  const clean = stripJsoncComments(text);
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
  const providerObjectBrace = skipJsonWhitespace(clean, providerKey.valueStart);
  if (clean[providerObjectBrace] !== "{") return undefined;
  const providerObjectEnd = findMatchingBracket(clean, providerObjectBrace);
  if (providerObjectEnd === undefined || providerObjectEnd > providersEnd) return undefined;
  const providerCompatKey = findJsonObjectKey(clean, providerObjectBrace, "compat");
  if (providerCompatKey?.count && providerCompatKey.count > 1) return undefined;
  const modelsKey = findJsonObjectKey(clean, providerObjectBrace, "models");
  if (modelsKey?.count && modelsKey.count > 1) return undefined;

  let modelOverridesObjectBrace = -1;
  let modelOverridesObjectEnd = -1;
  let modelOverrideObjectBrace = -1;
  let modelOverrideObjectEnd = -1;
  let modelOverrideCompatBrace = -1;
  let modelOverrideCompatEnd = -1;
  let modelOverrideKeyCount = 0;
  let modelOverrideCompatKeyCount = 0;
  const overridesKey = findJsonObjectKey(clean, providerObjectBrace, "modelOverrides");
  if (overridesKey?.count && overridesKey.count > 1) return undefined;
  if (overridesKey && overridesKey.keyStart < providerObjectEnd) {
    const brace = skipJsonWhitespace(clean, overridesKey.valueStart);
    if (clean[brace] !== "{") return undefined;
    const end = findMatchingBracket(clean, brace);
    if (end === undefined || end > providerObjectEnd) return undefined;
    modelOverridesObjectBrace = brace;
    modelOverridesObjectEnd = end;

    const overrideKey = findJsonObjectKey(clean, brace, modelId);
    modelOverrideKeyCount = overrideKey?.count ?? 0;
    if (overrideKey?.count && overrideKey.count > 1) return undefined;
    if (overrideKey && overrideKey.keyStart < end) {
      const entryBrace = skipJsonWhitespace(clean, overrideKey.valueStart);
      if (clean[entryBrace] !== "{") return undefined;
      const entryEnd = findMatchingBracket(clean, entryBrace);
      if (entryEnd === undefined || entryEnd > end) return undefined;
      modelOverrideObjectBrace = entryBrace;
      modelOverrideObjectEnd = entryEnd;

      const compatKey = findJsonObjectKey(clean, entryBrace, "compat");
      modelOverrideCompatKeyCount = compatKey?.count ?? 0;
      if (compatKey?.count && compatKey.count > 1) return undefined;
      if (compatKey && compatKey.keyStart < entryEnd) {
        const compatBrace = skipJsonWhitespace(clean, compatKey.valueStart);
        if (clean[compatBrace] !== "{") return undefined;
        const compatEnd = findMatchingBracket(clean, compatBrace);
        if (compatEnd === undefined || compatEnd > entryEnd) return undefined;
        modelOverrideCompatBrace = compatBrace;
        modelOverrideCompatEnd = compatEnd;
      }
    }
  }

  return {
    providerKeyCount: providerKey.count,
    modelOverridesKeyCount: overridesKey?.count ?? 0,
    modelOverrideKeyCount,
    modelOverrideCompatKeyCount,
    providerObjectBrace,
    providerObjectEnd,
    modelOverridesObjectBrace,
    modelOverridesObjectEnd,
    modelOverrideObjectBrace,
    modelOverrideObjectEnd,
    modelOverrideCompatBrace,
    modelOverrideCompatEnd,
  };
}

/**
 * Deep-equal comparison of two values, used for post-write self-check.
 * Compares all keys recursively, allowing `extraKeys` to be present in `a` but not in `b`.
 */
export function deepEqualIgnoringKeys(a: unknown, b: unknown, extraKeys: string[]): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualIgnoringKeys(a[i], b[i], extraKeys)) return false;
    }
    return true;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const aKeys = Object.keys(a as Record<string, unknown>).filter(k => !extraKeys.includes(k));
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!(k in (b as Record<string, unknown>))) return false;
      if (!deepEqualIgnoringKeys(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        extraKeys,
      )) return false;
    }
    return true;
  }
  return false;
}

export function findExistingCompatKeysInJsonc(
  original: string,
  compatBrace: number,
  compatEnd: number,
  keys: string[],
): string[] {
  if (compatBrace < 0 || compatEnd <= compatBrace) return [];
  const clean = stripJsoncComments(original);
  return keys.filter((key) => {
    const found = findJsonObjectKey(clean, compatBrace, key);
    return !!found && found.keyStart < compatEnd;
  });
}

export function maskJsonSyntaxPreservingComments(text: string, start: number, end: number): string {
  // Replace only JSON syntax/value bytes. Comments are copied verbatim so a
  // user explanation attached to a receipt-owned key survives a surgical
  // rollback. Newlines are also retained to keep line structure unchanged.
  const output = text.slice(start, end).split("");
  let i = start;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let escaped = false;
  while (i < end) {
    const ch = text[i];
    const next = text[i + 1];
    const offset = i - start;
    if (inLineComment) {
      if (ch === "\n" || ch === "\r") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        i += 2;
        inBlockComment = false;
      } else {
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === "\n" || ch === "\r") {
        i++;
        continue;
      }
      output[offset] = " ";
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      output[offset] = " ";
    } else if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    } else if (ch !== "\n" && ch !== "\r") {
      output[offset] = " ";
    }
    i++;
  }
  return output.join("");
}

export type JsonPropertyEdit = { start: number; end: number; text: string };

export function locateJsonPropertyValueSpan(
  text: string,
  objectBrace: number,
  objectEnd: number,
  key: string,
): { keyStart: number; valueStart: number; valueEnd: number; removal: JsonPropertyEdit } | undefined {
  const clean = stripJsoncComments(text);
  const property = findJsonObjectKey(clean, objectBrace, key);
  if (!property || property.keyStart >= objectEnd || property.count !== 1) return undefined;
  const valueStart = skipJsonWhitespace(clean, property.valueStart);
  const valueEnd = skipJsonValue(clean, valueStart);
  if (valueEnd === undefined || valueEnd > objectEnd) return undefined;

  const next = skipJsonWhitespace(clean, valueEnd);
  if (clean[next] === ",") {
    return {
      keyStart: property.keyStart,
      valueStart,
      valueEnd,
      removal: {
        start: property.keyStart,
        end: next + 1,
        text: maskJsonSyntaxPreservingComments(text, property.keyStart, next + 1),
      },
    };
  }

  let previous = property.keyStart - 1;
  while (previous >= objectBrace && isJsonWhitespace(clean[previous])) previous--;
  const removalStart = clean[previous] === "," ? previous : property.keyStart;
  return {
    keyStart: property.keyStart,
    valueStart,
    valueEnd,
    removal: {
      start: removalStart,
      end: valueEnd,
      text: maskJsonSyntaxPreservingComments(text, removalStart, valueEnd),
    },
  };
}
