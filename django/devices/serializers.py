from rest_framework import serializers
from .models import DeviceData

class DeviceDataSerializer(serializers.ModelSerializer):
    class Meta:
        model = DeviceData
        fields = ("id", "temperature", "timestamp")