"""Dataset endpoints - MIGRATED to Labeler DB (2025-11-21)."""

import uuid
import json
import logging
import boto3
from botocore.client import Config
from datetime import datetime
from typing import List, Optional, Dict, Set, Any
from fastapi import APIRouter, Depends, HTTPException, status, File, Form, UploadFile
from sqlalchemy.orm import Session
from sqlalchemy import select, func, or_
from pydantic import BaseModel

logger = logging.getLogger(__name__)

from app.core.database import get_platform_db, get_user_db, get_labeler_db
from app.core.security import get_current_user
from app.core.config import settings
from app.db.models.user import User
from app.db.models.labeler import Dataset, DatasetPermission, AnnotationProject, Annotation
from app.schemas.dataset import (
    DatasetCreate,
    DatasetUpdate,
    DatasetResponse,
    DeleteDatasetRequest,
    DeleteDatasetResponse,
    DeletionImpactResponse,
    DatasetUploadResponse,
    UploadSummary,
)
from app.schemas.permission import (
    PermissionInviteRequest,
    PermissionResponse,
    PermissionUpdateRequest,
    TransferOwnershipRequest,
)
from app.schemas.project import ProjectResponse
from app.services.dataset_delete_service import (
    calculate_deletion_impact,
    delete_dataset_complete,
)
from app.services.dataset_upload_service import (
    upload_files_to_s3,
    parse_annotation_file,
)
from app.services.annotation_import_service import (
    import_annotations_to_db,
    update_image_status,
)
from app.services.thumbnail_service import get_thumbnail_path
from app.services.storage_folder_service import (
    get_storage_structure,
    preview_upload_structure,
)
from app.core.security import require_dataset_permission
from app.core.storage import storage_client

router = APIRouter()


class ImageResponse(BaseModel):
    """Image response with presigned URL."""
    id: str  # file_path as unique identifier (source of truth = storage)
    file_name: str
    width: Optional[int] = None
    height: Optional[int] = None
    url: str  # Presigned URL for viewing
    thumbnail_url: Optional[str] = None  # Presigned URL for thumbnail

    class Config:
        from_attributes = True


def generate_distinct_color(index: int, total: int) -> str:
    """Generate visually distinct colors using HSL color space."""
    # Use golden ratio conjugate for better color distribution
    golden_ratio = 0.618033988749895
    hue = (index * golden_ratio) % 1.0

    # Use high saturation and medium lightness for vibrant, distinguishable colors
    saturation = 0.7
    lightness = 0.5

    # Convert HSL to RGB
    def hsl_to_rgb(h, s, l):
        c = (1 - abs(2 * l - 1)) * s
        x = c * (1 - abs((h * 6) % 2 - 1))
        m = l - c / 2

        if h < 1/6:
            r, g, b = c, x, 0
        elif h < 2/6:
            r, g, b = x, c, 0
        elif h < 3/6:
            r, g, b = 0, c, x
        elif h < 4/6:
            r, g, b = 0, x, c
        elif h < 5/6:
            r, g, b = x, 0, c
        else:
            r, g, b = c, 0, x

        r, g, b = int((r + m) * 255), int((g + m) * 255), int((b + m) * 255)
        return f"#{r:02x}{g:02x}{b:02x}"

    return hsl_to_rgb(hue, saturation, lightness)


def load_annotations_from_s3(annotation_path: str) -> Optional[Dict]:
    """Load annotations.json from S3/MinIO storage."""
    try:
        s3_client = boto3.client(
            's3',
            endpoint_url=settings.S3_ENDPOINT,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION,
            config=Config(signature_version='s3v4')
        )

        response = s3_client.get_object(
            Bucket=settings.S3_BUCKET_DATASETS,
            Key=annotation_path
        )
        content = response['Body'].read().decode('utf-8')
        return json.loads(content)
    except Exception as e:
        print(f"Error loading annotations from S3: {e}")
        return None


def calculate_class_statistics(project_id: str, labeler_db: Session) -> Dict[str, Dict]:
    """Calculate bbox count and image count for each class from Labeler DB."""
    from collections import defaultdict

    # Query all annotations for this project
    annotations = labeler_db.query(Annotation).filter(
        Annotation.project_id == project_id
    ).all()

    # Calculate statistics per class
    class_stats = defaultdict(lambda: {'image_ids': set(), 'bbox_count': 0})

    for ann in annotations:
        class_id = ann.class_id
        # Handle class_id=0 (don't skip it) and convert to string for consistency
        if class_id is not None:
            class_id_str = str(class_id)
            class_stats[class_id_str]['image_ids'].add(ann.image_id)
            class_stats[class_id_str]['bbox_count'] += 1

    # Convert to final format
    result = {}
    for class_id, stats in class_stats.items():
        result[class_id] = {
            'image_count': len(stats['image_ids']),
            'bbox_count': stats['bbox_count'],
        }

    return result


