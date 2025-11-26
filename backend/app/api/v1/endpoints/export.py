"""Export endpoints for annotations."""

import json
import io
import zipfile
import logging
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.core.database import get_platform_db, get_user_db, get_labeler_db
from app.core.security import get_current_user, require_project_permission
from app.core.storage import storage_client
from app.db.models.user import User
from app.db.models.labeler import AnnotationProject, AnnotationVersion, AnnotationSnapshot, Annotation
from app.schemas.version import (
    ExportRequest,
    ExportResponse,
    VersionPublishRequest,
    VersionResponse,
    VersionListResponse,
)
from app.services.coco_export_service import export_to_coco, get_export_stats as get_coco_stats
from app.services.yolo_export_service import export_to_yolo, get_export_stats as get_yolo_stats
from app.services.dice_export_service import export_to_dice, get_export_stats as get_dice_stats

router = APIRouter()


@router.post("/projects/{project_id}/export", response_model=ExportResponse, tags=["Export"])
async def export_annotations(
    project_id: str,
    export_request: ExportRequest,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    current_user: User = Depends(get_current_user),
    _permission = Depends(require_project_permission("admin")),
):
    """
    Export annotations in specified format (COCO or YOLO).

    Requires: admin role or higher

    This endpoint generates an export file, uploads it to S3, and returns a presigned download URL.

    - **project_id**: Project ID to export
    - **export_format**: Format (coco, yolo, voc)
    - **include_draft**: Include draft annotations (default: False)
    - **image_ids**: Export specific images only (None = all)
    """
    # Verify project exists
    project = labeler_db.query(AnnotationProject).filter(
        AnnotationProject.id == project_id
    ).first()

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project {project_id} not found",
        )

    # Generate export data based on format
    export_format = export_request.export_format.lower()

    try:
        if export_format == "dice":
            export_data, stats, filename = _export_dice(
                labeler_db=labeler_db,
                platform_db=platform_db,
                project_id=project_id,
                include_draft=export_request.include_draft,
                image_ids=export_request.image_ids,
            )
        elif export_format == "coco":
            export_data, stats, filename = _export_coco(
                labeler_db=labeler_db,
                platform_db=platform_db,
                project_id=project_id,
                include_draft=export_request.include_draft,
                image_ids=export_request.image_ids,
            )
        elif export_format == "yolo":
            export_data, stats, filename = _export_yolo(
                labeler_db=labeler_db,
                project_id=project_id,
                include_draft=export_request.include_draft,
                image_ids=export_request.image_ids,
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported export format: {export_format}. Supported: dice, coco, yolo",
            )

        # Upload to S3
        version_number = f"export_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
        s3_key, download_url, expires_at = storage_client.upload_export(
            project_id=project_id,
            version_number=version_number,
            export_data=export_data,
            export_format=export_format,
            filename=filename,
        )

        # Return export response
        return ExportResponse(
            export_path=s3_key,
            download_url=download_url,
            download_url_expires_at=expires_at,
            export_format=export_format,
            annotation_count=stats["annotation_count"],
            image_count=stats["image_count"],
            file_size_bytes=len(export_data),
        )

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to export annotations: {str(e)}",
        )


def _export_dice(
    labeler_db: Session,
    platform_db: Session,
    project_id: str,
    include_draft: bool,
    image_ids: Optional[list[str]],
    task_type: Optional[str] = None,
) -> tuple[bytes, dict, str]:
    """Export to DICE format."""
    # Generate DICE JSON
    dice_data = export_to_dice(
        db=labeler_db,
        platform_db=platform_db,
        project_id=project_id,
        include_draft=include_draft,
        image_ids=image_ids,
        task_type=task_type,
    )

    # Convert to JSON bytes
    json_str = json.dumps(dice_data, indent=2)
    export_data = json_str.encode('utf-8')

    # Get statistics
    stats = get_dice_stats(dice_data)

    # Filename
    filename = "annotations.json"  # Standard DICE format filename

    return export_data, stats, filename


