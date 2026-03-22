from django.urls import path
from . import views

urlpatterns = [
    # we’ll fill these in next:
    path("token/", views.get_nats_token, name="issue_token"),
    path("perms/", views.get_nats_permissions, name="get_permissions"),
]