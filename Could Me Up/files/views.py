import os
from django.conf import settings

if settings.DEBUG:
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

import io
import json
from pathlib import Path

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.shortcuts import redirect
from django.views.decorators.csrf import csrf_exempt

from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload, MediaIoBaseDownload

from django.views.generic import TemplateView
from django.shortcuts import render
from django.http import JsonResponse, HttpResponse, Http404
from django.views.decorators.csrf import csrf_exempt

from pathlib import Path

# Where the "private cloud provider" stores objects (server-side storage)
PRIVATE_STORE_DIR = Path(__file__).resolve().parent.parent / "private_store"
PRIVATE_STORE_DIR.mkdir(parents=True, exist_ok=True)


class UploadView(TemplateView):
    def get(self, request):
        return render(request, "upload.html", {})


class DownloadView(TemplateView):
    def get(self, request):
        return render(request, "download.html", {})


@csrf_exempt
def put_object(request, object_id: str):
    """
    Minimal "private cloud" API: store raw bytes sent by the client.
    This simulates an internal/private storage provider controlled by the organization.
    """
    if request.method != "PUT":
        return JsonResponse({"error": "Use PUT"}, status=405)

    # Optional: simple API key check for demo
    # expected = "demo"
    # got = request.headers.get("X-API-Key", "")
    # if expected and got != expected:
    #     return JsonResponse({"error": "Invalid key"}, status=401)

    data = request.body
    if data is None:
        return JsonResponse({"error": "Empty body"}, status=400)

    path = PRIVATE_STORE_DIR / object_id
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)

    return JsonResponse({"ok": True, "id": object_id, "size": len(data)})


def get_object(request, object_id: str):
    """
    Minimal "private cloud" API: retrieve bytes for an object_id.
    """
    if request.method != "GET":
        return JsonResponse({"error": "Use GET"}, status=405)

    path = PRIVATE_STORE_DIR / object_id
    if not path.exists():
        raise Http404("Object not found")

    resp = HttpResponse(path.read_bytes(), content_type="application/octet-stream")
    resp["Content-Disposition"] = f'attachment; filename="{path.name}"'
    return resp

TOKEN_PATH = Path(settings.BASE_DIR) / "google_token.json"
CLIENT_SECRETS_PATH = Path(settings.BASE_DIR) / "client_secret.json"

GOOGLE_SCOPES = ["https://www.googleapis.com/auth/drive.file"]
GOOGLE_REDIRECT_URI = "http://127.0.0.1:8000/oauth/google/callback"


def _load_token():
    if TOKEN_PATH.exists():
        return json.loads(TOKEN_PATH.read_text(encoding="utf-8"))
    return None


def _save_token(data: dict):
    TOKEN_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def google_start(request):
    if not CLIENT_SECRETS_PATH.exists():
        return HttpResponse("Missing client_secret.json next to manage.py", status=500)

    flow = Flow.from_client_secrets_file(
        str(CLIENT_SECRETS_PATH),
        scopes=GOOGLE_SCOPES,
        redirect_uri=GOOGLE_REDIRECT_URI,
    )

    auth_url, state = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        include_granted_scopes="true",
    )
    request.session["google_state"] = state
    return redirect(auth_url)


def google_callback(request):
    state = request.session.get("google_state")
    flow = Flow.from_client_secrets_file(
        str(CLIENT_SECRETS_PATH),
        scopes=GOOGLE_SCOPES,
        state=state,
        redirect_uri=GOOGLE_REDIRECT_URI,
    )
    flow.fetch_token(authorization_response=request.build_absolute_uri())
    creds = flow.credentials

    _save_token({
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes or []),
    })

    return HttpResponse("Google Drive connected. You can close this tab.")


def _gdrive_service():
    t = _load_token()
    if not t:
        raise RuntimeError("Google not connected. Visit /oauth/google/start first.")

    creds = Credentials(
        token=t["token"],
        refresh_token=t.get("refresh_token"),
        token_uri=t["token_uri"],
        client_id=t["client_id"],
        client_secret=t["client_secret"],
        scopes=t.get("scopes", GOOGLE_SCOPES),
    )

    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        t["token"] = creds.token
        _save_token(t)

    return build("drive", "v3", credentials=creds)


def _get_or_create_folder(service, name="ScottyChunks"):
    q = f"mimeType='application/vnd.google-apps.folder' and name='{name}' and trashed=false"
    res = service.files().list(q=q, fields="files(id,name)", pageSize=1).execute()
    files = res.get("files", [])
    if files:
        return files[0]["id"]

    folder = service.files().create(
        body={"name": name, "mimeType": "application/vnd.google-apps.folder"},
        fields="id",
    ).execute()
    return folder["id"]


@csrf_exempt
def gdrive_put_object(request, object_id):
    if request.method != "PUT":
        return JsonResponse({"error": "Method not allowed"}, status=405)

    try:
        service = _gdrive_service()
        folder_id = _get_or_create_folder(service)

        data = request.body  # ciphertext bytes
        media = MediaIoBaseUpload(io.BytesIO(data), mimetype="application/octet-stream", resumable=False)

        created = service.files().create(
            body={"name": object_id, "parents": [folder_id]},
            media_body=media,
            fields="id",
        ).execute()

        return JsonResponse({"ok": True, "driveFileId": created["id"]})
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


def gdrive_get_object(request, file_id):
    if request.method != "GET":
        return JsonResponse({"error": "Method not allowed"}, status=405)

    try:
        service = _gdrive_service()
        req = service.files().get_media(fileId=file_id)

        fh = io.BytesIO()
        downloader = MediaIoBaseDownload(fh, req)
        done = False
        while not done:
            _, done = downloader.next_chunk()

        return HttpResponse(fh.getvalue(), content_type="application/octet-stream")
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)