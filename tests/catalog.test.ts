import assert from "node:assert/strict";
import test from "node:test";
import {
  isUsableChatModel,
  missingSelectionIds,
  modelDisplayName,
  modelKey,
  normalizeCatalog,
  REASONING_EFFORT_LEVELS,
  toggledActiveIds,
  type RouteraiModelRaw,
} from "../core/models.ts";

function raw(overrides: Partial<RouteraiModelRaw> & { id: string }): RouteraiModelRaw {
  return {
    name: overrides.id,
    context_length: 128_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools"],
    pricing: { prompt: 0.000001, completion: 0.000002, input_cache_read: 0.0000005 },
    pricing_units: { prompt: "token", completion: "token", input_cache_read: "token" },
    ...overrides,
  };
}

test("keeps only text→text models that support tools", () => {
  const payload = {
    data: [
      raw({ id: "a/text-tools" }),
      raw({ id: "b/no-tools", supported_parameters: ["temperature"] }),
      raw({
        id: "c/image-out",
        architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      }),
      raw({
        id: "d/decisions",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] },
      }),
      raw({
        id: "e/video",
        architecture: { input_modalities: ["text"], output_modalities: ["video"] },
      }),
    ],
  };
  const models = normalizeCatalog(payload);
  assert.deepEqual(
    models.map((model) => model.id),
    ["a/text-tools"],
  );
});

test("vision models stay when the output is text", () => {
  const payload = {
    data: [
      raw({
        id: "v/vision",
        architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
      }),
    ],
  };
  const [model] = normalizeCatalog(payload);
  assert.ok(model);
  assert.deepEqual(model.input, ["text", "image", "file"]);
});

test("prices are converted from per-token to RUB per 1M tokens", () => {
  const [model] = normalizeCatalog({
    data: [raw({ id: "p/model", pricing: { prompt: 0.00000822309488, completion: 0.00001644618976 } })],
  });
  assert.ok(model);
  assert.equal(model.prices.input, 8.2231);
  assert.equal(model.prices.output, 16.4462);
  assert.equal(model.prices.cacheRead, null);
});

test("non-token pricing units are not shown as token prices", () => {
  const [model] = normalizeCatalog({
    data: [raw({ id: "p/unit", pricing: { prompt: 0.5 }, pricing_units: { prompt: "request" } })],
  });
  assert.ok(model);
  assert.equal(model.prices.input, null);
});

test("reasoning levels come only from advertised reasoning_effort", () => {
  const models = normalizeCatalog({
    data: [
      raw({ id: "r/effort", supported_parameters: ["tools", "reasoning", "reasoning_effort"] }),
      raw({ id: "r/bool", supported_parameters: ["tools", "reasoning"] }),
      raw({ id: "r/none", supported_parameters: ["tools"] }),
    ],
  });
  const byId = new Map(models.map((model) => [model.id, model]));
  assert.deepEqual(byId.get("r/effort")?.levels, [...REASONING_EFFORT_LEVELS]);
  assert.equal(byId.get("r/effort")?.reasoning, true);
  assert.deepEqual(byId.get("r/bool")?.levels, []);
  assert.equal(byId.get("r/bool")?.reasoning, true);
  assert.equal(byId.get("r/none")?.reasoning, false);
  assert.deepEqual(byId.get("r/none")?.levels, []);
});

test("output limit is bounded by context and the fixed ceiling", () => {
  const models = normalizeCatalog({
    data: [
      raw({ id: "small", context_length: 4096 }),
      raw({ id: "huge", context_length: 2_000_000 }),
    ],
  });
  const byId = new Map(models.map((model) => [model.id, model]));
  assert.equal(byId.get("small")?.output, 4096);
  // The catalog publishes no output cap; the ceiling matches the official plugin.
  assert.equal(byId.get("huge")?.output, 32_000);
});

test("model keys are slugged and unique", () => {
  assert.equal(modelKey("anthropic/claude-haiku-5.5"), "anthropic-claude-haiku-5.5");
  assert.equal(modelKey("~deepseek/x"), "deepseek-x");
  const models = normalizeCatalog({
    data: [
      raw({ id: "same/id", name: "A" }),
      raw({ id: "same-id", name: "B" }),
    ],
  });
  assert.deepEqual(
    models.map((model) => model.key),
    ["same-id", "same-id-2"],
  );
});

test("picker names keep the version and move the vendor to the end", () => {
  // bb shows ~40 characters of `routerai-managed/<name>`, so the tail is what
  // gets cut; the version must not be at the end of the raw catalog name.
  assert.equal(
    modelDisplayName({ id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5" }),
    "Claude Haiku 5.5 (Anthropic)",
  );
  // The vendor is already in the name: no parenthetical noise.
  assert.equal(
    modelDisplayName({ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek: DeepSeek V4.1 Flash" }),
    "DeepSeek V4.1 Flash",
  );
  // A name without a vendor prefix stays as is.
  assert.equal(
    modelDisplayName({ id: "reka/reka-edge", name: "Reka Edge" }),
    "Reka Edge",
  );
  // Alias ids share the pinned release's name, so they get a marker instead.
  assert.equal(
    modelDisplayName({ id: "~anthropic/claude-sonnet-latest", name: "Anthropic: Claude Sonnet 5.5" }),
    "Claude Sonnet 5.5 (latest)",
  );
});

test("catalog order is name-sorted and stable", () => {
  const models = normalizeCatalog({
    data: [
      raw({ id: "b", name: "Beta" }),
      raw({ id: "a", name: "alpha" }),
      raw({ id: "a2", name: "Alpha" }),
    ],
  });
  assert.deepEqual(
    models.map((model) => model.name),
    ["alpha", "Alpha", "Beta"],
  );
});

test("missing selection ids are reported, not dropped", () => {
  const models = normalizeCatalog({ data: [raw({ id: "exists" })] });
  assert.deepEqual(missingSelectionIds(["exists", "gone"], models), ["gone"]);
});

test("a malformed payload fails loudly", () => {
  assert.throws(() => normalizeCatalog({ nope: true }), /нет массива data/);
});

test("selection order follows the user, so the first model stays the default", () => {
  assert.deepEqual(toggledActiveIds([], "a", true), ["a"]);
  assert.deepEqual(toggledActiveIds(["a"], "b", true), ["a", "b"]);
  assert.deepEqual(toggledActiveIds(["a", "b"], "a", false), ["b"]);
  assert.deepEqual(toggledActiveIds(["a", "b"], "c", true), ["a", "b", "c"]);
  // Re-enabling an already active model keeps a single entry.
  assert.deepEqual(toggledActiveIds(["a", "b"], "a", true), ["b", "a"]);
  // Ids that vanished from the catalog keep their place until disabled.
  assert.deepEqual(toggledActiveIds(["gone", "a"], "b", true), ["gone", "a", "b"]);
});

test("isUsableChatModel ignores non-object entries", () => {
  assert.equal(isUsableChatModel({} as RouteraiModelRaw), false);
});
