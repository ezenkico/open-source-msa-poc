from django.urls import path

from .views import DeviceListCreateView, DeviceRotateKeyView


urlpatterns = [
    path("devices/", DeviceListCreateView.as_view()),
    path("devices/<uuid:device_id>/rotate-key/", DeviceRotateKeyView.as_view()),
]
