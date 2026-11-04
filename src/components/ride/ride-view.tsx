"use client";

import { useEffect, useMemo, useState } from "react";
import { CursorStore, type Selection } from "@/lib/cursor-store";
import { estimatePower } from "@/lib/analysis/power";
import { computeRideMetrics } from "@/lib/analysis/metrics";
import type { RideMeta, RideStreams } from "@/lib/analysis/types";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  toProfile,
  type RiderSettings,
} from "@/lib/rider-settings";
import { wPrimeBalance } from "@/lib/analysis/w-prime";
import { movingAverage } from "@/lib/analysis/signal";
import { ZONE_SMOOTH_HALF_WINDOW } from "@/lib/analysis/zones";
import { RiderSettingsPanel } from "./rider-settings-panel";
import { RideMapLoader } from "./map-loader";
import { StreamChart } from "./stream-chart";
import { ConfidenceChip } from "./confidence-chip";
import { StatRow } from "./stat-row";
import { ZonePanel } from "./zone-panel";

/**
 * Work capacity above threshold, joules.
 *
 * A season-long power curve can fit this per rider, but that fit needs repeated
 * maximal efforts between two and fifteen minutes, and it is not worth a knob in
 * settings: 20 kJ is the usual order of magnitude, and with modelled rather than
 * measured power the trace is only ever read for its shape.
 */
const DEFAULT_W_PRIME_J = 20_000;

/** Below this the tank never emptied enough for the trace to say anything. */
const W_PRIME_VISIBLE_DEPLETION = 0.02;

type ChannelKey = "power" | "heartrate" | "speed" | "altitude";

const MAP_CHANNELS: { key: ChannelKey; label: string; token: string }[] = [
  { key: "power", label: "Power", token: "--ch-power" },
  { key: "heartrate", label: "Heart rate", token: "--ch-hr" },
  { key: "speed", label: "Speed", token: "--ch-speed" },
  { key: "altitude", label: "Elevation", token: "--ch-elevation-line" },
];

export interface RideViewProps {
  streams: RideStreams;
  meta: RideMeta;
  name: string;
  startedAt: string;
  /**
   * Calories the recording device wrote into the file, when it wrote any.
   * Not derivable from the streams — it models metabolic cost from heart rate,
   * where everything computed here is mechanical work at the pedals.
   */
  reportedCalories?: number | null;
  /** The matching Strava activity, for a link back to it. */
  stravaActivityId?: number | null;
}

