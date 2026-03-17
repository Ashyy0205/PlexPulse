import logging
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from plexapi.exceptions import Unauthorized
from plexapi.server import PlexServer
from pydantic import BaseModel
from sqlalchemy.orm import Session

import plex_state
from database import get_db
from models import Setting

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])

_PLEX_CRED_KEYS = {"PLEX_URL", "PLEX_TOKEN"}


# ── Response models ────────────────────────────────────────────────────────────

class SettingsResponse(BaseModel):
    settings: dict[str, str]


class SettingsUpdateRequest(BaseModel):
    settings: dict[str, str]


class SettingsUpdateResponse(BaseModel):
    updated_keys: list[str]
    plex_reconnected: bool | None = None
    plex_connection_ok: bool | None = None
    plex_server_name: str | None = None


# ── Helpers ────────────────────────────────────────────────────────────────────

def _mask_token(value: str) -> str:
    """Show only the last 4 characters of a Plex token."""
    if len(value) <= 4:
        return "*" * len(value)
    return "*" * (len(value) - 4) + value[-4:]


def _normalise_url(url: str) -> str:
    """Prepend http:// if the URL has no scheme."""
    url = url.strip()
    if url and not url.startswith(("http://", "https://")):
        url = "http://" + url
    return url.rstrip("/")


def _get_setting(key: str, db: Session) -> str | None:
    row = db.query(Setting).filter(Setting.key == key).first()
    return row.value if row else None


def _upsert_setting(key: str, value: str, db: Session) -> None:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))


def _delete_setting(key: str, db: Session) -> None:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        db.delete(row)


def _try_connect(url: str, token: str, db: Session | None = None) -> tuple[bool, str | None]:
    """Attempt a Plex connection. Returns (success, server_name_or_None)."""
    url = _normalise_url(url)
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="PLEX_URL must use http or https.")
    try:
        server = PlexServer(url.rstrip("/"), token)
        plex_state.set_connection(server, True)
        if db is not None:
            _upsert_setting("PLEX_SERVER_NAME", server.friendlyName, db)
        log.info("Plex reconnected: %s (version %s)", server.friendlyName, server.version)
        return True, server.friendlyName
    except Unauthorized:
        plex_state.set_connection(None, False)
        log.warning("Plex reconnect failed: invalid token.")
        return False, None
    except Exception as exc:  # noqa: BLE001
        plex_state.set_connection(None, False)
        log.warning("Plex reconnect failed: %s", exc)
        return False, None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("", response_model=SettingsResponse)
def get_settings(db: Session = Depends(get_db)):
    rows = db.query(Setting).order_by(Setting.key).all()
    result: dict[str, str] = {}
    for row in rows:
        if row.key == "PLEX_TOKEN":
            result[row.key] = _mask_token(row.value)
        else:
            result[row.key] = row.value
    return SettingsResponse(settings=result)


@router.put("", response_model=SettingsUpdateResponse)
def update_settings(body: SettingsUpdateRequest, db: Session = Depends(get_db)):
    updated: list[str] = []

    for key, value in body.settings.items():
        # Normalise Plex URL before storing
        if key == "PLEX_URL" and value:
            value = _normalise_url(value)
        row = db.query(Setting).filter(Setting.key == key).first()
        if row is None:
            db.add(Setting(key=key, value=value))
        else:
            row.value = value
        updated.append(key)

    db.commit()

    # Re-test Plex if credentials were touched
    plex_reconnected = None
    plex_ok = None
    server_name = None

    if _PLEX_CRED_KEYS & set(body.settings.keys()):
        plex_reconnected = True
        url = _get_setting("PLEX_URL", db) or ""
        token = _get_setting("PLEX_TOKEN", db) or ""
        if url and token:
            plex_ok, server_name = _try_connect(url, token, db)
            if plex_ok:
                db.commit()
        else:
            plex_state.set_connection(None, False)
            plex_ok = False

    return SettingsUpdateResponse(
        updated_keys=updated,
        plex_reconnected=plex_reconnected,
        plex_connection_ok=plex_ok,
        plex_server_name=server_name,
    )


# ── Plex OAuth router ──────────────────────────────────────────────────────────

auth_router = APIRouter(prefix="/api/v1/auth/plex", tags=["plex-auth"])

