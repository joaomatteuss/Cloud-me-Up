"""
URL configuration for scotty project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
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
from django.urls import path
from django.shortcuts import redirect
from files.views import (
    UploadView,
    DownloadView,
    put_object,
    get_object,
    google_start,
    google_callback,
    gdrive_put_object,
    gdrive_get_object,
)

def home(request):
    # Optional: redirect "/" to "/upload/"
    return redirect("/upload/")

urlpatterns = [
    path("",home),
    path('admin/', admin.site.urls),
	path("upload/", UploadView.as_view(), name="upload"),
    path("download/", DownloadView.as_view(), name="download"),


    # Private cloud provider API
    path("api/objects/<path:object_id>/get", get_object, name="custom_get"),
    path("api/objects/<path:object_id>", put_object, name="custom_put"),

    # Google OAuth
    path("oauth/google/start", google_start, name="google_start"),
    path("oauth/google/callback", google_callback, name="google_callback"),

    # Google Drive provider
    path("api/gdrive/objects/<path:object_id>", gdrive_put_object, name="gdrive_put"),     # PUT ciphertext -> Drive
    path("api/gdrive/files/<str:file_id>/get", gdrive_get_object, name="gdrive_get"),      # GET ciphertext <- Drive
]
