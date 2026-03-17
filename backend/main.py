import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI
from plexapi.exceptions import Unauthorized
from plexapi.server import PlexServer
from sqlalchemy.orm import Session

from database import create_tables, get_db
from models import Library, Snapshot
import plex_state
from routers.libraries import router as libraries_router
from routers.disk import router as disk_router
from routers.summary import router as summary_router
from routers.settings import router as settings_router
from routers.alerts import router as alerts_router
from scheduler import start_scheduler, stop_scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def _upsert_libraries(plex: PlexServer, db: Session) -> int:
    """Sync Plex libraries into the DB and return the count."""
    sections = plex.library.sections()
    for section in sections:
        lib = db.query(Library).filter_by(plex_library_key=str(section.key)).first()
        if lib is None:
            lib = Library(
                plex_library_key=str(section.key),
                name=section.title,
                type=section.type,
                created_at=datetime.now(timezone.utc),
            )
            db.add(lib)
        else:
            lib.name = section.title
            lib.type = section.type
    db.commit()
    return len(sections)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _plex, _plex_connected

    # 1. Initialise database
    create_tables()
    log.info("Database tables ready.")

    # 2. Read env vars
    plex_url = os.environ.get("PLEX_URL", "").rstrip("/")
    plex_token = os.environ.get("PLEX_TOKEN", "")

    # 3. Connect to Plex
    if plex_url and plex_token:
        try:
            server = PlexServer(plex_url, plex_token)
            plex_state.set_connection(server, True)
            log.info("Connected to Plex server: %s (version %s)", server.friendlyName, server.version)

            # 4. Discover and upsert libraries
            db = next(get_db())
            try:
                count = _upsert_libraries(server, db)
                log.info("Found %d Plex librar%s.", count, "ies" if count != 1 else "y")
            finally:
                db.close()

        except Unauthorized:
            log.error("Plex connection failed: invalid token.")
        except Exception as exc:  # noqa: BLE001
            log.error("Plex connection failed: %s", exc)
    else:
        log.warning("PLEX_URL or PLEX_TOKEN not set — skipping Plex connection.")

    # 5. Start the collection scheduler
    start_scheduler()

    yield

    # Shutdown
    stop_scheduler()


app = FastAPI(title="PlexPulse", version="0.1.0", lifespan=lifespan)

app.include_router(libraries_router)
app.include_router(disk_router)
app.include_router(summary_router)
app.include_router(settings_router)
app.include_router(alerts_router)


@app.get("/health")
def health():
    return {"status": "ok", "plex_connected": plex_state.is_connected()}


@app.get("/api/v1/status")
def status(db: Session = Depends(get_db)):
    library_count = db.query(Library).count()
    snapshot_taken = db.query(Snapshot).first() is not None
    server = plex_state.get_plex()

    return {
        "server_name": server.friendlyName if server else None,
        "plex_version": server.version if server else None,
        "library_count": library_count,
        "snapshot_collected": snapshot_taken,
    }

