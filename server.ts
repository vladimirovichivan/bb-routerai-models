// RouterAI Managed Profile — a bb plugin that keeps a cached RouterAI catalog,
// lets the user pick models and reasoning levels, and serves the result to
// OpenCode as an inline config through bb's own ACP provider bridge.
//
// Design constraints enforced here:
//  - No RouterAI request happens on page open, filter, sort, or toggle. The only
//    network calls are an explicit refresh (RPC/CLI/button) and the optional
//    once-a-day background refresh.
//  - The user's own ~/.config/opencode/opencode.json is never read or written.
//  - No other plugin's settings are read or written: the provider is declared
//    with `bb.providers.register`, the same mechanism the official RouterAI
//    plugin uses, instead of borrowing `provider-acp` custom agents.
//  - The API key never appears in logs, errors, RPC payloads, or CLI output.
import { defineRpcContract, type BbPluginApi, type PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildManagedConfig,
  ConfigTooLargeError,
  DEFAULT_BASE_URL,
  OPENCODE_CONFIG_ENV,
  redactConfig,
  MAX_CONFIG_BYTES,
  type BuiltConfig,
} from "./core/config.ts";
import { normalizeCatalog, toggledActiveIds, type CatalogModel } from "./core/models.ts";
import {
  describeFetchError,
  emptyCacheMessage,
  staleCacheMessage,
} from "./core/refresh.ts";
import {
  ACP_ARGS,
  buildProviderDeclaration,
  MANAGED_PROVIDER_DISPLAY_NAME,
  MANAGED_PROVIDER_ID,
  providerSignature,
} from "./core/provider.ts";
import { groupModels, missingIds, sanitizeReasoning } from "./core/sort.ts";
import type {
  ConfigSummary,
  ManagedProviderView,
  PluginState,
  RefreshResult,
  StoredApplyState,
  StoredCatalog,
  StoredRefreshMeta,
  StoredSelection,
} from "./core/state.ts";

const CATALOG_KEY = "catalog";
const SELECTION_KEY = "selection";
const APPLY_KEY = "apply";
const REFRESH_KEY = "refresh";
const CHANGED_CHANNEL = "routerai-managed-changed";

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

const priceSchema = z.object({
  input: z.number().nullable(),
  output: z.number().nullable(),
  cacheRead: z.number().nullable(),
  cacheWrite: z.number().nullable(),
});

const modelSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  context: z.number(),
  output: z.number(),
  input: z.array(z.string()),
  reasoning: z.boolean(),
  levels: z.array(z.string()),
  tools: z.boolean(),
  prices: priceSchema,
  created: z.number(),
});

const refreshStateSchema = z.object({
  inProgress: z.boolean(),
  lastAttemptAt: z.number().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.number().nullable(),
});

const configSummarySchema = z.object({
  bytes: z.number(),
  maxBytes: z.number(),
  modelCount: z.number(),
  missingIds: z.array(z.string()),
  tooLarge: z.boolean(),
  error: z.string().nullable(),
  lastAppliedAt: z.number().nullable(),
  appliedModelCount: z.number(),
  appliedBytes: z.number(),
});

const providerViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  registered: z.boolean(),
  command: z.string(),
  args: z.array(z.string()),
  modelCount: z.number(),
  error: z.string().nullable(),
});

const pluginStateSchema = z.object({
  settings: z.object({
    hasApiKey: z.boolean(),
    apiKeySource: z.enum(["settings", "environment"]).nullable(),
    autoRefreshDaily: z.boolean(),
    opencodeCommandSet: z.boolean(),
    disableApprovalPrompts: z.boolean(),
  }),
  catalog: z
    .object({
      fetchedAt: z.number(),
      models: z.array(modelSchema),
      rawCount: z.number(),
      etag: z.boolean(),
    })
    .nullable(),
  selection: z.object({
    activeIds: z.array(z.string()),
    reasoning: z.record(z.string(), z.string()),
    updatedAt: z.number(),
  }),
  missingIds: z.array(z.string()),
  refresh: refreshStateSchema,
  config: configSummarySchema,
  provider: providerViewSchema,
});

