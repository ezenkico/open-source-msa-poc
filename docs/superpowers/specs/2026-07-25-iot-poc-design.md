# Real-Time IoT Proof-of-Concept Design

## Purpose

This proof of concept demonstrates how Django, React, PostgreSQL, NATS,
`nats-auth-redirect`, Nginx, and a device simulator can be assembled into a
small real-time IoT system.

It is an integration demonstration, not a production IoT platform. PostgreSQL
is the authoritative measurement store. Core NATS carries ephemeral
notifications that tell the browser new data is available.

## Scope

The proof of concept includes:

- staff-controlled device provisioning and key rotation;
- signed HTTP ingestion of one measurement per request;
- durable measurement storage in PostgreSQL;
- per-device ordering;
- authenticated historical and latest-measurement APIs;
- browser authentication through the NATS auth-callout flow;
- ephemeral real-time notifications over NATS WebSocket;
- a minimal static React application;
- a single local Docker Compose topology behind Nginx.

The following are deliberately outside scope:

- MQTT;
- JetStream or another durable message queue;
- replay protection for device requests;
- OIDC, Keycloak, or external identity providers;
- device fleets, certificates, or automated device enrollment;
- deletion, insertion, or reordering of measurements;
- Kubernetes, high availability, or production scaling;
- production TLS configuration;
- analytics, alerting, and data-retention policies.

The README and relevant integration documentation must state that MQTT and
JetStream are omitted because this project demonstrates frameworks integrating
with open-source services rather than a complete production application.

## System Architecture

The device-data flow is:

1. The simulator sends one HMAC-signed HTTP measurement to Nginx.
2. Nginx proxies the request to Django.
3. Django verifies the signature, validates the body, assigns ordering and
   receipt metadata, and stores the measurement in PostgreSQL.
4. After the database transaction commits, Django attempts to publish an
   ephemeral notification to Core NATS.
5. NATS delivers the notification through its WebSocket listener, proxied by
   Nginx, to React.
6. React uses Django's APIs as the authoritative source for initial data,
   pagination, gap recovery, and reconnect recovery.

The browser authentication flow is:

1. The browser authenticates with Django.
2. Django issues a short-lived NATS connection token.
3. The browser connects to NATS WebSocket with that token.
4. NATS sends an authorization-request JWT to `nats-auth-redirect`.
5. The redirect service calls Django's authorization endpoint with the
   connection token as a Bearer token.
6. Django validates the token and returns an account plus subscribe-only
   permissions matching the redirect service's documented JSON contract.
7. The redirect signs the NATS authorization response.
8. NATS accepts or rejects the browser connection.

The simulator never connects to NATS.

## Components and Responsibilities

### Nginx

Nginx is the only host-exposed application entry point. It:

- serves the compiled React assets;
- proxies Django API requests;
- proxies NATS WebSocket upgrade requests.

The local deployment uses HTTP and unencrypted WebSocket traffic. A deployment
may add TLS by placing a TLS-terminating reverse proxy or load balancer in front
of Nginx.

### Django

Django:

- authenticates users and staff;
- provisions devices and rotates device keys;
- verifies signed device requests;
- assigns per-device entry indexes;
- persists measurements;
- exposes device, latest-measurement, history, and gap-recovery APIs;
- issues short-lived NATS connection tokens;
- returns NATS authorization decisions in the external redirect service's
  documented response shape;
- publishes best-effort Core NATS notifications after database commit.

Django does not consume device data from NATS and does not use JetStream.

### PostgreSQL

PostgreSQL is the source of truth for devices, encrypted device keys, device
counters, and measurements.

### NATS

Core NATS carries transient measurement notifications. It does not store or
replay measurement events. Missed notifications are recovered through Django's
HTTP APIs.

### `nats-auth-redirect`

The external redirect service performs only the behavior defined by
`docs/integrations/nats-auth-redirect.md`. Django must return exactly its
documented top-level `account`, `pub`, and `sub` response structure. The
redirect service signs the resulting NATS authorization response.

### React

React is compiled to static files and served by Nginx. Node.js is a build-time
dependency only and is not present as an application runtime container.

The application displays one selected device at a time, including:

