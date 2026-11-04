"use client";

import { useEffect, useState } from "react";
import { listRides } from "@/lib/store/rides";
import { fetchRemoteRides, sync, type SyncProgress, type SyncResult } from "@/lib/sync/client";
import { reconcileSettings } from "@/lib/sync/settings";

export function SyncPanel() {
  const [local, setLocal] = useState<number | null>(null);
  const [remote, setRemote] = useState<number | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputed, setRecomputed] = useState<number | null>(null);

  async function refresh() {
    try {
      const [l, r] = await Promise.all([listRides(), fetchRemoteRides()]);
      setLocal(l.length);
      setRemote(r.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not reach the server");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function run() {
    setError(null);
    setResult(null);
    try {
      // Reconcile the rider's numbers before any ride moves. Rides pulled down
      // are re-analysed with these, so doing it the other way round would
      // analyse a season against a 75 kg stranger and then correct it.
      const settings = await reconcileSettings();
      const outcome = await sync(settings, setProgress);
      setResult(outcome);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "sync failed");
    } finally {
      setProgress(null);
    }
  }

  async function recompute() {
    setRecomputing(true);
    setError(null);
    try {
      const res = await fetch("/api/rides/recompute", { method: "POST" });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const body = (await res.json()) as { recomputed: number };
      setRecomputed(body.recomputed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "recompute failed");
    } finally {
      setRecomputing(false);
    }
  }

  return (
    <section className="mt-5 rounded-xl border border-hairline bg-surface-1 p-5">
      <h2 className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Sync</h2>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[13px]">
        <span className="text-ink-secondary">
          In this browser <span className="text-ink tabular-nums">{local ?? "…"}</span>
        </span>
        <span className="text-ink-secondary">
          On the server <span className="text-ink tabular-nums">{remote ?? "…"}</span>
        </span>
      </div>

      <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-ink-secondary">
        Sync copies rides in both directions and matches them by start time and
        duration, so importing the same file on two devices converges on one ride
        rather than two. Rides pulled down are re-analysed here with your current
        weight and threshold, not trusted from the server.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={run}
          disabled={progress !== null}
          className="rounded-md bg-[var(--brand)] px-3 py-2 text-[13px] font-medium text-[var(--brand-contrast)] transition-opacity disabled:opacity-60"
        >
          {progress ? "Syncing…" : "Sync now"}
        </button>
        <button
          onClick={recompute}
          disabled={recomputing}
          className="rounded-md border border-hairline bg-surface-2 px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-3 disabled:opacity-60"
        >
          {recomputing ? "Recomputing…" : "Recompute on the server"}
        </button>
      </div>

      <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-ink-muted">
        Stored figures are an interpretation of the samples, so they go stale when
        the model improves. Saving your rider settings already re-derives them;
        this is the button for when nothing about you changed but the maths did.
        {recomputed !== null ? (
          <span className="text-ink-secondary"> Re-derived {recomputed} rides.</span>
        ) : null}
      </p>

      {progress ? (
        <p className="mt-3 text-[12px] text-ink-muted">
          {progress.phase === "push" ? "Uploading" : "Downloading"} {progress.done}/
          {progress.total} — {progress.name}
        </p>
      ) : null}

      {result ? (
        <p className="mt-3 text-[12px] text-ink-secondary">
          Uploaded {result.pushed}, updated {result.updated}, downloaded {result.pulled}
          {result.removed > 0 ? `, removed ${result.removed} Strava copies` : ""}.
          {result.failed.length > 0 ? (
            <span style={{ color: "var(--status-warning)" }}>
              {" "}
              {result.failed.length} failed: {result.failed[0].reason}.
            </span>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 text-[12px]" style={{ color: "var(--status-critical)" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
