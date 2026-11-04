import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { normalise, parseFit, type FitRecord } from "./fit";
import { estimatePower } from "@/lib/analysis/power";
import { computeRideMetrics, elevationGain, totalAscent } from "@/lib/analysis/metrics";
import { DEFAULT_PROFILE } from "@/lib/analysis/types";

/**
 * Exercised against a real file when one is present locally.
 *
 * Ride files are gitignored (a GPS trace is a home address), so these skip in
 * CI rather than fail. The synthetic tests cover the algorithms; this suite
 * exists to catch the things only real device output reveals — recording gaps,
 * missing channels, vendor quirks.
 */
const FIXTURE = "sample data/Afternoon_Ride.fit";
const hasFixture = existsSync(FIXTURE);
const suite = hasFixture ? describe : describe.skip;

function loadFixture() {
  const buf = readFileSync(FIXTURE);
  return parseFit(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

suite("parseFit against a real device file", () => {
  test("produces a uniform 1 Hz grid with every stream the same length", async () => {
    const ride = await loadFixture();
    const { streams, meta } = ride;

    expect(meta.n).toBeGreaterThan(1000);
    expect(streams.time).toHaveLength(meta.n);
    expect(streams.distance).toHaveLength(meta.n);
    expect(streams.altitude).toHaveLength(meta.n);
    expect(streams.latlng).toHaveLength(meta.n * 2);
    for (const s of [streams.heartrate, streams.cadence, streams.speed]) {
      if (s) expect(s).toHaveLength(meta.n);
    }

    // Uniform grid: every step is exactly one second.
    for (let i = 1; i < meta.n; i++) {
      expect(streams.time[i] - streams.time[i - 1]).toBe(1);
    }
  });

  test("distance is monotonically non-decreasing, including across pauses", async () => {
    const { streams, meta } = await loadFixture();
    for (let i = 1; i < meta.n; i++) {
      expect(streams.distance[i]).toBeGreaterThanOrEqual(streams.distance[i - 1] - 1e-6);
    }
  });

  test("total distance agrees with what the head unit reported", async () => {
    const ride = await loadFixture();
    const computed = ride.streams.distance[ride.meta.n - 1] - ride.streams.distance[0];
    const reported = ride.reported.distanceMeters!;
    // Within 1%: we resample, the device does not.
    expect(Math.abs(computed - reported) / reported).toBeLessThan(0.01);
  });

  test("recording gaps are held, not interpolated into phantom movement", async () => {
    const ride = await loadFixture();
    // This file has ~80 minutes of elapsed-minus-moving time.
    expect(ride.gapSeconds).toBeGreaterThan(0);
    // Held gaps must not manufacture speed.
    for (let i = 0; i < ride.meta.n; i++) {
      expect(Number.isFinite(ride.streams.speed![i])).toBe(true);
      expect(ride.streams.speed![i]).toBeGreaterThanOrEqual(0);
    }
  });

  test("no NaNs anywhere in the normalised streams", async () => {
    const { streams, meta } = await loadFixture();
    const check = (name: string, arr?: ArrayLike<number>) => {
      if (!arr) return;
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i])) throw new Error(`${name}[${i}] is ${arr[i]}`);
      }
    };
    check("distance", streams.distance);
    check("altitude", streams.altitude);
    check("speed", streams.speed);
    check("heartrate", streams.heartrate);
    check("cadence", streams.cadence);
    check("latlng", streams.latlng);
    expect(meta.n).toBeGreaterThan(0);
  });

  test("paused samples are marked and excluded from averages", async () => {
    const ride = await loadFixture();
    const paused = ride.streams.paused!;
    let pausedCount = 0;
    for (const p of paused) if (p) pausedCount++;

    // This file has roughly 80 minutes of stops inside a 5h47 elapsed window.
    expect(pausedCount).toBeGreaterThan(1000);
    expect(pausedCount).toBeCloseTo(ride.gapSeconds, -2);

    const { watts } = estimatePower(ride.streams, ride.meta, DEFAULT_PROFILE);
    const base = {
      watts,
      time: ride.streams.time,
      distance: ride.streams.distance,
      altitude: ride.streams.altitude,
      heartrate: ride.streams.heartrate,
      ftp: 250,
    };
    const withoutFlag = computeRideMetrics(base);
    const withFlag = computeRideMetrics({ ...base, paused });

    // Stopped time is excluded on the evidence of the distance channel, so
    // supplying the pause flag as well must not move any average. That
    // equivalence is the point: a head unit with auto-pause writes no records
    // and gets a flag, a phone records straight through the red light and gets
    // none, and the rider was doing the same thing — sitting still. Deciding
    // from the flag alone made average power 8-13% lower on the phone files.
    expect(withFlag.meanPower).toBeCloseTo(withoutFlag.meanPower, 6);
    expect(withFlag.weightedPower).toBeCloseTo(withoutFlag.weightedPower, 6);
    expect(withFlag.meanHeartRate!).toBeCloseTo(withoutFlag.meanHeartRate!, 6);

    // And stopped time really is being dropped, rather than nothing happening.
    const everySample = computeRideMetrics({
      ...base,
      distance: ride.streams.distance.map((_, i) => i * 5) as Float64Array,
    });
    expect(withFlag.meanPower).toBeGreaterThan(everySample.meanPower * 1.15);

    // Total work is a sum, so it must NOT change — stopped samples are zero.
    expect(withFlag.kilojoules).toBeCloseTo(withoutFlag.kilojoules, 6);
  });

  test("mean power is consistent with steady-state physics for the ride's speed", async () => {
    const ride = await loadFixture();
    const { watts } = estimatePower(ride.streams, ride.meta, DEFAULT_PROFILE);
    const m = computeRideMetrics({
      watts,
      time: ride.streams.time,
      distance: ride.streams.distance,
      altitude: ride.streams.altitude,
      paused: ride.streams.paused,
      ftp: 250,
    });
    // 23.8 km/h on the flat for an 84 kg system is ~89 W of steady-state drag
    // plus rolling resistance. Coasting zeros pull the mean under that, but not
    // by half — that signature is paused time leaking in.
    const meanSpeed = m.distanceMeters / m.movingSeconds;
    expect(meanSpeed).toBeGreaterThan(6);
    expect(m.meanPower).toBeGreaterThan(70);
  });

  test("this ride has no power meter, so estimation is required", async () => {
    const ride = await loadFixture();
    expect(ride.hasMeasuredPower).toBe(false);
  });

  test("ascent lands within 25% of what the head unit reported", async () => {
    const ride = await loadFixture();
    const gain = totalAscent(ride.streams.altitude);
    const reported = ride.reported.ascentMeters!;
    expect(Math.abs(gain - reported) / reported).toBeLessThan(0.25);
  });

  test("raw delta summing is wildly wrong, which is why totalAscent smooths", async () => {
    // Guards the reason ASCENT_SMOOTHING_HALF_WINDOW exists. This ride spans
    // 22 m between its lowest and highest point; summing raw barometric deltas
    // claims several hundred metres of climbing.
    const ride = await loadFixture();
    const alt = ride.streams.altitude;
    const relief = Math.max(...alt) - Math.min(...alt);
    expect(relief).toBeLessThan(40);

    const raw = elevationGain(alt, 0);
    expect(raw).toBeGreaterThan(relief * 10);
    expect(totalAscent(alt)).toBeLessThan(raw / 2);
  });

  test("estimated power is physically plausible for a real ride", async () => {
    const ride = await loadFixture();
    const { watts, confidence } = estimatePower(ride.streams, ride.meta, DEFAULT_PROFILE);
    const metrics = computeRideMetrics({
      watts,
      time: ride.streams.time,
      distance: ride.streams.distance,
      altitude: ride.streams.altitude,
      heartrate: ride.streams.heartrate,
      ftp: 250,
    });

    for (const w of watts) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(2000); // nobody sustains a sample above this
    }
    // A real endurance ride should average somewhere in this band.
    expect(metrics.meanPower).toBeGreaterThan(20);
    expect(metrics.meanPower).toBeLessThan(400);
    // Weighted power is >= mean by construction of the 4th-power weighting.
    expect(metrics.weightedPower).toBeGreaterThanOrEqual(metrics.meanPower - 1);
    expect(confidence.summary.length).toBeGreaterThan(10);
  });

  test("moving time is close to the device's timer, not to elapsed time", async () => {
    const ride = await loadFixture();
    const metrics = computeRideMetrics({
      watts: new Float32Array(ride.meta.n),
      time: ride.streams.time,
      distance: ride.streams.distance,
      altitude: ride.streams.altitude,
    });
    const timer = ride.reported.movingSeconds!;
    const elapsed = ride.reported.elapsedSeconds!;
    // The whole point of holding gaps: moving time must not drift toward elapsed.
    expect(metrics.movingSeconds).toBeLessThan(elapsed);
    expect(Math.abs(metrics.movingSeconds - timer) / timer).toBeLessThan(0.25);
  });
});

