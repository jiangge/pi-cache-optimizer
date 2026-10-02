import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { LOG_PREFIX, type PiModel, asRecord, getNumber, isNonEmptyString, lower } from "./common.ts";
import { findLastExactModelDefinition } from "./compat-config.ts";
import { featureEnabled } from "./config.ts";
import { ROUTED_FALLBACK_MODEL_SYMBOL, getAssistantRecord, isNativeVirtualModel, isResponsesPromptRewriteBypassApi, modelKey, readEffectiveCompatConfig } from "./model-identity.ts";

export const VIRTUAL_REWRITE_ENV = "PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE";

export const PI_ROUTING_REGISTRY_SYMBOL = Symbol.for("pi.routing.registry.v1");

export const PI_CACHE_HINTS_SYMBOL = Symbol.for("pi.cache.hints.v1");

export type PiRouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: "planned" | "trying" | "selected" | "success" | "failed";
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

export type PiRouteResolveHint = {
  sessionIdHash?: string;
  requestId?: string;
};

export type PiRouterAdapterV1 = {
  virtualProvider: string;
  resolveActiveRoute(
    virtualModelId: string,
    hint?: PiRouteResolveHint,
  ): PiRouteSnapshot | undefined;
  resolveCandidateRoutes?(virtualModelId: string): PiRouteSnapshot[];
  subscribe?(listener: (event: PiRouteSnapshot) => void): () => void;
};

export type PiRoutingRegistryV1 = {
  version: 1;
  registerRouter(adapter: PiRouterAdapterV1): () => void;
  getRouter(virtualProvider: string): PiRouterAdapterV1 | undefined;
};

export type PiCacheHintsInput = {
  sessionIdHash?: string;
  virtualProvider?: string;
  virtualModelId?: string;
  upstreamProvider?: string;
  upstreamModelId?: string;
  api?: string;
};

export type PiCacheHintsOutput = {
  systemPrompt?: string;
  promptCacheKey?: string;
  cacheRetention?: "long";
};

export type PiCacheHintsV1 = {
  version: 1;
  getHints(input: PiCacheHintsInput): PiCacheHintsOutput | undefined;
};

export type ProtocolGlobal = typeof globalThis & Record<symbol, unknown> & {
  __piCacheOptimizerRouter?: unknown;
  __piCacheOptimizerCacheKey__?: unknown;
};

export type ModelRegistryLike = {
  find?(provider: string, modelId: string): PiModel | undefined;
  getAvailable?(): PiModel[];
  getAll?(): PiModel[];
};

export type ContextWithOptionalModelRegistry = Pick<ExtensionContext, "sessionManager"> & {
  modelRegistry?: ModelRegistryLike;
};

/**
 * Hash a session id for use as a non-reversible opaque scope key.
 * Returns a 16-character hex string (64 bits of SHA-256 digest prefix)
 * suitable for scoping stats buckets without exposing the raw session id.
 */
export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export function getProtocolGlobal(): ProtocolGlobal {
  return globalThis as ProtocolGlobal;
}

export function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (isNonEmptyString(value)) return value.trim();
  }
  return undefined;
}

export function sessionHashFromContext(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  return sessionId ? hashSessionId(sessionId) : undefined;
}

export function isPiRouterAdapterV1(value: unknown): value is PiRouterAdapterV1 {
  const record = asRecord(value);
  return !!record && isNonEmptyString(record.virtualProvider) && typeof record.resolveActiveRoute === "function";
}

export function isRoutingRegistryV1(value: unknown): value is PiRoutingRegistryV1 {
  const record = asRecord(value);
  return !!record && record.version === 1 && typeof record.registerRouter === "function" && typeof record.getRouter === "function";
}

export function createRoutingRegistry(): PiRoutingRegistryV1 {
  const routers = new Map<string, PiRouterAdapterV1>();
  return {
    version: 1,
    registerRouter(adapter: PiRouterAdapterV1): () => void {
      if (!isPiRouterAdapterV1(adapter)) return () => undefined;
      const key = adapter.virtualProvider.trim();
      routers.set(key, adapter);
      return () => {
        if (routers.get(key) === adapter) routers.delete(key);
      };
    },
    getRouter(virtualProvider: string): PiRouterAdapterV1 | undefined {
      return routers.get(virtualProvider);
    },
  };
}

