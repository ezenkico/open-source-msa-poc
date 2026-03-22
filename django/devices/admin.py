from django.contrib import admin
from .models import DeviceData

@admin.register(DeviceData)
class DeviceDataAdmin(admin.ModelAdmin):
    list_display = ("id", "temperature", "timestamp")
    list_filter = ("timestamp",)
    ordering = ("-timestamp",)