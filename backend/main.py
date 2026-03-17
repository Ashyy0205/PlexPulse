import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from plexapi.exceptions import Unauthorized
from plexapi.server import PlexServer
from pydantic import BaseModel
from sqlalchemy.orm import Session
from starlette.requests import Request

from database import create_tables, get_db
from models import DiskSnapshot, Library, Snapshot
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


# ── Consistent error shape ─────────────────────────────────────────────────────

@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
    return JSONResponse(status_code=exc.status_code, content={"error": detail, "detail": detail})


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": "Validation error", "detail": exc.errors()})

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


@app.post("/api/v1/collect")
def trigger_collect():
    """Manually trigger a collection snapshot."""
    try:
        result = collect()
        return result
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v1/stats")
def get_stats(db: Session = Depends(get_db)):
    snapshot_count = db.query(Snapshot).count()
    disk_snapshot_count = db.query(DiskSnapshot).count()
    db_path = "/data/plexpulse.db"
    db_size = os.path.getsize(db_path) if os.path.exists(db_path) else 0
    return {
        "snapshot_count": snapshot_count + disk_snapshot_count,
        "db_size_bytes": db_size,
    }


class _TestConnectionBody(BaseModel):
    plex_url: str
    plex_token: str


@app.post("/api/v1/test-connection")
def test_plex_connection(body: _TestConnectionBody):
    parsed = urlparse(body.plex_url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="PLEX_URL must use http or https.")
    if not parsed.netloc:
        raise HTTPException(status_code=400, detail="PLEX_URL is not a valid URL.")
    try:
        server = PlexServer(body.plex_url.rstrip("/"), body.plex_token)
        return {"ok": True, "server_name": server.friendlyName, "version": server.version}
    except Unauthorized:
        return {"ok": False, "detail": "Invalid Plex token."}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "detail": str(exc)}


# ── Static files + SPA catch-all ──────────────────────────────────────────────
# Must be mounted AFTER all API routes so /api/* is never shadowed.
_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

if os.path.isdir(_STATIC_DIR):
    # Serve hashed assets (JS/CSS chunks) directly
    app.mount("/assets", StaticFiles(directory=os.path.join(_STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        """Return index.html for any path that isn't a known API route."""
        file_path = os.path.join(_STATIC_DIR, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(_STATIC_DIR, "index.html"))

