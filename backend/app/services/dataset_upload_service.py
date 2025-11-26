"""Dataset Upload Service

Handles file uploads for datasets:
- Individual image files
- ZIP archives with folder structure
- Annotation file parsing
"""

import logging
import os
import io
import zipfile
import json
from typing import List, Dict, Optional, Tuple
from fastapi import UploadFile
from datetime import datetime
from sqlalchemy.orm import Session

from app.core.storage import storage_client
from app.core.config import settings
from app.services.thumbnail_service import create_thumbnail, get_thumbnail_path
from app.db.models.labeler import ImageMetadata  # Phase 2.12: Performance

logger = logging.getLogger(__name__)


class UploadResult:
    """Result of file upload operation."""

    def __init__(
        self,
        images_count: int = 0,
        total_bytes: int = 0,
        folder_structure: Dict[str, int] = None
    ):
        self.images_count = images_count
        self.total_bytes = total_bytes
        self.folder_structure = folder_structure or {}


async def upload_files_to_s3(
    dataset_id: str,
    files: List[UploadFile],
    labeler_db: Session,  # Phase 2.12: For saving metadata
    preserve_structure: bool = True
) -> UploadResult:
    """
    Upload files to S3 with optional folder structure preservation.

    Phase 2.12: Now saves image metadata to DB for fast lookups.

    Args:
        dataset_id: Dataset ID
        files: List of uploaded files
        labeler_db: Database session for saving metadata
        preserve_structure: Whether to preserve folder structure

    Returns:
        UploadResult with counts and structure info
    """
    images_count = 0
    total_bytes = 0
    folder_structure = {}
    COMMIT_BATCH_SIZE = 50  # Commit every 50 images to avoid large transaction

    for file in files:
        # Handle ZIP files
        if file.filename and file.filename.lower().endswith('.zip'):
            result = await upload_zip_with_structure(dataset_id, file, labeler_db)
            images_count += result.images_count
            total_bytes += result.total_bytes
            folder_structure.update(result.folder_structure)

        # Handle individual images
        elif file.filename and is_image_file(file.filename):
            # Determine S3 key and relative path
            if preserve_structure and '/' in file.filename:
                # Keep folder structure
                relative_path = file.filename
                s3_key = f"datasets/{dataset_id}/images/{relative_path}"
                folder_path = os.path.dirname(relative_path)
            else:
                # Flat structure
                file_name = os.path.basename(file.filename)
                relative_path = file_name
                s3_key = f"datasets/{dataset_id}/images/{file_name}"
                folder_path = None

            # Upload original to S3
            content = await file.read()
            storage_client.s3_client.put_object(
                Bucket=storage_client.datasets_bucket,
                Key=s3_key,
                Body=content,
                ContentType=get_content_type(file.filename)
            )

            images_count += 1
            total_bytes += len(content)

            # Generate and upload thumbnail
            thumbnail_bytes = create_thumbnail(content)
            if thumbnail_bytes:
                thumbnail_key = get_thumbnail_path(s3_key)
                storage_client.s3_client.put_object(
                    Bucket=storage_client.datasets_bucket,
                    Key=thumbnail_key,
                    Body=thumbnail_bytes,
                    ContentType='image/jpeg'
                )
                logger.debug(f"Uploaded thumbnail: {thumbnail_key} ({len(thumbnail_bytes)} bytes)")

            # Phase 2.12: Save image metadata to DB
            # Generate unique image ID (relative path without extension)
            image_id = relative_path.rsplit('.', 1)[0] if '.' in relative_path else relative_path
            file_name = os.path.basename(file.filename)

            db_image = ImageMetadata(
                id=image_id,
                dataset_id=dataset_id,
                file_name=file_name,
                s3_key=s3_key,
                folder_path=folder_path,
                size=len(content),
                uploaded_at=datetime.utcnow(),
                last_modified=datetime.utcnow()
            )
            labeler_db.add(db_image)
            logger.debug(f"Saved metadata for image: {image_id}")

            # Track folder structure
            if '/' in file.filename:
                folder = os.path.dirname(file.filename)
                if folder not in folder_structure:
                    folder_structure[folder] = 0
                folder_structure[folder] += 1

            logger.info(f"Uploaded image: {s3_key} ({len(content)} bytes)")

            # Commit periodically to avoid large transactions
            if images_count % COMMIT_BATCH_SIZE == 0:
                labeler_db.commit()
                logger.debug(f"Committed batch of {COMMIT_BATCH_SIZE} images")

    # Final commit for remaining images
    labeler_db.commit()
    logger.debug(f"Final commit completed")

    return UploadResult(
        images_count=images_count,
        total_bytes=total_bytes,
        folder_structure=folder_structure
    )


