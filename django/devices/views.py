from django.utils import timezone
from rest_framework.generics import ListAPIView
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated
from rest_framework.exceptions import NotFound
from .models import DeviceData
from .serializers import DeviceDataSerializer

class TemperatureListView(ListAPIView):
    """
    GET /api/temperature/?limit=100&since=2025-11-01T00:00:00Z
    Requires devices.view_devicedata via DjangoModelPermissions.
    """
    serializer_class = DeviceDataSerializer
    permission_classes = [IsAuthenticated]  # DjangoModelPermissions also applied via settings

    def get_queryset(self):
        qs = DeviceData.objects.order_by("-timestamp")
        since = self.request.query_params.get("since")
        if since:
            try:
                # naive parse; for strict parsing, use dateutil or DRF parsers
                since_dt = timezone.datetime.fromisoformat(since.replace("Z", "+00:00"))
                qs = qs.filter(timestamp__gte=since_dt)
            except Exception:
                pass
        limit = self.request.query_params.get("limit")
        if limit and limit.isdigit():
            return qs[: int(limit)]
        return qs[:200]  # sane default for charts

class LatestTemperatureView(APIView):
    """
    GET /api/temperature/latest/
    Returns the newest record.
    Requires devices.view_devicedata.
    """
    permission_classes = [IsAuthenticated]  # DjangoModelPermissions also applied via settings

    def get(self, request):
        obj = DeviceData.objects.order_by("-timestamp").first()
        if not obj:
            raise NotFound("No temperature data yet.")
        return Response(DeviceDataSerializer(obj).data)
