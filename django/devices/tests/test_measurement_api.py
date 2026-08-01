from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase, APIClient

from devices.models import Device, Measurement


class MeasurementApiTests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="reader", password="password"
        )
        self.device = Device.objects.create(
            name="selected", key_ciphertext=b"ciphertext", key_nonce=b"nonce"
        )
        other_device = Device.objects.create(
            name="other", key_ciphertext=b"ciphertext", key_nonce=b"nonce"
        )
        measured_at = timezone.now() - timedelta(minutes=1)
        Measurement.objects.bulk_create(
            [
                Measurement(
                    device=self.device,
                    entry_index=index,
                    measurement_name="temperature",
                    value=float(index),
                    measured_at=measured_at,
                )
                for index in (1, 2, 3, 4, 5, 8)
            ]
            + [
                Measurement(
                    device=other_device,
                    entry_index=1,
                    measurement_name="humidity",
                    value=50.0,
                    measured_at=measured_at,
                )
            ]
        )
        self.client.force_authenticate(self.user)

    def measurements_url(self):
        return f"/api/devices/{self.device.id}/measurements/"

    def test_latest_returns_highest_index_for_selected_device(self):
        response = self.client.get(f"{self.measurements_url()}latest/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["device_id"], str(self.device.id))
        self.assertEqual(response.data["entry_index"], 8)

    def test_default_returns_newest_page_with_offset_envelope(self):
        response = self.client.get(f"{self.measurements_url()}?limit=3")

        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data, dict)
        self.assertEqual(
            set(response.data), {"results", "total", "limit", "offset", "order"}
        )
        self.assertEqual(response.data["total"], 6)
        self.assertEqual(response.data["limit"], 3)
        self.assertEqual(response.data["offset"], 0)
        self.assertEqual(response.data["order"], "desc")
        self.assertEqual(
            [row["entry_index"] for row in response.data["results"]],
            [8, 5, 4],
        )

    def test_descending_offset_uses_row_positions_with_noncontiguous_indexes(self):
        response = self.client.get(
            f"{self.measurements_url()}?limit=2&offset=2&order=desc"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["total"], 6)
        self.assertEqual(response.data["limit"], 2)
        self.assertEqual(response.data["offset"], 2)
        self.assertEqual(response.data["order"], "desc")
        self.assertEqual(
            [row["entry_index"] for row in response.data["results"]], [4, 3]
        )

    def test_ascending_offset_returns_oldest_rows_first(self):
        response = self.client.get(
            f"{self.measurements_url()}?limit=2&offset=2&order=asc"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["total"], 6)
        self.assertEqual(response.data["limit"], 2)
        self.assertEqual(response.data["offset"], 2)
        self.assertEqual(response.data["order"], "asc")
        self.assertEqual(
            [row["entry_index"] for row in response.data["results"]], [3, 4]
        )

    def test_offset_beyond_total_returns_empty_results_with_authoritative_total(self):
        response = self.client.get(
            f"{self.measurements_url()}?limit=2&offset=20&order=desc"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data,
            {
                "results": [],
                "total": 6,
                "limit": 2,
                "offset": 20,
                "order": "desc",
            },
        )

    def test_total_is_scoped_to_selected_device(self):
        response = self.client.get(f"{self.measurements_url()}?limit=1")

        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data, dict)
        self.assertEqual(response.data["total"], 6)
        self.assertEqual(len(response.data["results"]), 1)

    def test_gap_range_uses_exclusive_after_and_inclusive_through(self):
        response = self.client.get(
            f"{self.measurements_url()}?after_index=2&through_index=5&limit=10"
        )

        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data, dict)
        self.assertEqual(
            set(response.data), {"results", "total", "limit", "offset", "order"}
        )
        self.assertEqual(response.data["total"], 3)
        self.assertEqual(response.data["limit"], 10)
        self.assertEqual(response.data["offset"], 0)
        self.assertEqual(response.data["order"], "asc")
        self.assertEqual(
            [row["entry_index"] for row in response.data["results"]], [3, 4, 5]
        )

    def test_gap_total_counts_full_matching_range_before_limit(self):
        response = self.client.get(
            f"{self.measurements_url()}?after_index=2&through_index=5&limit=2"
        )

        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data, dict)
        self.assertEqual(response.data["total"], 3)
        self.assertEqual(response.data["limit"], 2)
        self.assertEqual(response.data["offset"], 0)
        self.assertEqual(response.data["order"], "asc")
        self.assertEqual(
            [row["entry_index"] for row in response.data["results"]], [3, 4]
        )

    def test_gap_bounds_reject_explicit_offset_or_order(self):
        for query in ("after_index=1&offset=0", "after_index=1&order=asc"):
            with self.subTest(query=query):
                response = self.client.get(f"{self.measurements_url()}?{query}")
                self.assertEqual(response.status_code, 400)

    def test_through_requires_after_and_cannot_precede_it(self):
        for query in (
            "through_index=5",
            "after_index=5&through_index=4",
        ):
            with self.subTest(query=query):
                response = self.client.get(f"{self.measurements_url()}?{query}")
                self.assertEqual(response.status_code, 400)

    def test_limit_is_required_to_be_an_integer_from_one_to_two_hundred(self):
        for limit in ("0", "201", "-1", "one"):
            with self.subTest(limit=limit):
                response = self.client.get(f"{self.measurements_url()}?limit={limit}")
                self.assertEqual(response.status_code, 400)

        response = self.client.get(f"{self.measurements_url()}?limit=1")

        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data, dict)
        self.assertEqual([row["entry_index"] for row in response.data["results"]], [8])

    def test_query_parameters_must_match_the_documented_contract(self):
        for query in (
            "before_index=4",
            "unknown=value",
            "limit=1&limit=2",
            "offset=0&offset=1",
            "order=asc&order=desc",
        ):
            with self.subTest(query=query):
                response = self.client.get(f"{self.measurements_url()}?{query}")
                self.assertEqual(response.status_code, 400)

    def test_offset_must_be_a_non_negative_postgresql_bigint(self):
        for offset in ("-1", "9223372036854775808", "one"):
            with self.subTest(offset=offset):
                response = self.client.get(f"{self.measurements_url()}?offset={offset}")
                self.assertEqual(response.status_code, 400)

    def test_order_must_be_ascending_or_descending(self):
        for order in ("ascending", "DESC", "newest"):
            with self.subTest(order=order):
                response = self.client.get(f"{self.measurements_url()}?order={order}")
                self.assertEqual(response.status_code, 400)

    def test_index_bounds_must_fit_non_negative_postgresql_bigints(self):
        for field in ("after_index", "through_index"):
            for value in ("-1", "9223372036854775808"):
                with self.subTest(field=field, value=value):
                    response = self.client.get(
                        f"{self.measurements_url()}?{field}={value}"
                    )
                    self.assertEqual(response.status_code, 400)

    def test_measurement_routes_require_authentication(self):
        anonymous_client = APIClient()

        for path in (self.measurements_url(), f"{self.measurements_url()}latest/"):
            with self.subTest(path=path):
                response = anonymous_client.get(path)
                self.assertEqual(response.status_code, 401)

    def test_unknown_device_returns_not_found(self):
        unknown_device = Device.objects.create(
            name="removed", key_ciphertext=b"ciphertext", key_nonce=b"nonce"
        )
        unknown_device.delete()

        response = self.client.get(
            f"/api/devices/{unknown_device.id}/measurements/"
        )

        self.assertEqual(response.status_code, 404)

    def test_latest_returns_not_found_when_existing_device_has_no_measurements(self):
        empty_device = Device.objects.create(
            name="empty", key_ciphertext=b"ciphertext", key_nonce=b"nonce"
        )

        response = self.client.get(
            f"/api/devices/{empty_device.id}/measurements/latest/"
        )

        self.assertEqual(response.status_code, 404)

    def test_list_returns_empty_envelope_when_existing_device_has_no_measurements(self):
        empty_device = Device.objects.create(
            name="empty", key_ciphertext=b"ciphertext", key_nonce=b"nonce"
        )

        response = self.client.get(f"/api/devices/{empty_device.id}/measurements/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data,
            {
                "results": [],
                "total": 0,
                "limit": 50,
                "offset": 0,
                "order": "desc",
            },
        )

    def test_latest_returns_not_found_for_unknown_device(self):
        unknown_device = Device.objects.create(
            name="removed", key_ciphertext=b"ciphertext", key_nonce=b"nonce"
        )
        unknown_device.delete()

        response = self.client.get(
            f"/api/devices/{unknown_device.id}/measurements/latest/"
        )

        self.assertEqual(response.status_code, 404)
