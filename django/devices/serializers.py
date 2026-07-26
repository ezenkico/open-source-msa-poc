from rest_framework import serializers

from .models import Device, Measurement


class DeviceSerializer(serializers.ModelSerializer):
    class Meta:
        model = Device
        fields = ["id", "name", "enabled", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class DeviceCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)


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
