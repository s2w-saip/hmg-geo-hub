import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repositories/projects", () => ({
  projectRepository: { getById: vi.fn() },
}));
vi.mock("@/lib/db/repositories/tracked-entities", () => ({
  trackedBrandRepository: { listForProject: vi.fn() },
  trackedVehicleRepository: { listForProject: vi.fn() },
}));

import { projectRepository } from "@/lib/db/repositories/projects";
import {
  trackedBrandRepository,
  trackedVehicleRepository,
} from "@/lib/db/repositories/tracked-entities";
import { getProjectTrackedDictionary } from "./project-tracked-dictionary";

describe("getProjectTrackedDictionary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges project brand, tracked brands, and model aliases into one dictionary", async () => {
    vi.mocked(projectRepository.getById).mockResolvedValue({
      id: "p1",
      brand: "Hyundai",
    } as never);
    vi.mocked(trackedBrandRepository.listForProject).mockResolvedValue([
      {
        canonicalName: "Tesla",
        aliases: ["tesla", "테슬라"],
      },
    ] as never);
    vi.mocked(trackedVehicleRepository.listForProject).mockResolvedValue([
      {
        brand: "Hyundai",
        model: "Tucson",
        aliases: ["투싼", "Toucan"],
      },
    ] as never);

    const dict = await getProjectTrackedDictionary("p1");

    expect(dict.brands).toEqual([
      { canonicalName: "Hyundai", aliases: ["Hyundai"] },
      { canonicalName: "Tesla", aliases: ["Tesla", "tesla", "테슬라"] },
    ]);
    expect(dict.models).toEqual([
      { brand: "Hyundai", model: "Tucson", aliases: ["Tucson", "투싼", "Toucan"] },
    ]);
  });
});
