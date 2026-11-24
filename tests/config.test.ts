import assert from "node:assert/strict";
import test from "node:test";
import {
  buildManagedConfig,
  ConfigTooLargeError,
  configBytes,
  MAX_CONFIG_BYTES,
  MAX_OUTPUT_TOKENS,
  redactConfig,
} from "../core/config.ts";
import type { CatalogModel } from "../core/models.ts";

function model(index: number, overrides: Partial<CatalogModel> = {}): CatalogModel {
  const id = overrides.id ?? `vendor/model-${index}`;
  return {
    id,
    key: overrides.key ?? id.replace(/[^a-z0-9._-]+/gi, "-"),
    name: overrides.name ?? `Model ${index}`,
    context: 128_000,
    output: 65_536,
    input: ["text"],
    reasoning: true,
    levels: ["low", "medium", "high", "default"],
    tools: true,
    prices: { input: 8.2, output: 16.4, cacheRead: 1.6, cacheWrite: null },
    created: 1,
    ...overrides,
  };
}

test("emits only selected models, using the RouterAI id as upstream id", () => {
  const models = [model(1), model(2), model(3)];
  const built = buildManagedConfig({
    models,
    selection: { activeIds: ["vendor/model-1", "vendor/model-3"], reasoning: {} },
    apiKey: "secret-key",
  });
  const parsed = JSON.parse(built.json);
  const provider = parsed.provider["routerai-managed"];
  assert.equal(parsed.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(parsed.enabled_providers, ["routerai-managed"]);
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider.options.apiKey, "secret-key");
  assert.equal(provider.options.baseURL, "https://routerai.ru/api/v1");
  assert.deepEqual(Object.keys(provider.models).sort(), ["vendor-model-1", "vendor-model-3"]);
  assert.equal(provider.models["vendor-model-1"].id, "vendor/model-1");
  assert.equal(built.modelCount, 2);
});

test("copies limits, cost, capabilities and modalities", () => {
  const built = buildManagedConfig({
    models: [model(1, { input: ["text", "image"] })],
    selection: { activeIds: ["vendor/model-1"], reasoning: {} },
    apiKey: "k",
  });
  const entry = JSON.parse(built.json).provider["routerai-managed"].models["vendor-model-1"];
  assert.deepEqual(entry.limit, { context: 128_000, output: MAX_OUTPUT_TOKENS });
  assert.deepEqual(entry.cost, {
    input: 8.2,
    output: 16.4,
    cache_read: 1.6,
    cache_write: 8.2,
  });
  assert.deepEqual(entry.capabilities, { reasoning: true, toolCall: true, attachment: true });
  assert.equal(entry.reasoning, true);
  assert.equal(entry.tool_call, true);
  assert.equal(entry.attachment, true);
  assert.deepEqual(entry.modalities.input, ["text", "image"]);
});

test("modalities are limited to the OpenCode enum", () => {
  // RouterAI says `file`; OpenCode's schema only has `pdf`. A value outside the
  // enum makes OpenCode reject the whole config (`CatalogNotReady`), so every
  // unknown modality must be mapped or dropped.
  const built = buildManagedConfig({
    models: [
      model(1, { input: ["text", "image", "file"] }),
      model(2, { input: ["text", "document", "speech"] }),
    ],
    selection: { activeIds: ["vendor/model-1", "vendor/model-2"], reasoning: {} },
    apiKey: "k",
  });
  const models = JSON.parse(built.json).provider["routerai-managed"].models;
  assert.deepEqual(models["vendor-model-1"].modalities.input, ["text", "image", "pdf"]);
  assert.equal(models["vendor-model-1"].attachment, true);
  assert.deepEqual(models["vendor-model-2"].modalities.input, ["text"]);
  assert.equal(models["vendor-model-2"].attachment, false);
  for (const entry of Object.values<{ modalities: { input: string[] } }>(models)) {
    for (const modality of entry.modalities.input) {
      assert.ok(["text", "audio", "image", "video", "pdf"].includes(modality), modality);
    }
  }
});

test("cached tokens fall back to the input price, like the official plugin", () => {  const built = buildManagedConfig({
    models: [
      model(1, {
        prices: { input: 3, output: 5, cacheRead: null, cacheWrite: null },
      }),
    ],
    selection: { activeIds: ["vendor/model-1"], reasoning: {} },
    apiKey: "k",
  });
  const entry = JSON.parse(built.json).provider["routerai-managed"].models["vendor-model-1"];
  assert.equal(entry.cost.cache_read, 3);
  assert.equal(entry.cost.cache_write, 3);
});

