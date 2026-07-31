import base64
import hashlib
import hmac
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).parents[1] / "iot-device-sim.py"
SPEC = importlib.util.spec_from_file_location("iot_device_sim", MODULE_PATH)
iot_device_sim = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = iot_device_sim
SPEC.loader.exec_module(iot_device_sim)


class DeviceSimulatorTests(unittest.TestCase):
    def test_load_dotenv_accepts_comments_export_and_quotes_without_overwriting_environment(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            dotenv_path = Path(directory) / ".env"
            dotenv_path.write_text(
                "# Device credentials\n"
                "DEVICE_ID=file-id\n"
                'export DEVICE_KEY="file-key"\n',
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"DEVICE_ID": "process-id"}, clear=True):
                iot_device_sim.load_dotenv(dotenv_path, os.environ)

                self.assertEqual(os.environ["DEVICE_ID"], "process-id")
                self.assertEqual(os.environ["DEVICE_KEY"], "file-key")

    def test_main_uses_dotenv_device_credentials(self):
        encoded_key = base64.b64encode(b"dotenv key").decode("ascii")
        send_measurement = Mock(return_value={"entry_index": 1})

        def provide_dotenv(_path, environ):
            environ.update({"DEVICE_ID": "dotenv-id", "DEVICE_KEY": encoded_key})

        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(iot_device_sim.Path, "exists", return_value=True),
            patch.object(iot_device_sim, "load_dotenv", side_effect=provide_dotenv),
            patch.object(iot_device_sim, "send_measurement", send_measurement),
            patch.object(
                sys,
                "argv",
                [
                    "iot-device-sim.py",
                    "--name",
                    "temperature",
                    "--value",
                    "21.5",
                    "--measured-at",
                    "2026-07-25T18:30:00Z",
                ],
            ),
            patch("sys.stdout", new_callable=io.StringIO),
        ):
            iot_device_sim.main()

        send_measurement.assert_called_once_with(
            "http://localhost",
            "dotenv-id",
            b"dotenv key",
            "temperature",
            21.5,
            "2026-07-25T18:30:00Z",
        )

    def test_cli_device_credentials_override_environment(self):
        environment_key = base64.b64encode(b"environment key").decode("ascii")
        cli_key = base64.b64encode(b"cli key").decode("ascii")
        send_measurement = Mock(return_value={"entry_index": 1})

        with (
            patch.dict(
                os.environ,
                {"DEVICE_ID": "environment-id", "DEVICE_KEY": environment_key},
                clear=True,
            ),
            patch.object(iot_device_sim, "load_dotenv"),
            patch.object(iot_device_sim, "send_measurement", send_measurement),
            patch.object(
                sys,
                "argv",
                [
                    "iot-device-sim.py",
                    "--device-id",
                    "cli-id",
                    "--key",
                    cli_key,
                    "--name",
                    "temperature",
                    "--value",
                    "21.5",
                    "--measured-at",
                    "2026-07-25T18:30:00Z",
                ],
            ),
            patch("sys.stdout", new_callable=io.StringIO),
        ):
            iot_device_sim.main()

        send_measurement.assert_called_once_with(
            "http://localhost",
            "cli-id",
            b"cli key",
            "temperature",
            21.5,
            "2026-07-25T18:30:00Z",
        )

    def test_main_reports_missing_device_credentials(self):
        standard_error = io.StringIO()

        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(iot_device_sim, "load_dotenv"),
            patch.object(
                sys,
                "argv",
                [
                    "iot-device-sim.py",
                    "--name",
                    "temperature",
                    "--value",
                    "21.5",
                ],
            ),
            patch("sys.stderr", standard_error),
            self.assertRaises(SystemExit) as raised,
        ):
            iot_device_sim.main()

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--device-id or DEVICE_ID", standard_error.getvalue())
        self.assertIn("--key or DEVICE_KEY", standard_error.getvalue())
        self.assertNotIn("file-key", standard_error.getvalue())

    def test_main_reports_invalid_base64_key_without_printing_key(self):
        invalid_key = "not-base64!"
        standard_error = io.StringIO()

        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(iot_device_sim, "load_dotenv"),
            patch.object(
                sys,
                "argv",
                [
                    "iot-device-sim.py",
                    "--device-id",
                    "device-id",
                    "--key",
                    invalid_key,
                    "--name",
                    "temperature",
                    "--value",
                    "21.5",
                ],
            ),
            patch("sys.stderr", standard_error),
            self.assertRaises(SystemExit) as raised,
        ):
            iot_device_sim.main()

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--key/DEVICE_KEY must be valid base64", standard_error.getvalue())
        self.assertNotIn(invalid_key, standard_error.getvalue())

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
    def test_send_response_exposes_the_real_http_status(self, post):
        response = Mock(status_code=201)
        post.return_value = response

        result = iot_device_sim.send_measurement_response(
            "http://localhost/api/device-measurements/",
            "device-id",
            b"d" * 32,
            "temperature",
            21.5,
            "2026-07-25T18:30:00Z",
        )

        self.assertIs(result, response)

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
