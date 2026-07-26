from django.db import transaction
from django.db.models import F
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied
from rest_framework.permissions import AllowAny, IsAdminUser, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .crypto import (
    decrypt_device_key,
    encode_device_key,
    encrypt_device_key,
    generate_device_key,
)
from .models import Device, Measurement
from .serializers import (
    DeviceCreateSerializer,
    DeviceSerializer,
    MeasurementInputSerializer,
    MeasurementSerializer,
)
from .signatures import verify_device_signature


class DeviceListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(
            DeviceSerializer(Device.objects.order_by("name"), many=True).data
        )

    def post(self, request):
        if not request.user.is_staff:
            raise PermissionDenied()
        serializer = DeviceCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        key = generate_device_key()
        ciphertext, nonce = encrypt_device_key(key)
        device = Device.objects.create(
            name=serializer.validated_data["name"],
            key_ciphertext=ciphertext,
            key_nonce=nonce,
        )
        data = DeviceSerializer(device).data
        data["key"] = encode_device_key(key)
        return Response(data, status=status.HTTP_201_CREATED)


class DeviceRotateKeyView(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request, device_id):
        device = get_object_or_404(Device, id=device_id)
        key = generate_device_key()
        ciphertext, nonce = encrypt_device_key(key)
        device.key_ciphertext = ciphertext
        device.key_nonce = nonce
        device.save(update_fields=["key_ciphertext", "key_nonce", "updated_at"])
        return Response({"id": str(device.id), "key": encode_device_key(key)})


class MeasurementIngestView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get_authenticate_header(self, request):
        return "Device"

    def post(self, request):
        device_id = request.headers.get("X-Device-ID")
        signature = request.headers.get("X-Device-Signature", "")
        with transaction.atomic():
            device = get_object_or_404(Device.objects.select_for_update(), id=device_id)
            if not device.enabled:
                raise PermissionDenied("Device is disabled.")
            key = decrypt_device_key(device.key_ciphertext, device.key_nonce)
            if not verify_device_signature(key, request.body, signature):
                raise AuthenticationFailed("Invalid device signature.")

            serializer = MeasurementInputSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            entry_index = device.next_entry_index
            device.next_entry_index = F("next_entry_index") + 1
            device.save(update_fields=["next_entry_index", "updated_at"])
            measurement = Measurement.objects.create(
                device=device,
                entry_index=entry_index,
                **serializer.validated_data,
            )
        return Response(MeasurementSerializer(measurement).data, status=status.HTTP_201_CREATED)
