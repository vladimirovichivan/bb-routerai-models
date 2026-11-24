// The bb provider declaration for this plugin's managed profile.
//
// bb runs ACP agents through one generic bridge: a plugin re-exports
// `experimental_acpProviderBridge` from its `bb.host` artifact (see `host.ts`)
// and registers a provider whose `experimental_bridgeOptions.acpLaunchSpec`
// names the command and the environment it starts with. That is exactly what
// the official RouterAI plugin does; this module builds the same declaration
// shape without depending on the `provider-acp` plugin or its settings.
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { OPENCODE_CONFIG_ENV } from "./config.ts";

/** bb provider id; threads persist it, so it must never change. */
export const MANAGED_PROVIDER_ID = "routerai-managed";
export const MANAGED_PROVIDER_DISPLAY_NAME = "RouterAI Managed";

/** The agent binary; `opencode acp` speaks ACP. */
export const ACP_COMMAND = "opencode";
export const ACP_ARGS = ["acp"] as const;

/**
 * Dialect ids handed to bb's ACP bridge.
 *
 * `"opencode"` is the native choice: bb knows the agent, so it can apply its own
 * permission mode to it. That is the default, because bb's permission prompt is
 * a feature and a plugin should not silently disable it.
 *
 * `"acp"` is the generic dialect. bb does not inject permission rules for it,
 * so the agent follows OpenCode's own permission settings and `accept-edits`
 * stops asking before every shell command, web fetch and out-of-workspace
 * write — exactly how a hand-registered `opencode acp` agent behaves. Users
 * opt into it with the `disableApprovalPrompts` setting, because then bb's
 * permission-mode switch no longer applies to these threads.
 */
export const ACP_DIALECT_NATIVE = "opencode";
export const ACP_DIALECT_GENERIC = "acp";

/** The dialect for a given preference: prompts off means the generic dialect. */
export function acpDialect(disableApprovalPrompts: boolean): string {
  return disableApprovalPrompts ? ACP_DIALECT_GENERIC : ACP_DIALECT_NATIVE;
}

/**
 * Launch environment the plugin supplies in generic-dialect mode: ACP client
 * mode, no native question tool (it has no ACP handler), and an explicit
 * allow-all permission set for OpenCode 1.x (OpenCode 2.x has no such variable
 * and uses its own rules). With the native `"opencode"` dialect bb supplies
 * these itself, so the plugin only adds them when approvals are disabled.
 */
export const ACP_LAUNCH_ENV: Readonly<Record<string, string>> = {
  OPENCODE_CLIENT: "acp",
  OPENCODE_ENABLE_QUESTION_TOOL: "false",
  OPENCODE_PERMISSION: JSON.stringify({
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    external_directory: "allow",
  }),
};

/** Reasoning ladder this plugin advertises to bb's picker. */
export const PROVIDER_REASONING_LEVELS = ["low", "medium", "high"] as const;

export interface ProviderDeclarationInput {
  /**
   * Serialized `OPENCODE_CONFIG_CONTENT`. Always present: an empty catalog
   * still yields a valid provider with no models.
   */
  config: string;
  /** Opt-in absolute path to `opencode`, when it is not on the host PATH. */
  opencodeCommand?: string;
  /**
   * When true, the declaration uses the generic ACP dialect and supplies the
   * OpenCode environment itself, so bb no longer enforces its permission mode
   * on these threads. Defaults to false: a fresh install keeps bb's native
   * permission handling, and the user opts out explicitly.
   */
  disableApprovalPrompts?: boolean;
}

export function acpCommand(opencodeCommand: string | undefined): string {
  const custom = opencodeCommand?.trim() ?? "";
  return custom === "" ? ACP_COMMAND : custom;
}

/**
 * Builds the declaration bb keeps for every host. `config` is fixed launch
 * metadata here, so a new selection means a new declaration (the caller
 * disposes the old registration and registers again).
 */
export function buildProviderDeclaration(
  input: ProviderDeclarationInput,
): PluginProviderDeclaration {
  const suppressApprovals = input.disableApprovalPrompts === true;
  return {
    id: MANAGED_PROVIDER_ID,
    displayName: MANAGED_PROVIDER_DISPLAY_NAME,
    family: "acp",
    icon: "Sparkles",
    strings: {
      signInHint:
        "Задайте ключ RouterAI в настройках плагина RouterAI Managed Profile или выполните `bb routerai-managed refresh`.",
      expiredHint:
        "RouterAI отклонил ключ. Проверьте ключ в настройках плагина RouterAI Managed Profile.",
      installUrl: "https://opencode.ai/docs",
      brandPrefix: "RouterAI/",
    },
    experimental_bridgeOptions: {
      acpDialect: acpDialect(suppressApprovals),
      acpLaunchSpec: {
        displayName: MANAGED_PROVIDER_DISPLAY_NAME,
        command: acpCommand(input.opencodeCommand),
        args: [...ACP_ARGS],
        env: {
          [OPENCODE_CONFIG_ENV]: input.config,
          ...(suppressApprovals ? ACP_LAUNCH_ENV : {}),
        },
      },
    },
    // The model list comes from the agent itself, and is the same for every
    // workspace on a machine.
    models: { scope: "host" },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "tip",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: [...PROVIDER_REASONING_LEVELS],
    },
    composerActions: [],
  };
}

/**
 * Stable comparison key for the declaration. The caller reuses an existing
 * registration when this does not change, so the picker is not re-probed on
 * every page open.
 */
export function providerSignature(declaration: PluginProviderDeclaration): string {
  return JSON.stringify(declaration);
}
