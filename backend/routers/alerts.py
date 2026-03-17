import logging
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Alert, AlertLog

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/alerts", tags=["alerts"])

AlertType = Literal["free_space_gb", "free_space_percent", "runway_days", "monthly_growth_gb"]
ChannelType = Literal["email", "webhook"]

_WEBHOOK_TIMEOUT = 10  # seconds


# ── Response / request models ──────────────────────────────────────────────────

class AlertOut(BaseModel):
    id: int
    alert_type: str
    threshold_value: float
    threshold_unit: str
    channel: str
    destination: str
    enabled: bool
    last_triggered_at: datetime | None

    model_config = {"from_attributes": True}


class AlertCreate(BaseModel):
    alert_type: AlertType
    threshold_value: float
    threshold_unit: str
    channel: ChannelType
    destination: str


class AlertUpdate(BaseModel):
    alert_type: AlertType | None = None
    threshold_value: float | None = None
    threshold_unit: str | None = None
    channel: ChannelType | None = None
    destination: str | None = None
    enabled: bool | None = None


class AlertLogOut(BaseModel):
    id: int
    alert_id: int | None
    triggered_at: datetime
    message: str

    model_config = {"from_attributes": True}


class TestResult(BaseModel):
    success: bool
    detail: str


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_alert_or_404(alert_id: int, db: Session) -> Alert:
    alert = db.query(Alert).filter(Alert.id == alert_id).first()
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found.")
    return alert


def _validate_webhook_url(url: str) -> None:
    """Reject non-HTTP(S) schemes to prevent protocol-level SSRF."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(
            status_code=400,
            detail="Webhook destination must be an http or https URL.",
        )
    if not parsed.netloc:
        raise HTTPException(status_code=400, detail="Webhook destination is not a valid URL.")


def _send_webhook(alert: Alert) -> TestResult:
    _validate_webhook_url(alert.destination)
    payload = {
        "alert_type": alert.alert_type,
        "threshold_value": alert.threshold_value,
        "threshold_unit": alert.threshold_unit,
        "test": True,
    }
    try:
        resp = httpx.post(alert.destination, json=payload, timeout=_WEBHOOK_TIMEOUT)
        resp.raise_for_status()
        return TestResult(success=True, detail=f"Webhook returned HTTP {resp.status_code}.")
    except httpx.HTTPStatusError as exc:
        return TestResult(success=False, detail=f"Webhook returned HTTP {exc.response.status_code}.")
    except httpx.RequestError as exc:
        return TestResult(success=False, detail=f"Webhook request failed: {exc}")


def _log_alert(alert_id: int, message: str, db: Session) -> None:
    db.add(AlertLog(alert_id=alert_id, triggered_at=datetime.now(timezone.utc), message=message))
    db.commit()


# ── Endpoints — ORDER MATTERS: literals before {id} params ────────────────────

@router.get("/history", response_model=list[AlertLogOut])
def get_history(db: Session = Depends(get_db)):
    rows = (
        db.query(AlertLog)
        .order_by(AlertLog.triggered_at.desc())
        .limit(50)
        .all()
    )
    return rows


@router.post("/test/{alert_id}", response_model=TestResult)
def test_alert(alert_id: int, db: Session = Depends(get_db)):
    alert = _get_alert_or_404(alert_id, db)

    if alert.channel == "webhook":
        result = _send_webhook(alert)
    else:
        # Email: placeholder
        log.info("Would send email alert (id=%d) to %s", alert.id, alert.destination)
        result = TestResult(success=True, detail="Email notification logged (not yet implemented).")

    message = f"Test notification sent via {alert.channel} to {alert.destination}. Success={result.success}"
    _log_alert(alert.id, message, db)
    return result


@router.get("", response_model=list[AlertOut])
def list_alerts(db: Session = Depends(get_db)):
    return db.query(Alert).order_by(Alert.id).all()


@router.post("", response_model=AlertOut, status_code=201)
def create_alert(body: AlertCreate, db: Session = Depends(get_db)):
    if body.channel == "webhook":
        _validate_webhook_url(body.destination)
    alert = Alert(
        alert_type=body.alert_type,
        threshold_value=body.threshold_value,
        threshold_unit=body.threshold_unit,
        channel=body.channel,
        destination=body.destination,
        enabled=True,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return alert


@router.put("/{alert_id}", response_model=AlertOut)
def update_alert(alert_id: int, body: AlertUpdate, db: Session = Depends(get_db)):
    alert = _get_alert_or_404(alert_id, db)

    if body.channel is not None:
        alert.channel = body.channel
    destination = body.destination if body.destination is not None else alert.destination
    if body.destination is not None:
        if (body.channel or alert.channel) == "webhook":
            _validate_webhook_url(body.destination)
        alert.destination = body.destination
    if body.alert_type is not None:
        alert.alert_type = body.alert_type
    if body.threshold_value is not None:
        alert.threshold_value = body.threshold_value
    if body.threshold_unit is not None:
        alert.threshold_unit = body.threshold_unit
    if body.enabled is not None:
        alert.enabled = body.enabled

    db.commit()
    db.refresh(alert)
    return alert


@router.delete("/{alert_id}", status_code=204)
def delete_alert(alert_id: int, db: Session = Depends(get_db)):
    alert = _get_alert_or_404(alert_id, db)
    db.delete(alert)
    db.commit()
