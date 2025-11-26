"""
Phase 11: Add File Extensions to Image IDs

This script migrates existing image_ids in the database to include file extensions.

Background:
- Previously, image_id was stored without file extension (e.g., "images/zipper/001")
- This caused file_format to be "unknown" in exports
- Now we need to add the extension (e.g., "images/zipper/001.png")

Process:
1. List all images in R2 storage for each dataset
2. Query database for ImageAnnotationStatus records
3. Match image_ids without extensions to R2 files
4. Update image_id to include the file extension
5. Update all related Annotation records
"""

import sys
import os
from pathlib import Path

# Add backend to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

# Load .env file before importing app modules
# override=True: .env values take precedence over existing environment variables
from dotenv import load_dotenv
env_path = backend_dir / '.env'
load_dotenv(dotenv_path=env_path, override=True)

import logging
from sqlalchemy import text
from app.core.database import LabelerSessionLocal, PlatformSessionLocal
from app.db.models.labeler import ImageAnnotationStatus, Annotation, AnnotationProject
from app.db.models.platform import Dataset

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Lazy load storage_client to avoid connection issues during import
_storage_client = None

def get_storage_client():
    global _storage_client
    if _storage_client is None:
        from app.core.storage import storage_client
        _storage_client = storage_client
    return _storage_client


def get_r2_file_mapping(dataset_id: str) -> dict[str, str]:
    """
    Get mapping of image_id (without extension) to full filename (with extension) from R2.

    Returns:
        dict: {image_id_without_ext: filename_with_ext}
        Example: {"images/zipper/001": "001.png"}
    """
    mapping = {}

    try:
        # Get storage client
        storage_client = get_storage_client()

        # List all objects in the dataset's images folder
        prefix = f"datasets/{dataset_id}/images/"

        paginator = storage_client.s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(
            Bucket=storage_client.datasets_bucket,
            Prefix=prefix
        )

        for page in pages:
            if 'Contents' not in page:
                continue

            for obj in page['Contents']:
                key = obj['Key']

                # Skip directories
                if key.endswith('/'):
                    continue

                # Extract filename and path
                # key format: "datasets/{dataset_id}/images/{path}/{filename}"
                relative_path = key.replace(prefix, '', 1)  # Remove prefix
                filename = relative_path.split('/')[-1]

                # Get image_id without extension
                image_id_without_ext = relative_path.rsplit('.', 1)[0] if '.' in relative_path else relative_path

                # Store mapping
                mapping[image_id_without_ext] = relative_path

        logger.info(f"Found {len(mapping)} images in R2 for dataset {dataset_id}")
        return mapping

    except Exception as e:
        logger.error(f"Failed to list R2 files for dataset {dataset_id}: {e}")
        return {}


