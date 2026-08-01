import uuid

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
from .nats import publish_device_created_best_effort, publish_measurement_best_effort
from .serializers import (
    DeviceCreateSerializer,
    DeviceSerializer,
    MeasurementListQuerySerializer,
    MeasurementInputSerializer,
    MeasurementSerializer,
)
from .signatures import verify_device_signature


class DeviceListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get_authenticate_header(self, request):
        return "Bearer"

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
        transaction.on_commit(
            lambda device_id=device.id: publish_device_created_best_effort(device_id)
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
        try:
            parsed_device_id = uuid.UUID(device_id) if device_id else None
        except (TypeError, ValueError, AttributeError):
            parsed_device_id = None
        if parsed_device_id is None:
            raise AuthenticationFailed("Invalid device credentials.")

        with transaction.atomic():
            try:
                device = Device.objects.select_for_update().get(id=parsed_device_id)
            except Device.DoesNotExist:
                raise AuthenticationFailed("Invalid device credentials.") from None
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
            transaction.on_commit(
                lambda measurement_id=measurement.id: publish_measurement_best_effort(
                    measurement_id
                )
            )
        return Response(MeasurementSerializer(measurement).data, status=status.HTTP_201_CREATED)


class AuthenticatedMeasurementView(APIView):
    permission_classes = [IsAuthenticated]

    def get_authenticate_header(self, request):
        return "Bearer"


class LatestMeasurementView(AuthenticatedMeasurementView):
    def get(self, request, device_id):
        print(device_id)
        get_object_or_404(Device, id=device_id)
        measurement = (
            Measurement.objects.filter(device_id=device_id)
            .order_by("-entry_index")
            .first()
        )
        if measurement is None:
            return Response(status=status.HTTP_404_NOT_FOUND)
        return Response(MeasurementSerializer(measurement).data)


class MeasurementListView(AuthenticatedMeasurementView):
    def get(self, request, device_id):
        query = MeasurementListQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        get_object_or_404(Device, id=device_id)

        limit = query.validated_data["limit"]
        before_index = query.validated_data.get("before_index")
        after_index = query.validated_data.get("after_index")
        through_index = query.validated_data.get("through_index")
        queryset = Measurement.objects.filter(device_id=device_id)

        if before_index is not None:
            rows = list(
                queryset.filter(entry_index__lt=before_index)
                .order_by("-entry_index")[:limit]
            )
            rows.reverse()
        elif after_index is not None:
            queryset = queryset.filter(entry_index__gt=after_index)
            if through_index is not None:
                queryset = queryset.filter(entry_index__lte=through_index)
            rows = list(queryset.order_by("entry_index")[:limit])
        else:
            rows = list(queryset.order_by("-entry_index")[:limit])
            rows.reverse()

        return Response(MeasurementSerializer(rows, many=True).data)
