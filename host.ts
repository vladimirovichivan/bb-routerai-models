// RouterAI Managed Profile — host entry (runs on the machine that runs the agent).
//
// bb spawns this artifact as the provider bridge for `routerai-managed` and
// speaks ACP to `opencode acp` through the SDK's published bridge kit. All the
// plugin's own logic lives on the server side; the host part only re-exports
// the bridge.
export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

/**
 * No host RPC methods: the API key travels inline in the launch environment,
 * so nothing has to be written to disk on the agent machine.
 */
export default experimental_defineHostEntry({
  contract: {},
  handlers: {},
});