- the newest measurement regardless of measurement name;
- a fixed-size, paginated table containing all measurement names;
- live notification handling and API-based gap recovery.

### Device simulator

The simulator sends signed HTTP measurements. It holds a device ID and the
plaintext key returned during provisioning. It has no NATS credentials.

## Data Model

### Device

A device contains:

- a stable UUID device ID represented as lowercase canonical text;
- a human-readable name;
- encrypted device-key ciphertext;
- the random AES-GCM nonce used for that ciphertext;
- a `next_entry_index` counter;
- creation and update timestamps;
- an enabled/disabled state.

The canonical UUID text is safe for use as one NATS subject token.

### Measurement

A measurement contains:

- device foreign key;
- per-device `entry_index`;
- `measurement_name`;
- floating-point `value`;
- device-provided `measured_at`;
- Django-assigned `received_at`.

The database enforces uniqueness on `(device_id, entry_index)`. Indexes begin
at 1 and increase monotonically within each device. Entries are not deleted,
inserted between existing entries, or reordered in this proof of concept.

## Device Key Management

Only authenticated Django staff users may create devices or rotate keys.

On creation or rotation, Django:

1. generates a cryptographically random device key;
2. returns the plaintext key once in the successful API response;
3. encrypts the key with AES-256-GCM;
4. generates a fresh random nonce for every encryption;
5. stores the ciphertext and nonce with the device.

The 256-bit AES master key is supplied through an environment variable. No
fixed IV is used. The plaintext device key is never stored and cannot be
retrieved later. Rotation immediately replaces the stored key, invalidating
the previous key.

## Signed Measurement Ingestion

The ingestion request is:

```http
POST /api/device-measurements/
X-Device-ID: <device-id>
X-Device-Signature: sha256=<hex-hmac>
Content-Type: application/json
```

The body represents exactly one measurement:

```json
{
  "measurement_name": "temperature",
  "value": 21.7,
  "measured_at": "2026-07-25T18:30:00Z"
}
```

The signature is HMAC-SHA256 over the exact raw request body using the
device's decrypted shared key. Django:

1. resolves the device from `X-Device-ID`;
2. decrypts its key;
3. verifies the signature with a constant-time comparison;
4. parses and validates JSON only after signature verification;
5. rejects disabled or unknown devices;
6. validates that `value` is a finite floating-point number and
   `measured_at` is timezone-aware;
7. locks the device counter, assigns the next index, and stores the
   measurement atomically;
8. schedules the NATS publish after a successful transaction commit.

Replay detection is deliberately out of scope.

## Notification Contract

The notification subject is:

```text
devices.<device-id>.measurements
```

The notification contains the complete stored representation:

```json
{
  "device_id": "<device-id>",
  "entry_index": 42,
  "measurement_name": "temperature",
  "value": 21.7,
  "measured_at": "2026-07-25T18:30:00Z",
  "received_at": "2026-07-25T18:30:01Z"
}
```

Publishing is best effort and occurs only after database commit. If publishing
fails, Django still returns a successful ingestion response. Per the approved
scope, publish failures are not logged. PostgreSQL remains authoritative, and
React recovers through the API.

## NATS Accounts and Permissions

The NATS configuration separates these identities:

- redirect auth user: exempt user in the `AUTH` account, used only by
  `nats-auth-redirect`;
- Django publisher: internal credential in the `APP` account with publish-only
  access to `devices.*.measurements`;
- browser: auth-callout-authorized connection in the `APP` account with
  subscribe-only access to `devices.*.measurements`;
- device simulator: no NATS identity.

The Django authorization response must follow the integration contract:

```json
{
  "account": "APP",
  "pub": {
    "allow": [],
    "deny": ["devices.>"]
  },
  "sub": {
    "allow": ["devices.*.measurements"],
    "deny": []
  }
}
```

All authenticated browser users may subscribe to all device measurement
subjects in this proof of concept. Device-level browser authorization is
outside scope.

## HTTP API

The API surface is:

- `POST /api/devices/`: staff-only device creation, returning the initial
  plaintext key once;
- `POST /api/devices/<device-id>/rotate-key/`: staff-only key rotation,
  returning the replacement key once;
