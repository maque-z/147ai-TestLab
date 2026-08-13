from sqlalchemy import create_engine, event
# From sqlalchemy.orm, not sqlalchemy.ext.declarative: the latter re-export is
# deprecated in 2.0 (MovedIn20Warning) and slated for removal. Same class either
# way, so this changes nothing about the mapping.
from sqlalchemy.orm import declarative_base, sessionmaker
from .config import settings

engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False},
    # Generous because checkouts are short but bursty: a 50-wide batch fires 50
    # requests at once, each taking a connection just long enough to read its
    # config. They no longer hold one across the upstream call itself — see
    # core/deps.py, which is what keeps 50 concurrent generations from exceeding
    # this pool. SQLite connections are cheap, so headroom costs little.
    pool_size=30,
    max_overflow=10,
)

# Enable WAL mode and foreign keys for SQLite
@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
