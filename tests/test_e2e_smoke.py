import importlib.util
import unittest
from pathlib import Path
from unittest.mock import Mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "e2e-smoke.py"
SPEC = importlib.util.spec_from_file_location("e2e_smoke", MODULE_PATH)
e2e_smoke = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(e2e_smoke)


class E2ESimulatorBoundaryTests(unittest.TestCase):
    def test_ingest_uses_the_repository_device_simulator(self):
        simulator = Mock()
        response = Mock(status_code=201)
        response.json.return_value = {"entry_index": 1}
        simulator.send_measurement_response.return_value = response
        simulator._current_utc_timestamp.return_value = "2026-07-26T12:00:00Z"

        actual_response, payload = e2e_smoke.ingest(
            simulator,
            "http://localhost",
            "device-id",
            b"d" * 32,
            1,
        )

        self.assertIs(actual_response, response)
        self.assertEqual(payload, {"entry_index": 1})
        simulator.send_measurement_response.assert_called_once()
        args = simulator.send_measurement_response.call_args.args
        self.assertEqual(args[0], "http://localhost/api/device-measurements/")
        self.assertEqual(args[1], "device-id")
        self.assertEqual(args[2], b"d" * 32)
        self.assertEqual(args[3], "temperature")
        self.assertEqual(args[4], 21.0)
        self.assertEqual(args[5], "2026-07-26T12:00:00Z")


if __name__ == "__main__":
    unittest.main()
