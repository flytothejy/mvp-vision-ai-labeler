"""
Grant missing ProjectPermission to datasets created before the fix.

This script finds datasets/projects without ProjectPermission and grants
owner permission to the specified user.

Background:
- Before the fix, create_dataset only created DatasetPermission
- ProjectPermission was missing, causing "You don't have access to project" error
- This script fixes orphaned datasets by adding missing ProjectPermission

Usage:
    python scripts/grant_missing_permissions.py --email admin@example.com --dry-run
    python scripts/grant_missing_permissions.py --email admin@example.com --execute
"""

import sys
import os
from pathlib import Path
from datetime import datetime

# Add backend to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

# Load .env file before importing app modules
from dotenv import load_dotenv
env_path = backend_dir / '.env'
load_dotenv(dotenv_path=env_path, override=True)

import logging
from sqlalchemy import text
from app.core.database import LabelerSessionLocal, UserSessionLocal
from app.db.models.labeler import AnnotationProject, ProjectPermission
from app.db.models.user import User

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def find_orphaned_projects(labeler_db):
    """
    Find projects without any ProjectPermission.

    Returns:
        List of project IDs without permissions
    """
    # Get all projects
    all_projects = labeler_db.query(AnnotationProject).all()

    orphaned_projects = []

    for project in all_projects:
        # Check if project has any permissions
        permission_count = labeler_db.query(ProjectPermission).filter(
            ProjectPermission.project_id == project.id
        ).count()

        if permission_count == 0:
            orphaned_projects.append(project)
            logger.info(f"Found orphaned project: {project.id} (name: {project.name}, dataset: {project.dataset_id})")

    return orphaned_projects


def get_user_by_email(user_db, email: str):
    """Get user by email."""
    user = user_db.query(User).filter(User.email == email).first()
    return user


def grant_permissions(labeler_db, user_db, email: str, role: str = "owner", dry_run: bool = True):
    """
    Grant ProjectPermission to user for all orphaned projects.

    Args:
        labeler_db: Labeler database session
        user_db: User database session
        email: User email to grant permissions
        role: Permission role (default: "owner")
        dry_run: If True, only log changes without committing
    """
    # Get user
    user = get_user_by_email(user_db, email)
    if not user:
        logger.error(f"User not found: {email}")
        return

    logger.info(f"Found user: {user.email} (ID: {user.id})")

    # Find orphaned projects
    orphaned_projects = find_orphaned_projects(labeler_db)

    if not orphaned_projects:
        logger.info("No orphaned projects found. All projects have permissions.")
        return

    logger.info(f"Found {len(orphaned_projects)} orphaned projects")

    # Grant permissions
    granted_count = 0

    for project in orphaned_projects:
        logger.info(f"\nProject: {project.id}")
        logger.info(f"  Name: {project.name}")
        logger.info(f"  Dataset: {project.dataset_id}")
        logger.info(f"  Owner: {project.owner_id}")

        if not dry_run:
            # Create ProjectPermission
            permission = ProjectPermission(
                project_id=project.id,
                user_id=user.id,
                role=role,
                granted_by=user.id,  # Self-granted by admin
                granted_at=datetime.utcnow(),
            )
            labeler_db.add(permission)
            granted_count += 1
            logger.info(f"  ✅ Granted {role} permission to {email}")
        else:
            logger.info(f"  [DRY RUN] Would grant {role} permission to {email}")

    # Commit changes
    if not dry_run:
        labeler_db.commit()
        logger.info(f"\n✅ Granted permissions to {granted_count} projects")
    else:
        logger.info(f"\n🔍 DRY RUN: Would grant permissions to {len(orphaned_projects)} projects")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Grant missing ProjectPermission to orphaned datasets")
    parser.add_argument("--email", type=str, required=True, help="User email to grant permissions")
    parser.add_argument("--role", type=str, default="owner", choices=["owner", "admin", "reviewer", "annotator", "viewer"],
                       help="Permission role (default: owner)")
    parser.add_argument("--dry-run", action="store_true", default=True,
                       help="Dry run (no changes committed)")
    parser.add_argument("--execute", action="store_true",
                       help="Execute and commit changes")

    args = parser.parse_args()

    # Determine dry_run flag
    dry_run = not args.execute

    if dry_run:
        logger.info("🔍 DRY RUN MODE - No changes will be committed")
        logger.info("    Use --execute to actually commit changes")
    else:
        logger.info("⚠️  EXECUTE MODE - Changes will be committed to database")
        response = input(f"Grant {args.role} permission to {args.email} for all orphaned projects? (yes/no): ")
        if response.lower() != "yes":
            logger.info("Operation cancelled")
            sys.exit(0)

    # Open database sessions
    labeler_db = LabelerSessionLocal()
    user_db = UserSessionLocal()

    try:
        grant_permissions(
            labeler_db=labeler_db,
            user_db=user_db,
            email=args.email,
            role=args.role,
            dry_run=dry_run
        )
    except Exception as e:
        logger.error(f"Failed to grant permissions: {e}")
        labeler_db.rollback()
        raise
    finally:
        labeler_db.close()
        user_db.close()
