from django.contrib import admin

from .models import Device, Measurement

admin.site.register(Device)
admin.site.register(Measurement)
