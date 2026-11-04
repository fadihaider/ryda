import { describe, expect, test } from "vitest";
import { isCycling } from "@/lib/ingest/sport";
import {
  localDateFromStrava,
  NoStreamsError,
  sportFromStrava,
  streamsToRide,
  type StravaStreamSet,
  type StravaSummaryActivity,
} from "./convert";

const activity: StravaSummaryActivity = {
  id: 12_345_678_901,
  name: "Lachine canal loop",
  sport_type: "Ride",
  start_date: "2026-08-09T16:30:24Z",
  start_date_local: "2026-08-09T12:30:24Z",
  elapsed_time: 20,
  moving_time: 12,
  device_watts: false,
  device_name: "Geoid CC700",
};

/** 1 Hz for 10 s, a 10 s auto-pause, then 1 Hz again. */
function streams(): StravaStreamSet {
  const time = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 22];
  const distance = time.map((t) => (t < 20 ? t * 5 : 45 + (t - 20) * 5));
  return {
    time: { data: time },
    distance: { data: distance },
    altitude: { data: time.map(() => 12) },
    latlng: { data: time.map((t) => [45.5 + t * 1e-5, -73.55] as [number, number]) },
    velocity_smooth: { data: time.map(() => 5) },
    heartrate: { data: time.map(() => 120) },
    watts: { data: time.map(() => 300) },
  };
}

describe("sportFromStrava", () => {
  test("maps Strava's sport types onto the stored spelling", () => {
    expect(sportFromStrava("Ride")).toBe("ride");
    expect(sportFromStrava("GravelRide")).toBe("gravel_ride");
    expect(sportFromStrava("EBikeRide")).toBe("ebike_ride");
    expect(sportFromStrava("VirtualRide")).toBe("virtual_ride");
  });

  test("keeps the cycling classification working", () => {
    for (const t of ["Ride", "GravelRide", "MountainBikeRide", "VirtualRide", "EBikeRide"]) {
      expect(isCycling(sportFromStrava(t))).toBe(true);
    }
    for (const t of ["Walk", "Run", "Hike", "Swim"]) {
      expect(isCycling(sportFromStrava(t))).toBe(false);
    }
  });
});

describe("localDateFromStrava", () => {
  test("takes the wall-clock date, not the UTC one", () => {
    // 22:30 local in Montreal is already tomorrow in UTC.
    expect(localDateFromStrava("2026-08-09T22:30:00Z")).toBe("2026-08-09");
  });
});

describe("streamsToRide", () => {
  test("resamples onto 1 Hz and marks the pause", () => {
    const ride = streamsToRide(activity, streams());
    expect(ride.meta.n).toBe(23);
    expect(ride.streams.time.length).toBe(23);
    expect(ride.streams.latlng?.length).toBe(46);
    // Inside the gap the bike is held where it stopped.
    expect(ride.streams.paused?.[15]).toBe(1);
    expect(ride.streams.distance[15]).toBe(45);
    expect(ride.streams.paused?.[5]).toBe(0);
  });

  test("carries Strava's name, start and sport", () => {
    const ride = streamsToRide(activity, streams());
    expect(ride.name).toBe("Lachine canal loop");
    expect(ride.startedAt).toBe("2026-08-09T16:30:24.000Z");
    expect(ride.sport).toBe("ride");
    expect(ride.devices).toEqual(["Geoid CC700"]);
  });

  test("labels Strava's smoothed speed as derived", () => {
    expect(streamsToRide(activity, streams()).streams.speedIsDerived).toBe(true);
  });

  test("ignores watts Strava estimated", () => {
    const ride = streamsToRide(activity, streams());
    expect(ride.hasMeasuredPower).toBe(false);
    expect(ride.streams.power).toBeUndefined();
  });

  test("keeps watts from a power meter", () => {
    const ride = streamsToRide({ ...activity, device_watts: true }, streams());
    expect(ride.hasMeasuredPower).toBe(true);
    expect(ride.streams.power?.[3]).toBe(300);
  });

  test("never reports Strava's calories as the device's", () => {
    expect(streamsToRide(activity, streams()).reported.calories).toBeUndefined();
  });

  test("rejects an activity with no samples", () => {
    expect(() => streamsToRide(activity, {})).toThrow(NoStreamsError);
  });
});