export function getRoutingRegistry(): PiRoutingRegistryV1 | undefined {
  const candidate = getProtocolGlobal()[PI_ROUTING_REGISTRY_SYMBOL];
  return isRoutingRegistryV1(candidate) ? candidate : undefined;
}

export function ensureRoutingRegistry(): PiRoutingRegistryV1 {
  const existing = getRoutingRegistry();
  if (existing) return existing;

  const created = createRoutingRegistry();
  getProtocolGlobal()[PI_ROUTING_REGISTRY_SYMBOL] = created;
  return created;
}

export function parseRouteStatus(value: unknown): PiRouteSnapshot["status"] | undefined {
  return value === "planned" || value === "trying" || value === "selected" || value === "success" || value === "failed"
    ? value
    : undefined;
}

export function parseRouteSnapshot(
  value: unknown,
  fallbackVirtualProvider?: string,
  fallbackVirtualModelId?: string,
): PiRouteSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const virtualProvider = firstNonEmptyString(record.virtualProvider, fallbackVirtualProvider);
  const virtualModelId = firstNonEmptyString(record.virtualModelId, record.virtualModel, fallbackVirtualModelId);
  const provider = firstNonEmptyString(record.provider, record.upstreamProvider, record.targetProvider);
  const modelId = firstNonEmptyString(record.modelId, record.upstreamModelId, record.targetModelId, record.responseModel);
  if (!virtualProvider || !virtualModelId || !provider || !modelId) return undefined;

  const timestamp = getNumber(record.timestamp) ?? Date.now();
  return {
    virtualProvider,
    virtualModelId,
    provider,
    modelId,
    api: firstNonEmptyString(record.api),
    canonicalModelId: firstNonEmptyString(record.canonicalModelId),
    routeLabel: firstNonEmptyString(record.routeLabel, record.label),
    status: parseRouteStatus(record.status),
    sessionIdHash: firstNonEmptyString(record.sessionIdHash),
    requestId: firstNonEmptyString(record.requestId),
    timestamp,
  };
}

export function resolveActiveRouteSnapshot(
  model: PiModel | undefined,
  ctx?: Pick<ExtensionContext, "sessionManager">,
): PiRouteSnapshot | undefined {
  if (!model || isNativeVirtualModel(model)) return undefined;
  const hint: PiRouteResolveHint | undefined = ctx ? { sessionIdHash: sessionHashFromContext(ctx) } : undefined;

  const adapter = getRoutingRegistry()?.getRouter(model.provider);
  if (adapter) {
    try {
      const snapshot = parseRouteSnapshot(
        adapter.resolveActiveRoute(model.id, hint),
        model.provider,
        model.id,
      );
      if (snapshot) return snapshot;
    } catch (error) {
      console.warn(`${LOG_PREFIX}: routing registry adapter failed`, error);
    }
  }

  // Temporary migration shim for the prototype global used by early router PRs.
  // New integrations should use Symbol.for("pi.routing.registry.v1") instead.
  const legacy = getProtocolGlobal().__piCacheOptimizerRouter;
  if (!legacy || !lower(model.provider).includes("router")) return undefined;
  try {
    if (typeof legacy === "function") {
      return parseRouteSnapshot(legacy(model.provider, model.id, hint), model.provider, model.id);
    }
    const legacyRecord = asRecord(legacy);
    const resolver = legacyRecord?.resolveActiveRoute;
    if (typeof resolver === "function") {
      return parseRouteSnapshot(resolver.call(legacy, model.id, hint), model.provider, model.id);
    }
    return parseRouteSnapshot(legacy, model.provider, model.id);
  } catch (error) {
    console.warn(`${LOG_PREFIX}: legacy routing global failed`, error);
    return undefined;
  }
}

