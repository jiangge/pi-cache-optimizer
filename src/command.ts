import { type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { selectAdapterForModel } from "./adapters.ts";
import { backupTimestamp, hashText } from "./atomic-fs.ts";
import { FEATURE_COMMAND_MAP } from "./command-completion.ts";
import { type PiModel, asRecord } from "./common.ts";
import { describeMissingCacheCompatForModel, getModelsJsonDisplayPath, isAdaptiveThinkingCompatApplicable } from "./compat-advice.ts";
import { resolveEffectiveCompatFromConfig } from "./compat-config.ts";
import { FOOTER_MODE_ENV, type FooterStatsMode, formatOptimizerRuntimeMode, formatPersistentFeatureConfig, persistedCacheOptimizerConfig, persistedFooterStatsMode, readPersistedCacheOptimizerConfig, resolveFooterStatsMode, setPersistedCacheOptimizerConfig, setRuntimeOptimizerEnabled, writePersistedCacheOptimizerConfig, writePersistedFeature, writePersistedFooterMode } from "./config.ts";
import { buildCompatDiagnosis, buildDoctorDiagnosis, buildLowHitDiagnosis, getCompatCheckNotApplicableLines, isCompatCheckApplicable, isDeepSeekCompatCheckApplicable, isPromptCacheKeyUnsupportedApplicable } from "./diagnostics.ts";
import { locateModelOverrideInJsonc, parseJsonc } from "./jsonc.ts";
import { invalidateModelsConfigCache, isValidModelsConfigForEffectiveCompat, modelKey } from "./model-identity.ts";
import { analyzeModelsJsonForMissingEntry, applyModelsJsonFixTransaction, chooseFixPlacement, composeFixInsertion, composeModelOverrideInsertion, composeProviderAffinityInsertion, createModelsJsonFixReceipt, formatCompatKeysForInsertion, formatMissingEntryManualSnippet, isActionableModelsJsonFixReceipt, locateModelInJsonc, markModelsJsonFixReceiptRolledBack, prepareModelsJsonRollback, readModelsJsonFixReceipt, readModelsJsonFixReceiptSnapshot, resolveExplicitCompatValue, selfCheckFix, selfCheckMissingEntryInsertion, validateModelsJsonRollback, writeModelsJsonFixReceipt } from "./models-json-fix.ts";
import { MODELS_JSON_PATH } from "./paths.ts";
import { applyPromptCacheKeyConfigFix, isActionablePromptCacheKeyConfigReceipt, readPromptCacheKeyConfigReceiptSnapshot, rollbackPromptCacheKeyConfig } from "./prompt-cache-key-config.ts";
import { getEffectiveCompatValueSource, isPromptCacheKeyOmittedForModel } from "./request-payload.ts";
import { describeNativeVirtualRouteNote, resolveRouteModel } from "./routing.ts";
import { buildAllStatsOutput, buildContributorsStatsOutput, buildSessionStatsOutput } from "./stats-report.ts";
import { type FixSuggestion } from "./fix-types.ts";
import { type ProviderRequestState } from "./request-state.ts";
import { type CacheStats, type ShardAggregate } from "./stats-store.ts";
import { type CacheUsageSample } from "./stats-report.ts";
import { describeSkillCompressionOutcome } from "./prompt-rewrite.ts";

/**
 * Everything the command needs from the extension instance. The extension keeps this state in closures
 * (it is shared with the event hooks), so values that are reassigned there are exposed through getters.
 */
export type CommandRuntime = {
  syncSessionHash(ctx: Pick<ExtensionContext, "sessionManager">): void;
  resetCurrentSessionStats(): Promise<void>;
  resetStatsForModel(model: PiModel): Promise<void>;
  flushPersistCacheStats(ctx?: ExtensionContext, lifecycleState?: "active" | "closed"): Promise<void>;
  publishStatus(ctx: ExtensionContext, model?: PiModel): Promise<void>;
  refreshShardAggregate(): Promise<ShardAggregate>;
  sessionModelKey(model: { provider: string; id: string }): string;
  getRecentSamples(modelKeyStr: string): CacheUsageSample[];
  promptCacheKeyFixApplies(model: PiModel): boolean;
  buildCommandFixSuggestion(model: PiModel): FixSuggestion | undefined;
  buildPromptCacheKeyConfigPreview(model: PiModel): string[];
  providerRequestStates: ProviderRequestState[];
  promptCacheRetention400Models: Set<string>;
  promptCacheKeyRejectedModels: Set<string>;
  anthropicTtlOrderErrorModels: Set<string>;
  sendSessionAffinityHeaders403Models: Set<string>;
  openAISdkHeader403Models: Set<string>;
  getCacheStatsTotalsByModel(): Record<string, CacheStats>;
  getCurrentSessionHashSet(): boolean;
  getCurrentSessionHash(): string;
  getLastStatusText(): string | undefined;
  clearLastStatusText(): void;
};

export function createCacheOptimizerCommandHandler(runtime: CommandRuntime) {
  const {
    anthropicTtlOrderErrorModels,
    buildCommandFixSuggestion,
    buildPromptCacheKeyConfigPreview,
    flushPersistCacheStats,
    getRecentSamples,
    openAISdkHeader403Models,
    promptCacheKeyFixApplies,
    promptCacheKeyRejectedModels,
    promptCacheRetention400Models,
    providerRequestStates,
    publishStatus,
    refreshShardAggregate,
    resetCurrentSessionStats,
    resetStatsForModel,
    sendSessionAffinityHeaders403Models,
    sessionModelKey,
    syncSessionHash,
  } = runtime;
  const { getCacheStatsTotalsByModel, getCurrentSessionHashSet, getCurrentSessionHash, getLastStatusText, clearLastStatusText } = runtime;

  return async function handleCacheOptimizerCommand(
    args: string,
    cmdCtx: ExtensionCommandContext,
  ): Promise<void> {
    syncSessionHash(cmdCtx);
    const selectedModel = cmdCtx.model;
    const model = resolveRouteModel(selectedModel, cmdCtx) ?? selectedModel;
    const commandParts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const subcommand = commandParts[0] || "help";

      if (subcommand === "enable") {
        setRuntimeOptimizerEnabled(true);
        await resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx);
        await publishStatus(cmdCtx, model);
        cmdCtx.ui.notify(`✅ Pi Cache Optimizer enabled for this Pi process. Local footer stats were reset for before/after comparison.\n${formatOptimizerRuntimeMode()}`, "info");
      } else if (subcommand === "disable") {
        setRuntimeOptimizerEnabled(false);
        providerRequestStates.length = 0;
        await resetCurrentSessionStats();
        await flushPersistCacheStats(cmdCtx);
        await publishStatus(cmdCtx, model);
        cmdCtx.ui.notify(`⏸️ Pi Cache Optimizer disabled for this Pi process. Local footer stats were reset and will keep collecting while disabled for comparison.\n${formatOptimizerRuntimeMode()}`, "warning");
      } else if (subcommand === "doctor") {
        await refreshShardAggregate();
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const diagnosis = buildDoctorDiagnosis(model, { promptCacheRetention400: promptCacheRetention400Models.has(modelKey(model)), promptCacheKey400: promptCacheKeyRejectedModels.has(modelKey(model)), anthropicTtlOrderError: anthropicTtlOrderErrorModels.has(modelKey(model)), sessionAffinity403: sendSessionAffinityHeaders403Models.has(modelKey(model)), openAISdkHeader403: openAISdkHeader403Models.has(modelKey(model)) });
        const adapter = selectAdapterForModel(model);
        const sk = model ? sessionModelKey(model) : undefined;
        const statsState = model ? getCacheStatsTotalsByModel()[modelKey(model)] : undefined;
        const samples = sk ? getRecentSamples(sk) : [];
        const lowHitLines = buildLowHitDiagnosis(model, adapter, statsState, samples);
        const routeNote = describeNativeVirtualRouteNote(selectedModel, model);
        const fullDiagnosis = [routeNote, diagnosis, describeSkillCompressionOutcome(), ...lowHitLines].filter((line) => line !== undefined).join("\n");
        cmdCtx.ui.notify(fullDiagnosis, "info");
      } else if (subcommand === "stats") {
        const aggregate = await refreshShardAggregate();
        const statsMode = commandParts[1];
        if (statsMode === "all") {
          cmdCtx.ui.notify(buildAllStatsOutput(aggregate), "info");
        } else if (statsMode === "contributors") {
          cmdCtx.ui.notify(buildContributorsStatsOutput(aggregate, model, getCurrentSessionHashSet() ? getCurrentSessionHash() : undefined), "info");
        } else if (statsMode) {
          cmdCtx.ui.notify("Usage: /cache-optimizer stats [all|contributors]", "info");
        } else {
          const sessionModels = getCurrentSessionHashSet() ? aggregate.bySession[getCurrentSessionHash()] ?? {} : {};
          cmdCtx.ui.notify(buildSessionStatsOutput(sessionModels, model, aggregate.modelRefsByKey), "info");
        }
      } else if (subcommand === "config") {
        const configKey = commandParts[1];
        const requestedMode = commandParts[2];
        const feature = configKey ? FEATURE_COMMAND_MAP[configKey] : undefined;
        if (feature && (requestedMode === "on" || requestedMode === "off")) {
          try {
            await writePersistedFeature(feature, requestedMode === "on");
            clearLastStatusText();
            await publishStatus(cmdCtx, model);
            cmdCtx.ui.notify(`✅ ${configKey} set to ${requestedMode}. Persistent config overrides its environment variable.`, "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ Could not update ${configKey}: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        if (configKey === "reset") {
          try {
            await writePersistedCacheOptimizerConfig({ version: 2, footerMode: persistedFooterStatsMode, promptCacheKey: persistedCacheOptimizerConfig.promptCacheKey });
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify("✅ Feature configuration reset. Environment variables now apply again.", "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ Could not reset feature configuration: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        if (!configKey) {
          cmdCtx.ui.notify(formatPersistentFeatureConfig() + `\n• Footer mode: ${resolveFooterStatsMode(persistedFooterStatsMode).mode}` + "\n\n" +
            "Usage: /cache-optimizer config <feature> on|off | footer-mode total|session|process | reset", "info");
          return;
        }
        if (configKey !== "footer-mode" || !requestedMode || !["session", "total", "process"].includes(requestedMode)) {
          const resolved = resolveFooterStatsMode(persistedFooterStatsMode);
          cmdCtx.ui.notify(
            `Usage: /cache-optimizer config footer-mode total|session|process\n` +
            `       /cache-optimizer config prompt-rewrite|virtual-rewrite|skill-compression|openai-cache-key|tool-order on|off\n` +
            `       /cache-optimizer config reset\n` +
            `Current footer mode: ${resolved.mode} (${resolved.source})`,
            "info",
          );
          return;
        }

        const nextMode = requestedMode as FooterStatsMode;
        try {
          await writePersistedFooterMode(nextMode);
          setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
          clearLastStatusText();
          await publishStatus(cmdCtx, model);
          const resolved = resolveFooterStatsMode(persistedFooterStatsMode);
          cmdCtx.ui.notify(
            `✅ Footer mode set to ${resolved.mode}. Persistent config overrides ${FOOTER_MODE_ENV}.`,
            "info",
          );
        } catch (error) {
          cmdCtx.ui.notify(
            `❌ Could not update footer mode config: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      } else if (subcommand === "compat") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const compatResult = buildCompatDiagnosis(model);
        const compatRouteNote = describeNativeVirtualRouteNote(selectedModel, model);
        const withRouteNote = (text: string): string => compatRouteNote ? `${compatRouteNote}\n${text}` : text;
        if (compatResult) {
          cmdCtx.ui.notify(withRouteNote(compatResult), "warning");
        } else {
          cmdCtx.ui.notify(
            withRouteNote(isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)
              ? "✅ Compat fully configured."
              : getCompatCheckNotApplicableLines(model).join("\n")),
            "info",
          );
        }
      } else if (subcommand === "rollback") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const configReceiptSnapshot = await readPromptCacheKeyConfigReceiptSnapshot();
        const configReceipt = configReceiptSnapshot?.receipt;
        const modelsReceipt = await readModelsJsonFixReceipt();
        const useConfigReceipt = isActionablePromptCacheKeyConfigReceipt(configReceipt) &&
          configReceipt.provider === model.provider &&
          configReceipt.modelId === model.id &&
          (!isActionableModelsJsonFixReceipt(modelsReceipt) || modelsReceipt.provider !== model.provider ||
            (modelsReceipt.placement !== "provider" && modelsReceipt.modelId !== model.id) || configReceipt.appliedAt >= modelsReceipt.appliedAt);
        if (useConfigReceipt) {
          if (!cmdCtx.hasUI) {
            cmdCtx.ui.notify("❌ Rollback requires interactive confirmation. No changes were made.\nRun /cache-optimizer rollback in Pi's interactive UI to restore the prompt-cache-key setting.", "warning");
            return;
          }
          const confirmed = await cmdCtx.ui.confirm(
            "Cache Optimizer — Rollback prompt_cache_key opt-out",
            `Model: ${modelKey(model)}\nAction: restore the extension config before the confirmed opt-out.\nFooter mode and unrelated configuration will be preserved.\nAfterward, run /reload or restart Pi.\n\nProceed with rollback?`,
          );
          if (!confirmed) {
            cmdCtx.ui.notify("No changes were made. Rollback canceled by user.", "info");
            return;
          }
          try {
            if (!configReceiptSnapshot) throw new Error("prompt-cache-key receipt changed since the rollback preview");
            await rollbackPromptCacheKeyConfig(configReceiptSnapshot);
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify(`✅ Restored prompt_cache_key behavior for ${modelKey(model)}. Run /reload or restart Pi for the change to take effect.`, "info");
          } catch (error) {
            cmdCtx.ui.notify(`❌ Prompt cache key rollback refused: ${error instanceof Error ? error.message : String(error)}. No changes were made.`, "error");
          }
          return;
        }
        if (!cmdCtx.hasUI) {
          const receipt = await readModelsJsonFixReceipt();
          const backupHint = receipt && isActionableModelsJsonFixReceipt(receipt)
            ? ` The recorded backup is ${receipt.backupFile} next to ${getModelsJsonDisplayPath()}.`
            : " Check the recorded models.json backup manually if a fix receipt exists.";
          cmdCtx.ui.notify(
            "❌ Rollback requires interactive confirmation. No changes were made.\n" +
            `Run /cache-optimizer rollback in Pi's interactive UI.${backupHint} Then run /reload.`,
            "warning",
          );
          return;
        }

        const receiptSnapshot = await readModelsJsonFixReceiptSnapshot();
        const receipt = receiptSnapshot?.receipt;
        if (!receiptSnapshot || !isActionableModelsJsonFixReceipt(receipt)) {
          cmdCtx.ui.notify("ℹ️ No unapplied /cache-optimizer fix receipt was found.", "info");
          return;
        }
        if (receipt.provider !== model.provider || (receipt.placement !== "provider" && receipt.modelId !== model.id)) {
          cmdCtx.ui.notify(
            `ℹ️ The latest fix receipt is for ${receipt.provider}/${receipt.modelId}, not the active model ${model.provider}/${model.id}. ` +
            "Switch to the matching model before running rollback. No changes were made.",
            "warning",
          );
          return;
        }

        const rollback = await prepareModelsJsonRollback(receiptSnapshot);
        if ("error" in rollback) {
          cmdCtx.ui.notify(`ℹ️ ${rollback.error}`, "info");
          return;
        }

        const rollbackScope = rollback.mode === "exact"
          ? "restore the exact pre-fix models.json because the file is unchanged since the fix"
          : "restore only the receipt-owned compat scalar keys and preserve subsequent user changes";
        const rollbackPreview = [
          `Rollback transaction ${rollback.receipt.transactionId}:`,
          `Model: ${rollback.receipt.provider}/${rollback.receipt.modelId}`,
          `Action: ${rollbackScope}.`,
          `A new rollback backup will be written to: ${rollback.rollbackBackupPath}`,
          "Comments, credentials, unrelated fields, and the existing access mode will be preserved.",
          "Afterward, run /reload or restart Pi for the configuration change to take effect.",
          "",
          "Proceed with rollback?",
        ].join("\n");
        const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Rollback", rollbackPreview);
        if (!confirmed) {
          cmdCtx.ui.notify("No changes were made. Rollback canceled by user.", "info");
          return;
        }

        try {
          const result = await applyModelsJsonFixTransaction(
            rollback.modifiedText,
            rollback.rollbackBackupPath,
            (writtenText) => validateModelsJsonRollback(
              writtenText,
              rollback.receipt,
              rollback.expectedResultHash,
            ),
            {
              expectedCurrentHash: rollback.currentHash,
              expectedCurrentMode: rollback.fileMode,
              receiptGuard: rollback.receiptSnapshot,
              purpose: "rollback",
              onCommitted: async () => {
                await markModelsJsonFixReceiptRolledBack(rollback.receiptSnapshot);
              },
            },
          );
          if ("postCheckError" in result) {
            cmdCtx.ui.notify(
              `❌ Rollback self-check failed: ${result.postCheckError}\n` +
              `The rollback backup at ${rollback.rollbackBackupPath} was restored. No changes applied.`,
              "error",
            );
            return;
          }
          invalidateModelsConfigCache();
          cmdCtx.ui.notify(
            `✅ Rollback completed for ${rollback.receipt.provider}/${rollback.receipt.modelId}.\n` +
            `Rollback backup saved to: ${rollback.rollbackBackupPath}\n` +
            "The receipt was marked as rolled back. Run /reload or restart Pi for the change to take effect.",
            "info",
          );
        } catch (rollbackError) {
          cmdCtx.ui.notify(
            `❌ Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}\n` +
            "No automatic overwrite was performed; use the recorded backup for manual guidance.",
            "error",
          );
        }
      } else if (subcommand === "reset") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }
        const adapter = selectAdapterForModel(model);
        if (!adapter) {
          cmdCtx.ui.notify("ℹ️ Active model does not match a cache adapter. No stats to reset.", "info");
          return;
        }

        const displayKey = modelKey(model);

        // Reset local footer stats for the effective active model. If the
        // selected model is a virtual router and the protocol exposes a live
        // route, this clears the real upstream bucket, not the router shell.
        await resetStatsForModel(model);

        // Persist immediately.
        await flushPersistCacheStats(cmdCtx);

        // Update footer to show 0/0.
        await publishStatus(cmdCtx, model);

        cmdCtx.ui.notify(
          `✅ Reset local footer cache stats for "${displayKey}". ` +
          "Upstream provider prompt cache was not modified. " +
          "New requests will start a fresh local stats bucket for this provider/model.",
          "info",
        );
      } else if (subcommand === "fix") {
        if (!model) {
          cmdCtx.ui.notify("No active model selected. Select a model first with /model or pi --model.", "warning");
          return;
        }

        const promptCacheKeyRequested = commandParts[1] === "prompt-cache-key";
        const promptCacheKeyFixRequested = promptCacheKeyRequested || promptCacheKeyFixApplies(model);
        if (promptCacheKeyRequested && !isPromptCacheKeyUnsupportedApplicable(model)) {
          cmdCtx.ui.notify("ℹ️ Prompt cache key opt-out applies only to a known OpenAI-compatible provider/model endpoint. No changes were made.", "info");
          return;
        }
        const suggestion = promptCacheKeyFixRequested ? undefined : buildCommandFixSuggestion(model);

        if (promptCacheKeyFixRequested) {
          if (isPromptCacheKeyOmittedForModel(model)) {
            cmdCtx.ui.notify(`✅ prompt_cache_key is already omitted for "${modelKey(model)}".`, "info");
            return;
          }
          if (!cmdCtx.hasUI) {
            cmdCtx.ui.notify(
              "❌ Non-interactive terminal detected. Prompt cache key opt-out requires UI confirmation. No changes were made.\n" +
              `Run /cache-optimizer fix prompt-cache-key in Pi's interactive UI for ${modelKey(model)}.`,
              "warning",
            );
            return;
          }
          const preview = [
            "📝 Preview of extension configuration change:",
            ...buildPromptCacheKeyConfigPreview(model),
            "",
            "⚠️ Risk notice:",
            "  1. This affects all sessions using this exact provider/model.",
            "  2. Provider prompt-cache reuse may decrease because both key spellings are removed.",
            "  3. This does not modify Pi's models.json, credentials, prompts, headers, or other models.",
            "  4. The extension config will be backed up and Pi must be reloaded/restarted.",
            "",
            "Apply this persistent opt-out?",
          ].join("\n");
          const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Omit prompt_cache_key", preview);
          if (!confirmed) {
            cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
            return;
          }
          try {
            const result = await applyPromptCacheKeyConfigFix(model);
            setPersistedCacheOptimizerConfig(readPersistedCacheOptimizerConfig());
            cmdCtx.ui.notify(
              `✅ Prompt cache key opt-out saved for ${modelKey(model)}.\n` +
              `Config backup saved to: ${result.backupPath}\n` +
              "Run /reload or restart Pi for the change to take effect. Use /cache-optimizer rollback to restore it.",
              "info",
            );
          } catch (error) {
            cmdCtx.ui.notify(`❌ Could not save prompt cache key opt-out: ${error instanceof Error ? error.message : String(error)}. No changes were made.`, "error");
          }
          return;
        }

        if (!suggestion) {
          const key = modelKey(model);
          cmdCtx.ui.notify(`✅ Nothing to fix for "${key}". Compat already configured.`, "info");
          return;
        }

        if (!cmdCtx.hasUI) {
          // No UI — refuse to write, show manual guidance instead.
          const compatResult = buildCompatDiagnosis(model);
          const snippet = formatMissingEntryManualSnippet(
            suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
          );
          const manualLines = [
            `❌ Non-interactive terminal detected. Auto-fix requires UI confirmation.`,
            "",
            `Edit ${getModelsJsonDisplayPath()} and run /reload.`,
          ];
          if (promptCacheRetention400Models.has(modelKey(model))) {
            manualLines.push(
              "",
              "💡 This model returned HTTP 400 for prompt_cache_retention.",
              "Create or edit the entry below to override supportsLongCacheRetention to false.",
            );
          }
          if (anthropicTtlOrderErrorModels.has(modelKey(model))) {
            manualLines.push(
              "",
              "💡 This model returned an Anthropic cache-control TTL ordering error.",
              "Create or edit the entry below to override supportsLongCacheRetention to false.",
            );
          }
          if (sendSessionAffinityHeaders403Models.has(modelKey(model))) {
            manualLines.push(
              "",
              "💡 This model returned HTTP 403 while sendSessionAffinityHeaders was enabled.",
              "Create or edit the entry below to override sendSessionAffinityHeaders to false.",
            );
          }
          manualLines.push(
            "",
            "Add these compat keys at Pi's highest-precedence model override path:",
            `providers["${suggestion.providerLabel}"] -> modelOverrides -> "${suggestion.modelId}" -> compat:`,
            formatCompatKeysForInsertion(suggestion.compatKeys),
          );
          if (snippet.length > 0) {
            manualLines.push(
              "",
              "If the provider/model is missing (common for API-logged-in channels such as",
              `opencode go), add a minimal entry under "providers" (keep existing auth as-is):`,
              "",
              snippet,
            );
          }
          if (compatResult) {
            manualLines.push("", compatResult);
          }
          cmdCtx.ui.notify(manualLines.join("\n"), "warning");
          return;
        }

        // Read the models.json file
        let originalText: string;
        try {
          originalText = await readFile(MODELS_JSON_PATH, "utf8");
        } catch {
          cmdCtx.ui.notify(`❌ Could not read ${MODELS_JSON_PATH}. File may not exist.`, "error");
          return;
        }

        // Locate the model entry. API-logged-in providers (e.g. opencode go)
        // may not appear in models.json at all.
        const location = locateModelInJsonc(originalText, suggestion.providerLabel, suggestion.modelId);
        if (!location) {
          const diagnosis = analyzeModelsJsonForMissingEntry(originalText, suggestion.providerLabel, suggestion.modelId);
          const parsedOriginal = (() => { try { return parseJsonc(originalText); } catch { return undefined; } })();
          const provider = asRecord(asRecord(parsedOriginal)?.providers)?.[suggestion.providerLabel];
          const explicit = resolveExplicitCompatValue(parsedOriginal, suggestion.providerLabel, suggestion.modelId, "sendSessionAffinityHeaders");
          const targetOverrideLocation = locateModelOverrideInJsonc(
            originalText, suggestion.providerLabel, suggestion.modelId,
          );
          const hasTargetOverride = (targetOverrideLocation?.modelOverrideObjectBrace ?? -1) >= 0;
          const providerPlan = diagnosis && diagnosis.scenario !== "provider_missing" &&
            isValidModelsConfigForEffectiveCompat(parsedOriginal) && asRecord(provider) &&
            Object.keys(suggestion.compatKeys).length === 1 && suggestion.compatKeys.sendSessionAffinityHeaders === true &&
            !suggestion.forceModelLevel && !hasTargetOverride && explicit === undefined &&
            getEffectiveCompatValueSource(model, parsedOriginal, "sendSessionAffinityHeaders") === undefined
              ? composeProviderAffinityInsertion(originalText, suggestion.providerLabel)
              : undefined;
          if (providerPlan) {
            const checkProvider = (writtenText: string): string | null => {
              try {
                const changed = parseJsonc(writtenText);
                if (!isValidModelsConfigForEffectiveCompat(changed)) return "provider config is invalid";
                if (resolveEffectiveCompatFromConfig(model, changed).sendSessionAffinityHeaders !== true) return "affinity flag is not effective";
                const reverted = JSON.parse(JSON.stringify(changed)) as Record<string, unknown>;
                const target = asRecord(asRecord(reverted.providers)?.[suggestion.providerLabel]);
                const compat = asRecord(target?.compat);
                if (!target || !compat || compat.sendSessionAffinityHeaders !== true) return "provider affinity key is missing";
                delete compat.sendSessionAffinityHeaders;
                const originalCompat = asRecord(asRecord(provider)?.compat);
                if (!originalCompat) delete target.compat;
                return JSON.stringify(reverted) === JSON.stringify(parsedOriginal) ? null : "unrelated configuration was altered";
              } catch { return "invalid provider JSONC"; }
            };
            const checkError = checkProvider(providerPlan.modifiedText);
            if (checkError) {
              cmdCtx.ui.notify(`❌ Provider-level self-check failed: ${checkError}. No changes were made.`, "error");
              return;
            }
            const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${backupTimestamp()}`;
            const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Fix provider affinity", [
              `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
              `Location: ${providerPlan.placementLabel}`,
              `Compat JSON to write: ${JSON.stringify(suggestion.compatKeys)}`,
              `⚠️ This affects all models using this provider across all sessions; model-level overrides remain authoritative.`,
              `A timestamped backup will be written to: ${backupPath}`,
              "Run /reload or restart Pi for the change to take effect.",
              "Apply these changes?",
            ].join("\n"));
            if (!confirmed) {
              cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
              return;
            }
            const receipt = createModelsJsonFixReceipt(
              originalText, providerPlan.modifiedText, suggestion.providerLabel, suggestion.modelId,
              "provider", suggestion.compatKeys, true, backupPath,
            );
            if (!receipt) {
              cmdCtx.ui.notify("❌ Could not create a privacy-safe fix receipt. No changes were made.", "error");
              return;
            }
            try {
              const result = await applyModelsJsonFixTransaction(providerPlan.modifiedText, backupPath, checkProvider, {
                expectedCurrentHash: hashText(originalText), purpose: "fix",
                onCommitted: async () => writeModelsJsonFixReceipt(receipt),
              });
              if ("postCheckError" in result) {
                cmdCtx.ui.notify(`❌ Post-write self-check failed: ${result.postCheckError}. Backup restored.`, "error");
                return;
              }
              invalidateModelsConfigCache();
              cmdCtx.ui.notify(`✅ Fix applied to ${getModelsJsonDisplayPath()}.\nBackup saved to: ${backupPath}\nRun /reload or restart Pi.`, "info");
            } catch (error) {
              cmdCtx.ui.notify(`❌ Write failed: ${error instanceof Error ? error.message : String(error)}. Backup may be at: ${backupPath}`, "error");
            }
            return;
          }
          if (diagnosis && cmdCtx.hasUI) {
            const overrideLocation = locateModelOverrideInJsonc(
              originalText, suggestion.providerLabel, suggestion.modelId,
            );
            const repairsExistingOverride = (overrideLocation?.modelOverrideObjectBrace ?? -1) >= 0;
            // Prefer a modelOverrides edit when models[] has no target entry.
            const plan = composeModelOverrideInsertion(
              originalText, suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
            );
            if (!plan) {
              cmdCtx.ui.notify(
                `❌ Could not safely locate a modelOverrides insertion point.\n` +
                `Falling back to manual guidance. No changes were made.`,
                "error",
              );
            } else {
            const checkError = selfCheckMissingEntryInsertion(
              originalText, plan.modifiedText,
              suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys,
              model,
            );
            if (checkError !== null) {
              // Fall through to manual guidance.
              cmdCtx.ui.notify(
                `❌ Self-check would fail for auto-created entry: ${checkError}\n` +
                `Falling back to manual guidance. No changes were made.`,
                "error",
              );
              // Continue to manual guidance below.
            } else {
              const keysPreview = JSON.stringify(suggestion.compatKeys, null, 2);
              const ts = backupTimestamp();
              const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${ts}`;
              const previewLines = [
                `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
                ``,
                `Location: ${plan.placementLabel}`,
                `Compat JSON to write:`,
                keysPreview,
                ``,
                `⚠️  Risk notice:`,
                repairsExistingOverride
                  ? `  1. This updates the existing modelOverrides entry for "${suggestion.modelId}". Existing auth is not affected.`
                  : `  1. This creates a modelOverrides entry in models.json. Existing auth (e.g. login API tokens) is not affected.`,
                `  2. A timestamped backup will be written to: ${backupPath}`,
                `  3. You must run /reload or restart Pi for the change to take effect.`,
                `  4. If the file contains comments or unusual formatting, please verify the result after write.`,
              ];
              if (promptCacheRetention400Models.has(modelKey(model))) {
                previewLines.push(
                  "",
                  "💡  This fix overrides supportsLongCacheRetention to false because",
                  "a 400 prompt_cache_retention error was observed for this model.",
                  "After applying and reloading, Pi will no longer send the",
                  "prompt_cache_retention parameter to this provider.",
                );
              }
              previewLines.push("", `Apply these changes?`);
              const confirmed = await cmdCtx.ui.confirm(
                repairsExistingOverride ? "Cache Optimizer — Fix (model override)" : "Cache Optimizer — Fix (new override)",
                previewLines.join("\n"),
              );
              if (confirmed) {
                try {
                  const receipt = createModelsJsonFixReceipt(
                    originalText,
                    plan.modifiedText,
                    suggestion.providerLabel,
                    suggestion.modelId,
                    "modelOverride",
                    suggestion.compatKeys,
                    repairsExistingOverride,
                    backupPath,
                  );
                  if (!receipt) {
                    cmdCtx.ui.notify("❌ Could not create a privacy-safe fix receipt. No changes were made.", "error");
                    return;
                  }
                  const result = await applyModelsJsonFixTransaction(
                    plan.modifiedText,
                    backupPath,
                    (writtenText) => selfCheckMissingEntryInsertion(
                      originalText,
                      writtenText,
                      suggestion.providerLabel,
                      suggestion.modelId,
                      suggestion.compatKeys,
                      model,
                    ),
                    {
                      expectedCurrentHash: hashText(originalText),
                      purpose: "fix",
                      onCommitted: async () => writeModelsJsonFixReceipt(receipt),
                    },
                  );
                  if ("postCheckError" in result) {
                    cmdCtx.ui.notify(
                      `❌ Post-write self-check failed: ${result.postCheckError}\n` +
                      `The backup at ${backupPath} has been restored. No changes applied.`,
                      "error",
                    );
                    return;
                  }
                  invalidateModelsConfigCache();
                  cmdCtx.ui.notify(
                    `✅ Fix applied to ${getModelsJsonDisplayPath()}.\n` +
                    `Backup saved to: ${backupPath}\n` +
                    `Run /reload or restart Pi for the change to take effect.`,
                    "info",
                  );
                } catch (e) {
                  cmdCtx.ui.notify(
                    `❌ Write failed: ${e instanceof Error ? e.message : String(e)}\n` +
                    `Backup may be at: ${backupPath}`,
                    "error",
                  );
                }
                return;
              }
              cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
              return;
            }
            }
          }

          // Non-interactive or no diagnosis: show manual guidance.
          const snippet = diagnosis
            ? formatMissingEntryManualSnippet(suggestion.providerLabel, suggestion.modelId, suggestion.compatKeys)
            : formatCompatKeysForInsertion(suggestion.compatKeys);
          const adviceLines: string[] = [];
          if (!diagnosis) {
            adviceLines.push(
              `❌ Could not locate model "${suggestion.modelId}" or provider "${suggestion.providerLabel}" in ${getModelsJsonDisplayPath()}.`,
              "",
              "Providers that were added via Pi /login API (e.g. opencode go) do not have",
              "entries in models.json. You can create a minimal modelOverrides entry by hand:",
            );
          } else if (diagnosis.scenario === "provider_missing") {
            adviceLines.push(
              `ℹ️ Provider "${suggestion.providerLabel}" does not exist in ${getModelsJsonDisplayPath()}.`,
              `This is common for API-logged-in providers (e.g. /login ...).`,
              "",
              "Add the following minimal block under the \"providers\" key (keep your",
              "existing authentication as-is):",
            );
          } else {
            adviceLines.push(
              `ℹ️ Model "${suggestion.modelId}" was not found in ${getModelsJsonDisplayPath()}`,
              `under providers["${suggestion.providerLabel}"].`,
              "",
              "Add the following modelOverrides entry (keep existing auth):",
            );
          }
          adviceLines.push("", snippet, "", "Then save and run /reload.");
          cmdCtx.ui.notify(adviceLines.join("\n"), "warning");
          return;
        }

        const duplicateTargetDefinitions = location.allModelIds.filter(
          (configuredModelId) => configuredModelId === suggestion.modelId,
        ).length;
        if (duplicateTargetDefinitions > 1) {
          cmdCtx.ui.notify(
            `❌ ${getModelsJsonDisplayPath()} contains ${duplicateTargetDefinitions} custom model definitions ` +
            `with the exact id "${suggestion.modelId}" under providers["${suggestion.providerLabel}"].\n` +
            `Pi uses the last definition, but /cache-optimizer fix refuses an ambiguous duplicate-id edit. ` +
            `Remove or consolidate the duplicates, then run the command again.`,
            "error",
          );
          return;
        }

        // Compose the modified text — observed runtime failures are always
        // model-scoped; ordinary compat fixes use the safety-based placement.
        const decision = chooseFixPlacement(
          originalText,
          location,
          suggestion.compatKeys,
          suggestion.providerLabel,
          suggestion.forceModelLevel,
        );
        const createsModelOverride = decision.placement === "modelOverride" && location.modelOverrideObjectBrace < 0;
        const modelOverridePlan = createsModelOverride
          ? composeModelOverrideInsertion(
              originalText,
              suggestion.providerLabel,
              suggestion.modelId,
              suggestion.compatKeys,
            )
          : undefined;
        if (createsModelOverride && !modelOverridePlan) {
          cmdCtx.ui.notify(
            "❌ Could not safely create the highest-precedence model override. No changes were made.",
            "error",
          );
          return;
        }
        const modifiedText = modelOverridePlan?.modifiedText
          ?? composeFixInsertion(originalText, location, suggestion.compatKeys, decision.placement);

        // Self-check against the same provider → model → runtime →
        // modelOverride precedence used by request hooks.
        const checkError = createsModelOverride
          ? selfCheckMissingEntryInsertion(
              originalText,
              modifiedText,
              suggestion.providerLabel,
              suggestion.modelId,
              suggestion.compatKeys,
              model,
            )
          : selfCheckFix(
              originalText,
              modifiedText,
              suggestion.providerLabel,
              suggestion.modelId,
              suggestion.compatKeys,
              decision.placement,
              model,
            );
        if (checkError !== null) {
          cmdCtx.ui.notify(
            `❌ Self-check failed before write: ${checkError}\n` +
            `No changes were made. Manual edit required.`,
            "error",
          );
          return;
        }

        // Build preview snippet as copyable JSON (the surgical editor will
        // insert or repair these exact compat key/value pairs).
        const keysPreview = JSON.stringify(suggestion.compatKeys, null, 2);
        const targetHasCompat = decision.placement === "provider"
          ? location.providerCompatBrace >= 0
          : decision.placement === "modelOverride"
            ? location.modelOverrideCompatBrace >= 0
            : location.compatObjectBrace >= 0;
        const placementDesc = targetHasCompat ? `existing "compat" object` : `new "compat" object`;
        const locationDesc = decision.placement === "provider"
          ? `providers["${suggestion.providerLabel}"] -> compat (provider level, ${placementDesc})`
          : decision.placement === "modelOverride"
            ? `providers["${suggestion.providerLabel}"] -> modelOverrides -> "${suggestion.modelId}" -> compat (${placementDesc})`
            : `providers["${suggestion.providerLabel}"] -> models -> "${suggestion.modelId}" -> compat (model level, ${placementDesc})`;

        const ts = backupTimestamp();
        const backupPath = `${MODELS_JSON_PATH}.backup-cache-optimizer-${ts}`;

        const scopeRiskLine = decision.placement === "provider"
          ? `  1. This change applies to ALL ${location.allModelIds.length || 1} model(s) in the "${suggestion.providerLabel}" provider, across all sessions.`
          : `  1. This change affects ALL sessions using the "${suggestion.providerLabel}" provider/channel (scoped to model "${suggestion.modelId}").`;

        const previewLines = [
          `📝 Preview of changes to ${getModelsJsonDisplayPath()}:`,
          ``,
          `Location: ${locationDesc}`,
          `Placement: ${decision.placement} level — ${decision.reason}`,
          `Compat JSON to write:`,
          keysPreview,
          ``,
          `⚠️  Risk notice:`,
          scopeRiskLine,
          `  2. A timestamped backup will be written to: ${backupPath}`,
          `  3. You must restart Pi / run /reload for the change to take effect.`,
          `  4. If the file contains comments or unusual formatting, please verify the result after write.`,
        ];
        if (promptCacheRetention400Models.has(modelKey(model))) {
          previewLines.push(
            "",
            "💡  This fix overrides supportsLongCacheRetention to false because",
            "a 400 prompt_cache_retention error was observed for this model.",
            "After applying and reloading, Pi will no longer send the",
            "prompt_cache_retention parameter to this provider.",
          );
        }
        previewLines.push("", `Apply these changes?`);

        const confirmed = await cmdCtx.ui.confirm("Cache Optimizer — Fix", previewLines.join("\n"));
        if (!confirmed) {
          cmdCtx.ui.notify("No changes were made. Canceled by user.", "info");
          return;
        }

        // Write: backup → temp + rename → self-check again
        try {
          const receipt = createModelsJsonFixReceipt(
            originalText,
            modifiedText,
            suggestion.providerLabel,
            suggestion.modelId,
            decision.placement,
            suggestion.compatKeys,
            !createsModelOverride,
            backupPath,
          );
          if (!receipt) {
            cmdCtx.ui.notify("❌ Could not create a privacy-safe fix receipt. No changes were made.", "error");
            return;
          }
          const result = await applyModelsJsonFixTransaction(
            modifiedText,
            backupPath,
            (writtenText) => createsModelOverride
              ? selfCheckMissingEntryInsertion(
                  originalText,
                  writtenText,
                  suggestion.providerLabel,
                  suggestion.modelId,
                  suggestion.compatKeys,
                  model,
                )
              : selfCheckFix(
                  originalText,
                  writtenText,
                  suggestion.providerLabel,
                  suggestion.modelId,
                  suggestion.compatKeys,
                  decision.placement,
                  model,
                ),
            {
              expectedCurrentHash: hashText(originalText),
              purpose: "fix",
              onCommitted: async () => writeModelsJsonFixReceipt(receipt),
            },
          );
          if ("postCheckError" in result) {
            cmdCtx.ui.notify(
              `❌ Post-write self-check failed: ${result.postCheckError}\n` +
              `The backup at ${backupPath} has been restored. No changes applied.`,
              "error",
            );
            return;
          }

          invalidateModelsConfigCache();
          cmdCtx.ui.notify(
            `✅ Fix applied to ${getModelsJsonDisplayPath()}.\n` +
            `Backup saved to: ${backupPath}\n` +
            `Run /reload or restart Pi for the change to take effect.`,
            "info",
          );
        } catch (writeError) {
          cmdCtx.ui.notify(
            `❌ Write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}\n` +
            `Backup may be at: ${backupPath}`,
            "error",
          );
        }
      } else {
        // Try interactive selection menu when UI supports it
        if (cmdCtx.hasUI) {
          const menuOptions = [
            "Enable — Turn on runtime optimizations",
            "Disable — Turn off runtime optimizations",
            "Doctor — Show cache configuration",
            "Stats — Show current-session model statistics",
            "Compat — Show compat suggestion",
            "Fix — Auto-fix compat issues (writes models.json or extension config)",
            "Disable prompt_cache_key — Omit it for the active model",
            "Rollback — Undo the latest confirmed fix",
            "Footer mode — Choose total, session, or process stats",
            "Reset — Reset local provider/model stats",
            "Cancel",
          ];
          const choice = await cmdCtx.ui.select("Cache Optimizer", menuOptions);
          if (choice === menuOptions[0]) {
            await handleCacheOptimizerCommand("enable", cmdCtx);
          } else if (choice === menuOptions[1]) {
            await handleCacheOptimizerCommand("disable", cmdCtx);
          } else if (choice === menuOptions[2]) {
            await handleCacheOptimizerCommand("doctor", cmdCtx);
          } else if (choice === menuOptions[3]) {
            await handleCacheOptimizerCommand("stats", cmdCtx);
          } else if (choice === menuOptions[4]) {
            await handleCacheOptimizerCommand("compat", cmdCtx);
          } else if (choice === menuOptions[5]) {
            await handleCacheOptimizerCommand("fix", cmdCtx);
          } else if (choice === menuOptions[6]) {
            await handleCacheOptimizerCommand("fix prompt-cache-key", cmdCtx);
          } else if (choice === menuOptions[7]) {
            await handleCacheOptimizerCommand("rollback", cmdCtx);
          } else if (choice === menuOptions[8]) {
            const modeOptions = ["session — Current Pi conversation session (default)", "total — All local sessions today", "process — Current extension instance only", "Cancel"];
            const modeChoice = await cmdCtx.ui.select("Footer cache stats mode", modeOptions);
            const nextMode = modeChoice === modeOptions[0]
              ? "session"
              : modeChoice === modeOptions[1]
                ? "total"
                : modeChoice === modeOptions[2]
                  ? "process"
                  : undefined;
            if (nextMode) await handleCacheOptimizerCommand(`config footer-mode ${nextMode}`, cmdCtx);
          } else if (choice === menuOptions[9]) {
            await handleCacheOptimizerCommand("reset", cmdCtx);
          }
          // choice === "cancel" or undefined → no action
          return;
        }

        // Fallback: text help when no interactive UI
        const diagnosis: string[] = [];
        diagnosis.push("📋 /cache-optimizer commands:");
        diagnosis.push("  enable  — Enable prompt/cache optimizations for this Pi process");
        diagnosis.push("  disable — Disable prompt/cache optimizations for this Pi process");
        diagnosis.push("  doctor  — Show current model/provider/api/baseUrl/compat and low-hit diagnosis");
        diagnosis.push("  stats   — Show detailed statistics for every model in the current session");
        diagnosis.push("  stats all — Show detailed totals for every model across all local sessions");
        diagnosis.push("  stats contributors — Show per-session contributors for the active model");
        diagnosis.push("  compat  — Show compat suggestion with edit location");
        diagnosis.push("  config prompt-rewrite|virtual-rewrite|skill-compression|openai-cache-key|tool-order on|off — Persist feature settings");
        diagnosis.push("  config footer-mode total|session|process — Persist the footer stats mode");
        diagnosis.push("  config reset — Remove persistent feature overrides");
        diagnosis.push("  fix     — Auto-fix compat issues (writes models.json or extension config, requires UI)");
        diagnosis.push("  fix prompt-cache-key — Explicitly omit prompt_cache_key for the active model");
        diagnosis.push("  rollback — Undo the latest confirmed fix (requires UI confirmation)");
        diagnosis.push("  reset   — Reset local provider/model stats for current model (does not affect upstream)");
        diagnosis.push("");
        diagnosis.push(formatOptimizerRuntimeMode());
        const resolvedFooterMode = resolveFooterStatsMode(persistedFooterStatsMode);
        diagnosis.push(`Footer stats mode: ${resolvedFooterMode.mode} (${resolvedFooterMode.source})`);
        diagnosis.push("");
        if (model) {
          const displayKey = modelKey(model);
          const missing = describeMissingCacheCompatForModel(model);
          if (missing.length > 0) {
            diagnosis.push(`⚠️  Active model "${displayKey}" missing compat: ${missing.join(", ")}`);
            diagnosis.push('Run "/cache-optimizer compat" for edit instructions.');
          } else if (isAdaptiveThinkingCompatApplicable(model) || isDeepSeekCompatCheckApplicable(model) || isCompatCheckApplicable(model)) {
            diagnosis.push(`✅ Active model "${displayKey}": compat fully configured.`);
          } else {
            diagnosis.push(`ℹ️ Active model "${displayKey}": compat check not applicable.`);
            const detailLines = getCompatCheckNotApplicableLines(model).slice(1);
            for (const line of detailLines) diagnosis.push(line);
          }
        } else {
          diagnosis.push("No active model selected.");
        }
        cmdCtx.ui.notify(diagnosis.join("\n"), "info");
      }
  }
}
