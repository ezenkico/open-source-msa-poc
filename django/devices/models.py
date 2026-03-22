from django.db import models
from django.utils import timezone

# Create your models here.
class DeviceData(models.Model):
    # device_id = models.CharField(max_length=64, db_index=True)
    temperature = models.FloatField()
    timestamp = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        indexes = [
            models.Index(fields=["-timestamp"]),
        ]
        ordering = ["-timestamp"]

    def __str__(self):
        return f"Temperature @ {self.timestamp:%Y-%m-%d %H:%M:%S} = {self.temperature:.2f}°C"