// Dev tool: ask `opencode acp` which models it sees for a given
// OPENCODE_CONFIG_CONTENT. This is the only reliable way to check that the
// generated config is valid: the OpenCode background service ignores the env
// variable, while `opencode acp` starts its own server and honours it.
//
// Usage (from the repo root, with bb running):
//   node tools/acp-probe.mjs                 # current plugin config
//   node tools/acp-probe.mjs config.json     # any saved config (key may be "***")
//
// The API key: a real key from the plugin output is used as is; the redacted
// "***" placeholder is replaced with ROUTERAI_API_KEY (or
// ROUTERAI_WINDOWS_API_KEY) from the environment. Nothing is printed but model
// ids and names.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function currentConfig() {
  const out = execFileSync("cmd", ["/c", "bb", "routerai-managed", "show-config", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out).config;
}

function loadConfig(path) {
  if (path === undefined) return currentConfig();
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function withKey(config) {
  const providers = config.provider ?? {};
  const envKey = process.env.ROUTERAI_API_KEY ?? process.env.ROUTERAI_WINDOWS_API_KEY ?? "";
  for (const provider of Object.values(providers)) {
    const options = provider.options ?? {};
    if (options.apiKey === "***") {
      if (envKey === "") {
        console.error("apiKey is redacted and no ROUTERAI_API_KEY is set; using a dummy key.");
      }
      options.apiKey = envKey === "" ? "dummy-key" : envKey;
    }
  }
  return config;
}

function probe(config, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn("cmd", ["/c", "opencode", "acp"], {
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    let buffer = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === "") continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
          }
        } catch {
          // ACP servers may print non-JSON diagnostics; ignore them.
        }
      }
    });

    const request = (id, method, params) =>
      new Promise((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          done(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    (async () => {
      try {
        await request(1, "initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        });
        const created = await request(2, "session/new", { cwd: process.cwd(), mcpServers: [] });
        if (created.error !== undefined) {
          resolve({ ok: false, message: JSON.stringify(created.error), stderr });
          return;
        }
        const modelOption = (created.result?.configOptions ?? []).find(
          (option) => option.id === "model",
        );
        const models = (modelOption?.options ?? []).map((option) => option.value);
        resolve({ ok: true, models, current: modelOption?.currentValue ?? null, stderr });
      } catch (error) {
        resolve({ ok: false, message: error.message, stderr });
      } finally {
        child.stdin.end();
        child.kill();
      }
    })();
  });
}

const config = withKey(loadConfig(process.argv[2]));
const modelCount = Object.keys(config.provider?.["routerai-managed"]?.models ?? {}).length;
const bytes = Buffer.byteLength(JSON.stringify(config));
console.log(`config: ${bytes} bytes, ${modelCount} models`);

const result = await probe(config);
if (!result.ok) {
  console.error(`ACP rejected the config: ${result.message}`);
  if (result.stderr.trim() !== "") console.error(result.stderr.slice(0, 2000));
  process.exit(1);
}
console.log(`ACP reports ${result.models.length} models, current: ${result.current}`);
for (const model of result.models) console.log(`  ${model}`);
process.exit(0);
