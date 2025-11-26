"""
Database Connection Management

Manages connections to:
- Platform DB (read-only, PostgreSQL)
- User DB (read-only, PostgreSQL) - Phase 9
- Labeler DB (read-write, PostgreSQL)
"""

import logging
from sqlalchemy import create_engine, event, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import NullPool

from app.core.config import settings


# =============================================================================
# Platform Database (Read-Only)
# =============================================================================

# Phase 11: Disable SQL echo to reduce verbosity
# Keep application DEBUG mode but disable SQL query logging
platform_engine = create_engine(
    settings.PLATFORM_DB_URL,
    echo=False,  # Disabled for cleaner logs
    pool_pre_ping=True,
    poolclass=NullPool if settings.ENVIRONMENT == "test" else None,
)

PlatformSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=platform_engine,
)

PlatformBase = declarative_base()


# TODO: Implement read-only enforcement for Platform DB
# For now, we rely on application logic to prevent writes to Platform DB
# Future: Use PostgreSQL roles with read-only permissions


# =============================================================================
# User Database (Read-Only) - Phase 9
# =============================================================================

user_engine = create_engine(
    settings.USER_DB_URL,
    echo=False,  # Disabled for cleaner logs
    pool_pre_ping=True,
    poolclass=NullPool if settings.ENVIRONMENT == "test" else None,
)

UserSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=user_engine,
)

UserBase = declarative_base()


# =============================================================================
# Labeler Database (Read-Write)
# =============================================================================

labeler_engine = create_engine(
    settings.LABELER_DB_URL,
    echo=False,  # Disabled for cleaner logs
    pool_pre_ping=True,
    poolclass=NullPool if settings.ENVIRONMENT == "test" else None,
)

LabelerSessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=labeler_engine,
)

LabelerBase = declarative_base()


# =============================================================================
# Dependency Injection for FastAPI
# =============================================================================

def get_platform_db() -> Session:
    """
    Dependency for accessing Platform database (read-only).

    Usage:
        @app.get("/datasets")
        def get_datasets(db: Session = Depends(get_platform_db)):
            datasets = db.query(Dataset).all()
            return datasets
    """
    db = PlatformSessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_user_db() -> Session:
    """
    Dependency for accessing User database (read-only, PostgreSQL).

    Phase 9: User data is now separated into shared PostgreSQL database.

    Usage:
        @app.get("/users/me")
        def get_current_user(db: Session = Depends(get_user_db)):
            user = db.query(User).filter(User.id == user_id).first()
            return user
    """
    db = UserSessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_labeler_db() -> Session:
    """
    Dependency for accessing Labeler database (read-write).

    Usage:
        @app.post("/annotations")
        def create_annotation(db: Session = Depends(get_labeler_db)):
            annotation = Annotation(...)
            db.add(annotation)
            db.commit()
            return annotation
    """
    db = LabelerSessionLocal()
    try:
        yield db
    finally:
        db.close()
