# Real-Time IoT Framework Proof of Concept

This project demonstrates how quickly a credible real-time IoT experience can
be assembled from mature open-source services: Django, React, PostgreSQL, Core
NATS, `nats-auth-redirect`, and Nginx. It is intentionally small. A device
sends signed HTTP measurements, Django persists them, and a browser sees live
notifications while retaining an authoritative history API.

The broader pattern is more important than any one technology. AI-assisted
development can compose well-understood framework capabilities quickly, while
tests and explicit integration contracts define the boundaries that must be
verified. Django supplies authentication, an ORM, migrations, validation, and
an admin interface out of the box, so the proof of concept spends its effort
on the IoT-specific contracts instead of rebuilding common application
infrastructure.

## Architecture at a glance

```text
device simulator --HMAC HTTP--> Nginx --> Django --> PostgreSQL
                                           |
                                           +--best effort--> Core NATS
                                                               |
React <--static assets-- Nginx <--WebSocket notification--------+
  |
  +---------------- authenticated history/latest HTTP --> Django
```

PostgreSQL is the source of truth. Core NATS notifications are transient;
React recovers missed entries from Django's API. The simulator never connects
to NATS. See [the architecture guide](docs/architecture.md) and the
[`nats-auth-redirect` integration contract](docs/integrations/nats-auth-redirect.md).

MQTT and JetStream are deliberately omitted. This repository demonstrates
frameworks working together with open-source services; it is not a complete
production IoT platform. MQTT device connectivity, durable event streaming,
replay, and delivery guarantees would expand the demonstration without helping
its central goal.

## Prerequisites

- Docker Engine with Docker Compose v2
- Python 3.11 or newer for the simulator and smoke test
- Node.js 20 or newer only when running frontend tests outside Docker

Create the local environment file:

```sh
cp example.env .env
```

Replace every placeholder. Generate the 32-byte AES device-key encryption
key, for example, with:

```sh
openssl rand -base64 32
```

Generate an NATS account signer pair:

```sh
./get-issuer-key.sh
```

The first generated line is `ACCOUNT_SIGNER_SEED`; the second is
`ACCOUNT_SIGNER_PUB`. They are one matching account NKey pair. The output is
also stored in the ignored `nats-keys/` directory. Run this locally and copy
the values directly into `.env`. Never commit or share the seed. Also set
independent random values for the PostgreSQL, Django, NATS auth-user, and NATS
publisher credentials. Set `DJANGO_SUPERUSER_USERNAME`,
`DJANGO_SUPERUSER_PASSWORD`, and optionally `DJANGO_SUPERUSER_EMAIL` to create
a local staff account at container startup.

Never reuse values from examples or commit `.env`. If a real secret has ever
been committed or shared, remove it from use and rotate it; deleting it from
the current file is not sufficient.

## Run locally

Build and start the complete topology:

```sh
docker compose up --build -d
docker compose ps
```

Nginx is the only service that publishes a host port. Open
<http://localhost/> for the React application and sign in with the local staff
account. Django's administration interface is available at
<http://localhost/admin/>.

The local stack intentionally uses plaintext HTTP and WebSocket traffic. Use it
only on a trusted development machine. For a real deployment, place this Nginx
boundary behind a TLS-terminating reverse proxy or load balancer and apply the
other production controls described in the architecture guide.

## Provision a device

Obtain a Django access token and create a device through Nginx:

```sh
export E2E_STAFF_USERNAME='your-local-staff-user'
export E2E_STAFF_PASSWORD='your-local-staff-password'
export IOT_ACCESS_TOKEN="$(
  curl --fail --silent --show-error \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$E2E_STAFF_USERNAME\",\"password\":\"$E2E_STAFF_PASSWORD\"}" \
    http://localhost/api/auth/jwt/ |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["access"])'
)"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $IOT_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo-simulator"}' \
  http://localhost/api/devices/
```

The create response returns the device UUID and plaintext key exactly once.
Store the key securely. Django stores only an AES-256-GCM-encrypted form.
Key rotation is available with:

```sh
curl --fail --silent --show-error -X POST \
  -H "Authorization: Bearer $IOT_ACCESS_TOKEN" \
  http://localhost/api/devices/DEVICE_UUID/rotate-key/
```

Rotation immediately invalidates the previous device key.

## Send a simulated measurement

Install the simulator dependency in an isolated environment:

```sh
python3 -m venv .venv
.venv/bin/pip install requests
```

Put the device ID and one-time key returned during provisioning in `.env` as
`DEVICE_ID` and `DEVICE_KEY`. Then run:

```sh
.venv/bin/python iot-device-sim.py \
  --url http://localhost/api/device-measurements/ \
  --name temperature \
  --value 21.7
```

`--device-id` and `--key` remain available as overrides, but storing
provisioned values in `.env` avoids exposing real credentials in shell history.
The simulator signs the exact JSON body with HMAC-SHA256 and communicates only
over HTTP.

In React, select the device to see its latest measurement and its current
history page. Live NATS notifications update the latest value. A full history
page remains fixed, and gaps or reconnects are recovered from the Django API.

## Verification

Backend:

```sh
cd django
python3 manage.py test -v 2
python3 manage.py check
python3 manage.py makemigrations --check
```

Frontend:

```sh
cd frontend
npm install
npm test
npm run build
```

Simulator and deployment contracts:

```sh
python3 -m unittest tests.test_iot_device_sim -v
sh scripts/test-compose.sh
docker compose config --quiet
```

End-to-end acceptance requires the running stack and configured staff
credentials. The script never prints device keys, signatures, or JWTs:

```sh
python3 -m venv .venv
.venv/bin/pip install -r scripts/e2e-requirements.txt
export E2E_STAFF_USERNAME='your-local-staff-user'
export E2E_STAFF_PASSWORD='your-local-staff-password'
.venv/bin/python scripts/e2e-smoke.py
```

Optional overrides are `IOT_BASE_URL` (default `http://localhost`) and
`IOT_NATS_WS_URL` (default `ws://localhost/nats`).

## Replacing Django

Django is the reference backend, not an architectural requirement. Flask,
FastAPI, Rails, Laravel, Spring Boot, ASP.NET Core, or another framework can
replace it if the replacement preserves the same contracts:

- staff-authenticated device provisioning and one-time key rotation;
- raw-body HMAC ingestion and per-device ordered persistence;
- authenticated device, latest, history, and gap-recovery APIs;
- the documented NATS authorization response;
- post-commit full-payload notifications on the per-device NATS subject.

That replaceable boundary is part of the design: choose a mature framework that
best fits the team, reuse what it already provides, and verify interoperability
at the contracts.
