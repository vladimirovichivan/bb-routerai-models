// Pure grouping used by the page and by `bb routerai list`. Sorting is stable
// and depends only on cached data + the saved selection, never on the network.
import type { CatalogModel } from "./models.ts";

export interface GroupedModels {
  active: CatalogModel[];
  inactive: CatalogModel[];
}

function byName(left: CatalogModel, right: CatalogModel): number {
  return (
    left.name.localeCompare(right.name, "ru", { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Active models first, inactive below; both groups alphabetized. An id counts
 * as active when it is in the saved selection, even if the catalog no longer
 * contains it (that case is surfaced separately as "missing").
 */
export function groupModels(
  models: readonly CatalogModel[],
  activeIds: readonly string[],
): GroupedModels {
  const active = new Set(activeIds);
  const grouped: GroupedModels = { active: [], inactive: [] };
  for (const model of models) {
    (active.has(model.id) ? grouped.active : grouped.inactive).push(model);
  }
  grouped.active.sort(byName);
  grouped.inactive.sort(byName);
  return grouped;
}

/** Selection ids absent from the catalog, in the order the user enabled them. */
export function missingIds(activeIds: readonly string[], models: readonly CatalogModel[]): string[] {
  const known = new Set(models.map((model) => model.id));
  return activeIds.filter((id) => !known.has(id));
}

/** Drops reasoning values the model does not advertise (invalid input guard). */
export function sanitizeReasoning(
  models: readonly CatalogModel[],
  reasoning: Readonly<Record<string, string>>,
): Record<string, string> {
  const levels = new Map(models.map((model) => [model.id, new Set(model.levels)]));
  const result: Record<string, string> = {};
  for (const [id, level] of Object.entries(reasoning)) {
    const allowed = levels.get(id);
    if (allowed === undefined) {
      // Keep values for models that vanished so they return intact.
      result[id] = level;
      continue;
    }
    if (allowed.has(level)) result[id] = level;
  }
  return result;
}
