# Container and System Integration Guide

This guide is a handoff for engineers and coding agents integrating
`nats-auth-redirect` into a larger system. It covers the container boundary,
NATS auth-callout wiring, the HTTP authorization API, and reference Docker
Compose and Kubernetes deployments.

For implementation details, also read:

- [Architecture](architecture.md)
- [Configuration](configuration.md)
- [Authentication flow](authentication-flow.md)
- [Deployment](deployment.md)

## Integration contract

```mermaid
flowchart LR
    C[NATS client] -->|connect token| N[NATS server]
    N -->|authorization-request JWT| R[nats-auth-redirect container]
    R -->|GET with Bearer token| A[HTTP authorization API]
    A -->|account and permissions JSON| R
    R -->|signed authorization-response JWT| N
    N -->|accept or reject| C
```

The redirect container is not an HTTP server and exposes no port. It makes two
outbound connections:

1. a persistent NATS connection to `NATS_URL`;
2. one HTTP GET to `AUTH_SERVER` for each decoded authentication request.

The surrounding system must provide:

- a NATS server configured for auth callout;
- an account-signing NKey pair;
- credentials allowing the redirect service to connect as an auth user;
- a reachable HTTP authorization API;
- secure injection of the account signer seed.

## Values shared across components

| Value | NATS server | Redirect container | HTTP API |
|---|---|---|---|
| Account signer public key | Configured as the auth-callout `issuer` | Derived from the signer seed | Not required |
| Account signer seed | Never required | `ACCOUNT_SIGNER_SEED` | Never required |
| Auth-user credentials | Defines the exempt auth user | Included in `NATS_URL` | Not required |
| Client connection token | Included in auth request | Forwarded as Bearer token | Validates it |
| Authorized account and permissions | Consumes signed claims | Encodes the API response | Returns them |

The public key configured in NATS must match the private account signer seed
supplied to the redirect container. If they do not match, NATS cannot trust the
signed response.

## Container image

Build the repository image:

```sh
docker build -t registry.example.com/platform/nats-auth-redirect:<version> .
docker push registry.example.com/platform/nats-auth-redirect:<version>
```

The runtime image:

- runs `/runner` as a non-root user;
- listens on no network port;
- requires no persistent volume;
- loads configuration from environment variables;
- contains no implemented health endpoint.

Use an immutable version or digest in production. Do not use the development
credentials or signer material found in repository examples.

## Redirect container environment

```dotenv
AUTH_SERVER=https://authorization-api.example.internal/v1/nats/authorize
ACCOUNT_SIGNER_SEED=<account-signing-seed>
NATS_URL=tls://auth:<password>@nats.example.internal:4222
```

`AUTH_SERVER` must be non-empty or the process exits without starting the NATS
listener. The current implementation does not explicitly validate the signer
seed or NATS URL before attempting to use them.

The service uses `http.DefaultClient` without an explicit timeout. A deployment
platform should therefore detect stuck instances externally, but a platform
probe cannot cancel an individual blocked HTTP request.

## NATS auth-callout configuration

The repository supports the following development configuration pattern:

```hcl
authorization {
  auth_callout {
    issuer: <account-signer-public-key>
    account: AUTH
    auth_users: [ "auth" ]
  }
}

accounts {
  AUTH: {
    users: [
      { user: "auth", password: "<auth-user-password>" }
    ]
  }
  APP: {}
  SYS: {}
}

system_account: SYS
```

Integration requirements:

- `issuer` is the public key corresponding to `ACCOUNT_SIGNER_SEED`.
- The redirect's `NATS_URL` authenticates as a user listed in `auth_users`.
- The NATS system account is configured because auth-callout requests use the
  `$SYS.REQ.USER.AUTH` subject.
- Accounts returned by the HTTP API should exist in the deployed NATS account
  model. The repository does not test behavior for an unknown account.

The service queue-subscribes as `auth-workers`. Multiple replicas using the
same NATS deployment share auth requests through that queue group.

## HTTP authorization API

For every decoded NATS auth request, the service sends:

```http
GET /v1/nats/authorize HTTP/1.1
Host: authorization-api.example.internal
Authorization: Bearer <client-connection-token>
```

It sends no request body. The API returns JSON matching the Go
`ResponseData` type:

```json
{
  "account": "APP",
  "pub": {
    "allow": ["events.>"],
    "deny": ["events.internal.>"]
  },
  "sub": {
    "allow": ["requests"],
    "deny": []
  }
}
```

`pub` and `sub` are optional. The service does not locally validate the account
or permission subjects.

Observed status handling:

- status codes through 300 are decoded as authorization responses;
- status codes greater than 300 produce a signed denial whose error is
  `invalid token`;
- transport, body-read, and JSON-decode failures also produce signed denials.

Accepting status 300 may be unintended and is not covered by tests. Do not
design an API that relies on redirects.

## Docker Compose reference

This example adds the two components missing from the repository's existing
compose file. It is a reference topology, not a checked-in runnable manifest:

```yaml
services:
  nats:
    image: nats:<pinned-version>
    command: ["-c", "/etc/nats/nats.conf"]
    ports:
      - "4222:4222"
    volumes:
      - ./nats.conf:/etc/nats/nats.conf:ro
    networks: [auth]

  authorization-api:
    image: registry.example.com/platform/authorization-api:<version>
    networks: [auth]

  nats-auth-redirect:
    image: registry.example.com/platform/nats-auth-redirect:<version>
    depends_on:
      - nats
      - authorization-api
    environment:
      AUTH_SERVER: http://authorization-api:8000/v1/nats/authorize
      NATS_URL: nats://auth:${NATS_AUTH_PASSWORD}@nats:4222
      ACCOUNT_SIGNER_SEED: ${ACCOUNT_SIGNER_SEED}
    restart: unless-stopped
    networks: [auth]

networks:
  auth: {}
```

