from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAdminUser, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .crypto import encode_device_key, encrypt_device_key, generate_device_key
from .models import Device
from .serializers import DeviceCreateSerializer, DeviceSerializer


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
