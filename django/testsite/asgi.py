# project/asgi.py
import os
import asyncio
from contextlib import suppress

from django.core.asgi import get_asgi_application
from ..core.nats_worker import nats_listener

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")

django_asgi_app = get_asgi_application()


class LifespanApp:
    def __init__(self, app):
        self.app = app
        self._task = None

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            # Handle uvicorn startup/shutdown
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    # Start NATS listener in background
                    self._task = asyncio.create_task(nats_listener())
                    await send({"type": "lifespan.startup.complete"})

                elif message["type"] == "lifespan.shutdown":
                    if self._task:
                        self._task.cancel()
                        with suppress(asyncio.CancelledError):
                            await self._task
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        else:
            # Normal HTTP / websocket traffic goes to Django
            await self.app(scope, receive, send)


application = LifespanApp(django_asgi_app)
