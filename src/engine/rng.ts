import seedrandom from "seedrandom"

export class SeededRandom {
  private readonly prng: seedrandom.PRNG

  constructor(seed: string) {
    this.prng = seedrandom(seed)
  }

  next(): number {
    return this.prng()
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive)
  }

  shuffle<T>(items: T[]): T[] {
    const result = [...items]
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const temp = result[i]
      result[i] = result[j]
      result[j] = temp
    }
    return result
  }

  pickWeighted<T>(items: { value: T; weight: number }[]): T {
    if (items.length === 0) {
      throw new Error("pickWeighted: items must not be empty")
    }

    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0)
    if (totalWeight <= 0) {
      throw new Error("pickWeighted: all weights are zero")
    }

    let threshold = this.next() * totalWeight
    for (const item of items) {
      threshold -= item.weight
      if (threshold < 0) {
        return item.value
      }
    }

    return items[items.length - 1].value
  }
}
