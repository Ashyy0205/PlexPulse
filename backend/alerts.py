"""
Alert evaluation engine.

Called after every successful snapshot collection to check enabled alert rules
against current data and fire notifications when thresholds are breached.
"""
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx
import numpy as np
from scipy import stats as scipy_stats
from sqlalchemy import func
from sqlalchemy.orm import Session

from models import Alert, AlertLog, DiskSnapshot, Library, Snapshot

log = logging.getLogger(__name__)

_COOLDOWN_HOURS = 24
_WEBHOOK_TIMEOUT = 10


# ── Shared utilities ───────────────────────────────────────────────────────────

def _ensure_aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _cooldown_ok(alert: Alert, now: datetime) -> bool:
    """Return True if the alert hasn't fired within the last 24 hours."""
    if alert.last_triggered_at is None:
        return True
    return (now - _ensure_aware(alert.last_triggered_at)) >= timedelta(hours=_COOLDOWN_HOURS)


# ── Data helpers ───────────────────────────────────────────────────────────────

def _latest_disk_snapshots(db: Session) -> list[DiskSnapshot]:
    """Return the most recent DiskSnapshot row for each mount point."""
    subq = (
        db.query(
            DiskSnapshot.mount_point,
            func.max(DiskSnapshot.captured_at).label("max_ts"),
        )
        .group_by(DiskSnapshot.mount_point)
        .subquery()
    )
    return (
        db.query(DiskSnapshot)
        .join(
            subq,
            (DiskSnapshot.mount_point == subq.c.mount_point)
            & (DiskSnapshot.captured_at == subq.c.max_ts),
        )
        .all()
    )


def _days_remaining_for_mount(db: Session, mount: str) -> int | None:
    """
    Estimate days until the given mount is full via linear regression on
    free_bytes history.  Returns None when there is not enough data or when
    the disk is not filling up.
    """
    rows = (
        db.query(DiskSnapshot)
        .filter(DiskSnapshot.mount_point == mount)
        .order_by(DiskSnapshot.captured_at.asc())
        .all()
    )
    if len(rows) < 2:
        return None

    now = datetime.now(timezone.utc)
    span_days = (_ensure_aware(rows[-1].captured_at) - _ensure_aware(rows[0].captured_at)).days

    if span_days < 14 or len(rows) < 3:
        # Insufficient history — use 7-day rolling linear extrapolation
        window = [r for r in rows if _ensure_aware(r.captured_at) >= now - timedelta(days=7)]
        if len(window) < 2:
            return None
        delta_bytes = window[-1].free_bytes - window[0].free_bytes
        delta_days = max(
            (_ensure_aware(window[-1].captured_at) - _ensure_aware(window[0].captured_at)).total_seconds() / 86_400,
            1,
        )
        daily_rate = delta_bytes / delta_days
        if daily_rate >= 0:
            return None  # not filling up
        return int(window[-1].free_bytes / abs(daily_rate))

    t0 = _ensure_aware(rows[0].captured_at).timestamp()
    xs = np.array([(_ensure_aware(r.captured_at).timestamp() - t0) for r in rows], dtype=float)
    ys = np.array([r.free_bytes for r in rows], dtype=float)

    result = scipy_stats.linregress(xs, ys)
    slope: float = float(result.slope)
    intercept: float = float(result.intercept)
    if slope >= 0:
        return None  # not filling up

    t_now = now.timestamp() - t0
    y_now = slope * t_now + intercept
    if y_now <= 0:
        return 0
    secs_to_full = -y_now / slope
    return int(secs_to_full / 86_400)


def _monthly_growth_gb_all_libraries(db: Session) -> float:
    """Sum average monthly storage growth (in GB) across all libraries."""
    libraries = db.query(Library).all()
    total_gb = 0.0
    for lib in libraries:
        rows = (
            db.query(Snapshot)
            .filter(Snapshot.library_id == lib.id)
            .order_by(Snapshot.captured_at.asc())
            .all()
        )
        if len(rows) < 2:
            continue
        byte_deltas: list[float] = []
        for prev, curr in zip(rows, rows[1:]):
            t_prev = _ensure_aware(prev.captured_at)
            t_curr = _ensure_aware(curr.captured_at)
            elapsed_days = (t_curr - t_prev).total_seconds() / 86_400
            if elapsed_days <= 0:
                continue
            byte_deltas.append((curr.total_size_bytes - prev.total_size_bytes) * (30.0 / elapsed_days))
        if byte_deltas:
            total_gb += (sum(byte_deltas) / len(byte_deltas)) / 1e9
    return total_gb


# ── Notification dispatch ──────────────────────────────────────────────────────