def _export_coco(
    labeler_db: Session,
    platform_db: Session,
    project_id: str,
    include_draft: bool,
    image_ids: Optional[list[str]],
) -> tuple[bytes, dict, str]:
    """Export to COCO format."""
    # Generate COCO JSON
    coco_data = export_to_coco(
        db=labeler_db,
        platform_db=platform_db,
        project_id=project_id,
        include_draft=include_draft,
        image_ids=image_ids,
    )

    # Convert to JSON bytes
    json_str = json.dumps(coco_data, indent=2)
    export_data = json_str.encode('utf-8')

    # Get statistics
    stats = get_coco_stats(coco_data)

    # Filename
    filename = "annotations_coco.json"

    return export_data, stats, filename


def _export_yolo(
    labeler_db: Session,
    project_id: str,
    include_draft: bool,
    image_ids: Optional[list[str]],
) -> tuple[bytes, dict, str]:
    """Export to YOLO format."""
    # Generate YOLO format
    image_annotations, classes_txt = export_to_yolo(
        db=labeler_db,
        project_id=project_id,
        include_draft=include_draft,
        image_ids=image_ids,
    )

    # Create ZIP file with annotations
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        # Add classes.txt
        zip_file.writestr("classes.txt", classes_txt)

        # Add annotation files
        for image_id, annotations_str in image_annotations.items():
            # Use image_id as filename (without extension) + .txt
            txt_filename = f"{image_id}.txt" if not image_id.endswith('.txt') else image_id
            # Remove image extension if present
            txt_filename = txt_filename.replace('.jpg', '').replace('.png', '').replace('.jpeg', '')
            txt_filename = f"{txt_filename}.txt"

            zip_file.writestr(f"labels/{txt_filename}", annotations_str)

    export_data = zip_buffer.getvalue()

    # Get statistics
    stats = get_yolo_stats(image_annotations, classes_txt)

    # Filename
    filename = "annotations_yolo.zip"

    return export_data, stats, filename


# ===== Version Management APIs =====

