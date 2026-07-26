export type Measurement = {
  device_id: string;
  entry_index: number;
  measurement_name: string;
  value: number;
  measured_at: string;
  received_at: string;
};

export type MissingRange = {
  afterIndex: number;
  throughIndex: number;
};

export type MeasurementState = {
  latest: Measurement | null;
  rows: Measurement[];
  missingRange: MissingRange | null;
};

export function mergeNotification(
  state: MeasurementState,
  notification: Measurement,
  capacity: number,
): MeasurementState {
  if (state.latest && notification.entry_index <= state.latest.entry_index) {
    return state;
  }

  if (state.rows.length >= capacity) {
    return { ...state, latest: notification, missingRange: null };
  }

  const lastIndex = state.rows.at(-1)?.entry_index ?? 0;
  if (notification.entry_index === lastIndex + 1) {
    return {
      latest: notification,
      rows: [...state.rows, notification],
      missingRange: null,
    };
  }

  if (notification.entry_index > lastIndex + 1) {
    return {
      ...state,
      latest: notification,
      missingRange: {
        afterIndex: lastIndex,
        throughIndex: notification.entry_index,
      },
    };
  }

  return { ...state, latest: notification, missingRange: null };
}
