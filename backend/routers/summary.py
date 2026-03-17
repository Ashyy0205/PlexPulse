from datetime import datetime, timedelta, timezone

import numpy as np
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from scipy import stats
from sqlalchemy.orm import Session

from collector import collect
from database import get_db
from models import DiskSnapshot, Library, Snapshot
from routers.disk import DiskForecast, DiskSummary, ForecastPoint, _ensure_aware, _latest_per_mount
from routers.libraries import LibrarySummary, _latest_snapshot

router = APIRouter(prefix="/api/v1", tags=["summary"])

_FORECAST_STEP_DAYS = 7
_FORECAST_WINDOW_DAYS = 365


# ── Response models ────────────────────────────────────────────────────────────

class DashboardSummary(BaseModel):
    libraries: list[LibrarySummary]
    disk_mounts: list[DiskSummary]
    primary_mount_forecast: DiskForecast | None
    total_item_count: int
    combined_monthly_growth_bytes: float
    days_remaining: int | None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_library_summaries(db: Session) -> list[LibrarySummary]:
    libraries = db.query(Library).order_by(Library.name).all()
    result: list[LibrarySummary] = []
    for lib in libraries:
        snap = _latest_snapshot(lib.id, db)
        result.append(
            LibrarySummary(
                id=lib.id,
                name=lib.name,
                type=lib.type,
                item_count=snap.item_count if snap else None,
                total_size_bytes=snap.total_size_bytes if snap else None,
                last_captured_at=_ensure_aware(snap.captured_at) if snap else None,
            )
        )
    return result


def _build_disk_summaries(db: Session) -> list[DiskSummary]:
    rows = _latest_per_mount(db)
    result: list[DiskSummary] = []
    for row in rows:
        pct = round(row.used_bytes / row.total_bytes * 100, 2) if row.total_bytes else 0.0
        result.append(
            DiskSummary(
                mount_point=row.mount_point,
                total_bytes=row.total_bytes,
                used_bytes=row.used_bytes,
                free_bytes=row.free_bytes,
                captured_at=_ensure_aware(row.captured_at),
                percent_used=pct,
            )
        )
    return result


