"""
Shared Plex connection state.

Both main.py (startup) and routers/settings.py (reconnect on credential update)
mutate this module's globals so all other modules always read the current state.
"""
from __future__ import annotations

from plexapi.server import PlexServer

_plex: PlexServer | None = None
_plex_connected: bool = False


def get_plex() -> PlexServer | None:
    return _plex


def is_connected() -> bool:
    return _plex_connected


def set_connection(server: PlexServer | None, connected: bool) -> None:
    global _plex, _plex_connected
    _plex = server
    _plex_connected = connected
