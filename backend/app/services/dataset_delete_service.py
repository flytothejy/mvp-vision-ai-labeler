"""
Dataset Deletion Service

Handles complete deletion of datasets from both Labeler and Platform databases,
as well as S3 storage cleanup.

CRITICAL: Platform and Labeler databases are separate with no FK constraints.
Deleting from Platform will leave orphaned data in Labeler. This service
ensures complete cleanup across all systems.
"""

from datetime import datetime
from typing import Dict, Any, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func
import boto3
from botocore.exceptions import ClientError

from app.db.models.labeler import (
    Dataset,
    AnnotationProject,
    Annotation,
    ImageAnnotationStatus,
    AnnotationVersion,
    AnnotationSnapshot
)
from app.core.storage import storage_client
from app.services.dice_export_service import export_to_dice
import json


class DeletionImpact:
    """Data class for deletion impact summary."""

    def __init__(self):
        self.dataset_id: str = ""
        self.dataset_name: str = ""
        self.projects: List[Dict[str, Any]] = []
        self.total_projects: int = 0
        self.total_images: int = 0
        self.total_annotations: int = 0
        self.total_versions: int = 0
        self.storage_size_bytes: int = 0
        self.annotation_files: List[str] = []
        self.export_files: List[str] = []
        self.image_files: List[str] = []

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API response."""
        return {
            "dataset_id": self.dataset_id,
            "dataset_name": self.dataset_name,
            "projects": self.projects,
            "total_projects": self.total_projects,
            "total_images": self.total_images,
            "total_annotations": self.total_annotations,
            "total_versions": self.total_versions,
            "storage_size_mb": round(self.storage_size_bytes / (1024 * 1024), 2),
            "file_counts": {
                "annotations": len(self.annotation_files),
                "exports": len(self.export_files),
                "images": len(self.image_files)
            }
        }


def calculate_deletion_impact(
    labeler_db: Session,
    platform_db: Session,
    dataset_id: str
) -> DeletionImpact:
    """
    Calculate the impact of deleting a dataset.

    This provides a preview of what will be deleted:
    - Number of projects
    - Number of images
    - Number of annotations
    - Number of export versions
    - Storage size

    Args:
        labeler_db: Labeler database session
        platform_db: Platform database session
        dataset_id: Dataset ID to analyze

    Returns:
        DeletionImpact object with summary
    """
    impact = DeletionImpact()

    # Get dataset from Platform DB
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise ValueError(f"Dataset {dataset_id} not found")

    impact.dataset_id = dataset_id
    impact.dataset_name = dataset.name

    # Get all projects for this dataset from Labeler DB
    projects = labeler_db.query(AnnotationProject).filter(
        AnnotationProject.dataset_id == dataset_id
    ).all()

    impact.total_projects = len(projects)

    # Calculate statistics for each project
    for project in projects:
        # Count annotations
        annotation_count = labeler_db.query(func.count(Annotation.id)).filter(
            Annotation.project_id == project.id
        ).scalar() or 0

        # Count unique images
        image_count = labeler_db.query(func.count(ImageAnnotationStatus.id)).filter(
            ImageAnnotationStatus.project_id == project.id
        ).scalar() or 0

        # Count export versions
        version_count = labeler_db.query(func.count(AnnotationVersion.id)).filter(
            AnnotationVersion.project_id == project.id
        ).scalar() or 0

        impact.total_annotations += annotation_count
        impact.total_images += image_count
        impact.total_versions += version_count

        impact.projects.append({
            "project_id": project.id,
            "project_name": project.name,
            "task_types": project.task_types,
            "annotation_count": annotation_count,
            "image_count": image_count,
            "version_count": version_count
        })

    # Calculate S3 storage impact
    try:
        # List all files in dataset directory
        dataset_prefix = f"datasets/{dataset_id}/"

        paginator = storage_client.s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(
            Bucket=storage_client.datasets_bucket,
            Prefix=dataset_prefix
        )

        for page in pages:
            if 'Contents' in page:
                for obj in page['Contents']:
                    key = obj['Key']
                    size = obj['Size']
                    impact.storage_size_bytes += size

                    # Categorize files
                    if 'annotations_' in key or key.endswith('annotations.json'):
                        impact.annotation_files.append(key)
                    elif key.endswith(('.jpg', '.jpeg', '.png', '.bmp', '.gif')):
                        impact.image_files.append(key)

        # List export files
        for project in projects:
            export_prefix = f"exports/{project.id}/"

            export_pages = paginator.paginate(
                Bucket=storage_client.datasets_bucket,
                Prefix=export_prefix
            )

            for page in export_pages:
                if 'Contents' in page:
                    for obj in page['Contents']:
                        key = obj['Key']
                        size = obj['Size']
                        impact.storage_size_bytes += size
                        impact.export_files.append(key)

    except ClientError as e:
        print(f"Warning: Failed to calculate S3 storage size: {e}")

    return impact


def delete_labeler_data(
    labeler_db: Session,
    dataset_id: str
) -> Dict[str, int]:
    """
    Delete all Labeler database records for a dataset.

    This cascades through:
    1. Annotations
    2. ImageAnnotationStatus
    3. AnnotationVersions
    4. AnnotationSnapshots
    5. AnnotationProjects

    Args:
        labeler_db: Labeler database session
        dataset_id: Dataset ID to delete

    Returns:
        Dictionary with deletion counts
    """
    counts = {
        "annotations": 0,
        "image_statuses": 0,
        "annotation_versions": 0,
        "annotation_snapshots": 0,
        "projects": 0
    }

    # Get all projects for this dataset
    projects = labeler_db.query(AnnotationProject).filter(
        AnnotationProject.dataset_id == dataset_id
    ).all()

    project_ids = [p.id for p in projects]

    if not project_ids:
        return counts

    # Delete annotations
    deleted_annotations = labeler_db.query(Annotation).filter(
        Annotation.project_id.in_(project_ids)
    ).delete(synchronize_session=False)
    counts["annotations"] = deleted_annotations

    # Delete image annotation statuses
    deleted_statuses = labeler_db.query(ImageAnnotationStatus).filter(
        ImageAnnotationStatus.project_id.in_(project_ids)
    ).delete(synchronize_session=False)
    counts["image_statuses"] = deleted_statuses

    # Get version IDs first (before deleting versions)
    version_ids = [
        v.id for v in labeler_db.query(AnnotationVersion.id).filter(
            AnnotationVersion.project_id.in_(project_ids)
        ).all()
    ]

    # Delete annotation snapshots
    if version_ids:
        deleted_snapshots = labeler_db.query(AnnotationSnapshot).filter(
            AnnotationSnapshot.version_id.in_(version_ids)
        ).delete(synchronize_session=False)
        counts["annotation_snapshots"] = deleted_snapshots

    # Delete annotation versions
    deleted_versions = labeler_db.query(AnnotationVersion).filter(
        AnnotationVersion.project_id.in_(project_ids)
    ).delete(synchronize_session=False)
    counts["annotation_versions"] = deleted_versions

    # Delete projects
    deleted_projects = labeler_db.query(AnnotationProject).filter(
        AnnotationProject.id.in_(project_ids)
    ).delete(synchronize_session=False)
    counts["projects"] = deleted_projects

    # Commit transaction
    labeler_db.commit()

    return counts


def delete_s3_data(
    dataset_id: str,
    project_ids: List[str]
) -> Dict[str, int]:
    """
    Delete all S3 files for a dataset.

    This includes:
    1. Dataset images (datasets/{id}/)
    2. Dataset annotations (datasets/{id}/annotations_*.json)
    3. Export files (exports/{project_id}/)

    Args:
        dataset_id: Dataset ID
        project_ids: List of project IDs to clean up exports

    Returns:
        Dictionary with deletion counts
    """
    counts = {
        "dataset_files": 0,
        "export_files": 0
    }

    try:
        # Delete dataset directory
        dataset_prefix = f"datasets/{dataset_id}/"

        paginator = storage_client.s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(
            Bucket=storage_client.datasets_bucket,
            Prefix=dataset_prefix
        )

        # Collect all object keys
        objects_to_delete = []
        for page in pages:
            if 'Contents' in page:
                for obj in page['Contents']:
                    objects_to_delete.append({'Key': obj['Key']})

        # Delete in batches of 1000 (S3 limit)
        for i in range(0, len(objects_to_delete), 1000):
            batch = objects_to_delete[i:i+1000]
            if batch:
                storage_client.s3_client.delete_objects(
                    Bucket=storage_client.datasets_bucket,
                    Delete={'Objects': batch}
                )
                counts["dataset_files"] += len(batch)

        # Delete export directories for each project
        for project_id in project_ids:
            export_prefix = f"exports/{project_id}/"

            export_pages = paginator.paginate(
                Bucket=storage_client.datasets_bucket,
                Prefix=export_prefix
            )

            export_objects = []
            for page in export_pages:
                if 'Contents' in page:
                    for obj in page['Contents']:
                        export_objects.append({'Key': obj['Key']})

            # Delete export files in batches
            for i in range(0, len(export_objects), 1000):
                batch = export_objects[i:i+1000]
                if batch:
                    storage_client.s3_client.delete_objects(
                        Bucket=storage_client.datasets_bucket,
                        Delete={'Objects': batch}
                    )
                    counts["export_files"] += len(batch)

    except ClientError as e:
        raise RuntimeError(f"Failed to delete S3 data: {e}")

    return counts


def create_final_backup(
    labeler_db: Session,
    platform_db: Session,
    user_db: Session,
    dataset_id: str
) -> Dict[str, str]:
    """
    Create a final backup export before deletion.

    This exports all project data to DICE format and stores it in a
    special "backups" directory in S3.

    Args:
        labeler_db: Labeler database session
        platform_db: Platform database session
        user_db: User database session
        dataset_id: Dataset ID to backup

    Returns:
        Dictionary with backup file paths
    """
    backup_files = {}

    # Get all projects for this dataset
    projects = labeler_db.query(AnnotationProject).filter(
        AnnotationProject.dataset_id == dataset_id
    ).all()

    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

    for project in projects:
        try:
            # Export to DICE format
            dice_data = export_to_dice(
                db=labeler_db,
                platform_db=platform_db,
                user_db=user_db,
                project_id=project.id,
                include_draft=True  # Include everything for backup
            )

            # Save to backup directory
            backup_key = f"backups/{dataset_id}/{project.id}/backup_{timestamp}.json"

            storage_client.s3_client.put_object(
                Bucket=storage_client.datasets_bucket,
                Key=backup_key,
                Body=json.dumps(dice_data, indent=2),
                ContentType='application/json'
            )

            backup_files[project.id] = backup_key

        except Exception as e:
            print(f"Warning: Failed to backup project {project.id}: {e}")

    return backup_files


def delete_dataset_complete(
    labeler_db: Session,
    platform_db: Session,
    user_db: Session,
    dataset_id: str,
    create_backup: bool = False
) -> Dict[str, Any]:
    """
    Complete dataset deletion workflow.

    This orchestrates the entire deletion process:
    1. Calculate impact
    2. Create backup (optional)
    3. Delete Labeler data
    4. Delete S3 data
    5. Delete Platform dataset record

    Args:
        labeler_db: Labeler database session
        platform_db: Platform database session
        user_db: User database session
        dataset_id: Dataset ID to delete
        create_backup: Whether to create backup before deletion

    Returns:
        Summary of deletion operation
    """
    # Calculate impact first
    impact = calculate_deletion_impact(labeler_db, platform_db, dataset_id)

    # Create backup if requested
    backup_files = {}
    if create_backup:
        backup_files = create_final_backup(labeler_db, platform_db, user_db, dataset_id)

    # Get project IDs for S3 cleanup
    project_ids = [p["project_id"] for p in impact.projects]

    # Delete Labeler data
    labeler_counts = delete_labeler_data(labeler_db, dataset_id)

    # Delete S3 data
    s3_counts = delete_s3_data(dataset_id, project_ids)

    # Delete Labeler dataset record
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if dataset:
        labeler_db.delete(dataset)
        labeler_db.commit()

    return {
        "dataset_id": dataset_id,
        "dataset_name": impact.dataset_name,
        "deleted": True,
        "backup_created": create_backup,
        "backup_files": backup_files,
        "labeler_deletions": labeler_counts,
        "s3_deletions": s3_counts,
        "impact": impact.to_dict()
    }
