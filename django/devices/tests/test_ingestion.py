import base64
import hashlib
import hmac
import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch

from django.db import close_old_connections
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from devices.crypto import encrypt_device_key
from devices.models import Device, Measurement
from devices.serializers import MeasurementSerializer
from devices.signatures import verify_device_signature


MASTER_KEY = base64.b64encode(b"m" * 32).decode()
DEVICE_KEY = b"d" * 32


def signed_headers(device, body):
    digest = hmac.new(DEVICE_KEY, body, hashlib.sha256).hexdigest()
    return {
        "HTTP_X_DEVICE_ID": str(device.id),
        "HTTP_X_DEVICE_SIGNATURE": f"sha256={digest}",
    }


@override_settings(DEVICE_KEY_ENCRYPTION_KEY=MASTER_KEY)
class MeasurementIngestionTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        ciphertext, nonce = encrypt_device_key(DEVICE_KEY)
        self.device = Device.objects.create(
            name="simulator", key_ciphertext=ciphertext, key_nonce=nonce
        )
        self.client = APIClient()
        publisher_patcher = patch(
            "devices.views.publish_measurement_best_effort"
        )
        self.publish_measurement = publisher_patcher.start()
        self.addCleanup(publisher_patcher.stop)

    def body(self, value=21.5):
        return json.dumps(
            {
                "measurement_name": "temperature",
                "value": value,
                "measured_at": "2026-07-25T18:30:00Z",
            },
            separators=(",", ":"),
        ).encode()

    def test_signature_requires_sha256_prefix_and_exact_digest(self):
        body = self.body()
        digest = hmac.new(DEVICE_KEY, body, hashlib.sha256).hexdigest()

        self.assertTrue(verify_device_signature(DEVICE_KEY, body, f"sha256={digest}"))
        self.assertFalse(verify_device_signature(DEVICE_KEY, body, f"sha512={digest}"))
        self.assertFalse(verify_device_signature(DEVICE_KEY, body, f"sha256={digest[:-1]}"))

    def test_valid_signature_persists_server_metadata(self):
        body = self.body()
        response = self.client.generic(
            "POST",
            "/api/device-measurements/",
            body,
            content_type="application/json",
            **signed_headers(self.device, body),
        )

        self.assertEqual(response.status_code, 201)
        measurement = Measurement.objects.get()
        self.assertEqual(measurement.entry_index, 1)
        self.assertEqual(response.data, MeasurementSerializer(measurement).data)

    def test_body_change_invalidates_signature(self):
        signed_body = self.body(21.5)
        changed_body = self.body(22.0)
        response = self.client.generic(
            "POST",
            "/api/device-measurements/",
            changed_body,
            content_type="application/json",
            **signed_headers(self.device, signed_body),
        )

        self.assertEqual(response.status_code, 401)
        self.assertFalse(Measurement.objects.exists())

    def test_missing_device_id_is_rejected_without_server_error(self):
        body = self.body()
        response = self.client.generic(
            "POST",
            "/api/device-measurements/",
            body,
            content_type="application/json",
            HTTP_X_DEVICE_SIGNATURE="sha256=" + ("0" * 64),
        )

        self.assertEqual(response.status_code, 401)
        self.assertFalse(Measurement.objects.exists())

    def test_malformed_device_id_is_rejected_without_server_error(self):
        body = self.body()
        response = self.client.generic(
            "POST",
            "/api/device-measurements/",
            body,
            content_type="application/json",
            HTTP_X_DEVICE_ID="not-a-uuid",
            HTTP_X_DEVICE_SIGNATURE="sha256=" + ("0" * 64),
        )

        self.assertEqual(response.status_code, 401)
        self.assertFalse(Measurement.objects.exists())

    def test_unknown_device_id_is_rejected_without_server_error(self):
        body = self.body()
        response = self.client.generic(
            "POST",
            "/api/device-measurements/",
            body,
            content_type="application/json",
            HTTP_X_DEVICE_ID="11111111-1111-4111-8111-111111111111",
            HTTP_X_DEVICE_SIGNATURE="sha256=" + ("0" * 64),
        )

        self.assertEqual(response.status_code, 401)
        self.assertFalse(Measurement.objects.exists())

    def test_equivalent_json_encoding_invalidates_signature(self):
        signed_body = self.body()
        equivalent_body = (
            b'{ "value" : 21.5, "measurement_name" : "temperature", '
            b'"measured_at" : "2026-07-25T18:30:00Z" }'
        )
        response = self.client.generic(
            "POST",
            "/api/device-measurements/",
            equivalent_body,
            content_type="application/json",
            **signed_headers(self.device, signed_body),
        )

        self.assertEqual(response.status_code, 401)
        self.assertFalse(Measurement.objects.exists())

    def test_previous_key_fails_after_rotation(self):
        replacement = b"r" * 32
        ciphertext, nonce = encrypt_device_key(replacement)
        self.device.key_ciphertext = ciphertext
        self.device.key_nonce = nonce
        self.device.save()
        body = self.body()
        response = self.client.generic(
            "POST",
            "/api/device-measurements/",
            body,
            content_type="application/json",
            **signed_headers(self.device, body),
        )

        self.assertEqual(response.status_code, 401)
        self.assertFalse(Measurement.objects.exists())

    def test_disabled_device_is_rejected(self):
        self.device.enabled = False
        self.device.save()
        body = self.body()
        response = self.client.generic(
            "POST",
            "/api/device-measurements/",
            body,
            content_type="application/json",
            **signed_headers(self.device, body),
        )

        self.assertEqual(response.status_code, 403)
        self.assertFalse(Measurement.objects.exists())

    def test_non_finite_value_and_naive_timestamp_are_rejected(self):
        invalid_bodies = [
            b'{"measurement_name":"temperature","value":"NaN",'
            b'"measured_at":"2026-07-25T18:30:00Z"}',
            b'{"measurement_name":"temperature","value":21.5,'
            b'"measured_at":"2026-07-25T18:30:00"}',
        ]
        for body in invalid_bodies:
            response = self.client.generic(
                "POST",
                "/api/device-measurements/",
                body,
                content_type="application/json",
                **signed_headers(self.device, body),
            )
            self.assertEqual(response.status_code, 400)
        self.assertFalse(Measurement.objects.exists())

    def test_concurrent_requests_allocate_distinct_indexes(self):
        def post_measurement(value):
            close_old_connections()
            try:
                device = Device.objects.get(id=self.device.id)
                body = self.body(value)
                response = APIClient().generic(
                    "POST",
                    "/api/device-measurements/",
                    body,
                    content_type="application/json",
                    **signed_headers(device, body),
                )
                return response.status_code, response.data.get("entry_index")
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(post_measurement, [21.5, 22.0]))

        self.assertEqual(sorted(status for status, _ in results), [201, 201])
        self.assertEqual(sorted(index for _, index in results), [1, 2])


