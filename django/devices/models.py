import uuid

from django.db import models


class Device(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    key_ciphertext = models.BinaryField()
    key_nonce = models.BinaryField()
    next_entry_index = models.PositiveBigIntegerField(default=1)
    enabled = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name


class Measurement(models.Model):
    device = models.ForeignKey(
        Device, on_delete=models.PROTECT, related_name="measurements"
    )
    entry_index = models.PositiveBigIntegerField()
    measurement_name = models.CharField(max_length=100)
    value = models.FloatField()
    measured_at = models.DateTimeField()
    received_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["device_id", "entry_index"]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "entry_index"],
                name="devices_unique_measurement_entry_index",
            )
        ]
        indexes = [
            models.Index(fields=["device", "-entry_index"]),
        ]
