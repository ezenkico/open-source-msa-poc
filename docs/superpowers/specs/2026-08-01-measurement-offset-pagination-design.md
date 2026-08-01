# Measurement Offset Pagination and Ordering Design

## Goal

Replace inferred measurement pagination with an authoritative offset-based API,
add ascending and descending index ordering to the frontend, display numeric
page position, and document the repository's device-key encryption-key helper.

Entry indexes are identifiers in an ordered stream, not evidence that another
page exists. Page availability will therefore be derived only from the API's
`total`, `limit`, and `offset` values.

## Measurement List Request

The authenticated measurement-list endpoint remains:

```text
GET /api/devices/{device_id}/measurements/
```

Normal pagination accepts:

- `limit`: integer from 1 through 200, default 50;
- `offset`: non-negative integer, default 0; and
- `order`: `asc` or `desc`, default `desc`.

Example:

```text
GET /api/devices/{device_id}/measurements/?limit=50&offset=100&order=desc
```

The request never supplies `total`. Django computes the total number of stored
measurements for the selected device.

`before_index` will be removed from the public query contract. It is replaced
by `offset` for user-facing pagination.

## Measurement List Response

Every successful measurement-list response uses this envelope:

```json
{
  "results": [],
  "total": 123,
  "limit": 50,
  "offset": 100,
  "order": "desc"
}
```

- `results` contains serialized measurements in the requested index order.
- `total` is computed by the API and is never accepted from the request.
- `limit`, `offset`, and `order` echo the validated effective request values.
- An offset at or beyond the total returns an empty `results` array while
  preserving the supplied offset and authoritative total.
- Unknown devices continue returning 404 and authentication behavior is
  unchanged.

Ordering is deterministic by `entry_index`. Ascending page 1 begins with the
oldest stored indexes. Descending page 1 begins with the newest stored indexes.
Missing indexes do not affect pagination calculations.

## Gap-Recovery Compatibility

The existing NATS gap-recovery request retains `after_index`,
`through_index`, and `limit`. Gap bounds cannot be combined with `offset`,
`order`, or `before_index`. Gap results always use ascending index order.

Gap responses use the same envelope shape:

```json
{
  "results": [],
  "total": 3,
  "limit": 50,
  "offset": 0,
  "order": "asc"
}
```

For gap recovery, `total` is the total number of measurements matching the
validated exclusive `after_index` and inclusive `through_index` range, before
applying `limit`. The frontend consumes `results`; the range total is useful
contract metadata but does not drive page controls.

## Frontend Pagination State

For the selected device, the frontend owns:

- `offset`, initially 0;
- `order`, initially `desc`;
- the latest response envelope; and
- a request generation that prevents stale responses from replacing current
  device, page, or ordering state.

Page calculations are:

```text
current page = floor(offset / limit) + 1
total pages = max(1, ceil(total / limit))
requested offset = (requested page - 1) * limit
```

The interface displays `Page X of Y`. Empty results display `Page 1 of 1`.

Controls are based only on response metadata:

- the newer/previous control is disabled when `offset === 0`;
- the older/next control is disabled when
  `offset + results.length >= total`;
- moving newer uses `max(0, offset - limit)`;
- moving older uses `offset + limit`; and
- controls remain disabled while a page request is pending.

No decision uses the lowest or highest entry index.

The ordering selector offers `Newest first` (`desc`) and `Oldest first`
(`asc`). Changing order resets offset to 0 and performs an authoritative read.
Changing devices also resets offset to 0 while retaining the selected ordering.

## Live Updates and Recovery

Live NATS notifications continue to update the latest-measurement display.
They do not insert into or reorder the currently displayed page. This keeps a
user's page stable while measurements arrive.

Gap recovery continues fetching the missing exclusive/inclusive index range.
It consumes `response.results` to complete recovery and clear the missing-range
state, but it does not rewrite the currently displayed paginated rows. A NATS
reconnect reloads the currently selected device using the active `limit`,
`offset`, and `order`, rather than silently returning to page 1.

If a page becomes empty because authoritative data changed and its offset is
beyond the new total, the frontend requests the last valid page using:

```text
max(0, (max(1, ceil(total / limit)) - 1) * limit)
```

This correction is generation-guarded so it cannot overwrite a newer device,
ordering, or page selection.

## Errors and Validation

- `offset` must fit a non-negative PostgreSQL bigint.
- `order` must be exactly `asc` or `desc`.
- `before_index` is rejected as an unexpected query parameter.
- `after_index` and `through_index` retain their current bigint and relationship
  validation.
- Gap bounds reject explicit `offset` or `order`, even when values equal their
  defaults.
- Repeated and unknown query parameters remain rejected.
- A failed page request retains the last successful page and reports an
  accessible API error.
- Stale successes and stale failures are ignored after device, page, or order
  changes.

## Encryption-Key Documentation

The README setup section will instruct users to generate
`DEVICE_KEY_ENCRYPTION_KEY` with:

```sh
python3 generate-encryption-key.py
```

It will state that the printed base64 value belongs in
`DEVICE_KEY_ENCRYPTION_KEY` in `.env`. This is Django's server-side 32-byte
AES-256 key-encryption key and must not be committed or supplied to the device
simulator.

The README will distinguish it from `DEVICE_KEY`, which is a per-device
provisioning/HMAC key returned once when a device is created and used by
`iot-device-sim.py`.

## Component Boundaries

- `MeasurementListQuerySerializer` validates pagination, ordering, and gap
  modes.
- `MeasurementListView` computes authoritative totals, applies ordering and
  slicing, and returns the response envelope.
- The frontend API client validates and returns the envelope.
- `App` owns current offset/order and page-navigation orchestration.
- Measurement-state helpers continue owning latest-notification and gap
  detection; gap recovery consumes the envelope's `results` without inserting
  them into the current page.

No unrelated device provisioning, authentication, or NATS authorization changes
are included.

## Verification

Backend tests will cover defaults, explicit offsets, totals, asc/desc ordering,
empty/out-of-range pages, missing indexes, invalid order/offset, repeated and
unknown parameters, removed `before_index`, forbidden pagination/gap
combinations, and gap-envelope totals.

Frontend API tests will cover the exact envelope, runtime validation of every
field, and extraction of gap results.

Frontend component tests will cover page calculations, both navigation
directions, first/last-page disabling, empty data, ordering reset, selected
device reset, current-page reconnect reload, out-of-range correction, pending
controls, failures retaining prior data, and stale response protection.

Documentation/deployment tests will verify the README names
`generate-encryption-key.py`, `DEVICE_KEY_ENCRYPTION_KEY`, and the distinction
from per-device `DEVICE_KEY`.

The complete Django, frontend, simulator, build, and Compose checks will run
after implementation.