@router.post("", response_model=DatasetResponse, tags=["Datasets"], status_code=status.HTTP_201_CREATED)
async def create_dataset(
    dataset: DatasetCreate,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
):
    """
    Create new empty dataset in Labeler DB.

    This endpoint creates:
    1. Dataset record in Labeler DB
    2. Owner permission for the current user
    3. Annotation project linked to the dataset

    All operations are performed in a single transaction for consistency.

    - **name**: Dataset name
    - **description**: Optional dataset description
    - **task_types**: List of task types (e.g., ['detection', 'classification'])
    """
    # Generate dataset ID
    dataset_id = f"ds_{uuid.uuid4().hex[:16]}"

    # Define storage path
    storage_path = f"datasets/{dataset_id}/"

    # Create dataset record in Labeler DB
    db_dataset = Dataset(
        id=dataset_id,
        name=dataset.name,
        description=dataset.description,
        owner_id=current_user.id,
        storage_path=storage_path,
        storage_type="s3",
        format="images",
        labeled=False,
        num_images=0,
        visibility=dataset.visibility or "private",
        status="active",
        integrity_status="valid",
        version=1,
        is_snapshot=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    labeler_db.add(db_dataset)

    # Create owner permission record (SAME TRANSACTION)
    db_permission = DatasetPermission(
        dataset_id=dataset_id,
        user_id=current_user.id,
        role="owner",
        granted_by=current_user.id,
        granted_at=datetime.utcnow(),
    )
    labeler_db.add(db_permission)

    # Create annotation project (SAME TRANSACTION)
    project_id = f"proj_{uuid.uuid4().hex[:12]}"

    # Build task_config based on task_types (handle None and empty list)
    task_types = dataset.task_types or []
    task_config = {}
    for task_type in task_types:
        if task_type == "detection":
            task_config["detection"] = {"type": "bbox"}
        elif task_type == "segmentation":
            task_config["segmentation"] = {"type": "polygon"}
        elif task_type == "classification":
            task_config["classification"] = {"type": "single"}
        elif task_type == "geometry":
            task_config["geometry"] = {"type": "line"}

    db_project = AnnotationProject(
        id=project_id,
        name=dataset.name,
        description=dataset.description or f"Annotation project for {dataset.name}",
        dataset_id=dataset_id,
        owner_id=current_user.id,
        task_types=task_types,
        task_config=task_config,
        task_classes={},  # Empty classes - to be added later
        settings={},
        total_images=0,
        annotated_images=0,
        total_annotations=0,
        status="active",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
        last_updated_by=current_user.id,
    )
    labeler_db.add(db_project)

    # Create project owner permission (SAME TRANSACTION)
    from app.db.models.labeler import ProjectPermission

    db_project_permission = ProjectPermission(
        project_id=project_id,
        user_id=current_user.id,
        role="owner",
        granted_by=current_user.id,
        granted_at=datetime.utcnow(),
    )
    labeler_db.add(db_project_permission)

    # Commit all changes in single transaction
    try:
        labeler_db.commit()
        labeler_db.refresh(db_dataset)
    except Exception as e:
        labeler_db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create dataset: {str(e)}"
        )

    # Build response with owner information
    dataset_dict = {
        **db_dataset.__dict__,
        "num_items": db_dataset.num_images,
        "source": db_dataset.storage_type,
        "owner_name": current_user.full_name,
        "owner_email": current_user.email,
        "owner_badge_color": current_user.badge_color,
    }

    return DatasetResponse.model_validate(dataset_dict)


