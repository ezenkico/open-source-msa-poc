from datetime import timedelta

from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from devices.models import Device, Measurement


class MeasurementModelTests(TestCase):
    def test_indexes_are_unique_within_device_but_independent_between_devices(self):
        first = Device.objects.create(
            name="first", key_ciphertext=b"a", key_nonce=b"b"
        )
        second = Device.objects.create(
            name="second", key_ciphertext=b"a", key_nonce=b"b"
        )
        measured_at = timezone.now() - timedelta(seconds=1)
        Measurement.objects.create(
            device=first,
            entry_index=1,
            measurement_name="temperature",
            value=21.5,
            measured_at=measured_at,
        )
        Measurement.objects.create(
            device=second,
            entry_index=1,
            measurement_name="humidity",
            value=42.0,
            measured_at=measured_at,
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            Measurement.objects.create(
                device=first,
                entry_index=1,
                measurement_name="pressure",
                value=1001.0,
                measured_at=measured_at,
            )

    def test_device_counter_starts_at_one(self):
        device = Device.objects.create(
            name="simulator", key_ciphertext=b"a", key_nonce=b"b"
        )
        self.assertEqual(device.next_entry_index, 1)
