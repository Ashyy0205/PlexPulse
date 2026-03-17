import logging
import os
import shutil
from datetime import datetime, timezone

from plexapi.server import PlexServer
from sqlalchemy.orm import Session

from alerts import evaluate_alerts
from database import SessionLocal
from models import DiskSnapshot, Library, Setting, Snapshot

log = logging.getLogger(__name__)


def _normalise_url(url: str) -> str:
    """Prepend http:// if the URL has no scheme."""
    url = url.strip()
    if url and not url.startswith(("http://", "https://")):
        url = "http://" + url
    return url.rstrip("/")


def _get_plex() -> PlexServer:
    plex_url   = _normalise_url(os.environ.get("PLEX_URL", ""))
    plex_token = os.environ.get("PLEX_TOKEN", "")

    # Fall back to DB when env vars are not set (OAuth-configured installs)
    if not plex_url or not plex_token:
        db: Session = SessionLocal()
        try:
            def _get(key: str) -> str:
                row = db.query(Setting).filter(Setting.key == key).first()
                return row.value if row else ""
            if not plex_url:
                plex_url   = _normalise_url(_get("PLEX_URL"))
            if not plex_token:
                plex_token = _get("PLEX_TOKEN")
        finally:
            db.close()

    if not plex_url or not plex_token:
        raise RuntimeError("PLEX_URL and PLEX_TOKEN are not configured.")

    return PlexServer(plex_url, plex_token)


def _section_size_bytes(section) -> int:
    """
    Sum the file sizes of every media file in a Plex library section.

    section.all() returns top-level objects (Movie, Show, Artist).  Only
    Movie/Episode/Track objects have .media[].parts[].size, so for show and
    music sections we must fetch at the leaf level.
    """
    section_type = getattr(section, "type", "")
    if section_type == "show":
        items = section.all(libtype="episode")
    elif section_type in ("artist", "music"):
        items = section.all(libtype="track")
    else:
        items = section.all()   # movie, photo, etc.

    total = 0
    for item in items:
        try:
            for media in getattr(item, "media", []):
                for part in getattr(media, "parts", []):
                    total += getattr(part, "size", 0) or 0
        except Exception as exc:  # noqa: BLE001
            log.debug("Could not read size for item %r: %s", getattr(item, "title", "?"), exc)
    return total


def _resolve_mount(path: str) -> str:
    """Walk up from *path* until we find a mount point, fall back to '/'."""
    if not path:
        return "/"
    candidate = path
    while candidate != os.path.dirname(candidate):
        if os.path.ismount(candidate):
            return candidate
        candidate = os.path.dirname(candidate)
    return "/"


def _collect_mounts(plex: PlexServer) -> set[str]:
    """
    Return the set of mount points to snapshot disk usage for.

    Priority order:
      1. MONITOR_PATHS env var — comma-separated list of paths the user wants
         to track (e.g. "/mnt/user,/mnt/cache").  These are used as-is if they
         exist inside the container.
      2. /mnt/user — the Unraid merged-array path, used automatically when
         present (covers the common Unraid case without any config).
      3. Plex library locations — only paths that are actually accessible
         inside this container are included.
    """
    # 1. Explicit env-var override
    # Support both the combined MONITOR_PATHS and the per-library vars
    # MONITOR_PATH_MOVIES / MONITOR_PATH_TV / MONITOR_PATH_MUSIC set by the
    # Unraid template.  Merge all of them together.
    per_lib = [
        os.environ.get("MONITOR_PATH_MOVIES", "").strip(),
        os.environ.get("MONITOR_PATH_TV",     "").strip(),
        os.environ.get("MONITOR_PATH_MUSIC",  "").strip(),
    ]
    combined_env = os.environ.get("MONITOR_PATHS", "").strip()
    raw_paths = [p for p in per_lib + [combined_env] if p]
    all_paths = [p.strip() for entry in raw_paths for p in entry.split(",") if p.strip()]

    if all_paths:
        mounts: set[str] = set()
        for path in all_paths:
            if path and os.path.exists(path):
                mounts.add(_resolve_mount(path))
            elif path:
                log.warning("MONITOR_PATHS entry %r does not exist in container — skipping.", path)
        if mounts:
            return mounts

    # 2. Unraid default: /mnt/user (merged array view)
    if os.path.exists("/mnt/user"):
        log.debug("Using /mnt/user as disk monitor target (Unraid default).")
        return {_resolve_mount("/mnt/user")}

    # 3. Derive from Plex library locations (only paths visible in this container)
    mounts = set()
    try:
        for section in plex.library.sections():
            for location in section.locations:
                if os.path.exists(location):
                    mounts.add(_resolve_mount(location))
                else:
                    log.debug(
                        "Plex location %r not accessible in container — skipping.",
                        location,
                    )
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not read library locations: %s", exc)

    if not mounts:
        log.warning(
            "No accessible disk paths found. Set the MONITOR_PATHS environment "
            "variable (e.g. MONITOR_PATHS=/mnt/user) or mount /mnt into the container."
        )

    return mounts


