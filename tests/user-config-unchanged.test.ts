// Acceptance criterion 1: the user's own OpenCode config must stay
// byte-for-byte identical. This test snapshots its sha256, exercises the
// plugin's config generator (including a full 20-model config), and asserts the
// hash did not change. It also asserts the generator never opens that path:
// the module imports no filesystem at all.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildManagedConfig } from "../core/config.ts";
import type { CatalogModel } from "../core/models.ts";

const configPath = join(
  process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode"),
  "opencode.json",
);

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sampleModels(count: number): CatalogModel[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `vendor/model-${index}`,
    key: `vendor-model-${index}`,
    name: `Model ${index}`,
    context: 128_000,
    output: 65_536,
    input: ["text"],
    reasoning: true,
    levels: ["low", "medium", "high", "default"],
    tools: true,
    prices: { input: 8.2, output: 16.4, cacheRead: 1.6, cacheWrite: null },
    created: 0,
  }));
}

test("user opencode.json is byte-for-byte unchanged across config generation", (t) => {
  const before = sha256File(configPath);
  if (before === null) {
    t.skip(`нет пользовательского конфига по пути ${configPath} (пропущено)`);
    return;
  }
  for (const count of [0, 1, 10, 20]) {
    const models = sampleModels(count);
    buildManagedConfig({
      models,
      selection: { activeIds: models.map((model) => model.id), reasoning: {} },
      apiKey: "test-key-not-a-real-secret",
    });
  }
  const after = sha256File(configPath);
  assert.equal(after, before, "пользовательский opencode.json изменился");
  t.diagnostic(`sha256 пользовательского конфига: ${before}`);
});

test("the config generator does not import filesystem or read files", (_t) => {
  const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
  const source = readFileSync(join(pluginRoot, "core", "config.ts"), "utf8");
  assert.equal(/node:fs/u.test(source), false, "core/config.ts должен быть чистым");
});
