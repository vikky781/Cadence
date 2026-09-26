import { describe, expect, it } from "vitest"

import type { BlockNode } from "../dsl/types"
import { SeededRandom } from "./rng"
import { expandBlock, SchedulerError, shouldBreakAfter } from "./scheduler"

function makeBlock(params: {
  rows: Record<string, string | number>[]
  repetitions: number
  order: BlockNode["order"]
  orderColumn?: string
  maxConsecutiveRepeats?: number
  practice?: boolean
}): BlockNode {
  return {
    type: "block",
    id: "block-1",
    trialTemplate: "trial-1",
    next: "next-node",
    practice: params.practice ?? false,
    rows: params.rows,
    repetitions: params.repetitions,
    order: params.order,
    orderColumn: params.orderColumn,
    maxConsecutiveRepeats: params.maxConsecutiveRepeats,
  }
}

describe("expandBlock", () => {
  it("fixed order returns a full pass through all rows, repeated in sequence", () => {
    const block = makeBlock({
      rows: [{ r: 0 }, { r: 1 }, { r: 2 }],
      repetitions: 2,
      order: "fixed",
    })
    const rng = new SeededRandom("unused-for-fixed")

    const trials = expandBlock(block, rng)

    expect(trials.map((t) => [t.rowIndex, t.repetitionIndex])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ])
  })

  it("shuffle order reorders the same multiset and is reproducible for the same seed", () => {
    const block = makeBlock({
      rows: [{ r: 0 }, { r: 1 }, { r: 2 }],
      repetitions: 2,
      order: "shuffle",
    })

    const fixedBlock = makeBlock({
      rows: block.rows,
      repetitions: block.repetitions,
      order: "fixed",
    })
    const fixedTrials = expandBlock(fixedBlock, new SeededRandom("irrelevant"))
    const fixedPairs = fixedTrials
      .map((t) => `${t.rowIndex}-${t.repetitionIndex}`)
      .sort()

    const trialsA = expandBlock(block, new SeededRandom("shuffle-block-seed"))
    const trialsB = expandBlock(block, new SeededRandom("shuffle-block-seed"))

    const shuffledPairs = trialsA.map((t) => `${t.rowIndex}-${t.repetitionIndex}`).sort()
    expect(shuffledPairs).toEqual(fixedPairs)

    expect(trialsA).toEqual(trialsB)
  })

  it("blocked-by-column groups rows by column value, preserving first-appearance and within-group order", () => {
    const block = makeBlock({
      rows: [{ cond: "A" }, { cond: "B" }, { cond: "A" }],
      repetitions: 1,
      order: "blocked-by-column",
      orderColumn: "cond",
    })

    const trials = expandBlock(block, new SeededRandom("unused-for-blocked"))

    expect(trials).toEqual([
      {
        blockId: "block-1",
        rowIndex: 0,
        repetitionIndex: 0,
        row: { cond: "A" },
        practice: false,
      },
      {
        blockId: "block-1",
        rowIndex: 2,
        repetitionIndex: 0,
        row: { cond: "A" },
        practice: false,
      },
      {
        blockId: "block-1",
        rowIndex: 1,
        repetitionIndex: 0,
        row: { cond: "B" },
        practice: false,
      },
    ])
  })

  it("blocked-by-column throws SchedulerError when orderColumn is not set", () => {
    const block = makeBlock({
      rows: [{ cond: "A" }, { cond: "B" }],
      repetitions: 1,
      order: "blocked-by-column",
    })

    expect(() => expandBlock(block, new SeededRandom("no-order-column"))).toThrow(
      SchedulerError,
    )
  })

  it("shuffle-constrained succeeds and satisfies the constraint when easily satisfiable", () => {
    const block = makeBlock({
      rows: [{ cond: "A" }, { cond: "B" }, { cond: "A" }, { cond: "B" }],
      repetitions: 1,
      order: "shuffle-constrained",
      orderColumn: "cond",
      maxConsecutiveRepeats: 2,
    })

    const trials = expandBlock(block, new SeededRandom("constrained-satisfiable"))

    expect(trials).toHaveLength(4)

    let runLength = 1
    for (let i = 1; i < trials.length; i++) {
      if (trials[i].row.cond === trials[i - 1].row.cond) {
        runLength += 1
        expect(runLength).toBeLessThanOrEqual(2)
      } else {
        runLength = 1
      }
    }
  })

  it("shuffle-constrained throws SchedulerError when the constraint is impossible to satisfy", () => {
    const block = makeBlock({
      rows: [{ cond: "A" }],
      repetitions: 3,
      order: "shuffle-constrained",
      orderColumn: "cond",
      maxConsecutiveRepeats: 1,
    })

    expect(() => expandBlock(block, new SeededRandom("constrained-impossible"))).toThrow(
      SchedulerError,
    )
  })

  it("shuffle-constrained throws SchedulerError when maxConsecutiveRepeats is missing", () => {
    const block = makeBlock({
      rows: [{ cond: "A" }, { cond: "B" }],
      repetitions: 1,
      order: "shuffle-constrained",
      orderColumn: "cond",
    })

    expect(() => expandBlock(block, new SeededRandom("no-max-repeats"))).toThrow(
      SchedulerError,
    )
  })
})

describe("shouldBreakAfter", () => {
  it("returns true only at multiples of breakEveryN, excluding the final trial", () => {
    const totalTrials = 9
    const breakEveryN = 3

    expect(shouldBreakAfter(2, totalTrials, breakEveryN)).toBe(true)
    expect(shouldBreakAfter(5, totalTrials, breakEveryN)).toBe(true)
    expect(shouldBreakAfter(8, totalTrials, breakEveryN)).toBe(false)

    for (const index of [0, 1, 3, 4, 6, 7]) {
      expect(shouldBreakAfter(index, totalTrials, breakEveryN)).toBe(false)
    }
  })

  it("returns false whenever breakEveryN is undefined", () => {
    const totalTrials = 9
    for (let index = 0; index < totalTrials; index++) {
      expect(shouldBreakAfter(index, totalTrials, undefined)).toBe(false)
    }
  })
})
