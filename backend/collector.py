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
    """Sum the file sizes of every media item in a Plex library section."""
    total = 0
    for item in section.all():
        try:
            # Most media types expose .media[].parts[].size
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
    Derive mount points from Plex location paths.
    Only includes paths that are accessible inside this container.
    Falls back to {'/'} if nothing useful is found.
    """
    mounts: set[str] = set()
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
            "No Plex library paths are accessible inside this container. "
            "To monitor real disk usage on Unraid, add '/mnt:/mnt:ro' as a "
            "volume in the Docker template and restart the container."
        )
        return set()

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
