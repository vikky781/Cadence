import Dexie, { type Table } from "dexie"

export interface BufferedTrial {
  sessionId: string
  sequenceNumber: number
  nodeId: string
  stimulusRow: Record<string, string | number> | null
  response: string | null
  reactionTimeMs: number | null
  correct: boolean | null
  timingEvidence: unknown
  qualityFlag: "good" | "degraded" | "invalid"
  uploaded: boolean
}

class CadenceDB extends Dexie {
  trials!: Table<BufferedTrial, [string, number]>

  constructor() {
    super("cadence")
    // IndexedDB does not accept booleans as valid index key values: a
    // record with `uploaded: false` would silently never appear in a
    // boolean-typed index, so querying that index for `false` would always
    // return empty. `sessionId` is indexed instead, and `uploaded` is
    // filtered in JS after narrowing by that index.
    this.version(1).stores({
      trials: "[sessionId+sequenceNumber], sessionId",
    })
  }
}

export const db = new CadenceDB()

export async function bufferTrial(trial: BufferedTrial): Promise<void> {
  await db.trials.put(trial)
}

export async function getUnuploadedTrials(sessionId: string): Promise<BufferedTrial[]> {
  return db.trials
    .where("sessionId")
    .equals(sessionId)
    .filter((trial) => !trial.uploaded)
    .toArray()
}

export async function markUploaded(sessionId: string, sequenceNumber: number): Promise<void> {
  await db.trials.update([sessionId, sequenceNumber], { uploaded: true })
}
