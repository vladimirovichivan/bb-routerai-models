// Pure catalog logic: normalize the RouterAI /api/v1/models payload into the
// small record the plugin caches. No I/O, no network, no secrets.

/** One entry of `GET https://routerai.ru/api/v1/models` (`data` array). */
export interface RouteraiModelRaw {
  id?: unknown;
  name?: unknown;
  created?: unknown;
  context_length?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
  pricing?: Record<string, unknown>;
  pricing_units?: Record<string, unknown>;
  supported_parameters?: unknown;
  [key: string]: unknown;
}

export interface ModelPrices {
  /** RUB per 1M input tokens. */
  input: number | null;
  /** RUB per 1M output tokens. */
  output: number | null;
  /** RUB per 1M cache-read tokens. */
  cacheRead: number | null;
  /** RUB per 1M cache-write tokens. */
  cacheWrite: number | null;
}

export interface CatalogModel {
  /** RouterAI upstream model id, e.g. `deepseek/deepseek-v4.1-flash`. */
  id: string;
  /** OpenCode model key inside the managed provider (no slashes). */
  key: string;
  name: string;
  /** Context window in tokens. */
  context: number;
  /** Output limit in tokens (RouterAI does not publish one; bounded fallback). */
  output: number;
  /** Input modalities: `text` always, plus `image`/`file` when supported. */
  input: string[];
  reasoning: boolean;
  /** Selectable reasoning levels; empty when the provider advertises none. */
  levels: string[];
  tools: boolean;
  prices: ModelPrices;
  /** Unix seconds from the provider, used only as a stable sort tiebreaker. */
  created: number;
}

export const REASONING_DEFAULT = "default";

/** Levels offered when the provider advertises `reasoning_effort`. */
export const REASONING_EFFORT_LEVELS = ["low", "medium", "high", REASONING_DEFAULT] as const;

/** RouterAI publishes no output cap; the official plugin uses this value. */
const OUTPUT_LIMIT = 32_000;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function modalityList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function perMillion(perToken: number | null): number | null {
  if (perToken === null) return null;
  return Math.round(perToken * 1_000_000 * 10_000) / 10_000;
}

function priceOf(
  pricing: Record<string, unknown> | undefined,
  units: Record<string, unknown> | undefined,
  field: string,
): number | null {
  if (pricing === undefined) return null;
  const value = num(pricing[field]);
  if (value === null) return null;
  // RouterAI prices per token. Anything priced per request/unit is not a
  // token price and must not be shown as one.
  const unit = units?.[field];
  if (typeof unit === "string" && unit !== "token") return null;
  return perMillion(value);
}

/**
 * Selection order after enabling or disabling one model. The order is the order
 * the user enabled models, so the first one stays bb's default for the
 * provider; ids that vanished from the catalog keep their place.
 */
export function toggledActiveIds(
  activeIds: readonly string[],
  id: string,
  active: boolean,
): string[] {
  const next = activeIds.filter((existing) => existing !== id);
  if (active) next.push(id);
  return next;
}

/** OpenCode keys must be unique and free of slashes inside a provider. */
export function modelKey(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug === "" ? "model" : slug;
}

function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Keeps only text→text chat models that advertise tool calling. Image, video,
 * speech, embeddings, decision, and rerank models are dropped by the output
 * modality check.
 */
export function isUsableChatModel(raw: RouteraiModelRaw): boolean {
  const architecture = raw.architecture ?? {};
  const outputs = modalityList(architecture.output_modalities);
  const inputs = modalityList(architecture.input_modalities);
  const parameters = Array.isArray(raw.supported_parameters)
    ? raw.supported_parameters.filter((item): item is string => typeof item === "string")
    : [];
  if (!outputs.includes("text") || outputs.some((modality) => modality !== "text")) return false;
  if (!inputs.includes("text")) return false;
  return parameters.includes("tools");
}

export function normalizeModel(
  raw: RouteraiModelRaw,
  key: string,
): CatalogModel | null {
  if (!isUsableChatModel(raw)) return null;
  const id = str(raw.id);
  const name = str(raw.name) ?? id;
  if (id === null || name === null) return null;

  const architecture = raw.architecture ?? {};
  const inputs = modalityList(architecture.input_modalities);
  const parameters = new Set(modalityList(raw.supported_parameters));
  const context = num(raw.context_length) ?? 0;
  const created = num(raw.created) ?? 0;

  return {
    id,
    key,
    name,
    context,
    output: context > 0 ? Math.min(OUTPUT_LIMIT, context) : OUTPUT_LIMIT,
    input: inputs.filter((modality) => modality === "text" || modality === "image" || modality === "file"),
    reasoning: parameters.has("reasoning") || parameters.has("reasoning_effort"),
    levels: parameters.has("reasoning_effort") ? [...REASONING_EFFORT_LEVELS] : [],
    tools: true,
    prices: {
      input: priceOf(raw.pricing, raw.pricing_units, "prompt"),
      output: priceOf(raw.pricing, raw.pricing_units, "completion"),
      cacheRead: priceOf(raw.pricing, raw.pricing_units, "input_cache_read"),
      cacheWrite: priceOf(raw.pricing, raw.pricing_units, "input_cache_write"),
    },
    created,
  };
}

/**
 * Normalizes a full payload. Order is stable: by display name (case-insensitive)
 * with the upstream id as tiebreaker. The UI re-sorts into active/inactive
 * groups but never depends on provider order.
 */
export function normalizeCatalog(payload: unknown): CatalogModel[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error("RouterAI вернул неожиданный ответ: нет массива data");
  }
  const taken = new Set<string>();
  const models: CatalogModel[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as RouteraiModelRaw;
    if (!isUsableChatModel(raw)) continue;
    const id = str(raw.id);
    if (id === null) continue;
    const key = uniqueKey(modelKey(id), taken);
    const model = normalizeModel(raw, key);
    if (model === null) continue;
    taken.add(key);
    models.push(model);
  }
  models.sort(
    (left, right) =>
      left.name.localeCompare(right.name, "ru", { sensitivity: "base" }) ||
      left.id.localeCompare(right.id) ||
      left.created - right.created,
  );
  return models;
}

/** True when the selection references a model the latest catalog lacks. */
export function missingSelectionIds(activeIds: readonly string[], catalog: readonly CatalogModel[]): string[] {
  const known = new Set(catalog.map((model) => model.id));
  return activeIds.filter((id) => !known.has(id));
}
