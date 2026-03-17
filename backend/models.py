from sqlmodel import SQLModel


class MediaItem(SQLModel, table=True):
    id: int | None = None
    title: str
    year: int | None = None
    media_type: str  # movie, show, episode, etc.
    plex_key: str
    library: str
