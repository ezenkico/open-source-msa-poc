# Live Measurement Refresh and Tailwind Dashboard Design

## Goal

Make the signed-in frontend refresh its authoritative measurement view when new
measurements arrive, including rows, total count, page count, and navigation
boundaries. Restyle the frontend as a responsive operational IoT dashboard with
Tailwind CSS while preserving authentication, permissions, provisioning,
pagination, and API contracts.

## Live Refresh Behavior

Every valid NATS measurement notification continues to update the latest-value
display immediately. It also schedules an authoritative refresh after 250 ms.
Additional notifications inside that window reset the timer, coalescing a burst
into one API refresh.

The refresh requests both the latest measurement and the currently selected
measurement page. The page query uses the current device ID, `limit`, `offset`,
and `order`. A successful response replaces the displayed rows and commits the
response metadata, especially `total`, so the numeric page count and Previous
and Next boundaries update immediately. This applies to every selected page and
both sort orders; historical pages are no longer held stable after a live event.

The existing authoritative-page correction remains responsible for count
changes that invalidate the selected offset. An empty result normalizes to page
1 of 1, while a nonempty collection whose total now has fewer pages is fetched
once at the last valid offset.

## Concurrency and Lifecycle

Live refreshes use the same request-generation safeguards as manual pagination.
A response is committed only if its device, offset, order, session, and request
generation are still current. A stale success or failure cannot replace current
state or surface an obsolete error.

Pending debounce timers are cancelled when the selected device changes, the
user signs out, the session expires, or the component unmounts. A refresh
failure keeps the last successful rows and pagination metadata visible and
shows a non-destructive error. A later notification can schedule another
refresh.

The debounce/timer lifecycle will live in a focused hook or helper rather than
adding unrelated state-machine responsibility to `App.tsx`.

## Visual Direction

The UI becomes a dark operational dashboard:

- A slate/navy application canvas with a centered, wide content area.
- A compact header containing product identity, live connection state,
  authenticated user context, and sign-out.
- A device panel with strong selected states, names and full device IDs, and an
  Add device action rendered only for authorized users.
- A main workspace with a prominent latest-reading card, supporting device and
  connection metadata, and a measurement-history card.
- The history card contains ordering, refresh feedback, the data table, numeric
  page status, and Previous/Next actions.
- Cyan and teal communicate live and healthy states. Amber and red are reserved
  for warnings and failures.

Tailwind CSS provides layout, spacing, typography, colors, focus rings,
responsive behavior, disabled states, and table overflow. No component library
or icon package is introduced. Small inline SVG marks are acceptable when they
have accessible text or are decorative.

On narrow viewports, the device panel stacks above the main workspace and the
measurement table scrolls horizontally. All controls retain semantic labels,
keyboard operation, visible focus treatment, and existing accessible roles.

## Components and Scope

The existing authentication, device provisioning, device selection,
measurement API, and NATS subscription interfaces remain unchanged. Styling may
extract presentational components where that makes `App.tsx` easier to read,
but it must not change permissions or business behavior.

Tailwind is installed through the existing Vite frontend toolchain. The old
global stylesheet is reduced to base rules that complement Tailwind rather than
duplicating component styling.

## Testing

Frontend regression coverage must prove:

- A single notification schedules an authoritative refresh after 250 ms.
- A burst produces one refresh rather than one request per notification.
- The refresh uses the current device, offset, limit, and order.
- Successful refreshes replace the visible rows and update total and page count.
- Invalidated offsets follow the existing one-shot page correction behavior.
- Device changes, sign-out, session expiration, and unmount cancel pending work.
- Stale successes and failures are ignored.
- Current refresh failures preserve the last successful page and permit retry on
  a later notification.

Existing accessibility-oriented component tests remain valid or are updated to
assert the same user-facing semantics. The complete frontend test suite and
production build must pass. Backend, simulator, documentation, and Compose
checks are rerun to ensure the shared application remains healthy.

## Non-Goals

- Changing the measurements API or NATS message format.
- Adding charts, configurable themes, a component library, or an icon package.
- Changing authentication persistence, device permissions, or provisioning.
- Polling when no NATS event has arrived.
