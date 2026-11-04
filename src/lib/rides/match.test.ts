import { describe, expect, test } from "vitest";
import { rideId } from "@/lib/store/rides";
import { isSameRide } from "./match";

describe("isSameRide", () => {
  const file = { startedAt: "2026-08-09T16:30:24Z", durationSeconds: 15_929 };

  test("matches the same ride across a minute boundary the ids disagree on", () => {
    const strava = { startedAt: "2026-08-09T16:30:31Z", durationSeconds: 15_896 };
    expect(rideId(file.startedAt, file.durationSeconds)).not.toBe(
      rideId(strava.startedAt, strava.durationSeconds),
    );
    expect(isSameRide(file, strava)).toBe(true);
  });

  test("does not merge two rides on the same day", () => {
    const later = { startedAt: "2026-08-09T21:00:00Z", durationSeconds: 3_600 };
    expect(isSameRide(file, later)).toBe(false);
  });

  test("does not merge rides that start together but differ in length", () => {
    const shorter = { startedAt: file.startedAt, durationSeconds: file.durationSeconds - 600 };
    expect(isSameRide(file, shorter)).toBe(false);
  });
});