def _build_forecast(mount_point: str, db: Session) -> DiskForecast:
    """Inline the forecast logic from disk.py for a given mount point."""
    rows = (
        db.query(DiskSnapshot)
        .filter(DiskSnapshot.mount_point == mount_point)
        .order_by(DiskSnapshot.captured_at.asc())
        .limit(5000)
        .all()
    )

    now = datetime.now(timezone.utc)

    if not rows:
        return DiskForecast(
            projected_exhaustion_date=None,
            days_remaining=None,
            monthly_growth_bytes=0.0,
            confidence_low=[],
            confidence_high=[],
            forecast_points=[],
            insufficient_data=True,
        )

    span_days = (_ensure_aware(rows[-1].captured_at) - _ensure_aware(rows[0].captured_at)).days
    insufficient = span_days < 14 or len(rows) < 3

    t0 = _ensure_aware(rows[0].captured_at).timestamp()
    xs = np.array([(_ensure_aware(r.captured_at).timestamp() - t0) for r in rows], dtype=float)
    ys = np.array([r.free_bytes for r in rows], dtype=float)

    days = _FORECAST_WINDOW_DAYS

    if insufficient:
        window = [r for r in rows if (_ensure_aware(r.captured_at) >= now - timedelta(days=7))]
        if len(window) >= 2:
            delta_bytes = window[-1].free_bytes - window[0].free_bytes
            delta_days = max(
                (_ensure_aware(window[-1].captured_at) - _ensure_aware(window[0].captured_at)).total_seconds() / 86400,
                1,
            )
            daily_rate = delta_bytes / delta_days
        else:
            daily_rate = 0.0

        latest_free = rows[-1].free_bytes
        monthly_growth = abs(daily_rate * 30)
        forecast_points: list[ForecastPoint] = []
        exhaustion_date = None
        for step in range(0, days + 1, _FORECAST_STEP_DAYS):
            future_dt = now + timedelta(days=step)
            projected = latest_free + daily_rate * step
            forecast_points.append(ForecastPoint(date=future_dt, free_bytes=float(projected)))
            if projected <= 0 and exhaustion_date is None:
                exhaustion_date = future_dt

        days_remaining = int((exhaustion_date - now).days) if exhaustion_date else None
        return DiskForecast(
            projected_exhaustion_date=exhaustion_date,
            days_remaining=days_remaining,
            monthly_growth_bytes=monthly_growth,
            confidence_low=forecast_points,
            confidence_high=forecast_points,
            forecast_points=forecast_points,
            insufficient_data=True,
        )

    slope, intercept, _r, _p, std_err = stats.linregress(xs, ys)
    monthly_growth = abs(slope * 86_400 * 30)

    n = len(xs)
    x_mean = xs.mean()
    ss_xx = np.sum((xs - x_mean) ** 2)
    t_crit = stats.t.ppf(0.975, df=n - 2)
    residuals = ys - (slope * xs + intercept)
    s_err = np.sqrt(np.sum(residuals**2) / (n - 2))

    forecast_points = []
    confidence_low: list[ForecastPoint] = []
    confidence_high: list[ForecastPoint] = []
    exhaustion_date = None
    t_now = now.timestamp() - t0

    for step in range(0, days + 1, _FORECAST_STEP_DAYS):
        future_dt = now + timedelta(days=step)
        x_fut = t_now + step * 86_400
        y_pred = slope * x_fut + intercept
        se_pred = s_err * np.sqrt(1 + 1 / n + (x_fut - x_mean) ** 2 / ss_xx)
        margin = t_crit * se_pred
        forecast_points.append(ForecastPoint(date=future_dt, free_bytes=float(y_pred)))
        confidence_low.append(ForecastPoint(date=future_dt, free_bytes=float(y_pred - margin)))
        confidence_high.append(ForecastPoint(date=future_dt, free_bytes=float(y_pred + margin)))
        if y_pred <= 0 and exhaustion_date is None:
            exhaustion_date = future_dt

    days_remaining = int((exhaustion_date - now).days) if exhaustion_date else None
    return DiskForecast(
        projected_exhaustion_date=exhaustion_date,
        days_remaining=days_remaining,
        monthly_growth_bytes=monthly_growth,
        confidence_low=confidence_low,
        confidence_high=confidence_high,
        forecast_points=forecast_points,
        insufficient_data=False,
    )


def _combined_monthly_growth(db: Session) -> float:
    """Sum the 30-day normalised byte growth across all libraries."""
    total = 0.0
    for lib in db.query(Library).all():
        rows = (
            db.query(Snapshot)
            .filter(Snapshot.library_id == lib.id)
            .order_by(Snapshot.captured_at.asc())
            .limit(5000)
            .all()
        )
        if len(rows) < 2:
            continue
        deltas: list[float] = []
        for prev, curr in zip(rows, rows[1:]):
            t_prev = _ensure_aware(prev.captured_at)
            t_curr = _ensure_aware(curr.captured_at)
            elapsed = (t_curr - t_prev).total_seconds() / 86_400
            if elapsed <= 0:
                continue
            deltas.append((curr.total_size_bytes - prev.total_size_bytes) * 30 / elapsed)
        if deltas:
            total += sum(deltas) / len(deltas)
    return total


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/summary", response_model=DashboardSummary)
def get_summary(db: Session = Depends(get_db)):
    libraries = _build_library_summaries(db)
    disk_mounts = _build_disk_summaries(db)

    # Primary mount = the one with the most used_bytes
    primary_forecast: DiskForecast | None = None
    days_remaining: int | None = None
    if disk_mounts:
        primary = max(disk_mounts, key=lambda d: d.used_bytes)
        primary_forecast = _build_forecast(primary.mount_point, db)
        days_remaining = primary_forecast.days_remaining

    total_items = sum(lib.item_count or 0 for lib in libraries)
    combined_growth = _combined_monthly_growth(db)

    return DashboardSummary(
        libraries=libraries,
        disk_mounts=disk_mounts,
        primary_mount_forecast=primary_forecast,
        total_item_count=total_items,
        combined_monthly_growth_bytes=combined_growth,
        days_remaining=days_remaining,
    )


@router.post("/collect")
def trigger_collect():
    result = collect()
    return result
