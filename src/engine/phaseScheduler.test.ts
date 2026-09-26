import { describe, expect, it } from "vitest"

import type { Phase } from "../dsl/types"
import type { FrameRecord } from "./frameClock"
import { PhaseScheduler, PhaseSchedulerError, durationToFrames } from "./phaseScheduler"

function makeFrameRecords(count: number, intervalMs = 16.667): FrameRecord[] {
  const records: FrameRecord[] = []
  let timestamp = 0
  for (let i = 0; i < count; i++) {
    records.push({
      frameIndex: i,
      timestamp,
      interval: i === 0 ? null : intervalMs,
    })
    timestamp += intervalMs
  }
  return records
}

describe("durationToFrames", () => {
  it("returns the exact hand-calculated frame count for 200ms at 60Hz", () => {
    // 200 / (1000/60) = 200 * 60 / 1000 = 12 exactly.
    expect(durationToFrames(200, 60)).toBe(12)
  })

  it("returns 1, never 0, for a duration shorter than one frame", () => {
    expect(durationToFrames(5, 60)).toBe(1)
  })
})

describe("PhaseScheduler", () => {
  it("drives a 3-phase fixed-duration trial through exactly the hand-computed transition frames", () => {
    const refreshHz = 60
    const phases: Phase[] = [
      { type: "stimulus", duration: 500 },
      { type: "blank", duration: 300 },
      { type: "feedback", duration: 200 },
    ]
    const scheduler = new PhaseScheduler(phases, refreshHz)

    const t0 = durationToFrames(500, refreshHz)
    const t1 = durationToFrames(300, refreshHz)
    const t2 = durationToFrames(200, refreshHz)
    expect([t0, t1, t2]).toEqual([30, 18, 12])

    // Each internal transition shares one frame between the phase it
    // completes and the phase it starts, per the "no frame is ever lost to
    // a transition" rule, so total calls = sum(targets) - (numPhases - 1).
    const phase0CompletesAtCall = t0 // 30
    const phase1CompletesAtCall = t0 + t1 - 1 // 47
    const phase2CompletesAtCall = t0 + t1 + t2 - 2 // 58
    expect([phase0CompletesAtCall, phase1CompletesAtCall, phase2CompletesAtCall]).toEqual([
      30, 47, 58,
    ])

    const totalCalls = phase2CompletesAtCall
    const records = makeFrameRecords(totalCalls)

    for (let i = 0; i < totalCalls; i++) {
      const callNumber = i + 1
      const result = scheduler.onFrame(records[i])

      if (callNumber === 1) {
        expect(result).toMatchObject({
          phaseChanged: true,
          currentPhaseIndex: 0,
          isComplete: false,
        })
      } else if (callNumber === phase0CompletesAtCall) {
        expect(result).toMatchObject({
          phaseChanged: true,
          currentPhaseIndex: 1,
          isComplete: false,
        })
      } else if (callNumber === phase1CompletesAtCall) {
        expect(result).toMatchObject({
          phaseChanged: true,
          currentPhaseIndex: 2,
          isComplete: false,
        })
      } else if (callNumber === phase2CompletesAtCall) {
        expect(result).toMatchObject({
          phaseChanged: false,
          currentPhaseIndex: 2,
          isComplete: true,
        })
      } else {
        expect(result.phaseChanged).toBe(false)
        expect(result.isComplete).toBe(false)
      }
    }
  })

  it("counts exactly one dropped frame from a single oversized interval within a phase", () => {
    const refreshHz = 60
    const duration = 10 * (1000 / refreshHz)
    const phases: Phase[] = [{ type: "stimulus", duration }]
    const scheduler = new PhaseScheduler(phases, refreshHz)

    const target = durationToFrames(duration, refreshHz)
    expect(target).toBe(10)

    const records = makeFrameRecords(target)
    // 40ms > 1.5 * 16.667ms, so this one interval is a dropped frame.
    records[4] = { ...records[4], interval: 40 }
    // records[6] is left with its normal 16.667ms interval and must not
    // also be counted as dropped.

    let lastResult: ReturnType<PhaseScheduler["onFrame"]> | undefined
    for (const record of records) {
      lastResult = scheduler.onFrame(record)
    }

    expect(lastResult?.isComplete).toBe(true)
    expect(lastResult?.completedPhaseRecord?.droppedFramesDuringPhase).toBe(1)
  })

  it("never auto-completes an untilResponse phase; endCurrentPhase() finalizes it with the accumulated frame count", () => {
    const refreshHz = 60
    const phases: Phase[] = [{ type: "response", duration: "untilResponse" }]
    const scheduler = new PhaseScheduler(phases, refreshHz)

    const records = makeFrameRecords(200)
    const results = records.map((record) => scheduler.onFrame(record))

    // The very first call ever is always phaseChanged: true (entering
    // phase 0), regardless of that phase's duration kind.
    expect(results[0].phaseChanged).toBe(true)
    expect(results[0].isComplete).toBe(false)

    for (let i = 1; i < results.length; i++) {
      expect(results[i].phaseChanged).toBe(false)
      expect(results[i].isComplete).toBe(false)
    }

    const record = scheduler.endCurrentPhase()
    expect(record.targetFrames).toBeNull()
    // framesElapsedInCurrentPhase is set to 1 on the first call, then
    // incremented once per each of the remaining 199 calls: 1 + 199 = 200.
    expect(record.achievedFrames).toBe(200)
  })

  it("throws when endCurrentPhase() is called on a fixed-duration phase", () => {
    const refreshHz = 60
    const phases: Phase[] = [{ type: "stimulus", duration: 500 }]
    const scheduler = new PhaseScheduler(phases, refreshHz)

    scheduler.onFrame(makeFrameRecords(1)[0])

    expect(() => scheduler.endCurrentPhase()).toThrow(PhaseSchedulerError)
  })

  it("throws when constructed with an empty phases array", () => {
    expect(() => new PhaseScheduler([], 60)).toThrow(PhaseSchedulerError)
  })

  it("getCompletedRecords() returns a copy that later mutation cannot affect", () => {
    const refreshHz = 60
    const duration = 5 * (1000 / refreshHz)
    const phases: Phase[] = [
      { type: "stimulus", duration },
      { type: "blank", duration },
    ]
    const scheduler = new PhaseScheduler(phases, refreshHz)
    const target = durationToFrames(duration, refreshHz)

    for (const record of makeFrameRecords(target)) {
      scheduler.onFrame(record)
    }

    const first = scheduler.getCompletedRecords()
    expect(first).toHaveLength(1)

    first.push({ ...first[0], phaseIndex: 999 })
    first.length = 0

    const second = scheduler.getCompletedRecords()
    expect(second).toHaveLength(1)
    expect(second[0].phaseIndex).toBe(0)
  })
})
