"use client";

import { useEffect, useRef, useState } from "react";
import { pushQuietly } from "@/lib/sync/client";
import { reconcileSettings } from "@/lib/sync/settings";
import type { StravaProgress } from "@/lib/strava/sync";

interface Status {
  configured: boolean;
  connected: boolean;
  progress: StravaProgress | null;
}

/** What the callback's ?strava= outcome means, in words. */
const OUTCOMES: Record<string, string> = {
  connected: "Connected. The history is being listed now.",
  denied: "Strava access was declined.",
  "scope-missing": "Strava was connected without activity access, so there is nothing to sync. Connect again and leave “View data about your activities” ticked.",
  "state-mismatch": "That Strava response did not match a connection started here. Try again.",
  "exchange-failed": "Strava did not accept the authorisation code. Try again.",
  "signed-out": "Sign in first, then connect Strava.",
  "no-code": "Strava returned without an authorisation code. Try again.",
};

/**
 * Strava connection, backfill progress, and the buttons that move it along.
 *
 * The server does the syncing on its own — a webhook for new rides and a daily
 * job for everything else. This panel only shows where that has got to, and
 * lets the backfill run faster while the page is open.
 */
export function StravaPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);

  async function refresh() {
    try {
      const res = await fetch("/api/strava/status");
      if (!res.ok) throw new Error(`server said ${res.status}`);
      setStatus((await res.json()) as Status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not reach the server");
    }
  }

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("strava");
    if (outcome) {
      setNotice(OUTCOMES[outcome] ?? outcome);
      window.history.replaceState(null, "", window.location.pathname);
    }
    void refresh();
  }, []);

  /** Run batches back to back until the queue is empty, the limit is hit, or Stop. */
  async function run() {
    setRunning(true);
    setError(null);
    stop.current = false;
    try {
      let before = "";
      while (!stop.current) {
        const res = await fetch("/api/strava/sync", { method: "POST" });
        if (!res.ok) throw new Error(`server said ${res.status}`);
        const { progress } = (await res.json()) as { progress: StravaProgress };
        setStatus((s) => (s ? { ...s, progress } : s));
        if (progress.error) throw new Error(progress.error);
        const finished = progress.listComplete && progress.done >= progress.rides;
        // A batch that moved nothing is waiting on rides set aside for retry,
        // which only the nightly job releases. Looping would spin forever.
        const now = `${progress.rides}/${progress.done}/${progress.skipped}`;
        if (finished || progress.pausedUntil || now === before) break;
        before = now;
      }
      // Bring what arrived into this browser, the same way an import would.
      await pushQuietly(await reconcileSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Strava sync failed");
    } finally {
      setRunning(false);
    }
  }

  async function disconnect() {
    setError(null);
    const res = await fetch("/api/strava/disconnect", { method: "POST" });
    if (!res.ok) setError(`server said ${res.status}`);
    await refresh();
  }

  const progress = status?.progress ?? null;
  const backlog = progress ? !progress.listComplete || progress.done < progress.rides : false;

  return (
    <section className="mt-5 rounded-xl border border-hairline bg-surface-1 p-5">
      <h2 className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Strava</h2>

      {status === null ? (
        <p className="mt-3 text-[13px] text-ink-muted">Checking…</p>
      ) : !status.configured ? (
        <p className="mt-3 max-w-prose text-[12px] leading-relaxed text-ink-secondary">
          Not set up on this server. STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET
          need to be in the environment.
        </p>
      ) : !progress ? (
        <>
          <p className="mt-3 max-w-prose text-[12px] leading-relaxed text-ink-secondary">
            Connect to bring rides in from Strava automatically: new ones within
            seconds of uploading, and your history in the background. A file
            imported here always replaces Strava&apos;s copy of the same ride.
          </p>
          <a
            href="/api/strava/connect"
            className="mt-4 inline-block rounded-md bg-[#FC5200] px-3 py-2 text-[13px] font-medium text-white"
          >
            Connect Strava
          </a>
        </>
      ) : (
        <>
          <p className="mt-3 text-[13px] text-ink">
            {progress.listComplete ? (
              <>
                <span className="tabular-nums">{progress.done}</span> of{" "}
                <span className="tabular-nums">{progress.rides}</span> rides
              </>
            ) : (
              <>
                Listing your history… <span className="tabular-nums">{progress.rides}</span> rides
                found so far
              </>
            )}
          </p>
          <p className="mt-1 text-[12px] text-ink-secondary">
            {progress.imported} from Strava, {progress.linked} matched to files you imported,{" "}
            {progress.skipped} other activities skipped
            {progress.failed > 0 ? (
              <span style={{ color: "var(--status-warning)" }}>, {progress.failed} failed</span>
            ) : null}
            .
          </p>
          {progress.pausedUntil ? (
            <p className="mt-1 text-[12px] text-ink-muted">
              Strava&apos;s read limit reached; continues after{" "}
              {new Date(progress.pausedUntil).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
              .
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {running ? (
              <button
                onClick={() => {
                  stop.current = true;
                }}
                className="rounded-md border border-hairline bg-surface-2 px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-3"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={run}
                className="rounded-md bg-[var(--brand)] px-3 py-2 text-[13px] font-medium text-[var(--brand-contrast)]"
              >
                {backlog ? "Continue backfill now" : "Sync from Strava now"}
              </button>
            )}
            <button
              onClick={disconnect}
              disabled={running}
              className="rounded-md border border-hairline bg-surface-2 px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-3 disabled:opacity-60"
            >
              Disconnect
            </button>
          </div>

          <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-ink-muted">
            {running
              ? "Working… keep this page open to keep going. Closing it is fine; the nightly job carries on."
              : "New rides arrive on their own. The history also fills in nightly, about 90 rides a night, without this page open."}
          </p>
        </>
      )}

      {notice ? <p className="mt-3 text-[12px] text-ink-secondary">{notice}</p> : null}
      {error ? (
        <p className="mt-3 text-[12px]" style={{ color: "var(--status-critical)" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