@override_settings(DEVICE_KEY_ENCRYPTION_KEY=MASTER_KEY)
class MeasurementNotificationCallbackTests(TestCase):
    def setUp(self):
        ciphertext, nonce = encrypt_device_key(DEVICE_KEY)
        self.device = Device.objects.create(
            name="simulator", key_ciphertext=ciphertext, key_nonce=nonce
        )
        self.client = APIClient()

    def body(self):
        return json.dumps(
            {
                "measurement_name": "temperature",
                "value": 21.5,
                "measured_at": "2026-07-25T18:30:00Z",
            },
            separators=(",", ":"),
        ).encode()

    def post_measurement(self):
        body = self.body()
        return self.client.generic(
            "POST",
            "/api/device-measurements/",
            body,
            content_type="application/json",
            **signed_headers(self.device, body),
        )

    @patch("devices.views.publish_measurement_best_effort")
    def test_publish_is_deferred_until_after_commit(self, publish_measurement):
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.post_measurement()

        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(callbacks), 1)
        publish_measurement.assert_not_called()

        callbacks[0]()

        publish_measurement.assert_called_once_with(Measurement.objects.get().id)

    @patch("devices.nats._publish", new_callable=AsyncMock)
    def test_publish_failure_keeps_ingestion_successful(self, publish):
        publish.side_effect = RuntimeError("unavailable")
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            response = self.post_measurement()

        self.assertEqual(response.status_code, 201)
        callbacks[0]()
