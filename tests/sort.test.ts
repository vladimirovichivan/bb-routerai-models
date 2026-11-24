import assert from "node:assert/strict";
import test from "node:test";
import { groupModels, missingIds, sanitizeReasoning } from "../core/sort.ts";
import type { CatalogModel } from "../core/models.ts";

function model(id: string, name: string): CatalogModel {
  return {
    id,
    key: id,
    name,
    context: 1000,
    output: 1000,
    input: ["text"],
    reasoning: false,
    levels: [],
    tools: true,
    prices: { input: null, output: null, cacheRead: null, cacheWrite: null },
    created: 0,
  };
}

const catalog = [model("b", "Beta"), model("a", "alpha"), model("c", "Gamma"), model("d", "delta")];

test("active models come first and each group is name-sorted", () => {
  const grouped = groupModels(catalog, ["b", "d"]);
  assert.deepEqual(
    grouped.active.map((entry) => entry.id),
    ["b", "d"],
  );
  assert.deepEqual(
    grouped.inactive.map((entry) => entry.id),
    ["a", "c"],
  );
});

test("sorting does not depend on the saved order of ids", () => {
  const first = groupModels(catalog, ["d", "b"]);
  const second = groupModels(catalog, ["b", "d"]);
  assert.deepEqual(
    first.active.map((entry) => entry.id),
    second.active.map((entry) => entry.id),
  );
});

test("a selected id missing from the catalog never lands in a list", () => {
  const grouped = groupModels(catalog, ["gone"]);
  assert.equal(grouped.active.length, 0);
  assert.equal(grouped.inactive.length, 4);
  assert.deepEqual(missingIds(["gone", "b"], catalog), ["gone"]);
});

test("levels of known models are validated; vanished ids keep their value", () => {
  const withLevels = [{ ...model("a", "alpha"), levels: ["low", "high"] }];
  const sanitized = sanitizeReasoning(withLevels, {
    a: "high",
    b: "medium",
    ghost: "low",
  });
  // `a` is known and valid; `b`/`ghost` are not in this catalog, so their
  // values survive for when they come back.
  assert.deepEqual(sanitized, { a: "high", b: "medium", ghost: "low" });
});

test("a known model with an unadvertised level is dropped", () => {
  const withLevels = [{ ...model("a", "alpha"), levels: ["low"] }];
  assert.deepEqual(sanitizeReasoning(withLevels, { a: "high" }), {});
});
