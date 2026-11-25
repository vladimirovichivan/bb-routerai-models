// Pure managed-config generation for OpenCode. No I/O: the caller supplies the
// API key, the cached catalog, and the user's selection.
//
// The shape follows the official RouterAI bb plugin (router-ai/bb-plugin-routerai,
// src/opencode-config.ts) so both plugins behave the same way inside OpenCode:
// a `$schema`, `enabled_providers` limited to this provider, per-token prices
// in rubles, and cache prices falling back to the input price.
import type { CatalogModel } from "./models.ts";
import { modelDisplayName, REASONING_DEFAULT } from "./models.ts";

export const MANAGED_PROVIDER_ID = "routerai-managed";
export const MANAGED_PROVIDER_NAME = "RouterAI Managed";
export const DEFAULT_BASE_URL = "https://routerai.ru/api/v1";
export const MANAGED_NPM = "@ai-sdk/openai-compatible";
export const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";
export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

/**
 * Inline config ceiling: Windows refuses a single very large environment block
 * (`CreateProcess` limit 32767 characters for the whole block), so keep a
 * safety margin below it.
 */
export const MAX_CONFIG_BYTES = 24 * 1024;

/** RouterAI publishes no output cap; the official plugin uses this value. */
export const MAX_OUTPUT_TOKENS = 32_000;

export interface ManagedSelection {
  /** Active model ids (RouterAI ids). Order is irrelevant. */
  activeIds: readonly string[];
  /** Reasoning level per model id; `default` or absent means provider default. */
  reasoning: Readonly<Record<string, string>>;
}

export interface BuildConfigInput {
  models: readonly CatalogModel[];
  selection: ManagedSelection;
  /** Empty string while the key is not set yet: the config stays parseable. */
  apiKey: string;
  baseUrl?: string;
}

export interface BuiltConfig {
  /** Serialized OPENCODE_CONFIG_CONTENT value. Contains the API key. */
  json: string;
  bytes: number;
  modelCount: number;
  /** Model ids that were skipped because the catalog no longer has them. */
  missingIds: string[];
}

export class ConfigTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;
  readonly modelCount: number;
  constructor(bytes: number, maxBytes: number, modelCount: number) {
    super(
      `Слишком много активных моделей для inline-конфига: ${bytes} байт при лимите ${maxBytes}. ` +
        `Отключите часть моделей (сейчас активно ${modelCount}) и обновите конфиг.`,
    );
    this.name = "ConfigTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
    this.modelCount = modelCount;
  }
}

/**
 * Rubles per 1M tokens. Cached tokens cost the input price where the catalog
 * lists none of their own, which is what OpenCode uses to price a turn.
 */
function priceFields(model: CatalogModel): Record<string, number> {
  const cost: Record<string, number> = {};
  if (model.prices.input !== null) cost.input = model.prices.input;
  if (model.prices.output !== null) cost.output = model.prices.output;
  const cacheRead = model.prices.cacheRead ?? model.prices.input;
  const cacheWrite = model.prices.cacheWrite ?? model.prices.input;
  if (cacheRead !== null) cost.cache_read = cacheRead;
  if (cacheWrite !== null) cost.cache_write = cacheWrite;
  return cost;
}

/**
 * OpenCode's config schema only accepts these modalities (`opencode.ai/config.json`,
 * `provider.<id>.models.<key>.modalities`). RouterAI uses its own vocabulary —
 * notably a generic `file` for document attachments, which OpenCode calls `pdf`.
 */
const OPENCODE_MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;

/** RouterAI modality → OpenCode modality, for values that differ by name. */
const MODALITY_ALIASES: Record<string, string> = { file: "pdf" };

/**
 * Translates the catalog's modalities into the OpenCode enum. One unknown value
 * is enough for OpenCode to reject the whole config and report no models at all
 * (`CatalogNotReady`), so nothing outside the enum may reach the document.
 */
function opencodeModalities(input: readonly string[]): string[] {
  const allowed = new Set<string>(OPENCODE_MODALITIES);
  const result: string[] = [];
  for (const modality of input) {
    const mapped = MODALITY_ALIASES[modality] ?? modality;
    if (allowed.has(mapped) && !result.includes(mapped)) result.push(mapped);
  }
  if (!result.includes("text")) result.unshift("text");
  return result;
}

function modelEntry(model: CatalogModel, level: string | undefined) {
  const attachment = model.input.includes("image") || model.input.includes("file");
  const cost = priceFields(model);
  const useLevel =
    level !== undefined && level !== REASONING_DEFAULT && model.levels.includes(level);
  const entry: Record<string, unknown> = {
    name: modelDisplayName(model),
    id: model.id,
    limit: {
      context: model.context,
      output: Math.min(model.output, MAX_OUTPUT_TOKENS),
    },
    // Both shapes are emitted: OpenCode 1.x documents `capabilities`, while the
    // OpenCode 2 schema uses the flattened keys. Each version ignores the other.
    capabilities: { reasoning: model.reasoning, toolCall: model.tools, attachment },
    reasoning: model.reasoning,
    tool_call: model.tools,
    attachment,
    modalities: { input: opencodeModalities(model.input), output: ["text"] },
  };
  if (Object.keys(cost).length > 0) entry.cost = cost;
  if (useLevel) entry.options = { reasoningEffort: level };
  return entry;
}

/**
 * Builds `OPENCODE_CONFIG_CONTENT`. Only active models present in the catalog
 * are emitted; ids that disappeared stay in the stored selection but are
 * reported back so the UI can flag them.
 */
export function buildManagedConfig(input: BuildConfigInput): BuiltConfig {
  const active = new Set(input.selection.activeIds);
  const byId = new Map(input.models.map((model) => [model.id, model]));
  const missingIds: string[] = [];
  const entries: Record<string, ReturnType<typeof modelEntry>> = {};

  for (const id of active) {
    const model = byId.get(id);
    if (model === undefined) {
      missingIds.push(id);
      continue;
    }
    entries[model.key] = modelEntry(model, input.selection.reasoning[id]);
  }

  const document = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    // Only this provider's models reach the picker, not OpenCode's own catalog.
    enabled_providers: [MANAGED_PROVIDER_ID],
    provider: {
      [MANAGED_PROVIDER_ID]: {
        npm: MANAGED_NPM,
        name: MANAGED_PROVIDER_NAME,
        options: {
          baseURL: input.baseUrl ?? DEFAULT_BASE_URL,
          apiKey: input.apiKey,
        },
        models: entries,
      },
    },
  };

  const json = JSON.stringify(document);
  const bytes = new TextEncoder().encode(json).length;
  const modelCount = Object.keys(entries).length;
  return { json, bytes, modelCount, missingIds };
}

/** Byte count without materializing a key-bearing document elsewhere. */
export function configBytes(json: string): number {
  return new TextEncoder().encode(json).length;
}

/** Copy safe to show in logs, UI, or CLI output. */
export function redactConfig(json: string): string {
  try {
    const parsed = JSON.parse(json) as unknown;
    const providers = (parsed as { provider?: Record<string, { options?: Record<string, unknown> }> })
      .provider;
    if (providers !== undefined) {
      for (const provider of Object.values(providers)) {
        if (provider.options !== undefined) provider.options.apiKey = "***";
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return "<unserializable config>";
  }
}

export function reasoningLevelsFor(
  models: readonly CatalogModel[],
  id: string,
): readonly string[] {
  return models.find((model) => model.id === id)?.levels ?? [];
}
