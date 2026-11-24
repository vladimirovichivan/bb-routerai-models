// Shared wire types for the RPC contract and the page. Keep this module free of
// runtime imports so app.tsx can import only types.
import type { CatalogModel } from "./models.ts";
import type { ManagedSelection } from "./config.ts";

export interface StoredCatalog {
  fetchedAt: number;
  etag: string | null;
  lastModified: string | null;
  models: CatalogModel[];
  /** Number of models in the raw provider payload before filtering. */
  rawCount: number;
}

export interface StoredSelection extends ManagedSelection {
  updatedAt: number;
}

export interface StoredApplyState {
  lastAppliedAt: number;
  appliedModelCount: number;
  appliedBytes: number;
}

export interface StoredRefreshMeta {
  lastAttemptAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface RefreshState {
  inProgress: boolean;
  lastAttemptAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface ConfigSummary {
  /** Serialized bytes of the current config (never the content: it holds the key). */
  bytes: number;
  maxBytes: number;
  modelCount: number;
  /** Active ids the catalog no longer contains. */
  missingIds: string[];
  tooLarge: boolean;
  error: string | null;
  lastAppliedAt: number | null;
  appliedModelCount: number;
  appliedBytes: number;
}

export interface ManagedProviderView {
  id: string;
  displayName: string;
  /** True while bb holds a live registration for this provider. */
  registered: boolean;
  /** The command bb launches on the host (`opencode`, or an opt-in path). */
  command: string;
  args: string[];
  /** Models the provider currently offers in the picker. */
  modelCount: number;
  /** Last registration error, if any. */
  error: string | null;
}

export interface PluginState {
  settings: {
    hasApiKey: boolean;
    apiKeySource: "settings" | "environment" | null;
    autoRefreshDaily: boolean;
    opencodeCommandSet: boolean;
    disableApprovalPrompts: boolean;
  };
  catalog: {
    fetchedAt: number;
    models: CatalogModel[];
    rawCount: number;
    etag: boolean;
  } | null;
  selection: {
    activeIds: string[];
    reasoning: Record<string, string>;
    updatedAt: number;
  };
  /** Active selection ids that the current catalog does not contain. */
  missingIds: string[];
  refresh: RefreshState;
  config: ConfigSummary;
  provider: ManagedProviderView;
}

export interface SetActiveInput {
  id: string;
  active: boolean;
}

export interface SetReasoningInput {
  id: string;
  /** One of the model levels or `default`. */
  level: string;
}

export interface SetAutoRefreshInput {
  enabled: boolean;
}

export interface RefreshResult extends PluginState {
  /** What the explicit refresh did: fetched, kept cache (304), or failed. */
  outcome: "fetched" | "not-modified" | "failed";
  message: string | null;
}

export type { CatalogModel, ManagedSelection };
