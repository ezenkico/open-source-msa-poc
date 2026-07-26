# Task 8 Report: Unified Containers, NATS Accounts, and Nginx

## Status

Implemented the five-service root Compose topology and committed the Task 8
configuration. Nginx is the only host-published service and serves the built
React application while proxying Django HTTP and NATS WebSocket traffic.

## Changes

- Added image-time Django dependency installation and retained database setup,
  migrations, static collection, optional demo-user creation, and a
  one-Uvicorn-worker default.
- Added the multi-stage React build and Nginx runtime image with `/api/`,
  `/healthz`, `/nats`, and SPA routing.
- Added AUTH, APP, and SYS NATS accounts. The APP `publisher` can publish only
  `devices.*.measurements` and cannot subscribe. Dynamic callout users receive
  Django's subscribe-only APP permissions.
- Unified PostgreSQL, NATS, Django, redirect, and Nginx under one Compose
  network with startup health dependencies and a named PostgreSQL volume.
- Removed `django/docker-compose.yml`.
- Replaced committed usable example credentials with nonfunctional template
  values and pinned the existing redirect image by immutable digest.
- Added the Compose contract check, root Docker ignore rules, `.venv` and
  generated-data Git ignore rules, and a retained empty `django/staticfiles/`
  directory to eliminate the prior missing-static-directory warning.

## Red-Green Evidence

- Red: `sh scripts/test-compose.sh` exited 1 against the original topology;
  `docker compose config --services` listed only `nats`, `nats-redirect`, and
  `postgres`.
- Green: `sh scripts/test-compose.sh` passed after implementation.
- `docker compose config --quiet` passed, and rendered services were exactly
  `postgres`, `django`, `nats`, `nats-redirect`, and `nginx`.
- The rendered configuration contained the exact
  `AUTH_SERVER: http://django:8000/api/nats-auth/perms/`, one published host
  port (`80`), and no published `4222` or `8080`.
- Running the pinned `nats:2.14-scratch` image with
  `/nats-server -t -c /etc/nats/nats.conf` reported the mounted NATS
  configuration valid.
- `docker compose build` built both the Django image and the multi-stage
  React/Nginx image. The frontend production build transformed 33 modules and
  emitted the static bundle.
- `docker compose up -d` converged: PostgreSQL, NATS, and Django became
  healthy; redirect and Nginx started afterward.
- `docker compose ps` showed all five services up, only Nginx bound to the
  host (`0.0.0.0:80->80/tcp`), and no host binding for PostgreSQL, NATS,
  Django, or redirect.
- `curl --fail http://localhost/healthz` returned `{"status":"ok"}` and
  `curl --fail http://localhost/` returned the built React HTML.
- Startup logs showed NATS ready on Core NATS and no-TLS WebSocket listeners,
  redirect listening on `$SYS.REQ.USER.AUTH`, Django collecting 163 static
  files without the prior missing-directory warning, and `Workers: 1`.
- The Tasks 1-7 frontend baseline remained green: 4 files and 17 tests passed.
- Final `git diff --check` passed.

## Review Fix Verification

- Red: the strengthened Compose contract failed against the reviewed commit
  because it still rendered `nats:2.14-scratch` with the configuration-only
  `/nats-server -t` health check.
- Green: the NATS service now uses `nats:2.14-alpine`, whose included BusyBox
  `nc` probes the live Core NATS listener at `127.0.0.1:4222`.
- `docker compose up -d --wait --wait-timeout 30 nats` recreated the service
  and reported the container healthy.
- The Compose contract now requires exactly the five intended services and
  asserts the AUTH callout exemptions, AUTH account, APP publisher identity,
  publisher subject allowlist, subscriber denial, SYS account, and no-TLS
  WebSocket listener.

## Runtime Finding and Resolution

The prescribed `auth_users: [ "auth" ]` configuration did not permit the
static APP publisher to authenticate on NATS 2.14. Runtime logs proved NATS
sent the publisher connection through the auth callout; the redirect had no
client token to forward, Django returned 401, and the publisher was rejected.

The minimal correction was to exempt both statically configured users:
`auth_users: [ "auth", "publisher" ]`. The publisher remains in APP and its
publish-only permissions remain enforced by the APP user definition. Dynamic
browser token connections still go through the callout. NATS restarted with
the corrected configuration and returned to healthy status.

## Remaining Uncertainty and Concerns

- A pre-fix end-to-end probe proved the Django-issued browser token reached
  the exact permissions endpoint successfully and advanced through browser
  connection/subscription before blocking on publisher authentication. The
  process-level post-fix client probe did not return reliably through
  `docker compose exec` and was stopped by instruction. Therefore the final
  browser-receives-APP-publication assertion is not claimed, despite the
  corrected NATS config loading healthy.
- The local Django suite found 37 tests but could not run at baseline because
  localhost PostgreSQL was unavailable. It was not rerun after stack startup
  due the hard stop on further container commands.
- The pinned external redirect image logs decoded authentication request data,
  including bearer tokens. This behavior is outside this repository's Task 8
  configuration and should be addressed before any shared deployment.
- The local topology intentionally uses plaintext NATS passwords and no-TLS
  WebSocket transport exactly as scoped. NATS warns that both are unsuitable
  for production.
