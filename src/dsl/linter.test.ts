import { describe, expect, it } from "vitest"
import type { z } from "zod"

import { lintExperiment } from "./linter"
import { ExperimentSchema } from "./schema"
import type { Experiment, Node, Phase, Response } from "./types"

function baselineExperiment(): Experiment {
  const input: z.input<typeof ExperimentSchema> = {
    schemaVersion: 1,
    experimentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    version: 1,
    meta: {
      title: "Baseline experiment",
      description: "A minimal valid experiment for linter tests.",
      authors: ["Ada Lovelace"],
      estimatedMinutes: 5,
    },
    assets: [],
    variables: [],
    entry: "consent-1",
    nodes: {
      "consent-1": {
        type: "consent",
        id: "consent-1",
        markdown: "Do you consent?",
        declineNodeId: "end-1",
        next: "trial-1",
      },
      "trial-1": {
        type: "trial",
        id: "trial-1",
        phases: [{ type: "stimulus", duration: 500 }],
        next: "end-1",
      },
      "end-1": {
        type: "end",
        id: "end-1",
        message: "Thanks for participating!",
      },
    },
  }
  return ExperimentSchema.parse(input)
}

function cleanStroopExperiment(): Experiment {
  const input: z.input<typeof ExperimentSchema> = {
    schemaVersion: 1,
    experimentId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    version: 1,
    meta: {
      title: "Stroop task",
      description: "A colour-word Stroop task.",
      authors: ["Ada Lovelace"],
      estimatedMinutes: 10,
    },
    assets: [],
    variables: [{ name: "targetColor", type: "string" }],
    entry: "consent-1",
    nodes: {
      "consent-1": {
        type: "consent",
        id: "consent-1",
        markdown: "Do you consent?",
        declineNodeId: "end-1",
        next: "instructions-1",
      },
      "instructions-1": {
        type: "instructions",
        id: "instructions-1",
        markdown: "Press the key matching the ink colour.",
        advanceBy: "key",
        next: "stroop-block",
      },
      "stroop-trial": {
        type: "trial",
        id: "stroop-trial",
        phases: [
          { type: "fixation", duration: 500 },
          {
            type: "stimulus",
            duration: 1000,
            content: { kind: "column", value: "word" },
          },
          { type: "response", duration: "untilResponse" },
        ],
        response: {
          allowedKeys: ["r", "g", "b"],
          timeoutMs: 2000,
          correctAnswer: "targetColor",
          acceptInPhases: [2],
        },
        next: "end-1",
      },
      "stroop-block": {
        type: "block",
        id: "stroop-block",
        trialTemplate: "stroop-trial",
        rows: [
          { word: "RED", targetColor: "red" },
          { word: "GREEN", targetColor: "green" },
          { word: "BLUE", targetColor: "blue" },
        ],
        repetitions: 2,
        order: "shuffle",
        practice: false,
        next: "end-1",
      },
      "end-1": {
        type: "end",
        id: "end-1",
        message: "Thanks for participating!",
      },
    },
  }
  return ExperimentSchema.parse(input)
}

function asConsent(node: Node) {
  return node as Extract<Node, { type: "consent" }>
}

function asTrial(node: Node) {
  return node as Extract<Node, { type: "trial" }>
}

