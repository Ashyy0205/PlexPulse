from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from models import Base

DATABASE_URL = "sqlite:////data/plexpulse.db"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},  # required for SQLite + FastAPI
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def create_tables() -> None:
    """Create all tables and indexes if they don't already exist."""
    Base.metadata.create_all(bind=engine)
    # Create composite indexes explicitly so they are also added to pre-existing databases.
    with engine.connect() as conn:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_snapshots_library_captured "
            "ON snapshots (library_id, captured_at)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_disk_snapshots_mount_captured "
            "ON disk_snapshots (mount_point, captured_at)"
        ))
        conn.commit()


def get_db():
    """FastAPI dependency that yields a database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
