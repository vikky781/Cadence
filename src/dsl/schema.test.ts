import { describe, expect, it } from "vitest"
import type { z } from "zod"

import { ExperimentSchema, SettingsSchema } from "./schema"

function minimalExperiment(): z.input<typeof ExperimentSchema> {
  return {
    schemaVersion: 1 as const,
    experimentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    version: 1,
    meta: {
      title: "Minimal experiment",
      description: "A minimal valid experiment.",
      authors: ["Ada Lovelace"],
      estimatedMinutes: 5,
    },
    assets: [],
    variables: [],
    entry: "consent-1",
    nodes: {
      "consent-1": {
        type: "consent" as const,
        id: "consent-1",
        markdown: "Do you consent?",
        declineNodeId: "end-1",
        next: "trial-1",
      },
      "trial-1": {
        type: "trial" as const,
        id: "trial-1",
        phases: [{ type: "stimulus" as const, duration: 500 }],
        next: "end-1",
      },
      "end-1": {
        type: "end" as const,
        id: "end-1",
        message: "Thanks for participating!",
      },
    },
  }
}

describe("ExperimentSchema", () => {
  it("parses a minimal valid experiment and applies settings defaults", () => {
    const result = ExperimentSchema.safeParse(minimalExperiment())

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.settings).toEqual({
      requireFullscreen: true,
      allowedDevices: ["desktop"],
      minRefreshHz: 50,
      seedStrategy: "per-session",
      onTabHidden: "record",
      maxMinutes: 60,
    })
  })

  it("fails when entry references a nonexistent node id", () => {
    const experiment = minimalExperiment()
    experiment.entry = "does-not-exist"

    const result = ExperimentSchema.safeParse(experiment)

    expect(result.success).toBe(false)
  })

  it("fails when a node's next references a nonexistent node id", () => {
    const experiment = minimalExperiment()
    const trial = experiment.nodes["trial-1"] as { next: string }
    trial.next = "does-not-exist"

    const result = ExperimentSchema.safeParse(experiment)

    expect(result.success).toBe(false)
  })

  it("fails when a block node's trialTemplate references a non-trial node", () => {
    const experiment = minimalExperiment()
    experiment.nodes["block-1"] = {
      type: "block" as const,
      id: "block-1",
      trialTemplate: "end-1",
      rows: [],
      repetitions: 1,
      order: "fixed" as const,
      practice: false,
      next: "end-1",
    }

    const result = ExperimentSchema.safeParse(experiment)

    expect(result.success).toBe(false)
  })

  it("round-trips a fully-specified settings object unchanged", () => {
    const fullSettings = {
      requireFullscreen: false,
      allowedDevices: ["desktop", "tablet"] as const,
      minRefreshHz: 75,
      seedStrategy: "fixed" as const,
      onTabHidden: "pause" as const,
      maxMinutes: 30,
      completionRedirect: "https://example.com/done",
    }

    const result = SettingsSchema.safeParse(fullSettings)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data).toEqual(fullSettings)
  })
})
