#!/usr/bin/env python3

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import os
import shlex
from datetime import datetime, timezone
from pathlib import Path
from typing import MutableMapping

import requests


def load_dotenv(path: Path, environ: MutableMapping[str, str]) -> None:
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line.removeprefix("export ")
        if "=" not in line:
            continue

        name, value = line.split("=", 1)
        values = shlex.split(value, comments=True)
        if len(values) == 1:
            environ.setdefault(name.strip(), values[0])


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
    dotenv_path = Path(__file__).resolve().parent / ".env"
    if dotenv_path.exists():
        load_dotenv(dotenv_path, os.environ)

    parser = argparse.ArgumentParser(
        description="Send one signed measurement to the IoT proof of concept."
    )
    parser.add_argument("--url", default="http://localhost")
    parser.add_argument("--device-id", default=os.environ.get("DEVICE_ID"))
    parser.add_argument(
        "--key", default=os.environ.get("DEVICE_KEY_ENCRYPTION_KEY"), help="Base64 provisioning key"
    )
    parser.add_argument("--name", required=True)
    parser.add_argument("--value", required=True, type=float)
    parser.add_argument("--measured-at")
    args = parser.parse_args()

    missing_credentials = []
    if not args.device_id:
        missing_credentials.append("--device-id or DEVICE_ID")
    if not args.key:
        missing_credentials.append("--key or DEVICE_KEY")
    if missing_credentials:
        parser.error("; ".join(missing_credentials) + " is required")

    try:
        key = base64.b64decode(args.key, validate=True)
    except (binascii.Error, ValueError):
        parser.error("--key/DEVICE_KEY must be valid base64")
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