def migrate_dataset(dataset_id: str, dry_run: bool = True):
    """
    Migrate image_ids for a single dataset.

    Args:
        dataset_id: Dataset ID to migrate
        dry_run: If True, only log changes without committing
    """
    labeler_db = LabelerSessionLocal()

    try:
        # Get R2 file mapping
        logger.info(f"Fetching R2 files for dataset {dataset_id}...")
        r2_mapping = get_r2_file_mapping(dataset_id)

        if not r2_mapping:
            logger.warning(f"No R2 files found for dataset {dataset_id}")
            return

        # Get all ImageAnnotationStatus records for this dataset's projects
        projects = labeler_db.query(AnnotationProject).filter(
            AnnotationProject.dataset_id == dataset_id
        ).all()

        if not projects:
            logger.warning(f"No projects found for dataset {dataset_id}")
            return

        project_ids = [p.id for p in projects]

        # Get all ImageAnnotationStatus records
        statuses = labeler_db.query(ImageAnnotationStatus).filter(
            ImageAnnotationStatus.project_id.in_(project_ids)
        ).all()

        logger.info(f"Found {len(statuses)} image statuses across {len(projects)} projects")

        # Also get ImageMetadata records for this dataset
        from app.db.models.labeler import ImageMetadata
        metadata_records = labeler_db.query(ImageMetadata).filter(
            ImageMetadata.dataset_id == dataset_id
        ).all()

        logger.info(f"Found {len(metadata_records)} image metadata records")

        # Track statistics
        updated_status_count = 0
        updated_metadata_count = 0
        already_has_extension = 0
        not_found_in_r2 = 0

        # Update ImageMetadata first
        for metadata in metadata_records:
            old_image_id = metadata.id

            # Check if already has extension
            if '.' in old_image_id.split('/')[-1]:
                already_has_extension += 1
                continue

            # Look up in R2 mapping
            if old_image_id in r2_mapping:
                new_image_id = r2_mapping[old_image_id]

                logger.info(f"  [ImageMetadata] {old_image_id} -> {new_image_id}")

                if not dry_run:
                    metadata.id = new_image_id

                updated_metadata_count += 1
            else:
                logger.warning(f"  [ImageMetadata] Image not found in R2: {old_image_id}")
                not_found_in_r2 += 1

        # Update ImageAnnotationStatus and Annotations
        for status in statuses:
            old_image_id = status.image_id

            # Check if already has extension
            if '.' in old_image_id.split('/')[-1]:
                already_has_extension += 1
                continue

            # Look up in R2 mapping
            if old_image_id in r2_mapping:
                new_image_id = r2_mapping[old_image_id]

                logger.info(f"  {old_image_id} -> {new_image_id}")

                if not dry_run:
                    # Update ImageAnnotationStatus
                    status.image_id = new_image_id

                    # Update related Annotations
                    annotations = labeler_db.query(Annotation).filter(
                        Annotation.project_id == status.project_id,
                        Annotation.image_id == old_image_id
                    ).all()

                    for ann in annotations:
                        ann.image_id = new_image_id

                    logger.info(f"    Updated {len(annotations)} annotations")

                updated_status_count += 1
            else:
                logger.warning(f"  [ImageAnnotationStatus] Image not found in R2: {old_image_id}")
                # Don't increment not_found_in_r2 again if already counted in metadata

        # Commit changes
        if not dry_run:
            labeler_db.commit()
            logger.info(f"✅ Committed updates to database")
        else:
            labeler_db.rollback()
            logger.info(f"🔍 DRY RUN: Would update image_ids")

        # Summary
        logger.info(f"\nSummary for dataset {dataset_id}:")
        logger.info(f"  Total metadata records: {len(metadata_records)}")
        logger.info(f"  Total statuses: {len(statuses)}")
        logger.info(f"  Updated ImageMetadata: {updated_metadata_count}")
        logger.info(f"  Updated ImageAnnotationStatus: {updated_status_count}")
        logger.info(f"  Already has extension: {already_has_extension}")
        logger.info(f"  Not found in R2: {not_found_in_r2}")

    except Exception as e:
        labeler_db.rollback()
        logger.error(f"Failed to migrate dataset {dataset_id}: {e}")
        raise
    finally:
        labeler_db.close()


def migrate_all_datasets(dry_run: bool = True):
    """
    Migrate all datasets.

    Args:
        dry_run: If True, only log changes without committing
    """
    platform_db = PlatformSessionLocal()

    try:
        # Get all datasets
        datasets = platform_db.query(Dataset).all()
        logger.info(f"Found {len(datasets)} datasets to migrate")

        for dataset in datasets:
            logger.info(f"\n{'='*60}")
            logger.info(f"Processing dataset: {dataset.id} ({dataset.name})")
            logger.info(f"{'='*60}")

            migrate_dataset(dataset.id, dry_run=dry_run)

        logger.info(f"\n{'='*60}")
        logger.info(f"Migration completed for {len(datasets)} datasets")
        logger.info(f"{'='*60}")

    finally:
        platform_db.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Migrate image_ids to include file extensions")
    parser.add_argument("--dataset-id", type=str, help="Migrate specific dataset only")
    parser.add_argument("--dry-run", action="store_true", default=True,
                       help="Dry run (no changes committed)")
    parser.add_argument("--execute", action="store_true",
                       help="Execute migration (actually commit changes)")

    args = parser.parse_args()

    # Determine dry_run flag
    dry_run = not args.execute

    if dry_run:
        logger.info("🔍 DRY RUN MODE - No changes will be committed")
        logger.info("    Use --execute to actually commit changes")
    else:
        logger.info("⚠️  EXECUTE MODE - Changes will be committed to database")
        response = input("Are you sure you want to proceed? (yes/no): ")
        if response.lower() != "yes":
            logger.info("Migration cancelled")
            sys.exit(0)

    # Run migration
    if args.dataset_id:
        logger.info(f"Migrating single dataset: {args.dataset_id}")
        migrate_dataset(args.dataset_id, dry_run=dry_run)
    else:
        logger.info("Migrating all datasets")
        migrate_all_datasets(dry_run=dry_run)
