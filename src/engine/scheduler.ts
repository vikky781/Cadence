import type { BlockNode } from "../dsl/types"
import type { SeededRandom } from "./rng"

export interface ExpandedTrial {
  blockId: string
  rowIndex: number
  repetitionIndex: number
  row: Record<string, string | number>
  practice: boolean
}

export class SchedulerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SchedulerError"
  }
}

const MAX_SHUFFLE_ATTEMPTS = 200

function buildBaseList(block: BlockNode): ExpandedTrial[] {
  const baseList: ExpandedTrial[] = []
  for (let repetitionIndex = 0; repetitionIndex < block.repetitions; repetitionIndex++) {
    block.rows.forEach((row, rowIndex) => {
      baseList.push({
        blockId: block.id,
        rowIndex,
        repetitionIndex,
        row,
        practice: block.practice,
      })
    })
  }
  return baseList
}

function satisfiesConsecutiveRepeatLimit(
  list: ExpandedTrial[],
  maxConsecutiveRepeats: number,
  runValue: (trial: ExpandedTrial) => string | number,
): boolean {
  let runLength = 1
  for (let i = 1; i < list.length; i++) {
    if (runValue(list[i]) === runValue(list[i - 1])) {
      runLength += 1
      if (runLength > maxConsecutiveRepeats) return false
    } else {
      runLength = 1
    }
  }
  return true
}

export function expandBlock(block: BlockNode, rng: SeededRandom): ExpandedTrial[] {
  const baseList = buildBaseList(block)

  switch (block.order) {
    case "fixed":
      return baseList

    case "shuffle":
      return rng.shuffle(baseList)

    case "shuffle-constrained": {
      if (block.maxConsecutiveRepeats === undefined) {
        throw new SchedulerError(
          `Block "${block.id}" uses "shuffle-constrained" order but has no maxConsecutiveRepeats set.`,
        )
      }
      const maxConsecutiveRepeats = block.maxConsecutiveRepeats
      const orderColumn = block.orderColumn
      const runValue = (trial: ExpandedTrial): string | number =>
        orderColumn ? trial.row[orderColumn] : trial.rowIndex

      for (let attempt = 0; attempt < MAX_SHUFFLE_ATTEMPTS; attempt++) {
        const candidate = rng.shuffle(baseList)
        if (satisfiesConsecutiveRepeatLimit(candidate, maxConsecutiveRepeats, runValue)) {
          return candidate
        }
      }

      throw new SchedulerError(
        `Block "${block.id}" could not satisfy the maxConsecutiveRepeats constraint after ${MAX_SHUFFLE_ATTEMPTS} attempts.`,
      )
    }

    case "blocked-by-column": {
      if (!block.orderColumn) {
        throw new SchedulerError(
          `Block "${block.id}" uses "blocked-by-column" order but has no orderColumn set.`,
        )
      }
      const orderColumn = block.orderColumn

      const groups = new Map<string | number, ExpandedTrial[]>()
      for (const trial of baseList) {
        const key = trial.row[orderColumn]
        const group = groups.get(key)
        if (group) {
          group.push(trial)
        } else {
          groups.set(key, [trial])
        }
      }

      return [...groups.values()].flat()
    }

    default:
      throw new SchedulerError(`Block "${block.id}" has an unsupported order value.`)
  }
}

export function shouldBreakAfter(
  zeroBasedIndex: number,
  totalTrials: number,
  breakEveryN?: number,
): boolean {
  if (!breakEveryN || breakEveryN <= 0) return false
  const position = zeroBasedIndex + 1
  return position % breakEveryN === 0 && position < totalTrials
}
