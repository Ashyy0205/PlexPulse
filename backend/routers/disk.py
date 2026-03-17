from datetime import datetime, timedelta, timezone
from typing import Literal

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from scipy import stats
from sqlalchemy.orm import Session

from database import get_db
from models import DiskSnapshot

router = APIRouter(prefix="/api/v1/disk", tags=["disk"])

# ── Response models ────────────────────────────────────────────────────────────

class DiskSummary(BaseModel):
    mount_point: str
    total_bytes: int
    used_bytes: int
    free_bytes: int
    captured_at: datetime
    percent_used: float


class DiskPoint(BaseModel):
    captured_at: datetime
    total_bytes: int
    used_bytes: int
    free_bytes: int


class ForecastPoint(BaseModel):
    date: datetime
    free_bytes: float


class DiskForecast(BaseModel):
    projected_exhaustion_date: datetime | None
    days_remaining: int | None
    monthly_growth_bytes: float
    confidence_low: list[ForecastPoint]
    confidence_high: list[ForecastPoint]
    forecast_points: list[ForecastPoint]
    insufficient_data: bool = False


# ── Helpers ────────────────────────────────────────────────────────────────────

_RANGE_DAYS: dict[str, int | None] = {
    "1m": 30,
    "3m": 90,
    "6m": 180,
    "1y": 365,
    "max": None,
}

_FORECAST_STEP_DAYS = 7  # granularity of forecast points


def _ensure_aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _latest_per_mount(db: Session) -> list[DiskSnapshot]:
    """Return the most recent DiskSnapshot row for each unique mount_point."""
    subq = (
        db.query(
            DiskSnapshot.mount_point,
            DiskSnapshot.captured_at.label("max_captured_at"),
        )
        .group_by(DiskSnapshot.mount_point)
        .subquery()
    )
    return (
        db.query(DiskSnapshot)
        .join(
            subq,
            (DiskSnapshot.mount_point == subq.c.mount_point)
            & (DiskSnapshot.captured_at == subq.c.max_captured_at),
        )
        .all()
    )


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[DiskSummary])
def list_disk(db: Session = Depends(get_db)):
    rows = _latest_per_mount(db)
    results: list[DiskSummary] = []
    for row in rows:
        pct = round(row.used_bytes / row.total_bytes * 100, 2) if row.total_bytes else 0.0
        results.append(
            DiskSummary(
                mount_point=row.mount_point,
                total_bytes=row.total_bytes,
                used_bytes=row.used_bytes,
                free_bytes=row.free_bytes,
                captured_at=_ensure_aware(row.captured_at),
                percent_used=pct,
            )
        )
    return results


@router.get("/snapshots", response_model=list[DiskPoint])
def get_disk_snapshots(
    mount: str = Query("/", description="Mount point path"),
    range: Literal["1m", "3m", "6m", "1y", "max"] = "6m",
    db: Session = Depends(get_db),
):
    query = db.query(DiskSnapshot).filter(DiskSnapshot.mount_point == mount)

    days = _RANGE_DAYS[range]
    if days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        query = query.filter(DiskSnapshot.captured_at >= cutoff)

    rows = query.order_by(DiskSnapshot.captured_at.asc()).all()
    if not rows:
        raise HTTPException(status_code=404, detail=f"No disk snapshots found for mount '{mount}'.")

    return [
        DiskPoint(
            captured_at=_ensure_aware(row.captured_at),
            total_bytes=row.total_bytes,
            used_bytes=row.used_bytes,
            free_bytes=row.free_bytes,
        )
        for row in rows
    ]


@router.get("/forecast", response_model=DiskForecast)
def get_disk_forecast(
    mount: str = Query("/", description="Mount point path"),
    days: int = Query(180, ge=7, le=3650, description="How far ahead to forecast"),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(DiskSnapshot)
        .filter(DiskSnapshot.mount_point == mount)
        .order_by(DiskSnapshot.captured_at.asc())
        .all()
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"No disk snapshots found for mount '{mount}'.")

    now = datetime.now(timezone.utc)
    span_days = (_ensure_aware(rows[-1].captured_at) - _ensure_aware(rows[0].captured_at)).days
    insufficient = span_days < 14 or len(rows) < 3

    # ── Build forecast ─────────────────────────────────────────────────────
    # X = elapsed seconds from first point (float), Y = free_bytes
    t0 = _ensure_aware(rows[0].captured_at).timestamp()
    xs = np.array([(_ensure_aware(r.captured_at).timestamp() - t0) for r in rows], dtype=float)
    ys = np.array([r.free_bytes for r in rows], dtype=float)

    if insufficient:
        # Fallback: 7-day average daily change
        window = [r for r in rows if (_ensure_aware(r.captured_at) >= now - timedelta(days=7))]
        if len(window) >= 2:
            delta_bytes = window[-1].free_bytes - window[0].free_bytes
            delta_days = max(
                (_ensure_aware(window[-1].captured_at) - _ensure_aware(window[0].captured_at)).total_seconds() / 86400,
                1,
            )
            daily_rate = delta_bytes / delta_days  # bytes/day (negative = filling up)
        else:
            daily_rate = 0.0

        # Express as linear: free(t) = latest_free + daily_rate * elapsed_days
        latest_free = rows[-1].free_bytes
        monthly_growth = daily_rate * 30  # bytes gained per month (negative = growth in usage)

        forecast_points: list[ForecastPoint] = []
        exhaustion_date = None
        for step in range(0, days + 1, _FORECAST_STEP_DAYS):
            future_dt = now + timedelta(days=step)
            projected = latest_free + daily_rate * step
            forecast_points.append(ForecastPoint(date=future_dt, free_bytes=projected))
            if projected <= 0 and exhaustion_date is None:
                exhaustion_date = future_dt

        days_remaining = int((exhaustion_date - now).days) if exhaustion_date else None

        return DiskForecast(
            projected_exhaustion_date=exhaustion_date,
            days_remaining=days_remaining,
            monthly_growth_bytes=abs(monthly_growth),
            confidence_low=forecast_points,
            confidence_high=forecast_points,
            forecast_points=forecast_points,
            insufficient_data=True,
        )

    # ── Full linear regression via scipy ──────────────────────────────────
    slope, intercept, r_value, p_value, std_err = stats.linregress(xs, ys)

    # Bytes consumed per month (30 days)
    monthly_growth = abs(slope * 86_400 * 30)

    # Build 95% prediction interval
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

        # Prediction interval half-width
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