describe("normalise before the first GPS fix", () => {
  // A head unit starts recording before it has a fix or an altitude. Seeding
  // with zero drew a line from 0°N 0°E across the Atlantic and turned the first
  // real altitude into a one-second 30 m climb.
  const t0 = Date.parse("2026-08-15T14:00:42Z");
  const records: FitRecord[] = [
    { timestamp: new Date(t0), distance: 0 },
    { timestamp: new Date(t0 + 1000), distance: 0 },
    { timestamp: new Date(t0 + 2000), distance: 0, altitude: 20.8 },
    { timestamp: new Date(t0 + 3000), distance: 2, altitude: 20.6, position_lat: 45.497, position_long: -73.553 },
    { timestamp: new Date(t0 + 4000), distance: 6, altitude: 20.6, position_lat: 45.4971, position_long: -73.553 },
  ];

  test("holds the first fix rather than inventing 0°N 0°E", () => {
    const { streams } = normalise(records, {}, []);
    for (let i = 0; i < streams.time.length; i++) {
      expect(streams.latlng![i * 2]).toBeGreaterThan(45);
      expect(streams.latlng![i * 2 + 1]).toBeLessThan(-73);
    }
  });

  test("holds the first altitude rather than starting at 0 m", () => {
    const { streams } = normalise(records, {}, []);
    expect(streams.altitude[0]).toBeCloseTo(20.8);
    expect(streams.altitude[1]).toBeCloseTo(20.8);
  });
});
