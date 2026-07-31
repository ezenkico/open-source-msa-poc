#!/bin/sh
set -eu

mkdir -p ./nats-keys

docker run --rm -it \
  -v "$PWD/nats-keys:/work" \
  -w /work \
  alpine:latest \
  sh -lc '
    apk add --no-cache curl >/dev/null
    curl -sf https://binaries.nats.dev/nats-io/nsc/v2@latest | sh >/dev/null
    ./nsc generate nkey --account > account-issuer.txt
    cat account-issuer.txt
  '
