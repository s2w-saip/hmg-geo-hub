import "server-only";
import { projectRepository } from "@/lib/db/repositories/projects";
import {
  trackedBrandRepository,
  trackedVehicleRepository,
} from "@/lib/db/repositories/tracked-entities";

export interface TrackedBrandDictionaryEntry {
  canonicalName: string;
  aliases: string[];
}

export interface TrackedModelDictionaryEntry {
  brand: string;
  model: string;
  aliases: string[];
}

export interface ProjectTrackedDictionary {
  brands: TrackedBrandDictionaryEntry[];
  models: TrackedModelDictionaryEntry[];
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

// Canonical tracked dictionary the answer-analysis pipeline can consume.
// This keeps the setting UI's brand/model variation inputs in one read shape,
// instead of forcing future analyzers to know about multiple tables directly.
export async function getProjectTrackedDictionary(
  projectId: string,
): Promise<ProjectTrackedDictionary> {
  const [project, brandsRaw, vehicles] = await Promise.all([
    projectRepository.getById(projectId),
    trackedBrandRepository.listForProject(projectId),
    trackedVehicleRepository.listForProject(projectId),
  ]);

  const brands = new Map<string, Set<string>>();
  const pushBrand = (canonicalName: string, aliases: string[]) => {
    const key = canonicalName.trim();
    if (!key) return;
    const set = brands.get(key) ?? new Set<string>();
    set.add(key);
    for (const alias of aliases) set.add(alias);
    brands.set(key, set);
  };

  if (project?.brand) pushBrand(project.brand, []);
  for (const row of brandsRaw) {
    pushBrand(row.canonicalName, row.aliases ?? []);
  }
  for (const row of vehicles) {
    // Vehicle rows reinforce the parent brand surface if catalog sync lags.
    pushBrand(row.brand, []);
  }

  return {
    brands: [...brands.entries()]
      .map(([canonicalName, aliases]) => ({
        canonicalName,
        aliases: uniq([...aliases]),
      }))
      .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName)),
    models: vehicles
      .map((row) => ({
        brand: row.brand,
        model: row.model,
        aliases: uniq([row.model, ...(row.aliases ?? [])]),
      }))
      .sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model)),
  };
}
