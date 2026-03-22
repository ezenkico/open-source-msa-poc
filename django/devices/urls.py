from django.urls import path
from .views import TemperatureListView, LatestTemperatureView

urlpatterns = [
    path("temperature", TemperatureListView.as_view(), name="temperature-list"),
    path("temperature/latest/", LatestTemperatureView.as_view(), name="temperature-latest"),
]
