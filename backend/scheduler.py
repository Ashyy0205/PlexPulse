import logging
import os

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from collector import collect

log = logging.getLogger(__name__)

_scheduler = AsyncIOScheduler()


def _parse_interval_hours(raw: str) -> float:
    """Parse strings like '1h', '6h', '24h' into a float number of hours.
    Falls back to 6.0 if the value cannot be parsed.
    """
    value = raw.strip().lower()
    if value.endswith("h"):
        try:
            return float(value[:-1])
        except ValueError:
            pass
    # Try bare number (treat as hours)
    try:
        return float(value)
    except ValueError:
        log.warning("Cannot parse COLLECTION_INTERVAL %r — defaulting to 6h.", raw)
        return 6.0


def _run_collect() -> None:
    """Synchronous wrapper so APScheduler can call the blocking collect()."""
    try:
        collect()
    except Exception as exc:  # noqa: BLE001
        log.error("Scheduled collection failed: %s", exc)


def start_scheduler() -> None:
    raw_interval = os.environ.get("COLLECTION_INTERVAL", "6h")
    hours = _parse_interval_hours(raw_interval)

    _scheduler.add_job(
        _run_collect,
        trigger="interval",
        hours=hours,
        id="collect",
        replace_existing=True,
        max_instances=1,
    )
    _scheduler.start()
    log.info("Scheduler started — collecting every %.4gh.", hours)

    # Run first collection immediately without waiting for the interval
    log.info("Running initial collection now.")
    _run_collect()


def stop_scheduler() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
        log.info("Scheduler stopped.")
