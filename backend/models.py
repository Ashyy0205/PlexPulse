from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Library(Base):
    __tablename__ = "libraries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    plex_library_key = Column(String, unique=True, nullable=False)
    name = Column(String, nullable=False)
    type = Column(String, nullable=False)  # "movie", "show", or "music"
    created_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow)

    snapshots = relationship("Snapshot", back_populates="library", cascade="all, delete-orphan")


class Snapshot(Base):
    __tablename__ = "snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    library_id = Column(Integer, ForeignKey("libraries.id"), nullable=False)
    captured_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    item_count = Column(Integer, nullable=False)
    total_size_bytes = Column(Integer, nullable=False)

    library = relationship("Library", back_populates="snapshots")


class DiskSnapshot(Base):
    __tablename__ = "disk_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    mount_point = Column(String, nullable=False)
    captured_at = Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    total_bytes = Column(Integer, nullable=False)
    used_bytes = Column(Integer, nullable=False)
    free_bytes = Column(Integer, nullable=False)


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value = Column(String, nullable=False)


class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    alert_type = Column(String, nullable=False)
    threshold_value = Column(Float, nullable=False)
    threshold_unit = Column(String, nullable=False)
    channel = Column(String, nullable=False)
    destination = Column(String, nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    last_triggered_at = Column(DateTime(timezone=True), nullable=True)