def _fire_webhook(alert: Alert, current_value: float, now: datetime) -> bool:
    """Send a webhook POST. Returns True on HTTP 2xx, False otherwise."""
    parsed = urlparse(alert.destination)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        log.warning(
            "Alert %d has an invalid webhook URL %r — notification skipped.",
            alert.id, alert.destination,
        )
        return False

    payload = {
        "text": f"PlexPulse Alert: {alert.alert_type} threshold breached",
        "alert_type": alert.alert_type,
        "current_value": round(current_value, 4),
        "threshold": alert.threshold_value,
        "timestamp": now.isoformat(),
    }
    try:
        resp = httpx.post(alert.destination, json=payload, timeout=_WEBHOOK_TIMEOUT)
        resp.raise_for_status()
        log.info("Alert %d fired via webhook → HTTP %d", alert.id, resp.status_code)
        return True
    except httpx.HTTPStatusError as exc:
        log.warning("Alert %d webhook returned HTTP %d.", alert.id, exc.response.status_code)
        return False
    except httpx.RequestError as exc:
        log.warning("Alert %d webhook request failed: %s", alert.id, exc)
        return False


def _fire(alert: Alert, current_value: float, db: Session, now: datetime) -> None:
    """
    Dispatch the notification, stamp last_triggered_at, and append to alert_log.
    Both actions are committed together so the log is always consistent.
    """
    if alert.channel == "webhook":
        success = _fire_webhook(alert, current_value, now)
    else:
        # Email is a placeholder — log the intent and treat as fired
        log.info(
            "Alert %d (email to %s): current=%.4f %s, threshold=%.4f %s",
            alert.id, alert.destination,
            current_value, alert.threshold_unit,
            alert.threshold_value, alert.threshold_unit,
        )
        success = True

    if success:
        alert.last_triggered_at = now
        db.add(AlertLog(
            alert_id=alert.id,
            triggered_at=now,
            message=(
                f"Alert '{alert.alert_type}' fired: "
                f"current={current_value:.4f} {alert.threshold_unit}, "
                f"threshold={alert.threshold_value} {alert.threshold_unit}. "
                f"Channel={alert.channel}, dest={alert.destination}."
            ),
        ))
        db.commit()


# ── Per-rule evaluation ────────────────────────────────────────────────────────

def _evaluate_rule(
    rule: Alert,
    disk_snaps: list[DiskSnapshot],
    db: Session,
    now: datetime,
) -> None:
    atype = rule.alert_type

    if atype == "free_space_gb":
        if not disk_snaps:
            return
        worst = min(disk_snaps, key=lambda s: s.free_bytes)
        current = worst.free_bytes / 1e9
        if current < rule.threshold_value and _cooldown_ok(rule, now):
            log.info(
                "Alert %d triggered: free_space_gb=%.2f < threshold=%.2f (mount=%s)",
                rule.id, current, rule.threshold_value, worst.mount_point,
            )
            _fire(rule, current, db, now)

    elif atype == "free_space_percent":
        eligible = [s for s in disk_snaps if s.total_bytes]
        if not eligible:
            return
        worst = min(eligible, key=lambda s: s.free_bytes / s.total_bytes)
        current = (worst.free_bytes / worst.total_bytes) * 100
        if current < rule.threshold_value and _cooldown_ok(rule, now):
            log.info(
                "Alert %d triggered: free_space_percent=%.2f%% < threshold=%.2f%% (mount=%s)",
                rule.id, current, rule.threshold_value, worst.mount_point,
            )
            _fire(rule, current, db, now)

    elif atype == "runway_days":
        if not disk_snaps:
            return
        min_days: int | None = None
        for snap in disk_snaps:
            d = _days_remaining_for_mount(db, snap.mount_point)
            if d is not None:
                min_days = d if min_days is None else min(min_days, d)
        if min_days is not None and min_days < rule.threshold_value and _cooldown_ok(rule, now):
            log.info(
                "Alert %d triggered: runway_days=%d < threshold=%.0f",
                rule.id, min_days, rule.threshold_value,
            )
            _fire(rule, float(min_days), db, now)

    elif atype == "monthly_growth_gb":
        current = _monthly_growth_gb_all_libraries(db)
        if current > rule.threshold_value and _cooldown_ok(rule, now):
            log.info(
                "Alert %d triggered: monthly_growth_gb=%.2f > threshold=%.2f",
                rule.id, current, rule.threshold_value,
            )
            _fire(rule, current, db, now)

    else:
        log.warning("Unknown alert_type %r on alert id=%d — skipping.", atype, rule.id)


# ── Public entry point ─────────────────────────────────────────────────────────

def evaluate_alerts(db: Session) -> None:
    """
    Evaluate all enabled alert rules against the current database state.
    Intended to be called immediately after a successful snapshot collection.
    Each rule that breaches its threshold (and is outside its 24-hour cooldown)
    fires its configured notification channel and records a row in alert_logs.
    """
    rules = db.query(Alert).filter(Alert.enabled.is_(True)).all()
    if not rules:
        return

    now = datetime.now(timezone.utc)
    disk_snaps = _latest_disk_snapshots(db)

    log.debug("Evaluating %d alert rule(s).", len(rules))
    for rule in rules:
        try:
            _evaluate_rule(rule, disk_snaps, db, now)
        except Exception as exc:  # noqa: BLE001
            log.error("Error evaluating alert id=%d (%s): %s", rule.id, rule.alert_type, exc)
