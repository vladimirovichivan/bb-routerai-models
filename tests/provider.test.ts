import assert from "node:assert/strict";
import test from "node:test";
import {
  ACP_ARGS,
  buildProviderDeclaration,
  MANAGED_PROVIDER_ID,
  providerSignature,
} from "../core/provider.ts";
import { OPENCODE_CONFIG_ENV } from "../core/config.ts";

const config = JSON.stringify({ provider: { "routerai-managed": { models: {} } } });

test("the provider id is stable and slash-free", () => {
  const declaration = buildProviderDeclaration({ config });
  assert.equal(declaration.id, MANAGED_PROVIDER_ID);
  assert.equal(declaration.id, "routerai-managed");
  assert.equal(declaration.displayName, "RouterAI Managed");
});

test("the agent is bare `opencode acp`, so no platform path is hardcoded", () => {
  const declaration = buildProviderDeclaration({ config });
  const launch = declaration.experimental_bridgeOptions?.["acpLaunchSpec"] as {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  assert.equal(launch.command, "opencode");
  assert.deepEqual(launch.args, [...ACP_ARGS]);
  assert.equal(launch.env[OPENCODE_CONFIG_ENV], config);
});

test("an opt-in absolute path replaces the bare command", () => {
  const declaration = buildProviderDeclaration({
    config,
    opencodeCommand: "C:\\tools\\opencode.exe",
  });
  const launch = declaration.experimental_bridgeOptions?.["acpLaunchSpec"] as { command: string };
  assert.equal(launch.command, "C:\\tools\\opencode.exe");
});

test("without the opt-in the declaration keeps bb's native opencode dialect", () => {
  const declaration = buildProviderDeclaration({ config });
  assert.equal(declaration.experimental_bridgeOptions?.["acpDialect"], "opencode");
  const launch = declaration.experimental_bridgeOptions?.["acpLaunchSpec"] as {
    env: Record<string, string>;
  };
  // bb itself supplies the OpenCode session variables for this dialect.
  assert.deepEqual(launch.env, { [OPENCODE_CONFIG_ENV]: config });
  assert.deepEqual(declaration.models, { scope: "host" });
  assert.equal(declaration.maintenance?.health, true);
});

test("the opt-in switches to the generic ACP dialect so bb does not force approvals", () => {
  const declaration = buildProviderDeclaration({ config, disableApprovalPrompts: true });
  assert.equal(declaration.experimental_bridgeOptions?.["acpDialect"], "acp");
});

test("the opt-in launch environment keeps ACP client mode and allows tools without asking", () => {
  const declaration = buildProviderDeclaration({ config, disableApprovalPrompts: true });
  const launch = declaration.experimental_bridgeOptions?.["acpLaunchSpec"] as {
    env: Record<string, string>;
  };
  assert.equal(launch.env[OPENCODE_CONFIG_ENV], config);
  assert.equal(launch.env.OPENCODE_CLIENT, "acp");
  assert.equal(launch.env.OPENCODE_ENABLE_QUESTION_TOOL, "false");
  assert.deepEqual(JSON.parse(launch.env.OPENCODE_PERMISSION ?? "{}"), {
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    external_directory: "allow",
  });
});

test("capabilities mirror the official ACP declarations", () => {
  const declaration = buildProviderDeclaration({ config });
  assert.equal(declaration.capabilities.fork, "tip");
  assert.deepEqual(declaration.capabilities.permissionModes, ["accept-edits", "full"]);
  assert.deepEqual(declaration.capabilities.reasoningLevels, ["low", "medium", "high"]);
  assert.equal(declaration.capabilities.supportsServiceTier, false);
  assert.deepEqual(declaration.composerActions, []);
});

test("the signature changes with the config and is stable otherwise", () => {
  const first = providerSignature(buildProviderDeclaration({ config }));
  const same = providerSignature(buildProviderDeclaration({ config }));
  const changed = providerSignature(
    buildProviderDeclaration({ config: JSON.stringify({ provider: {} }) }),
  );
  assert.equal(first, same);
  assert.notEqual(first, changed);
});
