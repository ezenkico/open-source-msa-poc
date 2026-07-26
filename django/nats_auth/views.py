from datetime import timedelta

from django.utils import timezone
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
)
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from rest_framework_simplejwt.tokens import AccessToken
from django.conf import settings
import jwt  # from PyJWT (already a dependency of simplejwt)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def get_nats_token(request):
    """
    GET /auth/token/
    Requires the user to already be authenticated (session, basic, or JWT).
    Returns a short-lived JWT to be used as NATS auth token.
    """
    user = request.user

    token = AccessToken.for_user(user)

    # Add whatever claims NATS / your Go service will need:
    token["username"] = user.username
    token["email"] = user.email
    token["is_staff"] = user.is_staff
    token["token_type"] = "nats"

    # Override lifetime to something short (e.g. 5 minutes)
    token.set_exp(from_time=timezone.now(), lifetime=timedelta(minutes=5))

    return Response({"token": str(token)})

@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])  # we do our own JWT check here
def get_nats_permissions(request):
    """
    GET /auth/perms/
    Expects Authorization: Bearer <token>
    Returns allowed/denied pubs/subs for NATS.
    """
    auth_header = request.headers.get("Authorization", "")

    if not auth_header.startswith("Bearer "):
        return Response(
            {"detail": "Missing or invalid Authorization header"},
            status=status.HTTP_401_UNAUTHORIZED,
        )

    raw_token = auth_header.split(" ", 1)[1].strip()

    try:
        payload = jwt.decode(
            raw_token,
            settings.SIMPLE_JWT["SIGNING_KEY"],
            algorithms=[settings.SIMPLE_JWT["ALGORITHM"]],
        )
    except jwt.ExpiredSignatureError:
        return Response({"detail": "Token expired"}, status=status.HTTP_401_UNAUTHORIZED)
    except jwt.InvalidTokenError:
        return Response({"detail": "Invalid token"}, status=status.HTTP_401_UNAUTHORIZED)

    token_type = payload.get("token_type")

    if token_type != "nats":
        return Response({"detail": "Wrong token type"}, status=status.HTTP_401_UNAUTHORIZED)

    return Response(
        {
            "account": "APP",
            "pub": {"allow": [], "deny": ["devices.>"]},
            "sub": {"allow": ["devices.*.measurements"], "deny": []},
        }
    )
