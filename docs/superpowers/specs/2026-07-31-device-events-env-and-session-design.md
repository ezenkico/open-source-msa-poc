# Device Events, Simulator Environment, and Persistent Session Design

## Goal

Improve local setup and the browser experience without changing the proof of
concept's core architecture:

- document the repository's NATS account-key helper;
- let the simulator read device credentials from `.env`;
- notify signed-in browsers when a device is created; and
- retain a valid browser access token across page reloads and browser restarts.

PostgreSQL and Django's authenticated APIs remain authoritative. NATS events
remain transient, best-effort notifications that tell clients when to refresh
authoritative data.

## NATS Account-Key Setup Documentation

The README will direct users to run `./get-issuer-key.sh` after copying
`example.env` to `.env`. It will explain that the helper generates and prints a
matching account NKey pair, and that the two output values belong in
`ACCOUNT_SIGNER_SEED` and `ACCOUNT_SIGNER_PUB`.

The existing guidance not to commit or share the seed remains. The generated
`nats-keys` directory remains excluded from Git and Docker build contexts.

## Simulator Environment Configuration

`iot-device-sim.py` will read key-value pairs from the repository `.env` file
without adding a third-party dotenv dependency. Blank lines, comments, optional
`export` prefixes, and quoted values will be accepted. Existing process
environment variables take precedence over values from `.env`.

The simulator will use:

- `DEVICE_ID` as the default device identifier; and
- `DEVICE_KEY` as the default base64 provisioning key.

The existing `--device-id` and `--key` options remain available and take
precedence over environment values. Both values are still required after all
sources are resolved. Missing values and invalid base64 keys produce clear
command-line errors without printing secret material.

The measurement name and value remain command-line inputs. The URL retains its
existing command-line behavior and default.

## Device-Created Event

After a staff user successfully creates a device, Django will register a
post-commit callback that publishes a best-effort NATS message on
`devices.created`. A rolled-back database transaction must not emit the event.
Publishing failure must not fail or roll back device provisioning, matching the
existing measurement-notification reliability contract.

The event payload will contain the public `DeviceSerializer` representation of
the new device. It must never contain the one-time plaintext provisioning key,
encrypted key material, or nonce. Keeping a useful public payload makes the
event understandable to other listeners, although the frontend will treat it
only as an invalidation signal.

The browser's existing NATS authorization will permit subscribing to
`devices.created` in addition to per-device measurement subjects. Browser
clients remain unable to publish under `devices.>`.

## Frontend Device-List Refresh

After authentication, the frontend will maintain a NATS subscription to
`devices.created`. Each valid event causes the frontend to re-fetch
`/api/devices/` with the current access token. The returned list replaces local
device-list state, preserving Django's ordering and visibility rules.

The selected device remains selected when it is still present. The frontend
will clear the selection and measurement state if it is no longer present.
Overlapping refreshes must not let an older response replace a newer list, and
subscriptions will be closed when authentication ends or the component is
unmounted.

The existing per-device measurement subscription and recovery behavior remain
unchanged.

## Persistent Browser Session

After successful sign-in, the frontend stores only the access token in
`localStorage`. Passwords and short-lived NATS tokens are never persisted.

On application startup, the frontend reads the stored token and decodes its JWT
payload locally to inspect the numeric `exp` claim. This is an expiration check,
not signature validation. A missing, malformed, or expired token is deleted and
the sign-in form is shown. A token that appears current is then validated by
calling the authenticated device-list endpoint before the signed-in interface
is shown.

If startup validation rejects the token, the frontend deletes it and returns to
the sign-in form. Authentication failures encountered during later device-list
refreshes also clear the stored session. Other transient API or NATS failures
are displayed without discarding a still-valid access token.

The stored token naturally persists until Django's configured JWT expiration,
which is currently 30 days. This change does not add refresh-token handling or
extend the backend token lifetime.

## Error Handling and Security

- NATS publication is best effort and does not change successful API results.
- Device-list refresh failures retain the last successful list unless the API
  reports that authentication is invalid.
- Event parsing rejects malformed payloads and surfaces the connection error
  through the existing frontend error path.
- Secret device keys never appear in NATS events, browser storage, logs, or
  simulator error messages.
- `localStorage` has the usual exposure to same-origin script execution. This
  design follows the explicit persistence requirement and keeps the stored
  material limited to the access token.

## Verification

Automated tests will verify:

- `.env`, process-environment, and command-line precedence in the simulator;
- clear failure when `DEVICE_ID` or `DEVICE_KEY` is unavailable;
- post-commit publication on `devices.created`, payload shape, and key absence;
- NATS permission and frontend subscription behavior for the new subject;
- authoritative device-list refresh and stale-response protection;
- successful access-token storage and startup restoration;
- removal of malformed, expired, and backend-rejected stored tokens; and
- continued measurement-notification behavior.

The existing backend, frontend, simulator, compose-contract, and build checks
will be run after implementation.
