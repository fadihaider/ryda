import { describe, expect, test } from "vitest";
import { nextUtcMidnight, nextWindow, parsePair } from "./rate-limit";

describe("rate limit helpers", () => {
  test("parses a 15-minute,daily pair", () => {
    expect(parsePair("37,512")).toEqual([37, 512]);
    expect(parsePair(" 100 , 1000 ")).toEqual([100, 1000]);
    expect(parsePair(null)).toBeNull();
    expect(parsePair("garbage")).toBeNull();
  });

  test("the 15-minute window resets on the quarter hour", () => {
    expect(nextWindow(new Date("2026-11-04T10:07:12Z")).toISOString()).toBe(
      "2026-11-04T10:15:00.000Z",
    );
    expect(nextWindow(new Date("2026-11-04T10:45:00Z")).toISOString()).toBe(
      "2026-11-04T11:00:00.000Z",
    );
  });

  test("the daily window resets at midnight UTC", () => {
    expect(nextUtcMidnight(new Date("2026-11-04T23:59:00Z")).toISOString()).toBe(
      "2026-11-05T00:00:00.000Z",
    );
  });
});
