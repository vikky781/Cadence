import Papa from "papaparse"
import { useEffect, useState } from "react"

import { AuthGate } from "../lib/AuthGate"
import { getSupabaseClient } from "../runtime/session"

interface TrialRow {
  session_id: string
  sequence_number: number
  node_id: string
  response: string | null
  reaction_time_ms: number | null
  correct: boolean | null
  quality_flag: string
}

function Results({ versionId }: { versionId: string }) {
  const [rows, setRows] = useState<TrialRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const supabase = getSupabaseClient()

        // RLS hides other researchers' sessions/trials by returning empty
        // results, not an error, so check ownership explicitly first rather
        // than showing a misleading "no trials yet".
        const { data: version, error: versionError } = await supabase
          .from("experiment_versions")
          .select("experiment_id")
          .eq("id", versionId)
          .maybeSingle()
        if (versionError) throw new Error(`Failed to load version: ${versionError.message}`)
        if (!version) throw new Error(`No experiment version with id ${versionId}.`)

        const { data: experiment, error: experimentError } = await supabase
          .from("experiments")
          .select("id")
          .eq("id", version.experiment_id as string)
          .maybeSingle()
        if (experimentError) throw new Error(`Failed to load experiment: ${experimentError.message}`)
        if (!experiment) {
          throw new Error(
            "This experiment belongs to another researcher account, so its results are not visible to you.",
          )
        }

        const { data: sessions, error: sessionsError } = await supabase
          .from("sessions")
          .select("id")
          .eq("version_id", versionId)
        if (sessionsError) throw new Error(`Failed to load sessions: ${sessionsError.message}`)

        const sessionIds = (sessions ?? []).map((s) => s.id as string)
        if (sessionIds.length === 0) {
          if (!cancelled) setRows([])
          return
        }

        const { data: trials, error: trialsError } = await supabase
          .from("trials")
          .select("session_id, sequence_number, node_id, response, reaction_time_ms, correct, quality_flag")
          .in("session_id", sessionIds)
          .order("session_id")
          .order("sequence_number")
        if (trialsError) throw new Error(`Failed to load trials: ${trialsError.message}`)

        if (!cancelled) setRows((trials ?? []) as TrialRow[])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [versionId])

  function downloadCsv() {
    if (!rows) return
    const csv = Papa.unparse(rows)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `results-${versionId}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Revoking synchronously can cancel the download: the browser fetches the
    // blob URL asynchronously after click(), so release it a moment later.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <h1 className="text-xl font-medium">Results</h1>
      <p className="text-xs text-muted-foreground">Version {versionId}</p>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!error && rows === null && <p>Loading…</p>}

      {rows && (
        <>
          <button
            type="button"
            className="self-start rounded-md border px-4 py-2 disabled:opacity-40"
            disabled={rows.length === 0}
            onClick={downloadCsv}
          >
            Download CSV
          </button>
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-2">session</th>
                <th className="p-2">sequence_number</th>
                <th className="p-2">node_id</th>
                <th className="p-2">response</th>
                <th className="p-2">reaction_time_ms</th>
                <th className="p-2">correct</th>
                <th className="p-2">quality_flag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.session_id}-${r.sequence_number}`} className="border-b">
                  <td className="p-2 font-mono">{r.session_id.slice(0, 8)}</td>
                  <td className="p-2">{r.sequence_number}</td>
                  <td className="p-2">{r.node_id}</td>
                  <td className="p-2">{r.response === " " ? "(space)" : (r.response ?? "")}</td>
                  <td className="p-2">{r.reaction_time_ms ?? ""}</td>
                  <td className="p-2">{r.correct === null ? "" : String(r.correct)}</td>
                  <td className="p-2">{r.quality_flag}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="text-sm">No trials recorded for this version yet.</p>}
        </>
      )}
    </main>
  )
}

export default function ResultsPage() {
  const versionId = new URLSearchParams(window.location.search).get("version")

  return (
    <AuthGate>
      {() =>
        versionId ? (
          <Results versionId={versionId} />
        ) : (
          <p className="p-6 text-destructive">Missing ?version=&lt;experiment version id&gt; in the URL.</p>
        )
      }
    </AuthGate>
  )
}