@router.get("", response_model=List[DatasetResponse], tags=["Datasets"])
async def list_datasets(
    skip: int = 0,
    limit: int = 100,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get list of datasets from Labeler database.

    Returns datasets that the user has access to:
    - Datasets owned by the user
    - Datasets where the user has explicit permissions
    - Public datasets

    - **skip**: Number of records to skip (pagination)
    - **limit**: Maximum number of records to return (max 100)
    """
    # Get dataset IDs where user has explicit permissions
    user_dataset_permissions = (
        labeler_db.query(DatasetPermission.dataset_id)
        .filter(DatasetPermission.user_id == current_user.id)
        .all()
    )
    permitted_dataset_ids = [perm.dataset_id for perm in user_dataset_permissions]

    # Build filter conditions
    filter_conditions = [
        Dataset.owner_id == current_user.id,  # User owns the dataset
        Dataset.visibility == 'public'  # Dataset is public
    ]

    # Only add permission filter if user has explicit permissions
    if permitted_dataset_ids:
        filter_conditions.append(Dataset.id.in_(permitted_dataset_ids))

    # Query datasets from Labeler DB with permission filtering
    datasets = (
        labeler_db.query(Dataset)
        .filter(or_(*filter_conditions))
        .offset(skip)
        .limit(min(limit, 100))
        .all()
    )

    # Convert to response format with owner information from Platform DB
    result = []
    for dataset in datasets:
        # Get owner info from Platform DB
        owner = user_db.query(User).filter(User.id == dataset.owner_id).first()

        dataset_dict = {
            **dataset.__dict__,
            "num_items": dataset.num_images or 0,
            "source": dataset.storage_type or "upload",
            "owner_name": owner.full_name if owner else None,
            "owner_email": owner.email if owner else None,
            "owner_badge_color": owner.badge_color if owner else None,
        }
        result.append(DatasetResponse.model_validate(dataset_dict))

    return result


@router.put("/{dataset_id}", response_model=DatasetResponse, tags=["Datasets"])
async def update_dataset(
    dataset_id: str,
    dataset_update: DatasetUpdate,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
    permission = Depends(require_dataset_permission("owner")),
):
    """
    Update dataset information.

    Only owners can update dataset information.

    - **dataset_id**: Dataset ID
    - **name**: New dataset name
    - **description**: New dataset description
    - **visibility**: New visibility setting (private or public)
    """
    # Query dataset from Labeler DB
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()

    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found",
        )

    # Update fields
    dataset.name = dataset_update.name
    dataset.description = dataset_update.description
    if dataset_update.visibility:
        dataset.visibility = dataset_update.visibility
    dataset.updated_at = datetime.utcnow()

    # Commit changes
    try:
        labeler_db.commit()
        labeler_db.refresh(dataset)
    except Exception as e:
        labeler_db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update dataset: {str(e)}"
        )

    # Get owner info from Platform DB
    owner = user_db.query(User).filter(User.id == dataset.owner_id).first()

    dataset_dict = {
        **dataset.__dict__,
        "num_items": dataset.num_images or 0,
        "source": dataset.storage_type or "upload",
        "owner_name": owner.full_name if owner else None,
        "owner_email": owner.email if owner else None,
        "owner_badge_color": owner.badge_color if owner else None,
    }

    return DatasetResponse.model_validate(dataset_dict)


@router.get("/{dataset_id}", response_model=DatasetResponse, tags=["Datasets"])
async def get_dataset(
    dataset_id: str,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get dataset by ID from Labeler database.

    - **dataset_id**: Dataset ID
    """
    # Query dataset from Labeler DB
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()

    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found",
        )

    # Get owner info from Platform DB
    owner = user_db.query(User).filter(User.id == dataset.owner_id).first()

    dataset_dict = {
        **dataset.__dict__,
        "num_items": dataset.num_images or 0,
        "source": dataset.storage_type or "upload",
        "owner_name": owner.full_name if owner else None,
        "owner_email": owner.email if owner else None,
        "owner_badge_color": owner.badge_color if owner else None,
    }

    return DatasetResponse.model_validate(dataset_dict)