_PLEX_TV_BASE = "https://plex.tv/api/v2"
_PLEX_TV_HEADERS = {
    "Accept":         "application/json",
    "X-Plex-Product": "PlexPulse",
    "X-Plex-Version": "1.0",
}


def _get_or_create_client_id(db: Session) -> str:
    row = db.query(Setting).filter(Setting.key == "PLEX_CLIENT_ID").first()
    if row:
        return row.value
    client_id = str(uuid.uuid4())
    db.add(Setting(key="PLEX_CLIENT_ID", value=client_id))
    db.commit()
    return client_id


@auth_router.post("/start")
def start_plex_oauth(db: Session = Depends(get_db)):
    """Begin a Plex OAuth PIN flow. Returns the URL to open in the browser."""
    client_id = _get_or_create_client_id(db)
    headers = {**_PLEX_TV_HEADERS, "X-Plex-Client-Identifier": client_id}
    try:
        with httpx.Client(timeout=10) as http:
            resp = http.post(
                f"{_PLEX_TV_BASE}/pins",
                headers=headers,
                data={"strong": "true"},
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"Plex.tv returned {exc.response.status_code}.")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Plex.tv unreachable: {exc}")

    pin_data = resp.json()
    pin_id   = str(pin_data["id"])
    pin_code = pin_data["code"]

    _upsert_setting("PLEX_OAUTH_PIN_ID",   pin_id,   db)
    _upsert_setting("PLEX_OAUTH_PIN_CODE", pin_code, db)
    db.commit()

    auth_url = (
        f"https://app.plex.tv/auth"
        f"#?clientID={client_id}"
        f"&code={pin_code}"
        f"&context[device][product]=PlexPulse"
    )
    return {"auth_url": auth_url}


@auth_router.get("/poll")
def poll_plex_oauth(db: Session = Depends(get_db)):
    """Poll Plex.tv to see if the user completed the OAuth flow."""
    pin_id_row = db.query(Setting).filter(Setting.key == "PLEX_OAUTH_PIN_ID").first()
    if not pin_id_row:
        raise HTTPException(status_code=400, detail="No OAuth flow in progress.")

    client_id = _get_or_create_client_id(db)
    headers   = {**_PLEX_TV_HEADERS, "X-Plex-Client-Identifier": client_id}
    try:
        with httpx.Client(timeout=10) as http:
            resp = http.get(
                f"{_PLEX_TV_BASE}/pins/{pin_id_row.value}",
                headers=headers,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Plex.tv unreachable: {exc}")

    if resp.status_code == 404:
        _delete_setting("PLEX_OAUTH_PIN_ID",   db)
        _delete_setting("PLEX_OAUTH_PIN_CODE", db)
        db.commit()
        return {"authenticated": False, "expired": True}

    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"Plex.tv returned {exc.response.status_code}.")

    data       = resp.json()
    auth_token = data.get("authToken")

    if not auth_token:
        # Check whether the pin has passed its expiry time
        expires_at = data.get("expiresAt")
        if expires_at:
            try:
                exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                if exp < datetime.now(timezone.utc):
                    _delete_setting("PLEX_OAUTH_PIN_ID",   db)
                    _delete_setting("PLEX_OAUTH_PIN_CODE", db)
                    db.commit()
                    return {"authenticated": False, "expired": True}
            except Exception:  # noqa: BLE001
                pass
        return {"authenticated": False}

    # Token received — persist, clear temp state, attempt Plex connection
    _upsert_setting("PLEX_TOKEN", auth_token, db)
    _delete_setting("PLEX_OAUTH_PIN_ID",   db)
    _delete_setting("PLEX_OAUTH_PIN_CODE", db)
    db.commit()

    plex_url    = _normalise_url(_get_setting("PLEX_URL", db) or "")
    server_name = None
    if plex_url:
        ok, server_name = _try_connect(plex_url, auth_token, db)
        if ok:
            db.commit()

    return {
        "authenticated": True,
        "server_name":   server_name,
        "masked_token":  _mask_token(auth_token),
    }


@auth_router.post("/disconnect")
def disconnect_plex(db: Session = Depends(get_db)):
    """Remove the stored Plex token and clear the active connection."""
    _delete_setting("PLEX_TOKEN",       db)
    _delete_setting("PLEX_SERVER_NAME", db)
    db.commit()
    plex_state.set_connection(None, False)
    return {"disconnected": True}