const refreshResultSchema = pluginStateSchema.extend({
  outcome: z.enum(["fetched", "not-modified", "failed"]),
  message: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: pluginStateSchema },
  refresh: { input: z.null(), output: refreshResultSchema },
  set_active: {
    input: z.object({ id: z.string().min(1).max(300), active: z.boolean() }).strict(),
    output: pluginStateSchema,
  },
  set_reasoning: {
    input: z
      .object({
        id: z.string().min(1).max(300),
        level: z.string().min(1).max(32),
      })
      .strict(),
    output: pluginStateSchema,
  },
  apply: { input: z.null(), output: pluginStateSchema },
  set_auto_refresh: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: pluginStateSchema,
  },
  set_disable_approval_prompts: {
    input: z.object({ disabled: z.boolean() }).strict(),
    output: pluginStateSchema,
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "RouterAI API key",
      secret: true,
      description:
        "Ключ RouterAI для чтения каталога моделей. Хранится как секрет плагина; значение не попадает в логи и в UI.",
    },
    autoRefreshDaily: {
      type: "boolean",
      label: "Обновлять каталог раз в сутки",
      default: false,
      description:
        "Фоновое обновление раз в 24 часа. Выключено по умолчанию: без него каталог меняется только по кнопке «Обновить список моделей».",
    },
    opencodeCommand: {
      type: "string",
      label: "opencode (необязательный полный путь)",
      default: "",
      description:
        "Оставьте пустым, чтобы запускать `opencode acp` из PATH. Укажите абсолютный путь, только если бинарника в PATH нет.",
    },
    disableApprovalPrompts: {
      type: "boolean",
      label: "Не запрашивать подтверждения инструментов",
      default: false,
      description:
        "Выключено по умолчанию: bb сам управляет разрешениями через режим треда (accept-edits спрашивает перед shell, webfetch и записью вне workspace). Включите, если окна «Approval needed» мешают: провайдер перейдёт на generic-диалект ACP, и инструменты будут выполняться без подтверждений bb. Уже открытые треды сохранят прежнее поведение.",
    },
  });

  // In-memory only: "refreshing" must not survive a restart.
  let refreshInFlight: Promise<RefreshResult> | null = null;
  let applyChain: Promise<void> = Promise.resolve();
  let registration: { dispose(): void } | null = null;
  let registeredSignature: string | null = null;
  let registrationError: string | null = null;
  let registeredModelCount = 0;
  /**
   * Last config that actually registered. When a new selection no longer fits
   * the inline limit, the provider keeps serving this one instead of going
   * dark, and the UI/CLI still report the error.
   */
  let lastRegisteredConfig: string | null = null;

  async function resolveApiKey(): Promise<{ key: string; source: "settings" | "environment" } | null> {
    const values = await settings.get();
    const fromSettings = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    if (fromSettings !== "") return { key: fromSettings, source: "settings" };
    for (const name of ["ROUTERAI_API_KEY", "ROUTERAI_WINDOWS_API_KEY"]) {
      const candidate = process.env[name]?.trim() ?? "";
      if (candidate !== "") return { key: candidate, source: "environment" };
    }
    return null;
  }

  async function readCatalog(): Promise<StoredCatalog | null> {
    return (await bb.storage.kv.get<StoredCatalog>(CATALOG_KEY)) ?? null;
  }

  async function readSelection(catalog: StoredCatalog | null): Promise<StoredSelection> {
    const stored = await bb.storage.kv.get<StoredSelection>(SELECTION_KEY);
    if (stored === undefined) return { activeIds: [], reasoning: {}, updatedAt: 0 };
    const models = catalog?.models ?? [];
    return {
      activeIds: Array.isArray(stored.activeIds)
        ? stored.activeIds.filter((id): id is string => typeof id === "string")
        : [],
      reasoning: sanitizeReasoning(models, stored.reasoning ?? {}),
      updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : 0,
    };
  }

  async function readApplyState(): Promise<StoredApplyState> {
    const stored = await bb.storage.kv.get<StoredApplyState>(APPLY_KEY);
    return stored ?? { lastAppliedAt: 0, appliedModelCount: 0, appliedBytes: 0 };
  }

  async function readRefreshMeta(): Promise<StoredRefreshMeta> {
    return (
      (await bb.storage.kv.get<StoredRefreshMeta>(REFRESH_KEY)) ?? {
        lastAttemptAt: null,
        lastError: null,
        lastErrorAt: null,
      }
    );
  }

  /**
   * The config for the current cache + selection + key. Always returns a
   * document: with no catalog or no models it is a valid provider with an
   * empty model list, which keeps the picker free of OpenCode's own models.
   */
  async function buildCurrentConfig(): Promise<{
    built: BuiltConfig;
    catalog: StoredCatalog | null;
    selection: StoredSelection;
    hasKey: boolean;
  }> {
    const [catalog, storedSelection, key] = await Promise.all([
      readCatalog(),
      bb.storage.kv.get<StoredSelection>(SELECTION_KEY),
      resolveApiKey(),
    ]);
    const selection: StoredSelection =
      storedSelection === undefined
        ? { activeIds: [], reasoning: {}, updatedAt: 0 }
        : {
            activeIds: Array.isArray(storedSelection.activeIds) ? storedSelection.activeIds : [],
            reasoning: sanitizeReasoning(catalog?.models ?? [], storedSelection.reasoning ?? {}),
            updatedAt: storedSelection.updatedAt ?? 0,
          };
    const built = buildManagedConfig({
      models: catalog?.models ?? [],
      selection,
      apiKey: key?.key ?? "",
      baseUrl: DEFAULT_BASE_URL,
    });
    return { built, catalog, selection, hasKey: key !== null };
  }

  function declarationFor(
    config: string,
    opencodeCommand: string,
    disableApprovalPrompts: boolean,
  ): PluginProviderDeclaration {
    return buildProviderDeclaration({ config, opencodeCommand, disableApprovalPrompts });
  }

  /**
   * Registers (or replaces) the bb provider. bb's picker reads the model list
   * from the agent, so the launch environment carries the config; a changed
   * selection re-registers with a new declaration.
   */
  async function syncProviderRegistration(): Promise<ManagedProviderView> {
    const values = await settings.get();
    const command = (values.opencodeCommand ?? "").trim();
    const disableApprovalPrompts = values.disableApprovalPrompts === true;
    try {
      const { built } = await buildCurrentConfig();
      if (built.bytes > MAX_CONFIG_BYTES) {
        const message = new ConfigTooLargeError(
          built.bytes,
          MAX_CONFIG_BYTES,
          built.modelCount,
        ).message;
        registrationError = message;
        bb.log.error(`провайдер не обновлён: ${message}`);
        // The previous registration (if any) keeps serving: it is the last
        // config that fit, so the picker is not emptied by a failed change.
        return providerView(command, registration !== null);
      }
      const declaration = declarationFor(built.json, command, disableApprovalPrompts);
      const signature = providerSignature(declaration);
      if (registration !== null && signature === registeredSignature) {
        registrationError = null;
        return providerView(command, true);
      }
      registration?.dispose();
      registration = bb.providers.register(declaration);
      registeredSignature = signature;
      registeredModelCount = built.modelCount;
      lastRegisteredConfig = built.json;
      registrationError = null;
      bb.log.info(
        `provider ${MANAGED_PROVIDER_ID}: ${built.modelCount} моделей, ${built.bytes} байт inline-конфига`,
      );
      return providerView(command, true);
    } catch (error) {
      registrationError = error instanceof Error ? error.message.slice(0, 400) : String(error);
      bb.log.error(`не удалось зарегистрировать провайдера: ${registrationError}`);
      return providerView(command, registration !== null);
    }
  }

  function providerView(command: string, registered: boolean): ManagedProviderView {
    return {
      id: MANAGED_PROVIDER_ID,
      displayName: MANAGED_PROVIDER_DISPLAY_NAME,
      registered,
      command: command === "" ? "opencode" : command,
      args: [...ACP_ARGS],
      modelCount: registeredModelCount,
      error: registrationError,
    };
  }

  async function readState(options: { sync?: boolean } = {}): Promise<PluginState> {
    const [catalog, rawSelection, applyState, refreshMeta, values, apiKey] = await Promise.all([
      readCatalog(),
      bb.storage.kv.get<StoredSelection>(SELECTION_KEY),
      readApplyState(),
      readRefreshMeta(),
      settings.get(),
      resolveApiKey(),
    ]);
    const models = catalog?.models ?? [];
    const selection: StoredSelection =
      rawSelection === undefined
        ? { activeIds: [], reasoning: {}, updatedAt: 0 }
        : {
            activeIds: rawSelection.activeIds ?? [],
            reasoning: sanitizeReasoning(models, rawSelection.reasoning ?? {}),
            updatedAt: rawSelection.updatedAt ?? 0,
          };

    const missing = missingIds(selection.activeIds, models);

    let summary: ConfigSummary = {
      bytes: 0,
      maxBytes: MAX_CONFIG_BYTES,
      modelCount: 0,
      missingIds: missing,
      tooLarge: false,
      error: null,
      lastAppliedAt: applyState.lastAppliedAt > 0 ? applyState.lastAppliedAt : null,
      appliedModelCount: applyState.appliedModelCount,
      appliedBytes: applyState.appliedBytes,
    };
    if (apiKey === null) {
      summary = { ...summary, error: "Ключ RouterAI не задан в настройках плагина." };
    } else if (catalog === null) {
      summary = { ...summary, error: "Каталог ещё не загружался. Нажмите «Обновить список моделей»." };
    } else if (selection.activeIds.length === 0) {
      summary = { ...summary, error: "Не выбрано ни одной модели." };
    } else {
      try {
        const built = buildManagedConfig({
          models,
          selection,
          apiKey: apiKey.key,
          baseUrl: DEFAULT_BASE_URL,
        });
        summary = {
          ...summary,
          bytes: built.bytes,
          modelCount: built.modelCount,
          missingIds: built.missingIds,
          tooLarge: built.bytes > MAX_CONFIG_BYTES,
          error:
            built.bytes > MAX_CONFIG_BYTES
              ? new ConfigTooLargeError(built.bytes, MAX_CONFIG_BYTES, built.modelCount).message
              : null,
        };
      } catch (error) {
        summary = {
          ...summary,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const opencodeCommand = (values.opencodeCommand ?? "").trim();
    const provider = providerView(opencodeCommand, registration !== null);
    if (options.sync === true) {
      const synced = await syncProviderRegistration();
      provider.registered = synced.registered;
      provider.error = synced.error;
      provider.modelCount = synced.modelCount;
    } else if (registration !== null) {
      provider.modelCount = registeredModelCount;
    }

    return {
      settings: {
        hasApiKey: apiKey !== null,
        apiKeySource: apiKey?.source ?? null,
        autoRefreshDaily: values.autoRefreshDaily === true,
        opencodeCommandSet: opencodeCommand !== "",
        disableApprovalPrompts: values.disableApprovalPrompts === true,
      },
      catalog:
        catalog === null
          ? null
          : {
              fetchedAt: catalog.fetchedAt,
              models: catalog.models,
              rawCount: catalog.rawCount,
              etag: catalog.etag !== null,
            },
      selection: {
        activeIds: [...selection.activeIds],
        reasoning: { ...selection.reasoning },
        updatedAt: selection.updatedAt,
      },
      missingIds: missing,
      refresh: {
        inProgress: refreshInFlight !== null,
        lastAttemptAt: refreshMeta.lastAttemptAt,
        lastError: refreshMeta.lastError,
        lastErrorAt: refreshMeta.lastErrorAt,
      },
      config: summary,
      provider,
    };
  }

  function publishChanged(): void {
    bb.realtime.publish(CHANGED_CHANNEL, { at: Date.now() });
  }

  // --- explicit refresh -----------------------------------------------------

  async function performRefresh(signal: AbortSignal): Promise<RefreshResult> {
    const previous = await readCatalog();
    const now = Date.now();
    const attempt: StoredRefreshMeta = {
      lastAttemptAt: now,
      lastError: null,
      lastErrorAt: null,
    };
    const key = await resolveApiKey();
    if (key === null) {
      const meta = { ...attempt, lastError: "Ключ RouterAI не задан.", lastErrorAt: now };
      await bb.storage.kv.set(REFRESH_KEY, meta);
      const state = await readState();
      return { ...state, outcome: "failed", message: "Ключ RouterAI не задан в настройках плагина." };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key.key}`,
      Accept: "application/json",
    };
    // Conditional request: when the provider returns ETag/Last-Modified we send
    // them back and skip the body on 304. RouterAI currently sends neither.
    if (previous?.etag) headers["If-None-Match"] = previous.etag;
    if (previous?.lastModified) headers["If-Modified-Since"] = previous.lastModified;

    try {
      // Exactly one request per explicit refresh: this line is the network
      // counter the acceptance checks look for in the server log.
      bb.log.info(`RouterAI: запрос каталога моделей (${previous === null ? "первый" : "обновление"})`);
      const response = await fetch(`${DEFAULT_BASE_URL}/models`, { headers, signal });

      if (response.status === 304) {
        if (previous !== null) {
          await bb.storage.kv.set(CATALOG_KEY, { ...previous, fetchedAt: Date.now() });
        }
        await bb.storage.kv.set(REFRESH_KEY, attempt);
        const state = await readState();
        return {
          ...state,
          outcome: "not-modified",
          message: "Список моделей не изменился (304 Not Modified).",
        };
      }

      if (!response.ok) {
        throw new Error(`RouterAI вернул HTTP ${response.status} ${response.statusText}`.trim());
      }

      const payload: unknown = await response.json();
      const models = normalizeCatalog(payload);
      const rawCount = Array.isArray((payload as { data?: unknown }).data)
        ? ((payload as { data: unknown[] }).data.length as number)
        : models.length;
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      const stored: StoredCatalog = {
        fetchedAt: Date.now(),
        etag,
        lastModified,
        models,
        rawCount,
      };
      await bb.storage.kv.set(CATALOG_KEY, stored);
      await bb.storage.kv.set(REFRESH_KEY, attempt);
      // A successful catalog change may legitimately change the generated
      // config (a selected model vanished), so re-apply without a new request.
      await applyNow("refresh");
      const state = await readState();
      return {
        ...state,
        outcome: "fetched",
        message: `Загружено ${models.length} моделей (из ${rawCount} в ответе).`,
      };
    } catch (error) {
      const message = describeFetchError(error);
      const meta: StoredRefreshMeta = {
        lastAttemptAt: now,
        lastError: message,
        lastErrorAt: now,
      };
      await bb.storage.kv.set(REFRESH_KEY, meta);
      const state = await readState();
      return {
        ...state,
        outcome: "failed",
        message:
          previous === null
            ? emptyCacheMessage(message)
            : staleCacheMessage(message, previous.fetchedAt),
      };
    }
  }

  async function refreshCatalog(): Promise<RefreshResult> {
    if (refreshInFlight !== null) return refreshInFlight;
    const controller = new AbortController();
    refreshInFlight = performRefresh(controller.signal)
      .catch(async (error): Promise<RefreshResult> => {
        const state = await readState();
        const reason = describeFetchError(error);
        return {
          ...state,
          outcome: "failed",
          message:
            state.catalog === null
              ? emptyCacheMessage(reason)
              : staleCacheMessage(reason, state.catalog.fetchedAt),
        };
      })
      .finally(() => {
        refreshInFlight = null;
        publishChanged();
      });
    publishChanged();
    return refreshInFlight;
  }

  // --- apply ---------------------------------------------------------------

  async function applyNow(reason: string): Promise<void> {
    applyChain = applyChain.then(async () => {
      try {
        const view = await syncProviderRegistration();
        const { built } = await buildCurrentConfig();
        await bb.storage.kv.set(APPLY_KEY, {
          lastAppliedAt: Date.now(),
          appliedModelCount: view.modelCount,
          appliedBytes: built.bytes,
        } satisfies StoredApplyState);
      } catch (error) {
        bb.log.warn(
          `apply не удался (${reason}): ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        publishChanged();
      }
    });
    await applyChain;
  }

  // --- environment contribution -------------------------------------------

  // The launch spec in the declaration also carries the config, but bb probes
  // the provider's model list through this hook as well (with `threadId`
  // null). Returning the config here in both cases keeps a probe from running
  // against a stale launch env — and keeps the key out of bb's persisted
  // provider settings, since the value is computed per launch.
  bb.providers.experimental_contributeEnv(MANAGED_PROVIDER_ID, async ({ threadId }) => {
    try {
      const { built } = await buildCurrentConfig();
      if (built.bytes > MAX_CONFIG_BYTES) {
        bb.log.error(
          `OPENCODE_CONFIG_CONTENT не передан: ${built.bytes} байт > ${MAX_CONFIG_BYTES}. Отключите часть моделей.`,
        );
        if (lastRegisteredConfig === null) return [];
        // Keep the agent usable on the last config that fit.
        return [
          {
            name: OPENCODE_CONFIG_ENV,
            value: lastRegisteredConfig,
            reason: `RouterAI Managed: последний рабочий конфиг (${registeredModelCount} моделей)`,
          },
        ];
      }
      return [
        {
          name: OPENCODE_CONFIG_ENV,
          value: built.json,
          reason:
            threadId === null
              ? `RouterAI Managed: ${built.modelCount} моделей, inline-конфиг (опрос провайдера)`
              : `RouterAI Managed: ${built.modelCount} моделей, inline-конфиг`,
        },
      ];
    } catch (error) {
      bb.log.error(
        `не удалось собрать OPENCODE_CONFIG_CONTENT: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  });

  // --- RPC -----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    state: async () => readState(),
    refresh: async () => refreshCatalog(),
    set_active: async ({ id, active }) => {
      const catalog = await readCatalog();
      if (catalog === null) throw new Error("Каталог не загружен: сначала обновите список моделей.");
      if (!catalog.models.some((model) => model.id === id)) {
        throw new Error(`Модель ${id} отсутствует в каталоге`);
      }
      const selection = await readSelection(catalog);
      const activeIds = toggledActiveIds(selection.activeIds, id, active);
      const next: StoredSelection = {
        activeIds,
        reasoning: selection.reasoning,
        updatedAt: Date.now(),
      };
      await bb.storage.kv.set(SELECTION_KEY, next);
      await applyNow("set-active");
      publishChanged();
      return readState({ sync: true });
    },
    set_reasoning: async ({ id, level }) => {
      const catalog = await readCatalog();
      const selection = await readSelection(catalog);
      const model = catalog?.models.find((candidate) => candidate.id === id);
      if (catalog === null || model === undefined) {
        throw new Error(`Модель ${id} отсутствует в каталоге`);
      }
      if (!model.levels.includes(level)) {
        throw new Error(
          `Уровень ${level} недоступен для ${id}. Допустимо: ${model.levels.join(", ")}`,
        );
      }
      const next: StoredSelection = {
        ...selection,
        reasoning: { ...selection.reasoning, [id]: level },
        updatedAt: Date.now(),
      };
      await bb.storage.kv.set(SELECTION_KEY, next);
      await applyNow("set-reasoning");
      publishChanged();
      return readState({ sync: true });
    },
    apply: async () => {
      await applyNow("manual");
      return readState({ sync: true });
    },
    set_auto_refresh: async ({ enabled }) => {
      await settings.experimental_set({ autoRefreshDaily: enabled });
      publishChanged();
      return readState();
    },
    set_disable_approval_prompts: async ({ disabled }) => {
      await settings.experimental_set({ disableApprovalPrompts: disabled });
      await applyNow("set-approval-prompts");
      publishChanged();
      return readState({ sync: true });
    },
  });

  // --- CLI -----------------------------------------------------------------

  function stateLines(state: PluginState, options: { all?: boolean } = {}): string[] {
    const lines: string[] = [];
    if (state.catalog === null) {
      lines.push("Каталог: не загружался.");
    } else {
      lines.push(
        `Каталог: ${state.catalog.models.length} моделей, загружен ${new Date(
          state.catalog.fetchedAt,
        ).toLocaleString("ru-RU")}${state.catalog.etag ? " (ETag)" : ""}.`,
      );
    }
    if (state.refresh.lastError !== null) {
      lines.push(`Последняя ошибка: ${state.refresh.lastError}`);
    }
    const grouped = groupModels(state.catalog?.models ?? [], state.selection.activeIds);
    const price = (model: CatalogModel) =>
      model.prices.input === null && model.prices.output === null
        ? "цена н/д"
        : `${model.prices.input ?? "?"}/${model.prices.output ?? "?"} ₽ за 1M`;
    if (grouped.active.length === 0) {
      lines.push("Активных моделей нет.");
    } else {
      lines.push("Активные:");
      for (const model of grouped.active) {
        const level = state.selection.reasoning[model.id] ?? "default";
        lines.push(`  ✓ ${model.name}  [${model.id}]  reasoning=${level}  ${price(model)}`);
      }
    }
    if (state.missingIds.length > 0) {
      lines.push("Больше не доступны (сохранены в выборе):");
      for (const id of state.missingIds) lines.push(`  ! ${id}`);
    }
    if (options.all === true && grouped.inactive.length > 0) {
      lines.push("Выключенные:");
      for (const model of grouped.inactive) {
        lines.push(`  · ${model.name}  [${model.id}]  ${price(model)}`);
      }
    } else if (grouped.inactive.length > 0) {
      lines.push(`Выключенных: ${grouped.inactive.length} (показать: --all).`);
    }
    lines.push(
      state.config.error === null
        ? `Конфиг: ${state.config.bytes} байт, ${state.config.modelCount} моделей, лимит ${state.config.maxBytes}.`
        : `Конфиг: ${state.config.error}`,
    );
    lines.push(
      state.provider.error === null
        ? `Провайдер bb: ${state.provider.id} (${state.provider.registered ? "зарегистрирован" : "не зарегистрирован"}), ${state.provider.modelCount} моделей.`
        : `Провайдер bb: ошибка — ${state.provider.error}`,
    );
    lines.push(
      state.settings.disableApprovalPrompts
        ? "Подтверждения bb: отключены (generic ACP, инструменты разрешены)."
        : "Подтверждения bb: включены (диалект opencode, действует режим разрешений треда).",
    );
    return lines;
  }

  async function findModel(id: string): Promise<CatalogModel> {
    const catalog = await readCatalog();
    if (catalog === null) throw new Error("Каталог не загружен: выполните `bb routerai-managed refresh`.");
    const model = catalog.models.find((candidate) => candidate.id === id);
    if (model === undefined) {
      throw new Error(`Модель ${id} не найдена в каталоге. Список: bb routerai-managed list --all`);
    }
    return model;
  }

  bb.cli.register({
    name: "routerai-managed",
    summary:
      "RouterAI Managed Profile: кэш каталога, выбор моделей и inline-конфиг OpenCode (не конфликтует с `bb routerai`)",
    commands: [
      { name: "refresh", summary: "Обновить каталог моделей (единственный сетевой вызов)", usage: "bb routerai-managed refresh [--json]" },
      { name: "list", summary: "Показать активные модели и статус", usage: "bb routerai-managed list [--all] [--json]" },
      { name: "enable", summary: "Включить модель", usage: "bb routerai-managed enable <model-id>" },
      { name: "disable", summary: "Выключить модель", usage: "bb routerai-managed disable <model-id>" },
      { name: "reasoning", summary: "Задать уровень reasoning", usage: "bb routerai-managed reasoning <model-id> <low|medium|high|default>" },
      { name: "apply", summary: "Пересобрать и применить inline-конфиг", usage: "bb routerai-managed apply [--json]" },
      { name: "approvals", summary: "Запросы подтверждений bb: on|off", usage: "bb routerai-managed approvals <on|off>" },
      { name: "status", summary: "Состояние кэша, выбора и провайдера", usage: "bb routerai-managed status [--json]" },
      { name: "show-config", summary: "Показать конфиг с замаскированным ключом", usage: "bb routerai-managed show-config [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const all = argv.includes("--all");
      const args = argv.filter((arg) => arg !== "--json" && arg !== "--all");
      const [command, first, ...rest] = args;
      const ok = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value, null, 2) : text,
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return {
            exitCode: 0,
            stdout: [
              "Usage:",
              "  bb routerai-managed refresh",
              "  bb routerai-managed list [--all]",
              "  bb routerai-managed enable <model-id>",
              "  bb routerai-managed disable <model-id>",
              "  bb routerai-managed reasoning <model-id> <low|medium|high|default>",
              "  bb routerai-managed apply",
              "  bb routerai-managed approvals <on|off>",
              "  bb routerai-managed status",
              "  bb routerai-managed show-config",
              "  (--json is accepted by every command)",
            ].join("\n"),
          };
        case "refresh": {
          const result = await refreshCatalog();
          publishChanged();
          if (result.outcome === "failed") {
            return fail(result.message ?? "Не удалось обновить каталог.");
          }
          const text = `${result.message ?? "Каталог обновлён."}\n${stateLines(result).join("\n")}`;
          return ok(result, text);
        }
        case "list": {
          const state = await readState();
          return ok(state, stateLines(state, { all }).join("\n"));
        }
        case "status": {
          const state = await readState();
          return ok(state, stateLines(state).join("\n"));
        }
        case "enable":
        case "disable": {
          if (first === undefined || rest.length > 0) {
            return fail("Укажите ровно один model-id. Список: bb routerai-managed list --all");
          }
          const model = await findModel(first);
          const catalog = await readCatalog();
          const selection = await readSelection(catalog);
          const next: StoredSelection = {
            activeIds: toggledActiveIds(selection.activeIds, model.id, command === "enable"),
            reasoning: selection.reasoning,
            updatedAt: Date.now(),
          };
          await bb.storage.kv.set(SELECTION_KEY, next);
          await applyNow(`cli-${command}`);
          publishChanged();
          const state = await readState({ sync: true });
          return ok(state, `${command === "enable" ? "Включена" : "Выключена"}: ${model.name}\n${stateLines(state).join("\n")}`);
        }
        case "reasoning": {
          if (first === undefined || rest.length !== 1) {
            return fail("Usage: bb routerai-managed reasoning <model-id> <low|medium|high|default>");
          }
          const level = rest[0];
          const model = await findModel(first);
          if (!model.levels.includes(level)) {
            return fail(
              `Уровень ${level} недоступен для ${model.id}. Допустимо: ${model.levels.join(", ")}`,
            );
          }
          const catalog = await readCatalog();
          const selection = await readSelection(catalog);
          await bb.storage.kv.set(SELECTION_KEY, {
            ...selection,
            reasoning: { ...selection.reasoning, [model.id]: level },
            updatedAt: Date.now(),
          });
          await applyNow("cli-reasoning");
          publishChanged();
          const state = await readState({ sync: true });
          return ok(state, `${model.name}: reasoning=${level}\n${stateLines(state).join("\n")}`);
        }
        case "apply": {
          await applyNow("cli-apply");
          const state = await readState({ sync: true });
          return ok(state, stateLines(state).join("\n"));
        }
        case "approvals": {
          if (first !== "on" && first !== "off") {
            return fail("Usage: bb routerai-managed approvals <on|off>");
          }
          await settings.experimental_set({ disableApprovalPrompts: first === "off" });
          await applyNow("cli-approvals");
          publishChanged();
          const state = await readState({ sync: true });
          const text =
            first === "off"
              ? "Подтверждения bb отключены (generic ACP). Новые треды не будут спрашивать."
              : "Подтверждения bb включены (диалект opencode).";
          return ok(state, `${text}\n${stateLines(state).join("\n")}`);
        }
        case "show-config": {
          const catalog = await readCatalog();
          const selection = await readSelection(catalog);
          if (catalog === null || selection.activeIds.length === 0) {
            return fail("Конфиг пуст: нет каталога или активных моделей.");
          }
          const key = await resolveApiKey();
          if (key === null) return fail("Ключ RouterAI не задан.");
          const built = buildManagedConfig({
            models: catalog.models,
            selection,
            apiKey: key.key,
            baseUrl: DEFAULT_BASE_URL,
          });
          if (built.bytes > MAX_CONFIG_BYTES) {
            return fail(
              new ConfigTooLargeError(built.bytes, MAX_CONFIG_BYTES, built.modelCount).message,
            );
          }
          return ok(
            { bytes: built.bytes, modelCount: built.modelCount, config: JSON.parse(redactConfig(built.json)) },
            redactConfig(built.json),
          );
        }
        default:
          return fail(`Неизвестная команда "${command}". Запустите bb routerai-managed --help.`);
      }
    },
  });

  // --- startup + background ------------------------------------------------

  await syncProviderRegistration();

  bb.background.service("routerai-managed", {
    async start(signal: AbortSignal) {
      while (!signal.aborted) {
        await sleep(REFRESH_CHECK_INTERVAL_MS, signal);
        if (signal.aborted) break;
        const values = await settings.get();
        if (values.autoRefreshDaily !== true) continue;
        const current = await readCatalog();
        const age = current === null ? Number.POSITIVE_INFINITY : Date.now() - current.fetchedAt;
        if (age < DAY_MS) continue;
        try {
          await refreshCatalog();
        } catch (error) {
          bb.log.warn(
            `фоновое обновление не удалось: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    },
  });

  settings.onChange((next, prev) => {
    if (
      next.apiKey !== prev.apiKey ||
      next.opencodeCommand !== prev.opencodeCommand ||
      next.disableApprovalPrompts !== prev.disableApprovalPrompts
    ) {
      void applyNow("settings").catch(() => undefined);
    }
    publishChanged();
  });

  bb.onDispose(() => {
    registration?.dispose();
    registration = null;
    bb.log.info("disposed");
  });
}