export function resolveNativeVirtualCandidateModels(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel[] | undefined {
  if (!isNativeVirtualModel(model)) return undefined;
  const adapter = model ? getRoutingRegistry()?.getRouter(model.provider) : undefined;
  if (!adapter?.resolveCandidateRoutes) return undefined;

  try {
    const rawSnapshots = adapter.resolveCandidateRoutes(model.id);
    if (!Array.isArray(rawSnapshots) || rawSnapshots.length === 0) return undefined;
    const candidates: PiModel[] = [];
    for (const rawSnapshot of rawSnapshots) {
      const snapshot = parseRouteSnapshot(rawSnapshot, model.provider, model.id);
      if (!snapshot) return undefined;
      const candidate = findModelInRegistry(ctx?.modelRegistry, snapshot.provider, snapshot.modelId)
        ?? routeSnapshotToPiModel(snapshot, model);
      if (!isNonEmptyString(candidate.api)) return undefined;
      candidates.push(candidate);
    }
    return candidates;
  } catch {
    return undefined;
  }
}

export function canRewriteNativeVirtualPrompt(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): boolean {
  if (!isNativeVirtualModel(model) || !featureEnabled("virtualRewrite", VIRTUAL_REWRITE_ENV, false)) return false;
  const candidates = resolveNativeVirtualCandidateModels(model, ctx);
  return !!candidates?.length && candidates.every((candidate) =>
    candidate.api === "openai-completions" || candidate.api === "anthropic-messages",
  ) && candidates.every((candidate) => !isResponsesPromptRewriteBypassApi(candidate.api));
}

export function routeSnapshotToPiModel(snapshot: PiRouteSnapshot, fallback?: PiModel): PiModel {
  const sameIdentity = fallback?.provider === snapshot.provider && fallback?.id === snapshot.modelId;
  return {
    ...(sameIdentity ? fallback ?? {} : {}),
    id: snapshot.modelId,
    name: snapshot.canonicalModelId ?? snapshot.modelId,
    provider: snapshot.provider,
    api: snapshot.api ?? (sameIdentity ? fallback?.api : undefined) ?? "",
    baseUrl: sameIdentity ? fallback?.baseUrl ?? "" : "",
    reasoning: sameIdentity ? fallback?.reasoning ?? false : false,
    input: sameIdentity ? fallback?.input ?? ["text"] : ["text"],
    cost: sameIdentity
      ? fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: sameIdentity ? fallback?.contextWindow ?? 0 : 0,
    maxTokens: sameIdentity ? fallback?.maxTokens ?? 0 : 0,
    compat: sameIdentity ? fallback?.compat : undefined,
    [ROUTED_FALLBACK_MODEL_SYMBOL]: true,
  } as PiModel;
}

export function findModelInRegistry(registry: ModelRegistryLike | undefined, provider: string, id: string): PiModel | undefined {
  try {
    const found = registry?.find?.(provider, id);
    if (found) return found;

    const available = registry?.getAvailable?.() ?? [];
    const availableMatch = available.find((candidate) => candidate.provider === provider && candidate.id === id);
    if (availableMatch) return availableMatch;

    const all = registry?.getAll?.() ?? [];
    return all.find((candidate) => candidate.provider === provider && candidate.id === id);
  } catch {
    // Registry extensions are optional input; a malformed/throwing registry
    // must not turn a provider error hook into a Pi session failure.
    return undefined;
  }
}

export function applyConfiguredTransportToModel(model: PiModel, config: unknown): PiModel {
  const providers = asRecord(asRecord(config)?.providers);
  const provider = asRecord(providers?.[model.provider]);
  const customModel = findLastExactModelDefinition(
    Array.isArray(provider?.models) ? provider.models : undefined,
    model.id,
  );
  const configuredApi = customModel?.api ?? provider?.api;
  const configuredBaseUrl = customModel?.baseUrl ?? provider?.baseUrl;
  const api = isNonEmptyString(model.api)
    ? model.api
    : (isNonEmptyString(configuredApi) ? configuredApi : model.api);
  const baseUrl = isNonEmptyString(model.baseUrl)
    ? model.baseUrl
    : (isNonEmptyString(configuredBaseUrl) ? configuredBaseUrl : model.baseUrl);
  return api === model.api && baseUrl === model.baseUrl ? model : { ...model, api, baseUrl };
}

export function resolveRouteModel(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel | undefined {
  const nativeVirtualRoute = resolveNativeVirtualRouteModel(model, ctx);
  if (nativeVirtualRoute) return nativeVirtualRoute;

  const snapshot = resolveActiveRouteSnapshot(model, ctx);
  if (!snapshot) return undefined;

  const resolved = findModelInRegistry(ctx?.modelRegistry, snapshot.provider, snapshot.modelId)
    ?? routeSnapshotToPiModel(snapshot, model);
  return applyConfiguredTransportToModel(resolved, readEffectiveCompatConfig());
}

// Pi 0.99+ native virtual models (`pi.registerVirtualModel()`). `ctx.model`
// stays the virtual selection while Pi dispatches every request to a physical
// model; only assistant messages and the provider payload name that model.
// Older Pi hosts never produce this API, so every native-virtual path is inert.
export type NativeVirtualDispatch = { provider: string; id: string; api: string };

export function readSessionBranch(ctx: Pick<ExtensionContext, "sessionManager"> | undefined): unknown[] {
  try {
    const manager = ctx?.sessionManager as { getBranch?: () => unknown } | undefined;
    if (typeof manager?.getBranch !== "function") return [];
    const branch = manager.getBranch();
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

/**
 * Physical models that answered on the current session branch, newest first:
 * the latest successful response (Pi's `request.previous`) and the latest
 * response of any outcome (a failed attempt that a retry may reuse). The
 * catalog id in `message.model` is preferred over the echoed `responseModel`
 * because it is the id Pi dispatched and the registry knows.
 */
export function findNativeVirtualDispatches(ctx: Pick<ExtensionContext, "sessionManager"> | undefined): {
  latestSuccessful?: NativeVirtualDispatch;
  latestAny?: NativeVirtualDispatch;
} {
  const branch = readSessionBranch(ctx);
  let latestSuccessful: NativeVirtualDispatch | undefined;
  let latestAny: NativeVirtualDispatch | undefined;
  for (let index = branch.length - 1; index >= 0 && !latestSuccessful; index--) {
    const entry = asRecord(branch[index]);
    if (entry?.type !== "message") continue;
    const message = getAssistantRecord(entry.message);
    if (!message || isNativeVirtualModel(message)) continue;
    const dispatch = nativeVirtualDispatchFromMessage(message);
    if (!dispatch) continue;
    latestAny ??= dispatch;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") latestSuccessful = dispatch;
  }
  return { latestSuccessful, latestAny };
}

export function nativeVirtualDispatchFromMessage(message: unknown): NativeVirtualDispatch | undefined {
  const record = getAssistantRecord(message);
  if (!record || isNativeVirtualModel(record)) return undefined;
  const provider = firstNonEmptyString(record.provider);
  const id = firstNonEmptyString(record.model, record.responseModel);
  return provider && id ? { provider, id, api: firstNonEmptyString(record.api) ?? "" } : undefined;
}

export function nativeVirtualDispatchToModel(
  dispatch: NativeVirtualDispatch,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel {
  // A virtual model hides a same-id physical model in the catalog, so a
  // registry hit that is itself virtual is not physical metadata.
  const registered = findModelInRegistry(ctx?.modelRegistry, dispatch.provider, dispatch.id);
  const model = registered && !isNativeVirtualModel(registered)
    ? registered
    : ({
      provider: dispatch.provider,
      id: dispatch.id,
      name: dispatch.id,
      api: dispatch.api,
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 0,
      [ROUTED_FALLBACK_MODEL_SYMBOL]: true,
    } as PiModel);
  return applyConfiguredTransportToModel(model, readEffectiveCompatConfig());
}

/**
 * Physical model behind a native virtual selection for pre-request UX (footer,
 * doctor, compat, stats, reset, fix): the model that answered last on this
 * session branch, matching Pi's own routed-model display and context limits.
 */
export function resolveNativeVirtualRouteModel(
  model: PiModel | undefined,
  ctx?: ContextWithOptionalModelRegistry,
): PiModel | undefined {
  if (!isNativeVirtualModel(model)) return undefined;
  const { latestSuccessful, latestAny } = findNativeVirtualDispatches(ctx);
  const dispatch = latestSuccessful ?? latestAny;
  return dispatch ? nativeVirtualDispatchToModel(dispatch, ctx) : undefined;
}

export function getProviderPayloadModelId(payload: unknown): string | undefined {
  const record = asRecord(payload);
  // Pi's built-in transports put the dispatched catalog id in `model`
  // (OpenAI, Anthropic, Google, Mistral) or `modelId` (Bedrock Converse).
  return firstNonEmptyString(record?.model, record?.modelId);
}

export function physicalModelsWithId(candidates: readonly PiModel[] | undefined, id: string): PiModel[] {
  return (candidates ?? []).filter((candidate) => candidate.id === id
    && !isNativeVirtualModel(candidate)
    && !isRouterModel(candidate)
    && !getRoutingRegistry()?.getRouter(candidate.provider));
}

/**
 * Physical model of one native-virtual request. `before_provider_request`
 * carries only the payload and `ctx.model` stays virtual, so the payload's
 * dispatched model id is matched against credentialed physical models (a
 * router may only route to those). A unique provider match wins. An id shared
 * by several credentialed providers is used only when every candidate gets the
 * same request treatment (`requestPolicyKey`); the identity then stays
 * ambiguous so response evidence is never pinned to a guessed provider.
 * Differing policies return undefined so identity-dependent request mutations
 * fail closed. Without a credentialed match, the sticky branch candidates and
 * then the full catalog are consulted.
 */
export function resolveNativeVirtualRequestModel(
  model: PiModel | undefined,
  payload: unknown,
  ctx?: ContextWithOptionalModelRegistry,
  requestPolicyKey?: (candidate: PiModel) => string,
): { model: PiModel; identityAmbiguous: boolean } | undefined {
  if (!isNativeVirtualModel(model)) return undefined;
  const payloadModelId = getProviderPayloadModelId(payload);
  if (!payloadModelId) return undefined;
  const config = readEffectiveCompatConfig();
  // null: no candidate; undefined: ambiguous with differing request policies.
  const pick = (matches: PiModel[]): { model: PiModel; identityAmbiguous: boolean } | undefined | null => {
    if (matches.length === 0) return null;
    const configured = matches.map((candidate) => applyConfiguredTransportToModel(candidate, config));
    if (new Set(configured.map((candidate) => candidate.provider)).size === 1) {
      return { model: configured[0], identityAmbiguous: false };
    }
    const policies = requestPolicyKey ? new Set(configured.map(requestPolicyKey)) : undefined;
    return policies?.size === 1 ? { model: configured[0], identityAmbiguous: true } : undefined;
  };
  try {
    const credentialed = pick(physicalModelsWithId(ctx?.modelRegistry?.getAvailable?.(), payloadModelId));
    if (credentialed !== null) return credentialed;

    const { latestSuccessful, latestAny } = findNativeVirtualDispatches(ctx);
    for (const dispatch of [latestSuccessful, latestAny]) {
      if (dispatch?.id === payloadModelId) {
        return { model: nativeVirtualDispatchToModel(dispatch, ctx), identityAmbiguous: false };
      }
    }

    return pick(physicalModelsWithId(ctx?.modelRegistry?.getAll?.(), payloadModelId)) ?? undefined;
  } catch {
    // Registry access is optional input; never fail the provider request hook.
    return undefined;
  }
}

export function describeNativeVirtualRouteNote(selected: PiModel | undefined, effective: PiModel | undefined): string | undefined {
  if (!selected || !isNativeVirtualModel(selected)) return undefined;
  // Without a routed response, the not-applicable text explains the state.
  if (!effective || isNativeVirtualModel(effective)) return undefined;
  return `🔀 Native virtual model ${modelKey(selected)} → latest routed physical model ${modelKey(effective)}. The diagnostics below apply to that physical model; Pi may route later requests elsewhere.`;
}

export function installCacheHintsService(
  service: PiCacheHintsV1,
  options: { discardPrevious?: (value: unknown) => boolean } = {},
): () => void {
  const globals = getProtocolGlobal();
  const previous = globals[PI_CACHE_HINTS_SYMBOL];
  globals[PI_CACHE_HINTS_SYMBOL] = service;
  return () => {
    if (globals[PI_CACHE_HINTS_SYMBOL] !== service) return;
    if (previous !== undefined && !options.discardPrevious?.(previous)) {
      globals[PI_CACHE_HINTS_SYMBOL] = previous;
    } else {
      delete globals[PI_CACHE_HINTS_SYMBOL];
    }
  };
}

// ── Non-GPT OpenAI-compatible model detection ──────────────────────

export function isRouterModel(model: PiModel | undefined): boolean {
  return lower(model?.provider) === "router";
}
