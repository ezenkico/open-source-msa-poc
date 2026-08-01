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
  it.each([
    ["full ascending", [measurement(1), measurement(2)]],
    ["partial ascending", [measurement(1), measurement(2)]],
    ["full descending", [measurement(2), measurement(1)]],
    ["partial descending", [measurement(2), measurement(1)]],
  ])("updates latest while leaving the displayed %s page for authoritative refresh", (_case, rows) => {
    const result = mergeNotification(
      { latest: measurement(2), rows, missingRange: null },
      measurement(3),
    );

    expect(result.latest?.entry_index).toBe(3);
    expect(result.rows).toBe(rows);
    expect(result.missingRange).toBeNull();
  });

  it.each([
    ["full ascending", [measurement(1), measurement(2)]],
    ["partial ascending", [measurement(1), measurement(2)]],
    ["full descending", [measurement(2), measurement(1)]],
    ["partial descending", [measurement(2), measurement(1)]],
  ])("detects a gap while leaving the displayed %s page for authoritative refresh", (_case, rows) => {
    const result = mergeNotification(
      { latest: measurement(2), rows, missingRange: null },
      measurement(5),
    );

    expect(result.latest?.entry_index).toBe(5);
    expect(result.rows).toBe(rows);
    expect(result.missingRange).toEqual({ afterIndex: 2, throughIndex: 5 });
  });

  it("retains an outstanding missing range across later contiguous notifications", () => {
    const rows = [measurement(2), measurement(1)];
    const result = mergeNotification(
      {
        latest: measurement(5),
        rows,
        missingRange: { afterIndex: 2, throughIndex: 5 },
      },
      measurement(6),
    );

    expect(result.latest?.entry_index).toBe(6);
    expect(result.rows).toBe(rows);
    expect(result.missingRange).toEqual({ afterIndex: 2, throughIndex: 5 });
  });

  it("extends an outstanding missing range when another notification gap arrives", () => {
    const rows = [measurement(2), measurement(1)];
    const result = mergeNotification(
      {
        latest: measurement(5),
        rows,
        missingRange: { afterIndex: 2, throughIndex: 5 },
      },
      measurement(8),
    );

    expect(result.latest?.entry_index).toBe(8);
    expect(result.rows).toBe(rows);
    expect(result.missingRange).toEqual({ afterIndex: 2, throughIndex: 8 });
  });

  it("ignores duplicate and older notifications so latest never regresses", () => {
    const state = {
      latest: measurement(5),
      rows: [measurement(3), measurement(4), measurement(5)],
      missingRange: null,
    };

    expect(mergeNotification(state, measurement(5))).toEqual(state);
    expect(mergeNotification(state, measurement(4))).toEqual(state);
  });
});
