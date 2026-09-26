import { describe, expect, it } from "vitest"

import { SeededRandom } from "./rng"

describe("SeededRandom", () => {
  it("produces an identical sequence for the same seed", () => {
    const a = new SeededRandom("cadence-seed")
    const b = new SeededRandom("cadence-seed")

    const sequenceA = Array.from({ length: 10 }, () => a.next())
    const sequenceB = Array.from({ length: 10 }, () => b.next())

    expect(sequenceA).toEqual(sequenceB)
  })

  it("produces a different sequence for different seeds", () => {
    const a = new SeededRandom("seed-one")
    const b = new SeededRandom("seed-two")

    const sequenceA = Array.from({ length: 5 }, () => a.next())
    const sequenceB = Array.from({ length: 5 }, () => b.next())

    expect(sequenceA).not.toEqual(sequenceB)
  })

  it("shuffle returns the same elements without mutating the input", () => {
    const rng = new SeededRandom("shuffle-seed")
    const original = [1, 2, 3, 4, 5, 6, 7, 8]
    const originalCopy = [...original]

    const shuffled = rng.shuffle(original)

    expect([...shuffled].sort()).toEqual([...original].sort())
    expect(original).toEqual(originalCopy)
  })

  it("shuffle is reproducible for the same seed", () => {
    const items = ["a", "b", "c", "d", "e", "f"]

    const rngA = new SeededRandom("reproducible-shuffle")
    const rngB = new SeededRandom("reproducible-shuffle")

    expect(rngA.shuffle(items)).toEqual(rngB.shuffle(items))
  })

  describe("pickWeighted", () => {
    it("throws on an empty array", () => {
      const rng = new SeededRandom("weighted-seed")
      expect(() => rng.pickWeighted([])).toThrow()
    })

    it("throws when all weights are zero", () => {
      const rng = new SeededRandom("weighted-seed")
      expect(() =>
        rng.pickWeighted([
          { value: "a", weight: 0 },
          { value: "b", weight: 0 },
        ]),
      ).toThrow()
    })

    it("always returns the only nonzero-weighted item", () => {
      const rng = new SeededRandom("weighted-seed")
      const items = [
        { value: "never", weight: 0 },
        { value: "always", weight: 1 },
        { value: "also-never", weight: 0 },
      ]

      for (let i = 0; i < 50; i++) {
        expect(rng.pickWeighted(items)).toBe("always")
      }
    })
  })
})
