"use client";

import { useState } from "react";
import { signIn, signOut, signUp, useSession } from "@/lib/auth-client";
import { StravaPanel } from "./strava-panel";
import { SyncPanel } from "./sync-panel";

/**
 * Sign in, and everything that only makes sense once signed in.
 *
 * An account is optional on purpose. Rides parse and analyse entirely in the
 * browser and the app works with no account at all; signing in adds durability
 * and a second device, which is a different thing from being the price of entry.
 */
export function AccountPanel() {
  const { data: session, isPending } = useSession();

  return (
    <div className="mx-auto w-full max-w-[720px] px-6 py-8">
      <h1 className="text-xl font-medium tracking-tight text-ink">Account</h1>
      <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-secondary">
        Rides live in this browser by default, which means clearing site data
        loses them and nothing appears on your phone. An account keeps a copy on
        the server and is what the iOS app reads.
      </p>

      {isPending ? (
        <p className="mt-6 text-[13px] text-ink-muted">Checking…</p>
      ) : session ? (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-surface-1 px-4 py-3">
            <div>
              <div className="text-[13px] text-ink">{session.user.email}</div>
              <div className="text-[12px] text-ink-muted">Signed in</div>
            </div>
            <button
              onClick={() => signOut()}
              className="rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-3"
            >
              Sign out
            </button>
          </div>
          <SyncPanel />
          <StravaPanel />
        </>
      ) : (
        <SignInForm />
      )}
    </div>
  );
}

function SignInForm() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result =
      mode === "in"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: name || email });
    setBusy(false);
    if (result.error) setError(result.error.message ?? "That didn't work.");
  }

  return (
    <form onSubmit={submit} className="mt-6 max-w-[380px] rounded-xl border border-hairline bg-surface-1 p-5">
      <div className="inline-flex rounded-lg border border-hairline bg-surface-2 p-0.5">
        {(["in", "up"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={[
              "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
              mode === m
                ? "bg-surface-1 text-ink shadow-[var(--shadow-card)]"
                : "text-ink-muted hover:text-ink-secondary",
            ].join(" ")}
          >
            {m === "in" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {mode === "up" ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-ink-secondary">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink"
            />
          </label>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-secondary">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-ink-secondary">
            Password
            <span className="ml-1.5 text-ink-muted">at least 10 characters</span>
          </span>
          <input
            type="password"
            required
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            className="rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink"
          />
        </label>

        {error ? (
          <p className="text-[12px]" style={{ color: "var(--status-critical)" }}>
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-1 rounded-md bg-[var(--brand)] px-3 py-2 text-[13px] font-medium text-[var(--brand-contrast)] transition-opacity disabled:opacity-60"
        >
          {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
      </div>
    </form>
  );
}