test("default reasoning is not written as an option", () => {
  const built = buildManagedConfig({
    models: [model(1)],
    selection: { activeIds: ["vendor/model-1"], reasoning: { "vendor/model-1": "default" } },
    apiKey: "k",
  });
  const entry = JSON.parse(built.json).provider["routerai-managed"].models["vendor-model-1"];
  assert.equal(entry.options, undefined);
});

test("an explicit level is written as reasoningEffort", () => {
  const built = buildManagedConfig({
    models: [model(1)],
    selection: { activeIds: ["vendor/model-1"], reasoning: { "vendor/model-1": "high" } },
    apiKey: "k",
  });
  const entry = JSON.parse(built.json).provider["routerai-managed"].models["vendor-model-1"];
  assert.deepEqual(entry.options, { reasoningEffort: "high" });
});

test("a level the model does not advertise is ignored", () => {
  const built = buildManagedConfig({
    models: [model(1, { levels: [] })],
    selection: { activeIds: ["vendor/model-1"], reasoning: { "vendor/model-1": "high" } },
    apiKey: "k",
  });
  const entry = JSON.parse(built.json).provider["routerai-managed"].models["vendor-model-1"];
  assert.equal(entry.options, undefined);
});

test("missing ids are reported and skipped", () => {
  const built = buildManagedConfig({
    models: [model(1)],
    selection: { activeIds: ["vendor/model-1", "gone/model"], reasoning: {} },
    apiKey: "k",
  });
  assert.deepEqual(built.missingIds, ["gone/model"]);
  assert.equal(built.modelCount, 1);
});

test("an empty selection still yields a valid provider with no models", () => {
  const built = buildManagedConfig({
    models: [model(1)],
    selection: { activeIds: [], reasoning: {} },
    apiKey: "",
  });
  assert.equal(built.modelCount, 0);
  const provider = JSON.parse(built.json).provider["routerai-managed"];
  assert.deepEqual(provider.models, {});
  assert.equal(provider.options.apiKey, "");
});

test("20 realistic models stay well under the inline limit", () => {
  const models = Array.from({ length: 20 }, (_, index) =>
    model(index, {
      id: `vendor/some-long-model-name-number-${index}-2026`,
      name: `Some Vendor: Extremely Descriptive Model Name ${index}`,
      input: ["text", "image", "file"],
      prices: { input: 12.3456, output: 24.6912, cacheRead: 1.2345, cacheWrite: 2.4691 },
    }),
  );
  const built = buildManagedConfig({
    models,
    selection: { activeIds: models.map((entry) => entry.id), reasoning: {} },
    apiKey: "x".repeat(64),
  });
  assert.ok(built.bytes < MAX_CONFIG_BYTES, `bytes=${built.bytes}`);
  assert.ok(built.bytes > 4_000, `bytes=${built.bytes}`);
  assert.equal(built.bytes, configBytes(built.json));
});

test("the size guard is a plain, actionable error", () => {
  const models = Array.from({ length: 120 }, (_, index) =>
    model(index, { id: `vendor/${"x".repeat(220)}-${index}`, key: `k${index}` }),
  );
  const built = buildManagedConfig({
    models,
    selection: { activeIds: models.map((entry) => entry.id), reasoning: {} },
    apiKey: "x".repeat(64),
  });
  assert.ok(built.bytes > MAX_CONFIG_BYTES);
  const error = new ConfigTooLargeError(built.bytes, MAX_CONFIG_BYTES, built.modelCount);
  assert.match(error.message, /Слишком много активных моделей/);
  assert.match(error.message, /Отключите часть моделей/);
});

test("redaction removes the key but keeps the structure", () => {
  const built = buildManagedConfig({
    models: [model(1)],
    selection: { activeIds: ["vendor/model-1"], reasoning: {} },
    apiKey: "super-secret",
  });
  const redacted = redactConfig(built.json);
  assert.ok(!redacted.includes("super-secret"));
  assert.match(redacted, /"\*\*\*"/);
  assert.match(redacted, /routerai-managed/);
});
