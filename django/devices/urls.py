from django.urls import path

from .views import (
    DeviceListCreateView,
    DeviceRotateKeyView,
    LatestMeasurementView,
    MeasurementIngestView,
    MeasurementListView,
)


urlpatterns = [
    path("devices/", DeviceListCreateView.as_view()),
    path("devices/<uuid:device_id>/rotate-key/", DeviceRotateKeyView.as_view()),
    path(
        "devices/<uuid:device_id>/measurements/latest/",
        LatestMeasurementView.as_view(),
    ),
    path("devices/<uuid:device_id>/measurements/", MeasurementListView.as_view()),
    path("device-measurements/", MeasurementIngestView.as_view()),
]
