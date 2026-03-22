"""
URL configuration for testsite project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path, include
from django.db import connection, DatabaseError
#  from mozilla_django_oidc import views as oidc_views
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import AllowAny
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

class HealthzView(APIView):
    authentication_classes = []          # bypass global JWT/Session auth
    permission_classes = [AllowAny]      # allow anyone
    throttle_classes = []                # (optional) no throttling

    def get(self, request):
        try:
            with connection.cursor() as cur:
                cur.execute("SELECT 1;")
        except DatabaseError:
            return Response({"status": "error", "db": "unreachable"}, status=500)
        return Response({"status": "ok"})

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("devices.urls")),
    path("healthz", HealthzView.as_view()),

    # OIDC endpoints
    # path("oidc/authenticate/", oidc_views.OIDCAuthenticationRequestView.as_view(), name="oidc_auth"),
    # path("oidc/callback/", oidc_views.OIDCAuthenticationCallbackView.as_view(), name="oidc_callback"),
    # path("oidc/logout/", oidc_views.OIDCLogoutView.as_view(), name="oidc_logout"),

    # JWT endpoints
    path("api/auth/jwt/", TokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("api/auth/jwt/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    path("api/nats-auth/", include("nats_auth.urls"))
]
