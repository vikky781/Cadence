import type { Session } from "@supabase/supabase-js"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"

import { AppShell } from "./AppShell"

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
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState<"link" | "password">("password")
  const [password, setPassword] = useState("")

  if (auth.status === "loading") {
    return (
      <AppShell>
        <p className="eyebrow">Checking your session…</p>
      </AppShell>
    )
  }
  if (auth.status === "error") {
    return (
      <AppShell>
        <p role="alert" className="card border-destructive/40 text-sm text-destructive">{auth.message}</p>
      </AppShell>
    )
  }
  if (auth.status === "signed-in") {
    return <AppShell email={auth.session.user.email}>{children(auth.session)}</AppShell>
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSending(true)
    setMessage(null)
    const supabase = getSupabaseClient()

    if (mode === "password") {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      setSending(false)
      // On success onAuthStateChange swaps this screen for the app.
      if (error) setMessage({ tone: "error", text: `Could not sign in: ${error.message}` })
      return
    }

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href },
    })
    setSending(false)
    setMessage(
      error
        ? { tone: "error", text: `Could not send the link: ${error.message}` }
        : { tone: "ok", text: `Sign-in link sent to ${email}. Open it on this device to continue.` },
    )
  }

  const idleLabel = mode === "password" ? "Sign in" : "Send magic link"

  return (
    <AppShell>
      <div className="mx-auto mt-10 max-w-sm">
        <p className="eyebrow">Researcher access</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Sign in to build and publish studies</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "password"
            ? "Sign in with your email and password. Participants never need an account."
            : "We email you a one-time link. Participants never need an account."}
        </p>
        <form className="card mt-6 flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
          <label className="lbl">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              className="field"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {mode === "password" && (
            <label className="lbl">
              Password
              <input
                type="password"
                required
                autoComplete="current-password"
                className="field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? (mode === "password" ? "Signing in…" : "Sending…") : idleLabel}
          </button>
          {message && (
            <p role="status" className={message.tone === "error" ? "text-sm text-destructive" : "text-sm text-signal"}>
              {message.text}
            </p>
          )}
          <button
            type="button"
            className="btn btn-quiet self-center hover:text-foreground"
            onClick={() => {
              setMode(mode === "password" ? "link" : "password")
              setMessage(null)
            }}
          >
            {mode === "password" ? "Email me a sign-in link instead" : "Use a password instead"}
          </button>
        </form>
      </div>
    </AppShell>
  )
}
