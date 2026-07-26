#!/usr/bin/env python3
"""Bounded end-to-end acceptance test for the locally deployed IoT POC."""

import asyncio
import base64
import importlib.util
import json
import os
import sys
import uuid
from pathlib import Path
from types import ModuleType

import nats
import requests


HTTP_TIMEOUT = 10
NATS_TIMEOUT = 10


def fail(message: str) -> None:
    raise AssertionError(message)


def request_json(method: str, url: str, **kwargs) -> tuple[requests.Response, object]:
    response = requests.request(method, url, timeout=HTTP_TIMEOUT, **kwargs)
    try:
        payload = response.json()
    except requests.exceptions.JSONDecodeError:
        payload = None
    return response, payload


def expect_status(response: requests.Response, expected: int, operation: str) -> None:
    if response.status_code != expected:
        fail(f"{operation}: expected HTTP {expected}, got {response.status_code}")


def load_device_simulator() -> ModuleType:
    path = Path(__file__).resolve().parents[1] / "iot-device-sim.py"
    spec = importlib.util.spec_from_file_location("iot_device_sim", path)
    if spec is None or spec.loader is None:
        fail("Could not load the repository device simulator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ingest(simulator, base_url: str, device_id: str, key: bytes, sequence: int):
    response = simulator.send_measurement_response(
        f"{base_url}/api/device-measurements/",
        device_id,
        key,
        "temperature",
        20.0 + sequence,
        simulator._current_utc_timestamp(),
    )
    return response, response.json()


async def run() -> None:
    base_url = os.environ.get("IOT_BASE_URL", "http://localhost").rstrip("/")
    websocket_url = os.environ.get("IOT_NATS_WS_URL", "ws://localhost/nats")
    simulator = load_device_simulator()
    username = os.environ.get("E2E_STAFF_USERNAME") or os.environ.get(
        "DJANGO_SUPERUSER_USERNAME"
    )
    password = os.environ.get("E2E_STAFF_PASSWORD") or os.environ.get(
        "DJANGO_SUPERUSER_PASSWORD"
    )
    if not username or not password:
        fail(
            "Set E2E_STAFF_USERNAME/E2E_STAFF_PASSWORD or "
            "DJANGO_SUPERUSER_USERNAME/DJANGO_SUPERUSER_PASSWORD"
        )

    login_response, login_payload = await asyncio.to_thread(
        request_json,
        "POST",
        f"{base_url}/api/auth/jwt/",
        json={"username": username, "password": password},
    )
    expect_status(login_response, 200, "staff login")
    if not isinstance(login_payload, dict) or not login_payload.get("access"):
        fail("staff login: response has no access token")
    authorization = {"Authorization": f"Bearer {login_payload['access']}"}

    create_response, created = await asyncio.to_thread(
        request_json,
        "POST",
        f"{base_url}/api/devices/",
        json={"name": f"e2e-{uuid.uuid4().hex}"},
        headers=authorization,
    )
    expect_status(create_response, 201, "device creation")
    if not isinstance(created, dict) or not created.get("id") or not created.get("key"):
        fail("device creation: response has no device ID or one-time key")
    device_id = created["id"]
    device_key = base64.b64decode(created["key"], validate=True)

    token_response, token_payload = await asyncio.to_thread(
        request_json,
        "GET",
        f"{base_url}/api/nats-auth/token/",
        headers=authorization,
    )
    expect_status(token_response, 200, "NATS token")
    if not isinstance(token_payload, dict) or not token_payload.get("token"):
        fail("NATS token: response has no token")

    client = await asyncio.wait_for(
        nats.connect(
            websocket_url,
            token=token_payload["token"],
            connect_timeout=NATS_TIMEOUT,
            max_reconnect_attempts=0,
        ),
        timeout=NATS_TIMEOUT,
    )
    subscription = await client.subscribe(f"devices.{device_id}.measurements")
    await client.flush(timeout=NATS_TIMEOUT)
    try:
        first_response, first = await asyncio.to_thread(
            ingest, simulator, base_url, device_id, device_key, 1
        )
        expect_status(first_response, 201, "first ingestion")
        if not isinstance(first, dict) or first.get("entry_index") != 1:
            fail("first ingestion: expected entry index 1")

        message = await subscription.next_msg(timeout=NATS_TIMEOUT)
        notification = json.loads(message.data)
        if notification != first:
            fail("NATS notification does not equal the ingestion response")

        latest_response, latest = await asyncio.to_thread(
            request_json,
            "GET",
            f"{base_url}/api/devices/{device_id}/measurements/latest/",
            headers=authorization,
        )
        expect_status(latest_response, 200, "latest measurement")
        if not isinstance(latest, dict) or latest.get("entry_index") != 1:
            fail("latest measurement: expected entry index 1")

        for sequence in (2, 3):
            response, payload = await asyncio.to_thread(
                ingest, simulator, base_url, device_id, device_key, sequence
            )
            expect_status(response, 201, f"ingestion {sequence}")
            if not isinstance(payload, dict) or payload.get("entry_index") != sequence:
                fail(f"ingestion {sequence}: expected entry index {sequence}")

        history_response, history = await asyncio.to_thread(
            request_json,
            "GET",
            f"{base_url}/api/devices/{device_id}/measurements/?limit=50",
            headers=authorization,
        )
        expect_status(history_response, 200, "measurement history")
        if not isinstance(history, list) or [
            item.get("entry_index") for item in history
        ] != [1, 2, 3]:
            fail("measurement history: expected entry indexes [1, 2, 3]")

        rotate_response, rotated = await asyncio.to_thread(
            request_json,
            "POST",
            f"{base_url}/api/devices/{device_id}/rotate-key/",
            headers=authorization,
        )
        expect_status(rotate_response, 200, "device-key rotation")
        if not isinstance(rotated, dict) or not rotated.get("key"):
            fail("device-key rotation: response has no one-time key")
        new_key = base64.b64decode(rotated["key"], validate=True)

        old_response, _ = await asyncio.to_thread(
            ingest, simulator, base_url, device_id, device_key, 4
        )
        expect_status(old_response, 401, "old device key")
        new_response, new_measurement = await asyncio.to_thread(
            ingest, simulator, base_url, device_id, new_key, 4
        )
        expect_status(new_response, 201, "rotated device key")
        if (
            not isinstance(new_measurement, dict)
            or new_measurement.get("entry_index") != 4
        ):
            fail("rotated device key: expected entry index 4")
    finally:
        await client.close()


def main() -> int:
    try:
        asyncio.run(run())
    except Exception as error:
        print(f"E2E smoke: FAIL: {error}", file=sys.stderr)
        return 1
    print("E2E smoke: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
