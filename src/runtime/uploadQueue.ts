import { getUnuploadedTrials, markUploaded } from "../engine/localBuffer"
import { uploadTrial } from "./session"

// Returns a cleanup function (per the original contract) that also carries
// a `flush` method so callers can await a final upload before finishing.
export type UploadQueueHandle = (() => void) & { flush: () => Promise<void> }

export function startUploadQueue(sessionId: string, intervalMs = 3000): UploadQueueHandle {
  async function runFlush(): Promise<void> {
    try {
      const pending = await getUnuploadedTrials(sessionId)

      for (const trial of pending) {
        try {
          const { uploaded: _uploaded, ...trialFields } = trial
          await uploadTrial(sessionId, trial.sequenceNumber, trialFields)
          await markUploaded(sessionId, trial.sequenceNumber)
        } catch (error) {
          // Leave it unmarked so it retries on the next flush, and keep
          // going so one bad trial doesn't block the rest of the batch.
          console.error(
            `Upload failed for session ${sessionId} trial ${trial.sequenceNumber}:`,
            error,
          )
        }
      }
    } catch (error) {
      console.error(`Upload flush failed for session ${sessionId}:`, error)
    }
  }

  // Flushes are chained so they never overlap, and awaiting flush() waits
  // for every previously requested flush too.
  let chain: Promise<void> = Promise.resolve()
  function flush(): Promise<void> {
    chain = chain.then(runFlush)
    return chain
  }

  let tickQueued = false
  const intervalHandle = setInterval(() => {
    if (tickQueued) return
    tickQueued = true
    void flush().finally(() => {
      tickQueued = false
    })
  }, intervalMs)

  // Best-effort final flush when the page is being unloaded. This simply
  // calls the same async flush; a fully reliable keepalive/beacon-based
  // final flush (which can complete after the page is gone) is a scope cut
  // for this version, so trials buffered in the last interval may only be
  // uploaded on the next visit.
  const onPageHide = () => {
    void flush()
  }
  window.addEventListener("pagehide", onPageHide)

  const cleanup = () => {
    clearInterval(intervalHandle)
    window.removeEventListener("pagehide", onPageHide)
  }
  return Object.assign(cleanup, { flush })
}
