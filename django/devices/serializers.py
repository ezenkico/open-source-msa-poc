import math

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import serializers

from .models import Device, Measurement


class DeviceSerializer(serializers.ModelSerializer):
    class Meta:
        model = Device
        fields = ["id", "name", "enabled", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class DeviceCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)


class MeasurementInputSerializer(serializers.Serializer):
    measurement_name = serializers.CharField(max_length=100)
    value = serializers.FloatField()
    measured_at = serializers.DateTimeField()

    def validate_value(self, value):
        if not math.isfinite(value):
            raise serializers.ValidationError("Value must be finite.")
        return value

    def validate_measured_at(self, value):
        supplied = self.initial_data.get("measured_at")
        parsed = parse_datetime(supplied) if isinstance(supplied, str) else supplied
        if parsed is not None and timezone.is_naive(parsed):
            raise serializers.ValidationError("Timestamp must include a timezone.")
        return value


class MeasurementSerializer(serializers.ModelSerializer):
    device_id = serializers.UUIDField(read_only=True)

    class Meta:
        model = Measurement
        fields = [
            "device_id",
            "entry_index",
            "measurement_name",
            "value",
            "measured_at",
            "received_at",
        ]
