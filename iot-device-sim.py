#!/usr/bin/env python3

import argparse
import base64
import hashlib
import hmac
import json
from datetime import datetime, timezone

import requests


def encode_measurement(name: str, value: float, measured_at: str) -> bytes:
    return json.dumps(
        {
            "measurement_name": name,
            "value": value,
            "measured_at": measured_at,
        },
        separators=(",", ":"),
    ).encode("utf-8")


def sign_body(key: bytes, body: bytes) -> str:
    digest = hmac.new(key, body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def send_measurement_response(
    url: str,
    device_id: str,
    key: bytes,
    name: str,
    value: float,
    measured_at: str,
) -> dict:
    body = encode_measurement(name, value, measured_at)
    return requests.post(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Device-ID": device_id,
            "X-Device-Signature": sign_body(key, body),
        },
        timeout=10,
    )


def send_measurement(
    url: str,
    device_id: str,
    key: bytes,
    name: str,
    value: float,
    measured_at: str,
) -> dict:
    response = send_measurement_response(
        url, device_id, key, name, value, measured_at
    )
    response.raise_for_status()
    return response.json()


def _current_utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Send one signed measurement to the IoT proof of concept."
    )
    parser.add_argument("--url", required=True)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--key", required=True, help="Base64 provisioning key")
    parser.add_argument("--name", required=True)
    parser.add_argument("--value", required=True, type=float)
    parser.add_argument("--measured-at")
    args = parser.parse_args()

    key = base64.b64decode(args.key, validate=True)
    result = send_measurement(
        args.url,
        args.device_id,
        key,
        args.name,
        args.value,
        args.measured_at or _current_utc_timestamp(),
    )
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