@router.post("/projects/{project_id}/versions/publish", response_model=VersionResponse, tags=["Versions"])
async def publish_version(
    project_id: str,
    publish_request: VersionPublishRequest,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    current_user: User = Depends(get_current_user),
    _permission = Depends(require_project_permission("admin")),
):
    """
    Publish a new version of annotations.

    Requires: admin role or higher

    This creates an immutable snapshot of all annotations and exports them to the specified format.

    - **version_number**: Version number (auto-generated if not provided)
    - **description**: Version description
    - **export_format**: Export format (coco, yolo, voc)
    - **include_draft**: Include draft annotations (default: False)
    """
    # Verify project exists
    project = labeler_db.query(AnnotationProject).filter(
        AnnotationProject.id == project_id
    ).first()

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project {project_id} not found",
        )

    try:
        # Phase 2.9: Get task_type from request
        task_type = publish_request.task_type

        # Auto-generate version number if not provided
        if not publish_request.version_number:
            # Get latest version number for this task type
            latest_version = labeler_db.query(AnnotationVersion).filter(
                AnnotationVersion.project_id == project_id,
                AnnotationVersion.task_type == task_type,
                AnnotationVersion.version_type == "published"
            ).order_by(AnnotationVersion.created_at.desc()).first()

            if latest_version:
                # Extract version number (e.g., "v1.0" -> 1)
                try:
                    current_major = int(latest_version.version_number.replace('v', '').split('.')[0])
                    new_version_number = f"v{current_major + 1}.0"
                except:
                    new_version_number = "v1.0"
            else:
                new_version_number = "v1.0"
        else:
            new_version_number = publish_request.version_number

        # Check if version already exists for this task type
        existing = labeler_db.query(AnnotationVersion).filter(
            AnnotationVersion.project_id == project_id,
            AnnotationVersion.task_type == task_type,
            AnnotationVersion.version_number == new_version_number
        ).first()

        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Version {new_version_number} for task {task_type} already exists",
            )

        # Phase 2.9: Map task_type to annotation_types
        # no_object is filtered by attributes.task_type for all task types
        from sqlalchemy import or_, and_

        task_to_annotation_types_map = {
            'classification': ['classification'],
            'detection': ['bbox'],
            'object_detection': ['bbox'],  # Alternative name
            'segmentation': ['polygon'],
            'keypoints': ['keypoints'],
            'line': ['line'],
        }

        annotation_types = task_to_annotation_types_map.get(task_type, [task_type])

        # Get all annotations for this task type
        # Include no_object filtered by attributes.task_type
        query = labeler_db.query(Annotation).filter(
            Annotation.project_id == project_id,
            or_(
                Annotation.annotation_type.in_(annotation_types),
                and_(
                    Annotation.annotation_type == 'no_object',
                    Annotation.attributes['task_type'].astext == task_type
                )
            )
        )

        if not publish_request.include_draft:
            query = query.filter(Annotation.annotation_state.in_(['confirmed', 'verified']))

        annotations = query.all()

        # Count unique images
        unique_image_ids = list(set([ann.image_id for ann in annotations]))

        # Generate DICE export (always - this is our primary format)
        dice_data, dice_stats, dice_filename = _export_dice(
            labeler_db=labeler_db,
            platform_db=platform_db,
            project_id=project_id,
            include_draft=publish_request.include_draft,
            image_ids=None,
            task_type=task_type,
        )

        # Upload DICE to S3 (Phase 2.9: include task_type in path)
        dice_s3_key, dice_download_url, dice_expires_at = storage_client.upload_export(
            project_id=project_id,
            task_type=task_type,
            version_number=new_version_number,
            export_data=dice_data,
            export_format='dice',
            filename=dice_filename,
        )

        # Generate additional format if requested (COCO or YOLO)
        export_format = publish_request.export_format.lower()
        additional_s3_key = None

        if export_format == "coco":
            export_data, stats, filename = _export_coco(
                labeler_db=labeler_db,
                platform_db=platform_db,
                project_id=project_id,
                include_draft=publish_request.include_draft,
                image_ids=None,
            )
            additional_s3_key, _, _ = storage_client.upload_export(
                project_id=project_id,
                task_type=task_type,
                version_number=new_version_number,
                export_data=export_data,
                export_format=export_format,
                filename=filename,
            )
        elif export_format == "yolo":
            export_data, stats, filename = _export_yolo(
                labeler_db=labeler_db,
                project_id=project_id,
                include_draft=publish_request.include_draft,
                image_ids=None,
            )
            additional_s3_key, _, _ = storage_client.upload_export(
                project_id=project_id,
                task_type=task_type,
                version_number=new_version_number,
                export_data=export_data,
                export_format=export_format,
                filename=filename,
            )
        elif export_format != "dice":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported export format: {export_format}. Supported: dice, coco, yolo",
            )

        # Create version record (use DICE as primary export)
        version = AnnotationVersion(
            project_id=project_id,
            task_type=task_type,  # Phase 2.9: Task-specific versioning
            version_number=new_version_number,
            version_type="published",
            created_by=current_user.id,
            description=publish_request.description,
            annotation_count=len(annotations),
            image_count=len(unique_image_ids),
            export_format='dice',  # Primary format
            export_path=dice_s3_key,
            download_url=dice_download_url,
            download_url_expires_at=dice_expires_at,
        )

        labeler_db.add(version)
        labeler_db.flush()

        # Create annotation snapshots
        for annotation in annotations:
            snapshot = AnnotationSnapshot(
                version_id=version.id,
                annotation_id=annotation.id,
                snapshot_data={
                    "annotation_type": annotation.annotation_type,
                    "geometry": annotation.geometry,
                    "class_id": annotation.class_id,
                    "class_name": annotation.class_name,
                    "attributes": annotation.attributes,
                    "confidence": annotation.confidence,
                    "annotation_state": annotation.annotation_state,
                    "created_at": annotation.created_at.isoformat() if annotation.created_at else None,
                    "updated_at": annotation.updated_at.isoformat() if annotation.updated_at else None,
                }
            )
            labeler_db.add(snapshot)

        # Update Platform S3 with official task-specific DICE annotations
        try:
            annotation_path = storage_client.update_platform_annotations(
                dataset_id=project.dataset_id,
                task_type=task_type,
                dice_data=dice_data,
                version_number=new_version_number
            )

            # Update Platform DB with new annotation_path and labeled status
            from app.db.models.platform import Dataset
            dataset = platform_db.query(Dataset).filter(Dataset.id == project.dataset_id).first()
            if dataset:
                dataset.annotation_path = annotation_path
                dataset.labeled = True
                platform_db.commit()
                logger.info(f"Updated Platform DB: annotation_path={annotation_path}, labeled=True")
            else:
                logger.warning(f"Dataset {project.dataset_id} not found in Platform DB")

        except Exception as e:
            # Log error but don't fail the publish
            # Version is still created in Labeler, just Platform sync failed
            logger.error(f"Failed to update Platform S3/DB: {e}")

        labeler_db.commit()
        labeler_db.refresh(version)

        # Build response
        return VersionResponse(
            id=version.id,
            project_id=version.project_id,
            task_type=version.task_type,  # Phase 2.9
            version_number=version.version_number,
            version_type=version.version_type,
            created_at=version.created_at,
            created_by=version.created_by,
            description=version.description,
            annotation_count=version.annotation_count,
            image_count=version.image_count,
            export_format=version.export_format,
            export_path=version.export_path,
            download_url=version.download_url,
            download_url_expires_at=version.download_url_expires_at,
            created_by_name=current_user.full_name if current_user else None,
            created_by_email=current_user.email if current_user else None,
        )

    except HTTPException:
        raise
    except Exception as e:
        labeler_db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to publish version: {str(e)}",
        )


