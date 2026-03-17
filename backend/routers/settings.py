import logging
from urllib.parse import urlparse

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


def _get_setting(key: str, db: Session) -> str | None:
    row = db.query(Setting).filter(Setting.key == key).first()
    return row.value if row else None


def _try_connect(url: str, token: str) -> tuple[bool, str | None]:
    """Attempt a Plex connection. Returns (success, server_name_or_None)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="PLEX_URL must use http or https.")
    try:
        server = PlexServer(url.rstrip("/"), token)
        plex_state.set_connection(server, True)
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
            plex_ok, server_name = _try_connect(url, token)
        else:
            plex_state.set_connection(None, False)
            plex_ok = False

    return SettingsUpdateResponse(
        updated_keys=updated,
        plex_reconnected=plex_reconnected,
        plex_connection_ok=plex_ok,
        plex_server_name=server_name,
    )
