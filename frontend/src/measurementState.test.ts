import { describe, expect, it } from "vitest";
import { mergeNotification, type Measurement } from "./measurementState";

function measurement(entry_index: number): Measurement {
  return {
    device_id: "24e9a8e0-83d8-420a-a708-c7a0e89eb0cf",
    entry_index,
    measurement_name: "temperature",
    value: 20 + entry_index,
    measured_at: "2026-07-26T12:00:00Z",
    received_at: "2026-07-26T12:00:01Z",
  };
}

describe("mergeNotification", () => {
  it("updates latest but freezes a full table", () => {
    const result = mergeNotification(
      { latest: measurement(2), rows: [measurement(1), measurement(2)], missingRange: null },
      measurement(3),
      2,
    );

    expect(result.latest?.entry_index).toBe(3);
    expect(result.rows.map((row) => row.entry_index)).toEqual([1, 2]);
    expect(result.missingRange).toBeNull();
  });

  it("appends a contiguous notification when capacity remains", () => {
    const result = mergeNotification(
      { latest: measurement(1), rows: [measurement(1)], missingRange: null },
      measurement(2),
      3,
    );

    expect(result.rows.map((row) => row.entry_index)).toEqual([1, 2]);
  });

  it("requests an exclusive/inclusive range for a gap", () => {
    const result = mergeNotification(
      { latest: measurement(2), rows: [measurement(1), measurement(2)], missingRange: null },
      measurement(5),
      10,
    );

    expect(result.missingRange).toEqual({ afterIndex: 2, throughIndex: 5 });
  });

  it("ignores duplicate and older notifications so latest never regresses", () => {
    const state = {
      latest: measurement(5),
      rows: [measurement(3), measurement(4), measurement(5)],
      missingRange: null,
    };

    expect(mergeNotification(state, measurement(5), 10)).toEqual(state);
    expect(mergeNotification(state, measurement(4), 10)).toEqual(state);
  });
});
