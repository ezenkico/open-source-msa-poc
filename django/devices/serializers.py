from rest_framework import serializers

from .models import Measurement


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
