import math

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import serializers

from .models import Device, Measurement


MAX_ENTRY_INDEX = 2**63 - 1


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


class MeasurementListQuerySerializer(serializers.Serializer):
    limit = serializers.IntegerField(min_value=1, max_value=200, default=50)
    before_index = serializers.IntegerField(
        min_value=0, max_value=MAX_ENTRY_INDEX, required=False
    )
    after_index = serializers.IntegerField(
        min_value=0, max_value=MAX_ENTRY_INDEX, required=False
    )
    through_index = serializers.IntegerField(
        min_value=0, max_value=MAX_ENTRY_INDEX, required=False
    )

    def to_internal_value(self, data):
        errors = {}
        unexpected = set(data) - set(self.fields)
        if unexpected:
            errors["non_field_errors"] = [
                f"Unexpected query parameters: {', '.join(sorted(unexpected))}."
            ]

        if hasattr(data, "getlist"):
            repeated = [field for field in self.fields if len(data.getlist(field)) > 1]
            if repeated:
                errors["non_field_errors"] = [
                    f"Repeated query parameters: {', '.join(repeated)}."
                ]

        if errors:
            raise serializers.ValidationError(errors)
        return super().to_internal_value(data)

    def validate(self, attrs):
        before_index = attrs.get("before_index")
        after_index = attrs.get("after_index")
        through_index = attrs.get("through_index")

        if before_index is not None and (
            after_index is not None or through_index is not None
        ):
            raise serializers.ValidationError(
                "before_index cannot be combined with after_index or through_index."
            )
        if through_index is not None and after_index is None:
            raise serializers.ValidationError("through_index requires after_index.")
        if (
            after_index is not None
            and through_index is not None
            and through_index < after_index
        ):
            raise serializers.ValidationError(
                "through_index cannot be less than after_index."
            )
        return attrs
