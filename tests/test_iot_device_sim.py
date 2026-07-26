import hashlib
import hmac
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).parents[1] / "iot-device-sim.py"
SPEC = importlib.util.spec_from_file_location("iot_device_sim", MODULE_PATH)
iot_device_sim = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = iot_device_sim
SPEC.loader.exec_module(iot_device_sim)


class DeviceSimulatorTests(unittest.TestCase):
    def test_signature_uses_exact_compact_body(self):
        body = iot_device_sim.encode_measurement(
            "temperature", 21.5, "2026-07-25T18:30:00Z"
        )

        self.assertEqual(
            body,
            b'{"measurement_name":"temperature","value":21.5,'
            b'"measured_at":"2026-07-25T18:30:00Z"}',
        )
        expected = hmac.new(b"d" * 32, body, hashlib.sha256).hexdigest()
        self.assertEqual(
            iot_device_sim.sign_body(b"d" * 32, body), f"sha256={expected}"
        )

    @patch("iot_device_sim.requests.post")
    def test_post_sends_exact_body_and_device_headers(self, post):
        post.return_value = Mock(
            status_code=201,
            json=Mock(return_value={"entry_index": 1}),
        )

        result = iot_device_sim.send_measurement(
            "http://localhost/api/device-measurements/",
            "device-id",
            b"d" * 32,
            "temperature",
            21.5,
            "2026-07-25T18:30:00Z",
        )

        expected_body = (
            b'{"measurement_name":"temperature","value":21.5,'
            b'"measured_at":"2026-07-25T18:30:00Z"}'
        )
        expected_signature = hmac.new(
            b"d" * 32, expected_body, hashlib.sha256
        ).hexdigest()
        post.assert_called_once_with(
            "http://localhost/api/device-measurements/",
            data=expected_body,
            headers={
                "Content-Type": "application/json",
                "X-Device-ID": "device-id",
                "X-Device-Signature": f"sha256={expected_signature}",
            },
            timeout=10,
        )
        self.assertEqual(result, {"entry_index": 1})

    @patch("iot_device_sim.requests.post")
    def test_post_rejects_non_success_response(self, post):
        response = Mock(status_code=401)
        response.raise_for_status.side_effect = (
            iot_device_sim.requests.HTTPError("401 Client Error")
        )
        post.return_value = response

        with self.assertRaises(iot_device_sim.requests.HTTPError):
            iot_device_sim.send_measurement(
                "http://localhost/api/device-measurements/",
                "device-id",
                b"d" * 32,
                "temperature",
                21.5,
                "2026-07-25T18:30:00Z",
            )


if __name__ == "__main__":
    unittest.main()
