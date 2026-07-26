import json
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from django.test import TestCase, override_settings
from django.utils import timezone

from devices.models import Device, Measurement
from devices.nats import (
    notification_payload,
    notification_subject,
    publish_measurement_best_effort,
)
from devices.serializers import MeasurementSerializer


@override_settings(NATS_PUBLISH_URL="nats://publisher:secret@nats:4222")
class NotificationTests(TestCase):
    def setUp(self):
        self.device = Device.objects.create(
            name="simulator", key_ciphertext=b"a", key_nonce=b"b"
        )
        self.measurement = Measurement.objects.create(
            device=self.device,
            entry_index=1,
            measurement_name="temperature",
            value=21.5,
            measured_at=timezone.now() - timedelta(seconds=1),
        )

    def test_subject_and_payload_contain_stored_record(self):
        self.assertEqual(
            notification_subject(self.device.id),
            f"devices.{self.device.id}.measurements",
        )
        payload = json.loads(notification_payload(self.measurement))
        self.assertEqual(payload, MeasurementSerializer(self.measurement).data)

    @patch("devices.nats._publish", new_callable=AsyncMock)
    def test_publish_failure_is_silently_swallowed(self, publish):
        publish.side_effect = RuntimeError("unavailable")

        self.assertIsNone(publish_measurement_best_effort(self.measurement.id))
