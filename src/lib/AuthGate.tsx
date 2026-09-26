import type { Session } from "@supabase/supabase-js"
import { useEffect, useState, type ReactNode } from "react"

import { getSupabaseClient } from "../runtime/session"

type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; session: Session }
  | { status: "error"; message: string }

// An anonymous (participant) session is not a researcher session, so it is
// treated as signed-out here.
export function useAuthSession(): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" })

  useEffect(() => {
    let supabase: ReturnType<typeof getSupabaseClient>
    try {
      supabase = getSupabaseClient()
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      return
    }

    const apply = (session: Session | null) => {
      if (session && !session.user.is_anonymous) {
        setState({ status: "signed-in", session })
      } else {
        setState({ status: "signed-out" })
      }
    }

    void supabase.auth.getSession().then(({ data }) => apply(data.session))
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) =>
      apply(session),
    )
    return () => subscription.subscription.unsubscribe()
  }, [])

  return state
}

export function AuthGate({ children }: { children: (session: Session) => ReactNode }) {
  const auth = useAuthSession()
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState<string | null>(null)

  if (auth.status === "loading") return <p className="p-6">Loading…</p>
  if (auth.status === "error") return <p className="p-6 text-destructive">{auth.message}</p>
  if (auth.status === "signed-in") return <>{children(auth.session)}</>

  async function sendMagicLink() {
    setMessage(null)
    const { error } = await getSupabaseClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href },
    })
    setMessage(error ? `Error: ${error.message}` : "Magic link sent. Check your email.")
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 p-6">
      <h1 className="text-lg font-medium">Researcher sign-in</h1>
      <input
        type="email"
        className="rounded-md border px-3 py-2"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button
        type="button"
        className="self-start rounded-md bg-primary px-4 py-2 text-primary-foreground"
        onClick={() => void sendMagicLink()}
      >
        Send magic link
      </button>
      {message && <p className="text-sm">{message}</p>}
    </main>
  )
}