def collect() -> dict:
    """
    Collect a snapshot from Plex and write it to the database.

    Returns a summary dict:
        {"libraries_snapshotted": N, "mounts_snapshotted": N, "collected_at": <ISO str>}
    """
    collected_at = datetime.now(timezone.utc)
    db: Session = SessionLocal()

    libraries_snapshotted = 0
    mounts_snapshotted = 0

    try:
        plex = _get_plex()
        sections = plex.library.sections()

        # ── Library snapshots ──────────────────────────────────────────────
        for section in sections:
            try:
                item_count = len(section.all())
                total_size = _section_size_bytes(section)

                lib = db.query(Library).filter_by(plex_library_key=str(section.key)).first()
                if lib is None:
                    # Library exists in Plex but not in DB (e.g. startup connection
                    # failed). Create it now so the snapshot is not lost.
                    log.info(
                        "Auto-registering library key %s (%s) into DB.",
                        section.key,
                        section.title,
                    )
                    lib = Library(
                        plex_library_key=str(section.key),
                        name=section.title,
                        type=section.type,
                        created_at=datetime.now(timezone.utc),
                    )
                    db.add(lib)
                    db.flush()  # populate lib.id before creating snapshot

                snapshot = Snapshot(
                    library_id=lib.id,
                    captured_at=collected_at,
                    item_count=item_count,
                    total_size_bytes=total_size,
                )
                db.add(snapshot)
                libraries_snapshotted += 1
                log.info(
                    "Snapshot: library=%r  items=%d  size=%d bytes",
                    lib.name,
                    item_count,
                    total_size,
                )

            except Exception as exc:  # noqa: BLE001
                log.error(
                    "Failed to snapshot library %r (key=%s): %s",
                    getattr(section, "title", "?"),
                    getattr(section, "key", "?"),
                    exc,
                )

        # ── Disk snapshots ─────────────────────────────────────────────────
        mounts = _collect_mounts(plex)
        for mount in sorted(mounts):
            try:
                usage = shutil.disk_usage(mount)
                disk_snap = DiskSnapshot(
                    mount_point=mount,
                    captured_at=collected_at,
                    total_bytes=usage.total,
                    used_bytes=usage.used,
                    free_bytes=usage.free,
                )
                db.add(disk_snap)
                mounts_snapshotted += 1
                log.info(
                    "Disk snapshot: mount=%r  total=%d  used=%d  free=%d",
                    mount,
                    usage.total,
                    usage.used,
                    usage.free,
                )
            except Exception as exc:  # noqa: BLE001
                log.error("Failed to collect disk usage for %r: %s", mount, exc)

        db.commit()

        # Evaluate alert rules against the freshly committed snapshot data.
        # Wrapped separately so an alert failure never rolls back snapshot data.
        try:
            evaluate_alerts(db)
        except Exception as exc:  # noqa: BLE001
            log.error("Alert evaluation failed: %s", exc)

    except Exception as exc:  # noqa: BLE001
        log.error("Collection run failed: %s", exc)
        db.rollback()
    finally:
        db.close()

    summary = {
        "libraries_snapshotted": libraries_snapshotted,
        "mounts_snapshotted": mounts_snapshotted,
        "collected_at": collected_at.isoformat(),
    }
    log.info("Collection complete: %s", summary)
    return summary