@router.get("/{dataset_id}/project", response_model=ProjectResponse, tags=["Datasets"])
async def get_or_create_project_for_dataset(
    dataset_id: str,
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get or auto-create annotation project for dataset.

    This endpoint implements the 1:1 relationship between datasets and projects.
    If a project doesn't exist for the dataset, it will be created automatically
    with sensible defaults.

    - **dataset_id**: Dataset ID
    """
    # First, verify dataset exists in Labeler DB
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found",
        )

    # Check if project already exists in Labeler DB
    project = (
        labeler_db.query(AnnotationProject)
        .filter(AnnotationProject.dataset_id == dataset_id)
        .first()
    )

    # If not, create one with sensible defaults
    if not project:
        # Initialize with EMPTY task types - users will add them manually
        task_types = []
        task_config = {}
        task_classes = {}
        classes = {}
        annotated_images = 0
        total_annotations = 0

        # If dataset is labeled, load existing annotations for statistics and classes
        # but DON'T auto-assign task types
        if dataset.labeled and dataset.annotation_path:
            annotations_data = load_annotations_from_s3(dataset.annotation_path)
            if annotations_data:
                # Extract annotation statistics
                annotations_list = annotations_data.get('annotations', [])
                total_annotations = len(annotations_list)

                # Count unique annotated images
                annotated_image_ids: Set[int] = set()
                for ann in annotations_list:
                    annotated_image_ids.add(ann.get('image_id'))
                annotated_images = len(annotated_image_ids)

                # Calculate per-class statistics
                from collections import defaultdict
                class_stats = defaultdict(lambda: {'image_ids': set(), 'bbox_count': 0})

                for ann in annotations_list:
                    cat_id = ann.get('category_id')
                    img_id = ann.get('image_id')
                    class_stats[cat_id]['image_ids'].add(img_id)
                    class_stats[cat_id]['bbox_count'] += 1

                # Extract classes from categories with generated colors and statistics
                # Store in legacy 'classes' field for now
                categories = annotations_data.get('categories', [])
                if categories:
                    total_categories = len(categories)
                    classes = {}
                    for idx, cat in enumerate(categories):
                        cat_id = str(cat['id'])
                        # Generate distinct color or use provided color
                        color = cat.get('color') or generate_distinct_color(idx, total_categories)

                        # Get statistics for this class
                        stats = class_stats.get(cat['id'], {'image_ids': set(), 'bbox_count': 0})

                        classes[cat_id] = {
                            'name': cat['name'],
                            'color': color,
                            'image_count': len(stats['image_ids']),
                            'bbox_count': stats['bbox_count'],
                        }

        project = AnnotationProject(
            id=f"proj_{uuid.uuid4().hex[:12]}",
            name=dataset.name,
            description=f"Annotation project for {dataset.name}",
            dataset_id=dataset_id,
            owner_id=current_user.id,
            task_types=task_types,
            task_config=task_config,
            task_classes=task_classes,  # Phase 2.9: Task-based classes
            classes=classes,  # Legacy field
            settings={},
            total_images=dataset.num_images or 0,
            annotated_images=annotated_images,
            total_annotations=total_annotations,
            status="active",
            last_updated_by=current_user.id,
        )
        labeler_db.add(project)
        labeler_db.commit()
        labeler_db.refresh(project)

    # REFACTORING: Calculate real-time class statistics from Labeler DB
    # Legacy classes field removed - use task_classes only
    live_class_stats = calculate_class_statistics(project.id, labeler_db)

    # Update project.task_classes with live statistics
    updated_task_classes = {}
    if project.task_classes:
        for task_type, task_classes_dict in project.task_classes.items():
            updated_task_classes[task_type] = {}
            for class_id, class_info in task_classes_dict.items():
                updated_class_info = dict(class_info)
                stats = live_class_stats.get(class_id, {'image_count': 0, 'bbox_count': 0})
                updated_class_info['image_count'] = stats['image_count']
                updated_class_info['bbox_count'] = stats['bbox_count']
                updated_task_classes[task_type][class_id] = updated_class_info

    # Calculate real-time annotated_images and total_annotations from Labeler DB
    live_total_annotations = labeler_db.query(func.count(Annotation.id)).filter(
        Annotation.project_id == project.id
    ).scalar() or 0

    live_annotated_images = labeler_db.query(func.count(func.distinct(Annotation.image_id))).filter(
        Annotation.project_id == project.id
    ).scalar() or 0

    # Get dataset name from Platform DB
    dataset_name = dataset.name

    # Fetch user info if last_updated_by is set
    last_updated_by_name = None
    last_updated_by_email = None
    if project.last_updated_by:
        user = user_db.query(User).filter(User.id == project.last_updated_by).first()
        if user:
            last_updated_by_name = user.full_name
            last_updated_by_email = user.email

    # Build response
    return ProjectResponse(
        id=project.id,
        name=project.name,
        description=project.description,
        dataset_id=project.dataset_id,
        owner_id=project.owner_id,
        task_types=project.task_types,
        task_config=project.task_config,
        task_classes=updated_task_classes,  # Task-based classes with live stats
        settings=project.settings,
        total_images=project.total_images,
        annotated_images=live_annotated_images,  # Use live data
        total_annotations=live_total_annotations,  # Use live data
        status=project.status,
        created_at=project.created_at,
        updated_at=project.updated_at,
        last_updated_by=project.last_updated_by,
        last_updated_by_name=last_updated_by_name,
        last_updated_by_email=last_updated_by_email,
        dataset_name=dataset_name,
        dataset_num_items=dataset.num_images,
    )


@router.get("/{dataset_id}/images", response_model=List[ImageResponse], tags=["Datasets"])
async def list_dataset_images(
    dataset_id: str,
    limit: int = 12,
    random: bool = True,  # Phase 2.12: Random selection for dataset summary
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get list of images for a dataset with presigned URLs.

    Phase 2.12: Performance optimization - uses DB queries instead of S3 list.

    - **dataset_id**: Dataset ID
    - **limit**: Maximum number of images to return (default 12)
    - **random**: If true, return random images; if false, return in upload order (default true)
    """
    # Verify dataset exists in Labeler DB
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found",
        )

    # Phase 2.12: Get images from DB instead of S3 list (10x faster!)
    from app.db.models.labeler import ImageMetadata as ImageMetadataModel

    query = labeler_db.query(ImageMetadataModel).filter(
        ImageMetadataModel.dataset_id == dataset_id
    )

    # Phase 2.12: Random selection for dataset summary diversity
    if random:
        # Use database-level random ordering
        query = query.order_by(func.random())
    else:
        # Default to upload order
        query = query.order_by(ImageMetadataModel.uploaded_at)

    db_images = query.limit(limit).all()

    if not db_images:
        return []

    # Generate presigned URLs
    result = []
    for db_img in db_images:
        try:
            # Generate presigned URL for original image (valid for 1 hour)
            url = storage_client.generate_presigned_url(
                bucket=storage_client.datasets_bucket,
                key=db_img.s3_key,
                expiration=3600
            )

            # Generate presigned URL for thumbnail
            thumbnail_url = None
            try:
                thumbnail_key = get_thumbnail_path(db_img.s3_key)
                thumbnail_url = storage_client.generate_presigned_url(
                    bucket=storage_client.datasets_bucket,
                    key=thumbnail_key,
                    expiration=3600
                )
            except Exception:
                # Thumbnail might not exist for old images
                pass

            result.append(ImageResponse(
                id=db_img.id,
                file_name=db_img.id,  # Use relative path as file_name for display
                width=db_img.width,
                height=db_img.height,
                url=url,
                thumbnail_url=thumbnail_url
            ))
        except Exception as e:
            logger.error(f"Error generating presigned URL for {db_img.id}: {e}")
            continue

    return result


class DatasetSizeResponse(BaseModel):
    """Dataset size statistics."""
    total_images: int
    total_bytes: int
    total_mb: float
    total_gb: float

    class Config:
        from_attributes = True


