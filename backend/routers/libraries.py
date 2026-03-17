from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Library, Snapshot

router = APIRouter(prefix="/api/v1/libraries", tags=["libraries"])

# ── Response models ────────────────────────────────────────────────────────────

class LibrarySummary(BaseModel):
    id: int
    name: str
    type: str
    item_count: int | None
    total_size_bytes: int | None
    last_captured_at: datetime | None

    model_config = {"from_attributes": True}


class SnapshotPoint(BaseModel):
    captured_at: datetime
    item_count: int
    total_size_bytes: int

    model_config = {"from_attributes": True}


class GrowthStats(BaseModel):
    avg_monthly_growth_bytes: float | None
    avg_monthly_item_growth: float | None
    latest_item_count: int | None
    latest_size_bytes: int | None


# ── Helpers ────────────────────────────────────────────────────────────────────

_RANGE_DAYS: dict[str, int | None] = {
    "1m": 30,
    "3m": 90,
    "6m": 180,
    "1y": 365,
    "max": None,
}


def _get_library_or_404(library_id: int, db: Session) -> Library:
    lib = db.query(Library).filter(Library.id == library_id).first()
    if lib is None:
        raise HTTPException(status_code=404, detail="Library not found.")
    return lib


def _latest_snapshot(library_id: int, db: Session) -> Snapshot | None:
    return (
        db.query(Snapshot)
        .filter(Snapshot.library_id == library_id)
        .order_by(Snapshot.captured_at.desc())
        .first()
    )


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[LibrarySummary])
def list_libraries(db: Session = Depends(get_db)):
    libraries = db.query(Library).order_by(Library.name).all()
    results: list[LibrarySummary] = []
    for lib in libraries:
        snap = _latest_snapshot(lib.id, db)
        results.append(
            LibrarySummary(
                id=lib.id,
                name=lib.name,
                type=lib.type,
                item_count=snap.item_count if snap else None,
                total_size_bytes=snap.total_size_bytes if snap else None,
                last_captured_at=snap.captured_at if snap else None,
            )
        )
    return results


@router.get(
    "/{library_id}/snapshots",
    response_model=list[SnapshotPoint],
)
def get_snapshots(
    library_id: int,
    range: Literal["1m", "3m", "6m", "1y", "max"] = "6m",
    db: Session = Depends(get_db),
):
    _get_library_or_404(library_id, db)

    query = db.query(Snapshot).filter(Snapshot.library_id == library_id)

    days = _RANGE_DAYS[range]
    if days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        query = query.filter(Snapshot.captured_at >= cutoff)

    rows = query.order_by(Snapshot.captured_at.asc()).all()
    return [
        SnapshotPoint(
            captured_at=row.captured_at,
            item_count=row.item_count,
            total_size_bytes=row.total_size_bytes,
        )
        for row in rows
    ]


@router.get("/{library_id}/growth", response_model=GrowthStats)
def get_growth(library_id: int, db: Session = Depends(get_db)):
    _get_library_or_404(library_id, db)

    rows = (
        db.query(Snapshot)
        .filter(Snapshot.library_id == library_id)
        .order_by(Snapshot.captured_at.asc())
        .all()
    )

    if not rows:
        return GrowthStats(
            avg_monthly_growth_bytes=None,
            avg_monthly_item_growth=None,
            latest_item_count=None,
            latest_size_bytes=None,
        )

    latest = rows[-1]

    if len(rows) < 2:
        return GrowthStats(
            avg_monthly_growth_bytes=None,
            avg_monthly_item_growth=None,
            latest_item_count=latest.item_count,
            latest_size_bytes=latest.total_size_bytes,
        )

    # Rolling 30-day deltas: for each consecutive pair, normalise the delta to
    # 30 days so all windows contribute equally regardless of spacing.
    byte_deltas: list[float] = []
    item_deltas: list[float] = []

    for prev, curr in zip(rows, rows[1:]):
        t_prev = prev.captured_at
        t_curr = curr.captured_at

        # Ensure both datetimes are timezone-aware for subtraction
        if t_prev.tzinfo is None:
            t_prev = t_prev.replace(tzinfo=timezone.utc)
        if t_curr.tzinfo is None:
            t_curr = t_curr.replace(tzinfo=timezone.utc)

        elapsed_days = (t_curr - t_prev).total_seconds() / 86_400
        if elapsed_days <= 0:
            continue

        scale = 30.0 / elapsed_days
        byte_deltas.append((curr.total_size_bytes - prev.total_size_bytes) * scale)
        item_deltas.append((curr.item_count - prev.item_count) * scale)

    avg_bytes = sum(byte_deltas) / len(byte_deltas) if byte_deltas else None
    avg_items = sum(item_deltas) / len(item_deltas) if item_deltas else None

    return GrowthStats(
        avg_monthly_growth_bytes=avg_bytes,
        avg_monthly_item_growth=avg_items,
        latest_item_count=latest.item_count,
        latest_size_bytes=latest.total_size_bytes,
    )
