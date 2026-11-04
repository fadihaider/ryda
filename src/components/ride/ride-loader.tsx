"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getStreams, listRides, type RideSummary } from "@/lib/store/rides";
import type { RideMeta, RideStreams } from "@/lib/analysis/types";
import { RideView } from "./ride-view";

interface Loaded {
  streams: RideStreams;
  meta: RideMeta;
  name: string;
  startedAt: string;
  reportedCalories: number | null;
  stravaActivityId: number | null;
}

/**
 * Opens the ride named by ?id=.
 *
 * There is deliberately no fallback ride. This screen used to generate a
 * plausible-looking synthetic ride when opened without an id, which was useful
 * while there was nothing else to look at and actively misleading afterwards:
 * every number on it was invented, and nothing on the page said so.
 */
export function RideLoader() {
  const params = useSearchParams();
  const id = params.get("id");
  const [ride, setRide] = useState<Loaded | null | "missing">(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const [streams, rides] = await Promise.all([getStreams(id), listRides()]);
      if (cancelled) return;
      const summary: RideSummary | undefined = rides.find((r) => r.id === id);
      if (!streams || !summary) {
        setRide("missing");
        return;
      }
      setRide({
        streams: streams.streams,
        meta: streams.meta,
        name: summary.name,
        startedAt: summary.startedAt,
        reportedCalories: summary.reportedCalories,
        stravaActivityId: summary.stravaActivityId ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) return <Empty>Pick a ride from your library to open it here.</Empty>;
  if (ride === null) return <Empty>Loading ride…</Empty>;
  if (ride === "missing") {
    return <Empty>That ride isn&apos;t in this browser&apos;s library.</Empty>;
  }

  return (
    <RideView
      streams={ride.streams}
      meta={ride.meta}
      name={ride.name}
      startedAt={ride.startedAt}
      reportedCalories={ride.reportedCalories}
      stravaActivityId={ride.stravaActivityId}
    />
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1400px] px-6 py-10">
      <p className="text-[13px] text-ink-muted">{children}</p>
      <Link
        href="/library"
        className="mt-3 inline-block text-[13px] text-ink-secondary underline underline-offset-4 hover:text-ink"
      >
        Go to library
      </Link>
    </div>
  );
}
