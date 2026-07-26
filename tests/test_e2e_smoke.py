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
        simulator.send_measurement.return_value = {"entry_index": 1}

        payload = e2e_smoke.ingest(
            simulator,
            "http://localhost",
            "device-id",
            b"d" * 32,
            1,
        )

        self.assertEqual(payload, {"entry_index": 1})
        simulator.send_measurement.assert_called_once()
        args = simulator.send_measurement.call_args.args
        self.assertEqual(args[0], "http://localhost/api/device-measurements/")
        self.assertEqual(args[1], "device-id")
        self.assertEqual(args[2], b"d" * 32)
        self.assertEqual(args[3], "temperature")
        self.assertEqual(args[4], 21.0)


if __name__ == "__main__":
    unittest.main()