export function RideView({
  streams,
  meta,
  name,
  startedAt,
  reportedCalories,
  stravaActivityId,
}: RideViewProps) {
  const [xIsDistance, setXIsDistance] = useState(false);
  const [mapChannel, setMapChannel] = useState<ChannelKey>("power");
  const [selection, setSelection] = useState<Selection | null>(null);

  // One store per mounted ride view; charts and the map both talk to it.
  const cursor = useMemo(() => new CursorStore(), []);

  // Server render must match the client's first paint, so start from defaults
  // and adopt the stored settings after mount.
  const [settings, setSettings] = useState<RiderSettings>(DEFAULT_SETTINGS);
  useEffect(() => setSettings(loadSettings()), []);

  const profile = useMemo(() => toProfile(settings), [settings]);
  const ftp = profile.ftp ?? DEFAULT_SETTINGS.ftp;

  const power = useMemo(
    () => estimatePower(streams, meta, profile),
    [streams, meta, profile],
  );

  const x = xIsDistance ? streams.distance : streams.time;

  // Selecting a range recomputes every statistic for just that range. This is
  // the thing that makes a ride analyser feel alive, and Strava has no
  // equivalent.
  const metrics = useMemo(() => {
    const from = selection?.from ?? 0;
    const to = selection ? selection.to + 1 : meta.n;
    return computeRideMetrics({
      watts: power.watts.subarray(from, to),
      time: streams.time.subarray(from, to),
      distance: streams.distance.subarray(from, to),
      altitude: streams.altitude.subarray(from, to),
      heartrate: streams.heartrate?.subarray(from, to),
      paused: streams.paused?.subarray(from, to),
      ftp,
    });
  }, [power.watts, streams, meta.n, selection, ftp]);

  const mapValues =
    mapChannel === "power"
      ? power.watts
      : mapChannel === "heartrate"
        ? (streams.heartrate ?? power.watts)
        : mapChannel === "speed"
          ? (streams.speed ?? power.watts)
          : streams.altitude;

  const mapToken = MAP_CHANNELS.find((c) => c.key === mapChannel)!.token;

  // W′ balance: how much of the finite capacity above threshold is left at each
  // moment, which is why the fourth climb hurts more than the first at the same
  // power. Threshold stands in for critical power — they are not the same
  // quantity, but they are within a few watts of each other for most riders and
  // the difference is far inside this model's error.
  //
  // Fed the smoothed stream when power is modelled rather than measured. W′
  // balance integrates everything above threshold, so it is exactly as sharp as
  // its input's upper tail — and this model's upper tail is artefact. Run raw,
  // it reported 100% depletion on a four-hour endurance ride, which is the
  // estimator's spikes being read as repeated sprints. Smoothing to the
  // resolution the model actually has is the same restraint that keeps
  // sub-five-minute values off the power curve.
  const wPrimeInput = useMemo(
    () =>
      streams.power
        ? power.watts
        : movingAverage(power.watts, ZONE_SMOOTH_HALF_WINDOW),
    [power.watts, streams.power],
  );
  const wBalance = useMemo(
    () => wPrimeBalance(wPrimeInput, ftp, DEFAULT_W_PRIME_J),
    [wPrimeInput, ftp],
  );
  const wBalanceKj = useMemo(
    () => Float32Array.from(wBalance.balance, (j) => j / 1000),
    [wBalance.balance],
  );

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4 pb-6">
        <div>
          <h1 className="text-xl font-medium tracking-tight text-ink">{name}</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {formatDate(startedAt)}
            {stravaActivityId ? (
              <>
                {" · "}
                <a
                  href={`https://www.strava.com/activities/${stravaActivityId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-[#FC5200] underline-offset-4 hover:underline"
                >
                  View on Strava
                </a>
              </>
            ) : null}
            {selection ? (
              <>
                {" · "}
                <span className="text-ink-secondary">
                  showing a {formatDuration(selection.to - selection.from)} selection
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selection ? (
            <button
              onClick={() => setSelection(null)}
              className="rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-3"
            >
              Clear selection
            </button>
          ) : null}
          <RiderSettingsPanel settings={settings} onChange={setSettings} />
          <Segmented
            options={[
              { value: "time", label: "Time" },
              { value: "distance", label: "Distance" },
            ]}
            value={xIsDistance ? "distance" : "time"}
            onChange={(v) => setXIsDistance(v === "distance")}
          />
        </div>
      </header>

      <StatRow
        metrics={metrics}
        ftp={ftp}
        riderKg={settings.configured ? settings.riderKg : undefined}
        reportedCalories={reportedCalories}
      />

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <section className="flex flex-col overflow-hidden rounded-xl border border-hairline bg-surface-1">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3">
            <span className="text-[12px] font-medium text-ink-secondary">Route</span>
            <Segmented
              options={MAP_CHANNELS.map((c) => ({ value: c.key, label: c.label }))}
              value={mapChannel}
              onChange={(v) => setMapChannel(v as ChannelKey)}
            />
          </div>
          {/* Fills the column so the map matches the chart stack's height
              instead of leaving dead space under it. */}
          <div className="min-h-[480px] w-full flex-1">
            <RideMapLoader
              latlng={streams.latlng ?? new Float64Array(0)}
              channel={mapValues}
              distance={streams.distance}
              colorToken={mapToken}
              cursor={cursor}
              selection={selection}
            />
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-hairline bg-surface-1">
          <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
            <span className="text-[12px] font-medium text-ink-secondary">Channels</span>
            <span className="text-[11px] text-ink-muted">
              drag to select a range
            </span>
          </div>

          <StreamChart
            label="Elevation"
            colorToken="--ch-elevation-line"
            x={x}
            y={streams.altitude}
            unit="m"
            fill
            height={78}
            cursor={cursor}
            syncKey="ride"
            onSelect={setSelection}
            xIsDistance={xIsDistance}
          />
          <StreamChart
            label="Power (estimated)"
            colorToken="--ch-power"
            x={x}
            y={power.watts}
            unit="W"
            cursor={cursor}
            syncKey="ride"
            onSelect={setSelection}
            xIsDistance={xIsDistance}
          />
          {streams.heartrate ? (
            <StreamChart
              label="Heart rate"
              colorToken="--ch-hr"
              x={x}
              y={streams.heartrate}
              unit="bpm"
              cursor={cursor}
              syncKey="ride"
              onSelect={setSelection}
              xIsDistance={xIsDistance}
            />
          ) : null}
          {streams.cadence ? (
            <StreamChart
              label="Cadence"
              colorToken="--ch-cadence"
              x={x}
              y={streams.cadence}
              unit="rpm"
              cursor={cursor}
              syncKey="ride"
              onSelect={setSelection}
              xIsDistance={xIsDistance}
            />
          ) : null}
          {streams.speed ? (
            <StreamChart
              label="Speed"
              colorToken="--ch-speed"
              x={x}
              y={streams.speed}
              unit="km/h"
              format={(v) => (v * 3.6).toFixed(1)}
              cursor={cursor}
              syncKey="ride"
              onSelect={setSelection}
              xIsDistance={xIsDistance}
            />
          ) : null}
          {wBalance.maxDepletion > W_PRIME_VISIBLE_DEPLETION ? (
            <StreamChart
              label="W′ balance"
              colorToken="--ch-wbal"
              x={x}
              y={wBalanceKj}
              unit="kJ"
              format={(v) => v.toFixed(1)}
              cursor={cursor}
              syncKey="ride"
              onSelect={setSelection}
              xIsDistance={xIsDistance}
            />
          ) : null}
        </section>
      </div>

      <div className="mt-5">
        <ZonePanel
          watts={power.watts}
          heartrate={streams.heartrate}
          distance={streams.distance}
          time={streams.time}
          paused={streams.paused}
          ftp={ftp}
          lthr={settings.lthr}
          hasMeasuredPower={streams.power !== undefined}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <ConfidenceChip confidence={power.confidence} />
        <span className="text-[12px] text-ink-muted">
          {wBalance.maxDepletion > W_PRIME_VISIBLE_DEPLETION ? (
            <>
              Deepest W′ depletion{" "}
              <span className="text-ink-secondary tabular-nums">
                {(wBalance.maxDepletion * 100).toFixed(0)}%
              </span>{" "}
              — {(wBalance.minimum / 1000).toFixed(1)} kJ of {DEFAULT_W_PRIME_J / 1000} kJ left at
              the worst moment
            </>
          ) : (
            <>Never went meaningfully above threshold, so W′ stayed full.</>
          )}
        </span>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-hairline bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={[
            "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
            value === o.value
              ? "bg-surface-1 text-ink shadow-[var(--shadow-card)]"
              : "text-ink-muted hover:text-ink-secondary",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
