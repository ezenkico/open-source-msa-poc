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
): MeasurementState {
  if (state.latest && notification.entry_index <= state.latest.entry_index) {
    return state;
  }

  const latestIndex = state.latest?.entry_index;
  if (latestIndex !== undefined && notification.entry_index > latestIndex + 1) {
    return {
      ...state,
      latest: notification,
      missingRange: {
        afterIndex: state.missingRange?.afterIndex ?? latestIndex,
        throughIndex: notification.entry_index,
      },
    };
  }

  return { ...state, latest: notification };
}
