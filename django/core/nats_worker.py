# core/nats_worker.py
import asyncio
import nats
from nats.js.api import ConsumerConfig, DeliverPolicy, AckPolicy
import os

NATS_URL = os.getenv("NATS_URL","nats://localhost:4222")
NATS_USER = os.getenv("NATS_USER", "auth")
NATS_PASS = os.getenv("NATS_PASS", "auth")
STREAM = "events"
SUBJECT = "device.temperature"
DURABLE = "django_events"
QUEUE = "django_workers"

async def nats_listener():
    nc = await nats.connect(
        NATS_URL,
        user=NATS_USER,
        password=NATS_PASS
        )
    js = nc.jetstream()

    # Make sure the consumer exists and starts from the beginning
    await js.add_consumer(
        STREAM,
        ConsumerConfig(
            durable_name=DURABLE,
            deliver_policy=DeliverPolicy.ALL,   # <-- start at beginning
            ack_policy=AckPolicy.EXPLICIT,
        ),
    )

    # Queue group + durable consumer
    sub = await js.subscribe(
        SUBJECT,
        queue=QUEUE,
        durable=DURABLE,
        stream=STREAM,
    )

    try:
        while True:
            msg = await sub.next_msg()
            data = msg.data.decode()
            # TODO: process message (call Django models/services here)
            print("got message:", data)
            await msg.ack()
    finally:
        await nc.drain()
