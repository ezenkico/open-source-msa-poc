# Architecture and Proof-of-Concept Boundaries

## Data and notification flow

The simulator sends one HMAC-SHA256-signed measurement per HTTP request through
Nginx to Django. Django verifies the signature over the exact request bytes,
validates the measurement, assigns the next per-device index, and commits it to
PostgreSQL. Only after commit does Django attempt to publish the complete stored
representation to `devices.<device-id>.measurements`.

PostgreSQL is authoritative. Core NATS is a recoverable notification channel,
not a data store: publish failure does not change a successful ingestion, and
notifications are neither retained nor replayed. The browser loads the latest
value and history from Django, then uses NATS WebSocket notifications for
low-latency updates.

If React observes an index gap, it requests the missing range using
`after_index` and `through_index`. It performs the same API reconciliation
after reconnecting. The table is a fixed page: when that page is full, a new
notification updates the latest measurement but does not mutate the displayed
rows. Entries are append-only in this proof of concept, so no insertion,
deletion, or reorder reconciliation is required.

## Separate trust identities

The system deliberately separates four identities:

- A device has a per-device shared key. It signs HTTP bodies and never
  authenticates to NATS.
- A browser first authenticates to Django and receives a short-lived NATS
  connection token. The resulting NATS identity may subscribe to
  `devices.*.measurements` and may not publish device measurements.
- Django uses a dedicated NATS publisher identity restricted to publishing
  `devices.*.measurements` and denied subscriptions.
- `nats-auth-redirect` uses the exempt auth-callout identity. It forwards the
  browser token to Django and signs NATS authorization responses with the
  configured account signer seed.

The redirect service behavior and exact `account`, `pub`, and `sub` JSON shape
are defined only by
[`docs/integrations/nats-auth-redirect.md`](integrations/nats-auth-redirect.md).

## Why MQTT is omitted

MQTT is often appropriate for constrained devices and production IoT fleets,
but the simulator here already has a small signed HTTP contract. Adding an MQTT
broker, device credentials, topic authorization, and an ingestion consumer
would obscure the goal: showing the speed with which established frameworks
and open-source services can form a working application. MQTT is a possible
future transport, not a missing requirement for this proof of concept.

## Why JetStream is omitted

JetStream provides durable streams, acknowledgement, replay, and consumer
state. Those guarantees are unnecessary here because PostgreSQL is committed
before notification and remains the source of truth. Core NATS supplies only a
real-time hint; the API recovers missed data. A production design that needs
durable event delivery or downstream consumers should evaluate JetStream or
another durable broker explicitly.

## Deployment boundary

The local Compose topology contains PostgreSQL, Django, NATS,
`nats-auth-redirect`, and Nginx. React is built into the Nginx image, so Node.js
is not an application runtime container. Only Nginx exposes a host port. It
serves React and proxies Django HTTP and NATS WebSocket traffic.

Local traffic is deliberately plaintext and suitable only for a trusted
developer machine. A real deployment must put TLS in front of Nginx (or
configure equivalent TLS termination), protect secrets with a secrets manager,
set production Django security settings, and define operational readiness,
backup, monitoring, and rotation procedures.

## Explicit production exclusions

This proof of concept does not provide:

- MQTT device connectivity;
- JetStream, durable notifications, acknowledgement, or event replay;
- protection against replay of an otherwise valid device HTTP request;
- certificate-based device identity, automated enrollment, or fleet
  management;
- OIDC or another external user identity provider;
- insertion, deletion, or reordering of measurements;
- analytics, alerts, retention policies, or data export;
- high availability, horizontal scaling, Kubernetes, backups, or disaster
  recovery;
- production TLS, rate limiting, audit logging, observability, or hardened
  secret management.

These omissions are intentional. The project demonstrates a compact,
replaceable architecture and rapid framework assembly, not a complete
production IoT service.