@router.get("/{dataset_id}/size", response_model=DatasetSizeResponse, tags=["Datasets"])
async def get_dataset_size(
    dataset_id: str,
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get total dataset size from image metadata.

    Phase 2.12: Fast calculation using DB aggregation instead of S3 list.

    - **dataset_id**: Dataset ID

    Returns:
    - total_images: Number of images in dataset
    - total_bytes: Total size in bytes
    - total_mb: Total size in MB
    - total_gb: Total size in GB
    """
    # Verify dataset exists
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found",
        )

    # Phase 2.12: Use DB aggregation for fast calculation
    from app.db.models.labeler import ImageMetadata as ImageMetadataModel

    # Count total images
    total_images = labeler_db.query(func.count(ImageMetadataModel.id)).filter(
        ImageMetadataModel.dataset_id == dataset_id
    ).scalar() or 0

    # Sum total size
    total_bytes = labeler_db.query(func.sum(ImageMetadataModel.size)).filter(
        ImageMetadataModel.dataset_id == dataset_id
    ).scalar() or 0

    # Convert to MB and GB
    total_mb = total_bytes / (1024 * 1024) if total_bytes else 0
    total_gb = total_bytes / (1024 * 1024 * 1024) if total_bytes else 0

    return DatasetSizeResponse(
        total_images=total_images,
        total_bytes=int(total_bytes),
        total_mb=round(total_mb, 2),
        total_gb=round(total_gb, 2)
    )


@router.get("/{dataset_id}/deletion-impact", response_model=DeletionImpactResponse, tags=["Datasets"])
async def get_deletion_impact(
    dataset_id: str,
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
):
    """
    Preview the impact of deleting a dataset.

    Returns information about:
    - Number of projects that will be deleted
    - Number of images affected
    - Number of annotations that will be deleted
    - Number of export versions that will be deleted
    - Storage size that will be freed

    - **dataset_id**: Dataset ID
    """
    try:
        impact = calculate_deletion_impact(labeler_db, platform_db, dataset_id)
        return DeletionImpactResponse(**impact.to_dict())
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to calculate deletion impact: {str(e)}"
        )


@router.delete("/{dataset_id}", response_model=DeleteDatasetResponse, tags=["Datasets"])
async def delete_dataset(
    dataset_id: str,
    request: DeleteDatasetRequest,
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
):
    """
    Delete a dataset completely.

    This will:
    1. Delete all annotation projects for the dataset
    2. Delete all annotations in Labeler DB
    3. Delete all image annotation statuses
    4. Delete all export versions
    5. Delete all S3 files (images, annotations, exports)
    6. Delete the dataset record from Labeler DB

    **IMPORTANT**: This is a destructive operation and cannot be undone.
    You must confirm by providing the exact dataset name.

    - **dataset_id**: Dataset ID
    - **request**: Deletion request with confirmation
    """
    # Verify dataset exists in Labeler DB
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found"
        )

    # Verify dataset name confirmation
    if request.dataset_name_confirmation != dataset.name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Dataset name confirmation does not match. Expected: '{dataset.name}'"
        )

    # Check permissions - only owner can delete
    if dataset.owner_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the dataset owner can delete the dataset"
        )

    try:
        # Perform complete deletion
        result = delete_dataset_complete(
            labeler_db=labeler_db,
            platform_db=platform_db,
            user_db=user_db,
            dataset_id=dataset_id,
            create_backup=request.create_backup
        )

        return DeleteDatasetResponse(**result)

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete dataset: {str(e)}"
        )


# =============================================================================
# Dataset Permission Management (Phase 2.10.2)
# =============================================================================

@router.post("/{dataset_id}/permissions/invite", response_model=PermissionResponse, tags=["Permissions"])
async def invite_user_to_dataset(
    dataset_id: str,
    request: PermissionInviteRequest,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
    _permission = Depends(require_dataset_permission("owner")),
):
    """
    Invite a user to dataset (owner only).

    - **user_email**: Email of user to invite
    - **role**: Role to grant ('owner' or 'member')
    """
    # Validate role
    if request.role not in ['owner', 'member']:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role must be 'owner' or 'member'"
        )

    # Find user by email in Platform DB
    user = user_db.query(User).filter(User.email == request.user_email).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with email {request.user_email} not found"
        )

    # Check if permission already exists
    existing = (
        labeler_db.query(DatasetPermission)
        .filter(
            DatasetPermission.dataset_id == dataset_id,
            DatasetPermission.user_id == user.id,
        )
        .first()
    )

    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"User {request.user_email} already has access to this dataset"
        )

    # Create permission
    permission = DatasetPermission(
        dataset_id=dataset_id,
        user_id=user.id,
        role=request.role,
        granted_by=current_user.id,
        granted_at=datetime.utcnow(),
    )
    labeler_db.add(permission)
    labeler_db.commit()
    labeler_db.refresh(permission)

    # Get granted_by user info
    granted_by_user = user_db.query(User).filter(User.id == current_user.id).first()

    # Build response
    response_dict = {
        **permission.__dict__,
        "user_name": user.full_name,
        "user_email": user.email,
        "user_badge_color": user.badge_color,
        "granted_by_name": granted_by_user.full_name if granted_by_user else None,
        "granted_by_email": granted_by_user.email if granted_by_user else None,
    }

    return PermissionResponse.model_validate(response_dict)


@router.get("/{dataset_id}/permissions", response_model=List[PermissionResponse], tags=["Permissions"])
async def list_dataset_permissions(
    dataset_id: str,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
    _permission = Depends(require_dataset_permission("member")),
):
    """
    List all permissions for a dataset (members can view).

    - **dataset_id**: Dataset ID
    """
    # Get all permissions for this dataset
    permissions = (
        labeler_db.query(DatasetPermission)
        .filter(DatasetPermission.dataset_id == dataset_id)
        .all()
    )

    # Build response with user information
    result = []
    for perm in permissions:
        # Get user info from Platform DB
        user = user_db.query(User).filter(User.id == perm.user_id).first()
        granted_by_user = user_db.query(User).filter(User.id == perm.granted_by).first()

        response_dict = {
            **perm.__dict__,
            "user_name": user.full_name if user else None,
            "user_email": user.email if user else None,
            "user_badge_color": user.badge_color if user else None,
            "granted_by_name": granted_by_user.full_name if granted_by_user else None,
            "granted_by_email": granted_by_user.email if granted_by_user else None,
        }
        result.append(PermissionResponse.model_validate(response_dict))

    return result


@router.put("/{dataset_id}/permissions/{user_id}", response_model=PermissionResponse, tags=["Permissions"])
async def update_user_permission(
    dataset_id: str,
    user_id: int,
    request: PermissionUpdateRequest,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
    _permission = Depends(require_dataset_permission("owner")),
):
    """
    Update a user's permission role (owner only).

    - **dataset_id**: Dataset ID
    - **user_id**: User ID to update
    - **role**: New role ('owner' or 'member')
    """
    # Validate role
    if request.role not in ['owner', 'member']:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role must be 'owner' or 'member'"
        )

    # Find permission
    permission = (
        labeler_db.query(DatasetPermission)
        .filter(
            DatasetPermission.dataset_id == dataset_id,
            DatasetPermission.user_id == user_id,
        )
        .first()
    )

    if not permission:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Permission not found for user {user_id}"
        )

    # Can't change own permission
    if user_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot change your own permission"
        )

    # Update role
    permission.role = request.role
    labeler_db.commit()
    labeler_db.refresh(permission)

    # Get user info
    user = user_db.query(User).filter(User.id == user_id).first()
    granted_by_user = user_db.query(User).filter(User.id == permission.granted_by).first()

    response_dict = {
        **permission.__dict__,
        "user_name": user.full_name if user else None,
        "user_email": user.email if user else None,
        "user_badge_color": user.badge_color if user else None,
        "granted_by_name": granted_by_user.full_name if granted_by_user else None,
        "granted_by_email": granted_by_user.email if granted_by_user else None,
    }

    return PermissionResponse.model_validate(response_dict)


@router.delete("/{dataset_id}/permissions/{user_id}", status_code=status.HTTP_204_NO_CONTENT, tags=["Permissions"])
async def remove_user_permission(
    dataset_id: str,
    user_id: int,
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
    _permission = Depends(require_dataset_permission("owner")),
):
    """
    Remove a user's permission from dataset (owner only).

    - **dataset_id**: Dataset ID
    - **user_id**: User ID to remove
    """
    # Find permission
    permission = (
        labeler_db.query(DatasetPermission)
        .filter(
            DatasetPermission.dataset_id == dataset_id,
            DatasetPermission.user_id == user_id,
        )
        .first()
    )

    if not permission:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Permission not found for user {user_id}"
        )

    # Can't remove own permission
    if user_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove your own permission"
        )

    # Ensure at least one owner remains
    owner_count = (
        labeler_db.query(DatasetPermission)
        .filter(
            DatasetPermission.dataset_id == dataset_id,
            DatasetPermission.role == "owner",
        )
        .count()
    )

    if permission.role == "owner" and owner_count <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove the last owner. Transfer ownership first."
        )

    # Delete permission
    labeler_db.delete(permission)
    labeler_db.commit()

    return None


@router.post("/{dataset_id}/permissions/transfer-owner", response_model=PermissionResponse, tags=["Permissions"])
async def transfer_dataset_ownership(
    dataset_id: str,
    request: TransferOwnershipRequest,
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
    _permission = Depends(require_dataset_permission("owner")),
):
    """
    Transfer dataset ownership to another user (owner only).

    This will:
    1. Change the new user's role to 'owner'
    2. Change the current owner's role to 'member'
    3. Update dataset.owner_id

    - **dataset_id**: Dataset ID
    - **new_owner_user_id**: User ID of new owner
    """
    # Find new owner's permission
    new_owner_permission = (
        labeler_db.query(DatasetPermission)
        .filter(
            DatasetPermission.dataset_id == dataset_id,
            DatasetPermission.user_id == request.new_owner_user_id,
        )
        .first()
    )

    if not new_owner_permission:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User {request.new_owner_user_id} doesn't have access to this dataset"
        )

    # Can't transfer to yourself
    if request.new_owner_user_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You are already the owner"
        )

    # Get current owner permission
    current_owner_permission = (
        labeler_db.query(DatasetPermission)
        .filter(
            DatasetPermission.dataset_id == dataset_id,
            DatasetPermission.user_id == current_user.id,
        )
        .first()
    )

    # Get dataset
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found"
        )

    # Transfer ownership
    new_owner_permission.role = "owner"
    if current_owner_permission:
        current_owner_permission.role = "member"
    dataset.owner_id = request.new_owner_user_id

    labeler_db.commit()
    labeler_db.refresh(new_owner_permission)

    # Get user info
    user = user_db.query(User).filter(User.id == request.new_owner_user_id).first()
    granted_by_user = user_db.query(User).filter(User.id == new_owner_permission.granted_by).first()

    response_dict = {
        **new_owner_permission.__dict__,
        "user_name": user.full_name if user else None,
        "user_email": user.email if user else None,
        "user_badge_color": user.badge_color if user else None,
        "granted_by_name": granted_by_user.full_name if granted_by_user else None,
        "granted_by_email": granted_by_user.email if granted_by_user else None,
    }

    return PermissionResponse.model_validate(response_dict)


@router.post("/upload", response_model=DatasetUploadResponse, tags=["Datasets"], status_code=status.HTTP_201_CREATED)
async def upload_dataset(
    dataset_name: str = Form(...),
    dataset_description: Optional[str] = Form(None),
    task_types: Optional[str] = Form(None),  # JSON string of task types
    visibility: str = Form("private"),
    files: List[UploadFile] = File(...),
    annotation_file: Optional[UploadFile] = File(None),
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
):
    """
    Upload new dataset with images and optional annotations.

    Supports:
    - Multiple image files (jpg, png, etc.)
    - ZIP archive with folder structure
    - Optional annotations.json (COCO/DICE format)

    Process:
    1. Validate files and name uniqueness
    2. Create dataset record in Labeler DB
    3. Upload images to S3 (preserve folder structure)
    4. Parse and upload annotations if provided
    5. Auto-create project in Labeler DB
    6. Import annotations to Labeler DB if provided
    7. Return upload summary
    """
    # Parse task_types from JSON string
    task_types_list = []
    if task_types:
        try:
            task_types_list = json.loads(task_types)
        except:
            task_types_list = []

    # Step 1: Generate dataset ID
    dataset_id = f"ds_{uuid.uuid4().hex[:16]}"
    storage_path = f"datasets/{dataset_id}/"

    # Step 2: Upload files to S3
    upload_result = await upload_files_to_s3(
        dataset_id=dataset_id,
        files=files,
        labeler_db=labeler_db,
        preserve_structure=True
    )

    # Step 3: Handle annotations if provided
    annotations_data = None
    if annotation_file:
        annotations_data = await parse_annotation_file(annotation_file)

        # Upload to S3
        annotation_json = json.dumps(annotations_data).encode('utf-8')
        annotation_path = f"datasets/{dataset_id}/annotations_detection.json"
        storage_client.s3_client.put_object(
            Bucket=storage_client.datasets_bucket,
            Key=annotation_path,
            Body=annotation_json,
            ContentType='application/json'
        )

    # Step 4: Create dataset record in Labeler DB
    db_dataset = Dataset(
        id=dataset_id,
        name=dataset_name,
        description=dataset_description,
        owner_id=current_user.id,
        storage_path=storage_path,
        storage_type="s3",
        format="images",
        labeled=annotations_data is not None,
        num_images=upload_result.images_count,
        visibility=visibility,
        status="active",
        integrity_status="valid",
        version=1,
        is_snapshot=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    labeler_db.add(db_dataset)

    # Step 5: Create owner permission
    db_permission = DatasetPermission(
        dataset_id=dataset_id,
        user_id=current_user.id,
        role="owner",
        granted_by=current_user.id,
        granted_at=datetime.utcnow(),
    )
    labeler_db.add(db_permission)

    # Step 6: Create annotation project
    project_id = f"proj_{uuid.uuid4().hex[:12]}"

    # Build task_config based on task_types
    task_config = {}
    for task_type in task_types_list:
        if task_type == "detection":
            task_config["detection"] = {"type": "bbox"}
        elif task_type == "segmentation":
            task_config["segmentation"] = {"type": "polygon"}
        elif task_type == "classification":
            task_config["classification"] = {"type": "single"}
        elif task_type == "geometry":
            task_config["geometry"] = {"type": "line"}

    # Extract classes from annotations if provided
    task_classes = {}
    if annotations_data and 'categories' in annotations_data:
        # Build classes dict from categories
        classes_list = []
        for cat in annotations_data['categories']:
            classes_list.append({
                "id": str(cat['id']),
                "name": cat['name'],
                "color": cat.get('color', '#FF0000'),
                "order": cat.get('id', 0)
            })

        # Determine task type from annotations
        if annotations_data.get('annotations'):
            first_ann = annotations_data['annotations'][0]
            if 'bbox' in first_ann:
                task_classes['detection'] = classes_list
            elif 'segmentation' in first_ann:
                task_classes['segmentation'] = classes_list

    db_project = AnnotationProject(
        id=project_id,
        name=dataset_name,
        description=dataset_description or f"Annotation project for {dataset_name}",
        dataset_id=dataset_id,
        owner_id=current_user.id,
        task_types=task_types_list,
        task_config=task_config,
        task_classes=task_classes,
        settings={},
        total_images=upload_result.images_count,
        annotated_images=0,
        total_annotations=0,
        status="active",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
        last_updated_by=current_user.id,
    )
    labeler_db.add(db_project)

    # Commit dataset, permission, and project
    try:
        labeler_db.commit()
        labeler_db.refresh(db_dataset)
        labeler_db.refresh(db_project)
    except Exception as e:
        labeler_db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create dataset: {str(e)}"
        )

    # Step 7: Import annotations if provided
    annotations_imported = 0
    if annotations_data:
        import_result = import_annotations_to_db(
            labeler_db=labeler_db,
            project_id=project_id,
            annotations_data=annotations_data,
            current_user=current_user
        )
        annotations_imported = import_result.count

        # Update project stats
        db_project.total_annotations = annotations_imported
        labeler_db.commit()

    # Return response
    return DatasetUploadResponse(
        dataset_id=dataset_id,
        dataset_name=dataset_name,
        project_id=project_id,
        upload_summary=UploadSummary(
            images_uploaded=upload_result.images_count,
            annotations_imported=annotations_imported,
            storage_bytes_used=upload_result.total_bytes,
            folder_structure=upload_result.folder_structure
        )
    )


@router.post("/{dataset_id}/images", response_model=UploadSummary, tags=["Datasets"])
async def add_images_to_dataset(
    dataset_id: str,
    files: List[UploadFile] = File(...),
    annotation_file: Optional[UploadFile] = File(None),
    labeler_db: Session = Depends(get_labeler_db),
    platform_db: Session = Depends(get_platform_db),
    user_db: Session = Depends(get_user_db),
    current_user: User = Depends(get_current_user),
    permission = Depends(require_dataset_permission("member")),
):
    """
    Add images to an existing dataset.

    Requires member or owner permission.

    Process:
    1. Upload images to S3
    2. Parse and import annotations if provided
    3. Update dataset and project image counts
    4. Return upload summary
    """
    # Get dataset
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found"
        )

    # Get project
    project = labeler_db.query(AnnotationProject).filter(
        AnnotationProject.dataset_id == dataset_id
    ).first()
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project not found for dataset {dataset_id}"
        )

    # Step 1: Upload files to S3
    upload_result = await upload_files_to_s3(
        dataset_id=dataset_id,
        files=files,
        labeler_db=labeler_db,
        preserve_structure=True
    )

    # Step 2: Handle annotations if provided
    annotations_imported = 0
    if annotation_file:
        annotations_data = await parse_annotation_file(annotation_file)

        # Upload to S3
        annotation_json = json.dumps(annotations_data).encode('utf-8')
        annotation_path = f"datasets/{dataset_id}/annotations_detection.json"
        storage_client.s3_client.put_object(
            Bucket=storage_client.datasets_bucket,
            Key=annotation_path,
            Body=annotation_json,
            ContentType='application/json'
        )

        # Import annotations
        import_result = import_annotations_to_db(
            labeler_db=labeler_db,
            project_id=project.id,
            annotations_data=annotations_data,
            current_user=current_user
        )
        annotations_imported = import_result.count

        # Update project stats
        project.total_annotations += annotations_imported
        dataset.labeled = True

    # Step 3: Update counts
    dataset.num_images += upload_result.images_count
    project.total_images += upload_result.images_count
    dataset.updated_at = datetime.utcnow()
    project.updated_at = datetime.utcnow()

    labeler_db.commit()

    return UploadSummary(
        images_uploaded=upload_result.images_count,
        annotations_imported=annotations_imported,
        storage_bytes_used=upload_result.total_bytes,
        folder_structure=upload_result.folder_structure
    )


@router.get("/{dataset_id}/storage/structure", tags=["Storage"])
async def get_dataset_storage_structure(
    dataset_id: str,
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
    permission = Depends(require_dataset_permission("member")),
):
    """
    Get folder structure for dataset storage.

    Returns:
        - Folder hierarchy with file counts and sizes
        - Total statistics
    """
    # Verify dataset exists
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found"
        )

    try:
        structure = get_storage_structure(dataset_id)
        return structure
    except Exception as e:
        logger.error(f"Failed to get storage structure: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve storage structure"
        )


class UploadPreviewRequest(BaseModel):
    """Request for upload preview."""
    file_mappings: List[Dict[str, Any]]
    target_folder: str = ""

    class Config:
        json_schema_extra = {
            "example": {
                "file_mappings": [
                    {
                        "filename": "img001.jpg",
                        "relative_path": "train/cat/img001.jpg",
                        "size": 50000
                    }
                ],
                "target_folder": "dataset_v2/"
            }
        }


@router.post("/{dataset_id}/storage/preview", tags=["Storage"])
async def preview_dataset_upload(
    dataset_id: str,
    request: UploadPreviewRequest,
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
    permission = Depends(require_dataset_permission("member")),
):
    """
    Preview what the storage will look like after upload.

    This allows users to:
    - See which files will be new vs duplicates
    - Preview the final folder structure
    - Adjust target folder before actual upload
    """
    # Verify dataset exists
    dataset = labeler_db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset {dataset_id} not found"
        )

    try:
        preview = preview_upload_structure(
            dataset_id=dataset_id,
            file_mappings=request.file_mappings,
            target_folder=request.target_folder
        )
        return preview
    except Exception as e:
        logger.error(f"Failed to generate upload preview: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate upload preview"
        )
