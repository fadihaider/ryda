import { describe, expect, test } from "vitest";
import { buildPauseAxis, formatStop, STOP_BAND_SECONDS } from "./pause-axis";

/** 1 Hz ride: `ride` seconds, a stop of `stop` seconds, then `ride` again. */
function ride(rideS: number, stopS: number) {
  const n = rideS * 2 + stopS;
  const time = Float64Array.from({ length: n }, (_, i) => i);
  const paused = new Uint8Array(n);
  paused.fill(1, rideS, rideS + stopS);
  return { time, paused };
}

describe("buildPauseAxis on the time axis", () => {
  test("squeezes a long stop into a fixed-width band", () => {
    const { time, paused } = ride(600, 3600);
    const axis = buildPauseAxis(time, paused, false);
    expect(axis.stops).toEqual([{ x: 600, width: STOP_BAND_SECONDS, seconds: 3600 }]);
    // The hour-long stop now takes two minutes of axis.
    expect(axis.x[axis.x.length - 1]).toBe(1199 + STOP_BAND_SECONDS);
  });

  test("labels read as riding time, skipping the band", () => {
    const { time, paused } = ride(600, 3600);
    const axis = buildPauseAxis(time, paused, false);
    const last = axis.x[axis.x.length - 1];
    expect(axis.toRiding(last)).toBe(1199);
    expect(axis.toRiding(300)).toBe(300);
  });

  test("closes up a short stop with no band", () => {
    const { time, paused } = ride(600, 20);
    const axis = buildPauseAxis(time, paused, false);
    expect(axis.stops).toEqual([]);
    expect(axis.x[axis.x.length - 1]).toBe(1199);
  });

  test("keeps every sample, hides the filler, and stays ascending", () => {
    const { time, paused } = ride(600, 3600);
    const axis = buildPauseAxis(time, paused, false);
    expect(axis.x.length).toBe(time.length);
    expect(axis.hidden?.[600]).toBe(1);
    expect(axis.hidden?.[599]).toBe(0);
    expect(axis.stopSeconds?.[1000]).toBe(3600);
    for (let i = 1; i < axis.x.length; i++) expect(axis.x[i]).toBeGreaterThanOrEqual(axis.x[i - 1]);
  });

  test("is the plain clock when nothing paused", () => {
    const time = Float64Array.from({ length: 100 }, (_, i) => i);
    const axis = buildPauseAxis(time, new Uint8Array(100), false);
    expect(axis.x).toBe(time);
    expect(axis.hidden).toBeNull();
  });
});

describe("buildPauseAxis on the distance axis", () => {
  test("leaves distance alone and marks the stop where it happened", () => {
    const { paused } = ride(600, 3600);
    const distance = Float64Array.from(paused, (_, i) => (i < 600 ? i * 5 : i < 4200 ? 3000 : 3000 + (i - 4199) * 5));
    const axis = buildPauseAxis(distance, paused, true);
    expect(axis.x).toBe(distance);
    expect(axis.stops).toEqual([{ x: 3000, width: 0, seconds: 3600 }]);
  });
});

test("formatStop", () => {
  expect(formatStop(420)).toBe("7 min");
  expect(formatStop(3900)).toBe("1h05");
});