async def upload_zip_with_structure(
    dataset_id: str,
    zip_file: UploadFile,
    labeler_db: Session
) -> UploadResult:
    """
    Extract ZIP and upload with folder structure.

    Phase 2.12: Now saves image metadata to DB for fast lookups.

    Args:
        dataset_id: Dataset ID
        zip_file: ZIP file upload
        labeler_db: Database session for saving metadata

    Returns:
        UploadResult with counts and structure info
    """
    images_count = 0
    total_bytes = 0
    folder_structure = {}
    COMMIT_BATCH_SIZE = 50  # Commit every 50 images to avoid large transaction

    # Read ZIP into memory
    zip_content = await zip_file.read()
    zip_buffer = io.BytesIO(zip_content)

    with zipfile.ZipFile(zip_buffer) as zf:
        for member in zf.namelist():
            # Skip directories and hidden files
            if member.endswith('/') or member.startswith('.') or '/__MACOSX' in member:
                continue

            # Check if image file
            if not is_image_file(member):
                continue

            # Read file content
            content = zf.read(member)

            # Upload original to S3 with structure
            s3_key = f"datasets/{dataset_id}/images/{member}"
            storage_client.s3_client.put_object(
                Bucket=storage_client.datasets_bucket,
                Key=s3_key,
                Body=content,
                ContentType=get_content_type(member)
            )

            images_count += 1
            total_bytes += len(content)

            # Generate and upload thumbnail
            thumbnail_bytes = create_thumbnail(content)
            if thumbnail_bytes:
                thumbnail_key = get_thumbnail_path(s3_key)
                storage_client.s3_client.put_object(
                    Bucket=storage_client.datasets_bucket,
                    Key=thumbnail_key,
                    Body=thumbnail_bytes,
                    ContentType='image/jpeg'
                )
                logger.debug(f"Uploaded thumbnail: {thumbnail_key} ({len(thumbnail_bytes)} bytes)")

            # Phase 2.12: Save image metadata to DB
            # Generate unique image ID (relative path without extension)
            image_id = member.rsplit('.', 1)[0] if '.' in member else member
            file_name = os.path.basename(member)
            folder_path = os.path.dirname(member) if os.path.dirname(member) else None

            db_image = ImageMetadata(
                id=image_id,
                dataset_id=dataset_id,
                file_name=file_name,
                s3_key=s3_key,
                folder_path=folder_path,
                size=len(content),
                uploaded_at=datetime.utcnow(),
                last_modified=datetime.utcnow()
            )
            labeler_db.add(db_image)
            logger.debug(f"Saved metadata for image: {image_id}")

            # Track folder structure
            if folder_path:
                if folder_path not in folder_structure:
                    folder_structure[folder_path] = 0
                folder_structure[folder_path] += 1

            logger.info(f"Uploaded from ZIP: {s3_key} ({len(content)} bytes)")

            # Commit periodically to avoid large transactions
            if images_count % COMMIT_BATCH_SIZE == 0:
                labeler_db.commit()
                logger.debug(f"Committed batch of {COMMIT_BATCH_SIZE} images from ZIP")

    # Final commit for remaining images
    labeler_db.commit()
    logger.debug(f"Final commit completed for ZIP upload")

    logger.info(f"ZIP upload complete: {images_count} images, {total_bytes} bytes")

    return UploadResult(
        images_count=images_count,
        total_bytes=total_bytes,
        folder_structure=folder_structure
    )


async def parse_annotation_file(
    annotation_file: UploadFile
) -> Dict:
    """
    Parse annotation file (COCO/DICE format).

    Args:
        annotation_file: Uploaded annotation file

    Returns:
        Parsed annotation data (normalized to DICE format)
    """
    content = await annotation_file.read()
    annotations_data = json.loads(content.decode('utf-8'))

    # Detect format and normalize to DICE
    if 'info' in annotations_data and 'licenses' in annotations_data:
        # COCO format - convert to DICE
        logger.info("Detected COCO format, converting to DICE")
        return convert_coco_to_dice(annotations_data)
    else:
        # Assume DICE format
        logger.info("Detected DICE format")
        return annotations_data


def convert_coco_to_dice(coco_data: Dict) -> Dict:
    """
    Convert COCO format to DICE format.

    Args:
        coco_data: COCO format annotation data

    Returns:
        DICE format annotation data
    """
    # DICE format structure
    dice_data = {
        "images": [],
        "annotations": [],
        "categories": []
    }

    # Convert categories
    for cat in coco_data.get('categories', []):
        dice_data['categories'].append({
            "id": cat['id'],
            "name": cat['name'],
            "supercategory": cat.get('supercategory', ''),
            "color": cat.get('color', '#FF0000')
        })

    # Convert images
    for img in coco_data.get('images', []):
        dice_data['images'].append({
            "id": img['id'],
            "file_name": img['file_name'],
            "width": img.get('width', 0),
            "height": img.get('height', 0)
        })

    # Convert annotations
    for ann in coco_data.get('annotations', []):
        dice_ann = {
            "id": ann['id'],
            "image_id": ann['image_id'],
            "category_id": ann['category_id'],
        }

        # Handle different annotation types
        if 'bbox' in ann:
            dice_ann['bbox'] = ann['bbox']
            dice_ann['area'] = ann.get('area', 0)

        if 'segmentation' in ann:
            dice_ann['segmentation'] = ann['segmentation']

        if 'iscrowd' in ann:
            dice_ann['iscrowd'] = ann['iscrowd']

        dice_data['annotations'].append(dice_ann)

    return dice_data


def is_image_file(filename: str) -> bool:
    """Check if filename is an image file based on extension."""
    image_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif'}
    return any(filename.lower().endswith(ext) for ext in image_extensions)


def get_content_type(filename: str) -> str:
    """Get content type based on file extension."""
    ext = os.path.splitext(filename.lower())[1]
    content_types = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff',
    }
    return content_types.get(ext, 'application/octet-stream')