@router.get("/projects/{project_id}/versions", response_model=VersionListResponse, tags=["Versions"])
async def list_versions(
    project_id: str,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
    _permission = Depends(require_project_permission("viewer")),
):
    """
    Get list of versions for a project (published + working).

    Requires: viewer role or higher

    Returns all published and working versions, ordered by creation date (newest first).
    Automatically regenerates expired presigned URLs.

    Phase 11: Includes working versions for diff comparison.
    """
    # Verify project exists
    project = labeler_db.query(AnnotationProject).filter(
        AnnotationProject.id == project_id
    ).first()

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project {project_id} not found",
        )

    # Phase 11: Get all versions (published + working)
    versions = labeler_db.query(AnnotationVersion).filter(
        AnnotationVersion.project_id == project_id,
        AnnotationVersion.version_type.in_(["published", "working"])
    ).order_by(AnnotationVersion.created_at.desc()).all()

    # Check and regenerate expired URLs
    for version in versions:
        if version.download_url_expires_at and version.download_url_expires_at < datetime.utcnow():
            # Regenerate presigned URL
            try:
                new_url, new_expires_at = storage_client.regenerate_presigned_url(version.export_path)
                version.download_url = new_url
                version.download_url_expires_at = new_expires_at
                labeler_db.commit()
            except Exception as e:
                # Log error but don't fail the request
                print(f"Failed to regenerate URL for version {version.id}: {e}")

    # Build response
    version_responses = []
    for version in versions:
        # Get user info (Phase 9: from User DB)
        user = user_db.query(User).filter(User.id == version.created_by).first() if version.created_by else None

        # Debug: Print task_type value
        print(f"[list_versions] Version {version.version_number}: task_type={version.task_type}")

        version_responses.append(VersionResponse(
            id=version.id,
            project_id=version.project_id,
            task_type=version.task_type,  # Phase 2.9: Include task_type
            version_number=version.version_number,
            version_type=version.version_type,
            created_at=version.created_at,
            created_by=version.created_by,
            description=version.description,
            annotation_count=version.annotation_count,
            image_count=version.image_count,
            export_format=version.export_format,
            export_path=version.export_path,
            download_url=version.download_url,
            download_url_expires_at=version.download_url_expires_at,
            created_by_name=user.full_name if user else None,
            created_by_email=user.email if user else None,
        ))

    return VersionListResponse(
        versions=version_responses,
        total=len(version_responses),
        project_id=project_id,
    )