- `GET /api/devices/`: authenticated device listing for browser selection;
- `POST /api/device-measurements/`: signed device measurement ingestion;
- `GET /api/devices/<device-id>/measurements/latest/`: authenticated latest
  measurement;
- `GET /api/devices/<device-id>/measurements/`: authenticated pagination and
  missing-range retrieval;
- `GET /api/nats-auth/token/`: authenticated short-lived NATS token issuance;
- `GET /api/nats-auth/perms/`: redirect-service authorization lookup.

Index-based cursors or explicit index bounds must be used instead of offset
pagination. Measurement-list results are ordered by ascending `entry_index`.
With no bounds, the endpoint returns the newest page. `before_index` loads rows
strictly before an index. Gap recovery uses `after_index` as an exclusive lower
bound and `through_index` as an inclusive upper bound. `limit` caps every
response. `before_index` cannot be combined with `after_index` or
`through_index`.

## React Behavior

The application loads one selected device at a time.

On initial selection, it:

1. fetches the latest measurement;
2. fetches one fixed-size table page;
3. subscribes to that device's NATS subject.

For each notification:

- the latest-measurement display updates from the notification payload;
- if the table page is already full, the table is not changed;
- if the table has capacity and the next index is contiguous, the new row is
  appended;
- if the table has capacity and the index reveals a gap, React retrieves the
  missing range from Django and fills rows up to the page capacity.

Changing the selected device discards the previous device's live state and
subscription before loading and subscribing to the new device.

After a NATS disconnect and reconnect, React fetches authoritative state from
Django rather than assuming all notifications were received.

## Deployment

One root Docker Compose file defines:

- Nginx;
- Django;
- PostgreSQL;
- NATS;
- `nats-auth-redirect`.

The separate Django Compose file is removed after its service is incorporated
into the root topology. Nginx is the only application service exposed to the
host. Internal service ports remain on the Compose network.

The redirect service receives:

- the exact Django authorization endpoint as `AUTH_SERVER`;
- the trusted account signer seed;
- a NATS URL containing its exempt auth-user credentials;
- a restart policy because initial NATS connection failure terminates the
  service according to the integration contract.

Startup dependencies do not imply readiness. The local deployment must use
health checks, retry behavior, or restart policies sufficient for the complete
Compose stack to converge after a normal startup.

Local example secrets are disposable. Documentation must warn that committed
or example signer material and passwords are unsuitable for any shared or
production environment.

## Error Handling

- Invalid device IDs, disabled devices, malformed signatures, invalid JSON,
  invalid measurement values, and invalid timestamps produce explicit HTTP
  errors and do not create measurements.
- Counter allocation and measurement creation occur in one transaction.
- A failed database transaction does not publish a notification.
- A failed NATS publish does not change the successful ingestion response and
  is not logged.
- Invalid or expired browser NATS tokens produce authorization denial through
  the redirect contract.
- React reports API failures in the UI and can retry authoritative reads.

## Verification

Focused automated tests must cover:

- device creation and staff-only access;
- one-time plaintext-key responses;
- key rotation invalidating the previous key;
- AES-GCM nonce uniqueness;
- valid and invalid HMAC signatures over exact raw bodies;
- disabled and unknown devices;
- per-device counter independence and concurrent index allocation;
- measurement validation and persistence;
- no publish before transaction commit;
- successful ingestion despite NATS publish failure;
- the exact redirect-service authorization response schema;
- browser subscribe permission and publish denial;
- latest, pagination, and missing-range APIs;
- React full-page, contiguous-update, gap-recovery, device-switch, and reconnect
  behavior;
- an end-to-end local flow from signed simulator request through React update.

## Completion Criteria

The proof of concept is complete when a clean local Compose startup allows an
operator to:

1. authenticate as a staff user;
2. provision a device and receive its key;
3. configure and run the simulator with that key;
4. select the device in React;
5. observe signed measurements persist in PostgreSQL;
6. see the latest measurement update through a NATS WebSocket notification;
7. browse stable historical pages from Django;
8. demonstrate API-based recovery after a missed notification;
9. rotate the device key and verify the previous key is rejected.