describe("lintExperiment", () => {
  it("unreachable-node: flags a node with nothing pointing to it", () => {
    const experiment = structuredClone(baselineExperiment())
    experiment.nodes["orphan-1"] = {
      type: "instructions",
      id: "orphan-1",
      markdown: "Never shown.",
      advanceBy: "key",
      next: "end-1",
    }

    const result = lintExperiment(experiment)

    expect(result.errors).toEqual([
      expect.objectContaining({
        rule: "unreachable-node",
        severity: "error",
        nodeId: "orphan-1",
      }),
    ])
  })

  it("cycle-detected: flags a cycle in the edge graph", () => {
    const experiment = structuredClone(baselineExperiment())
    asTrial(experiment.nodes["trial-1"]).next = "consent-1"

    const result = lintExperiment(experiment)

    expect(result.errors).toEqual([
      expect.objectContaining({
        rule: "cycle-detected",
        severity: "error",
        nodeId: "consent-1",
      }),
    ])
  })

  it("no-reachable-end: flags a graph with no end node, alongside the cycle this structurally requires", () => {
    // Every non-"end" node type requires a valid outgoing edge to an
    // existing node, so a schema-valid graph with no reachable "end" node
    // must (by the pigeonhole principle) contain a cycle in its reachable
    // portion. These two rules cannot be triggered in isolation from each
    // other in this DSL -- this test asserts both are reported rather than
    // asserting no-reachable-end is the *only* error.
    const experiment = structuredClone(baselineExperiment())
    delete experiment.nodes["end-1"]
    asConsent(experiment.nodes["consent-1"]).declineNodeId = "trial-1"
    asTrial(experiment.nodes["trial-1"]).next = "consent-1"

    const result = lintExperiment(experiment)

    const ruleIds = result.errors.map((issue) => issue.rule)
    expect(ruleIds).toContain("no-reachable-end")
    expect(ruleIds).toContain("cycle-detected")

    const noReachableEnd = result.errors.find(
      (issue) => issue.rule === "no-reachable-end",
    )
    expect(noReachableEnd).toEqual(
      expect.objectContaining({ rule: "no-reachable-end", severity: "error" }),
    )
    expect(noReachableEnd?.nodeId).toBeUndefined()
  })

  it("missing-asset: flags a phase referencing an asset id that does not exist", () => {
    const experiment = structuredClone(baselineExperiment())
    asTrial(experiment.nodes["trial-1"]).phases = [
      {
        type: "stimulus",
        duration: 500,
        content: { kind: "asset", value: "nonexistent-asset" },
      },
    ]

    const result = lintExperiment(experiment)

    expect(result.errors).toEqual([
      expect.objectContaining({
        rule: "missing-asset",
        severity: "error",
        nodeId: "trial-1",
        message: expect.stringContaining("nonexistent-asset"),
      }),
    ])
  })

  it("missing-column: flags a block whose rows lack a column its trial template needs", () => {
    const experiment = structuredClone(baselineExperiment())
    asConsent(experiment.nodes["consent-1"]).next = "block-1"
    asTrial(experiment.nodes["trial-1"]).phases = [
      {
        type: "stimulus",
        duration: 500,
        content: { kind: "column", value: "missingCol" },
      },
    ]
    experiment.nodes["block-1"] = {
      type: "block",
      id: "block-1",
      trialTemplate: "trial-1",
      rows: [{ otherCol: 1 }],
      repetitions: 1,
      order: "fixed",
      practice: false,
      next: "end-1",
    }

    const result = lintExperiment(experiment)

    expect(result.errors).toEqual([
      expect.objectContaining({
        rule: "missing-column",
        severity: "error",
        nodeId: "block-1",
        message: expect.stringContaining("missingCol"),
      }),
    ])
  })

  it("invalid-expression: flags a correctAnswer expression with an unknown identifier", () => {
    const experiment = structuredClone(baselineExperiment())
    const response: Response = {
      allowedKeys: ["a"],
      timeoutMs: 1000,
      correctAnswer: "totallyUnknownVar + 1",
      acceptInPhases: [0],
    }
    asTrial(experiment.nodes["trial-1"]).response = response

    const result = lintExperiment(experiment)

    expect(result.errors).toEqual([
      expect.objectContaining({
        rule: "invalid-expression",
        severity: "error",
        nodeId: "trial-1",
        message: expect.stringContaining("totallyUnknownVar"),
      }),
    ])
  })

  it("hanging-response: flags a response with no allowed keys and a non-positive timeout", () => {
    const experiment = structuredClone(baselineExperiment())
    const response: Response = {
      allowedKeys: [],
      timeoutMs: 0,
      acceptInPhases: [0],
    }
    asTrial(experiment.nodes["trial-1"]).response = response

    const result = lintExperiment(experiment)

    expect(result.errors).toEqual([
      expect.objectContaining({
        rule: "hanging-response",
        severity: "error",
        nodeId: "trial-1",
      }),
    ])
  })

  it("reserved-response-key: flags an allowed key that is reserved by the browser", () => {
    const experiment = structuredClone(baselineExperiment())
    const response: Response = {
      allowedKeys: ["Escape", "a"],
      timeoutMs: 1000,
      acceptInPhases: [0],
    }
    asTrial(experiment.nodes["trial-1"]).response = response

    const result = lintExperiment(experiment)

    expect(result.errors).toEqual([
      expect.objectContaining({
        rule: "reserved-response-key",
        severity: "error",
        nodeId: "trial-1",
        message: expect.stringContaining("Escape"),
      }),
    ])
  })

  it("non-frame-duration: warns about a phase duration that is not frame-aligned", () => {
    const experiment = structuredClone(baselineExperiment())
    const phases: Phase[] = [{ type: "stimulus", duration: 103 }]
    asTrial(experiment.nodes["trial-1"]).phases = phases

    const result = lintExperiment(experiment)

    expect(result.warnings).toEqual([
      expect.objectContaining({
        rule: "non-frame-duration",
        severity: "warning",
        nodeId: "trial-1",
      }),
    ])
  })

  it("very-short-stimulus: warns about a stimulus shorter than two display frames", () => {
    const experiment = structuredClone(baselineExperiment())
    const phases: Phase[] = [{ type: "stimulus", duration: 1000 / 60 }]
    asTrial(experiment.nodes["trial-1"]).phases = phases

    const result = lintExperiment(experiment)

    expect(result.warnings).toEqual([
      expect.objectContaining({
        rule: "very-short-stimulus",
        severity: "warning",
        nodeId: "trial-1",
      }),
    ])
  })

  it("unequal-condition-counts: warns when a block's orderColumn groups are imbalanced", () => {
    const experiment = structuredClone(baselineExperiment())
    asConsent(experiment.nodes["consent-1"]).next = "block-1"
    experiment.nodes["block-1"] = {
      type: "block",
      id: "block-1",
      trialTemplate: "trial-1",
      rows: [{ cond: "A" }, { cond: "A" }, { cond: "A" }, { cond: "B" }],
      repetitions: 1,
      order: "blocked-by-column",
      orderColumn: "cond",
      practice: false,
      next: "end-1",
    }

    const result = lintExperiment(experiment)

    expect(result.warnings).toEqual([
      expect.objectContaining({
        rule: "unequal-condition-counts",
        severity: "warning",
        nodeId: "block-1",
      }),
    ])
  })

  it("oversized-image-asset: warns about an image asset exceeding size thresholds", () => {
    const experiment = structuredClone(baselineExperiment())
    experiment.assets = [
      {
        id: "img-1",
        kind: "image",
        storagePath: "images/img-1.png",
        sha256: "abc123",
        bytes: 3_000_000,
        width: 100,
        height: 100,
      },
    ]

    const result = lintExperiment(experiment)

    expect(result.warnings).toEqual([
      expect.objectContaining({
        rule: "oversized-image-asset",
        severity: "warning",
        message: expect.stringContaining("img-1"),
      }),
    ])
    expect(result.warnings[0]?.nodeId).toBeUndefined()
  })

  it("long-duration-estimate: warns when the estimated duration exceeds 30 minutes", () => {
    const experiment = structuredClone(baselineExperiment())
    experiment.meta.estimatedMinutes = 45

    const result = lintExperiment(experiment)

    expect(result.warnings).toEqual([
      expect.objectContaining({
        rule: "long-duration-estimate",
        severity: "warning",
      }),
    ])
    expect(result.warnings[0]?.nodeId).toBeUndefined()
  })

  it("unequal-randomizer-weights: flags a randomizer whose arms have unequal weights", () => {
    const experiment = structuredClone(baselineExperiment())
    asConsent(experiment.nodes["consent-1"]).next = "randomizer-1"
    experiment.nodes["randomizer-1"] = {
      type: "randomizer",
      id: "randomizer-1",
      method: "simple-weighted",
      arms: [
        { id: "arm-a", weight: 1, next: "trial-1" },
        { id: "arm-b", weight: 2, next: "trial-1" },
      ],
    }

    const result = lintExperiment(experiment)

    expect(result.infos).toEqual([
      expect.objectContaining({
        rule: "unequal-randomizer-weights",
        severity: "info",
        nodeId: "randomizer-1",
      }),
    ])
  })

  it("reports zero errors, warnings, and infos for a clean Stroop-like experiment", () => {
    const result = lintExperiment(cleanStroopExperiment())

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.infos).toEqual([])
  })
})