Store `NATS_AUTH_PASSWORD` and `ACCOUNT_SIGNER_SEED` outside the compose file.
`depends_on` controls start order but does not establish readiness. The NATS
client reconnects indefinitely after a connection is established, but an
initial connection failure terminates the redirect process through `must`.
The restart policy in this reference example compensates for that observed
startup behavior.

## Kubernetes reference

The following manifests show the redirect service's integration boundary.
They assume NATS and the HTTP API already have stable Kubernetes Services.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: nats-auth-redirect
  namespace: auth-system
type: Opaque
stringData:
  account-signer-seed: "<account-signing-seed>"
  nats-url: "tls://auth:<password>@nats.auth-system.svc:4222"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: nats-auth-redirect
  namespace: auth-system
data:
  auth-server: "https://authorization-api.auth-system.svc/v1/nats/authorize"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nats-auth-redirect
  namespace: auth-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: nats-auth-redirect
  template:
    metadata:
      labels:
        app: nats-auth-redirect
    spec:
      containers:
        - name: redirect
          image: registry.example.com/platform/nats-auth-redirect:<version>
          env:
            - name: AUTH_SERVER
              valueFrom:
                configMapKeyRef:
                  name: nats-auth-redirect
                  key: auth-server
            - name: ACCOUNT_SIGNER_SEED
              valueFrom:
                secretKeyRef:
                  name: nats-auth-redirect
                  key: account-signer-seed
            - name: NATS_URL
              valueFrom:
                secretKeyRef:
                  name: nats-auth-redirect
                  key: nats-url
          resources:
            requests:
              cpu: 25m
              memory: 32Mi
            limits:
              memory: 128Mi
```

The resource values are starting recommendations, not repository-derived
capacity requirements. Benchmark with the expected authentication rate.

No liveness or readiness probe is shown because the container exposes no
health endpoint and process liveness does not prove NATS or API readiness.
Use external synthetic authentication monitoring until the application
implements a meaningful health contract.

A restrictive NetworkPolicy should allow the pod to reach only:

- the NATS client port;
- the authorization API port;
- DNS and any required certificate/revocation services.

The exact NetworkPolicy is cluster- and CNI-specific and is therefore not
invented here.

## Startup and scaling

Recommended startup order:

1. provision the signer key pair and secrets;
2. deploy/configure the target NATS accounts;
3. configure NATS auth callout with the signer public key;
4. start NATS;
5. start the HTTP authorization API;
6. start one redirect replica;
7. validate authentication;
8. increase replica count if required.

All replicas must use signer seeds trusted by the same NATS configuration and
must reach an API with the same authorization policy. Queue group
`auth-workers` distributes requests across replicas. The repository has no
load, failover, or rolling-deployment tests.

## End-to-end validation

Validate in a non-production environment with a disposable token:

1. Confirm the redirect logs that it is listening on
   `$SYS.REQ.USER.AUTH`.
2. Connect a NATS client using token authentication.
3. Confirm the HTTP API receives a GET with the token as a Bearer credential.
4. Return a known account and narrowly scoped permissions.
5. Confirm the NATS connection succeeds.
6. Confirm an allowed publish or subscription succeeds.
7. Confirm a denied subject is rejected.
8. Repeat with an invalid token and confirm NATS rejects the connection.
9. Stop one redirect replica and confirm another processes new requests.

Repository clients provide partial examples but not a complete automated
acceptance test. Avoid capturing real tokens or JWTs in test output.

## Troubleshooting

| Symptom | Check |
|---|---|
| Container prints `No listener specified` and exits | `AUTH_SERVER` is absent or empty. |
| Container exits during startup | Validate the signer seed and initial NATS connectivity. |
| NATS rejects every response | Verify the auth-callout issuer matches the signer's public key. |
| API never receives requests | Check NATS auth-callout configuration, auth-user credentials, `$SYS` routing, and redirect logs. |
| API returns success but permissions are absent | Return top-level `pub` and `sub`; the nested `perms` shape in `server.py` is ignored. |
| Requests hang | Check API reachability; the service has no explicit HTTP timeout. |
| Some failures appear as malformed auth replies | Several early failure paths publish plain JSON rather than signed response JWTs. |
| Multiple replicas do not each see every request | Queue group behavior intentionally assigns a request to one worker. |

## Security checklist

- [ ] The signer seed is stored only in a secret-management system.
- [ ] The NATS issuer public key matches the deployed signer seed.
- [ ] Example usernames and passwords have been replaced.
- [ ] NATS and the authorization API use encrypted transport.
- [ ] Network policy limits redirect-container egress.
- [ ] Logs are access-controlled and do not enter a broadly accessible sink.
- [ ] The API validates tokens and returns least-privilege permissions.
- [ ] Images are pinned, scanned, and obtained from a trusted registry.
- [ ] Synthetic tests cover acceptance, denial, and replica failover.

## Known integration gaps

- The repository has no automated unit or end-to-end tests.
- The container has no health endpoint or graceful-shutdown handling.
- HTTP requests have no explicit timeout, retry, or response-size limit.
- The example HTTP server's permission shape differs from the Go API contract.
- Status 300 is accepted; the intended status policy is unclear.
- Some errors are plain JSON rather than signed authorization responses.
- Runtime resource requirements and scaling limits are not established.
