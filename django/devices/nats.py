import asyncio
import json
from uuid import UUID

import nats
from django.conf import settings

from devices.models import Device, Measurement
from devices.serializers import DeviceSerializer, MeasurementSerializer


DEVICE_CREATED_SUBJECT = "devices.created"


def notification_subject(device_id: UUID) -> str:
    return f"devices.{device_id}.measurements"


def notification_payload(measurement: Measurement) -> bytes:
    return json.dumps(
        MeasurementSerializer(measurement).data,
        separators=(",", ":"),
    ).encode()


def device_created_payload(device: Device) -> bytes:
    return json.dumps(DeviceSerializer(device).data, separators=(",", ":")).encode()


async def _publish(subject: str, payload: bytes) -> None:
    connection = await nats.connect(settings.NATS_PUBLISH_URL)
    try:
        await connection.publish(subject, payload)
        await connection.flush()
    finally:
        await connection.drain()


def publish_measurement_best_effort(measurement_id: int) -> None:
    try:
        measurement = Measurement.objects.select_related("device").get(
            id=measurement_id
        )
        asyncio.run(
            _publish(
                notification_subject(measurement.device_id),
                notification_payload(measurement),
            )
        )
    except Exception:
        pass


def publish_device_created_best_effort(device_id: UUID) -> None:
    try:
        device = Device.objects.get(id=device_id)
        asyncio.run(_publish(DEVICE_CREATED_SUBJECT, device_created_payload(device)))
    except Exception:
        pass
