import { getUnuploadedTrials, markUploaded } from "../engine/localBuffer"
import { uploadTrial } from "./session"

export function startUploadQueue(sessionId: string, intervalMs = 3000): () => void {
  let flushing = false

  async function flush(): Promise<void> {
    // Skip if a flush is already in flight so interval ticks and the
    // pagehide flush never upload the same batch concurrently.
    if (flushing) return
    flushing = true

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
    } finally {
      flushing = false
    }
  }

  const intervalHandle = setInterval(() => {
    void flush()
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

  return () => {
    clearInterval(intervalHandle)
    window.removeEventListener("pagehide", onPageHide)
  }
}
