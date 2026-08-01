from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class CurrentUserView(APIView):
    permission_classes = [IsAuthenticated]

    def get_authenticate_header(self, request):
        return "Bearer"

    def get(self, request):
        return Response({"can_add_devices": request.user.is_staff})
