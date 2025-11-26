"""
Storage Client for S3/MinIO

Handles image storage operations including:
- List images from datasets
- Generate presigned URLs
- Upload/download annotations
"""

import logging
from typing import List, Dict, Optional
from datetime import datetime, timedelta
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import settings

logger = logging.getLogger(__name__)


class StorageClient:
    """S3/MinIO storage client for managing images and annotations."""

    def __init__(self):
        """Initialize S3 client with configuration from settings."""
        self.s3_client = boto3.client(
            's3',
            endpoint_url=settings.S3_ENDPOINT,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION,
            config=Config(signature_version='s3v4'),
            use_ssl=settings.S3_USE_SSL
        )
        self.datasets_bucket = settings.S3_BUCKET_DATASETS
        self.annotations_bucket = settings.S3_BUCKET_ANNOTATIONS
        logger.info(f"Storage client initialized: endpoint={settings.S3_ENDPOINT}")

        # Ensure required buckets exist
        self._ensure_buckets_exist()

    def list_dataset_images(
        self,
        dataset_id: str,
        prefix: str = "images/",
        max_keys: int = 1000,
        offset: int = 0
    ) -> Dict[str, any]:
        """
        List images in a dataset with pagination support.

        Performance optimization:
        - Fetches all image metadata first (fast)
        - Generates presigned URLs only for requested page (slow operation)
        - Supports offset/limit pagination

        Args:
            dataset_id: Dataset ID
            prefix: Folder prefix (default: "images/")
            max_keys: Maximum number of images to return in this page
            offset: Number of images to skip (for pagination)

        Returns:
            Dict with keys:
            - images: List of image metadata dicts
            - total: Total number of images in dataset
            - offset: Current offset
            - limit: Current limit
        """
        try:
            # Storage structure: datasets/{dataset_id}/images/xxx.jpg
            s3_prefix = f"datasets/{dataset_id}/{prefix}"

            logger.info(f"Listing images: bucket={self.datasets_bucket}, prefix={s3_prefix}, offset={offset}, limit={max_keys}")

            # Phase 1: Get all image keys (fast - no URL generation)
            all_objects = []
            continuation_token = None

            while True:
                list_params = {
                    'Bucket': self.datasets_bucket,
                    'Prefix': s3_prefix,
                    'MaxKeys': 1000
                }
                if continuation_token:
                    list_params['ContinuationToken'] = continuation_token

                response = self.s3_client.list_objects_v2(**list_params)

                if 'Contents' in response:
                    all_objects.extend(response['Contents'])

                if not response.get('IsTruncated'):
                    break

                continuation_token = response.get('NextContinuationToken')

            # Filter image files only
            image_objects = []
            for obj in all_objects:
                key = obj['Key']

                # Skip folders
                if key.endswith('/'):
                    continue

                # Extract filename
                filename = key.split('/')[-1]

                # Skip non-image files
                if not self._is_image_file(filename):
                    continue

                image_objects.append(obj)

            total_images = len(image_objects)

            # Phase 2: Apply pagination (slice)
            paginated_objects = image_objects[offset:offset + max_keys]

            # Phase 3: Generate presigned URLs only for paginated images (slow)
            images = []
            dataset_prefix = f"datasets/{dataset_id}/"

            for obj in paginated_objects:
                key = obj['Key']
                filename = key.split('/')[-1]

                # Generate presigned URL (valid for 1 hour)
                presigned_url = self.generate_presigned_url(
                    bucket=self.datasets_bucket,
                    key=key,
                    expiration=3600
                )

                # Phase 11: Use relative path from dataset root (includes images/ prefix and full path)
                # This matches the format stored in DB: "images/zipper/squeezed_teeth/001.png"
                # key format: "datasets/{dataset_id}/images/zipper/squeezed_teeth/001.png"
                # image_id format: "images/zipper/squeezed_teeth/001.png"
                image_id = key[len(dataset_prefix):] if key.startswith(dataset_prefix) else filename

                images.append({
                    'id': image_id,
                    'key': key,
                    'filename': filename,
                    'file_name': filename,  # Frontend expects file_name
                    'size': obj['Size'],
                    'last_modified': obj['LastModified'].isoformat(),
                    'url': presigned_url
                })

            logger.info(f"Found {total_images} total images, returning {len(images)} (offset={offset}, limit={max_keys})")

            return {
                'images': images,
                'total': total_images,
                'offset': offset,
                'limit': max_keys
            }

        except ClientError as e:
            logger.error(f"Failed to list images in {dataset_id}: {e}")
            raise Exception(f"Failed to list images: {str(e)}")

    def generate_presigned_url(
        self,
        bucket: str,
        key: str,
        expiration: int = 3600
    ) -> str:
        """
        Generate a URL for accessing an object.

        Hybrid approach:
        - If R2_PUBLIC_URL is set: Use public R2.dev URL (for R2 development)
        - If R2_PUBLIC_URL is empty: Use presigned URL (for S3/MinIO compatibility)

        This allows the same code to work in both R2 and on-prem S3 environments
        without any code changes - just configure R2_PUBLIC_URL environment variable.

        Args:
            bucket: Bucket name
            key: Object key
            expiration: URL expiration time in seconds (default: 1 hour)

        Returns:
            URL string (either public R2.dev URL or presigned S3 URL)
        """
        # Check if R2 public URL is configured (for R2 development only)
        if settings.R2_PUBLIC_URL and bucket == self.datasets_bucket:
            # Use R2 public development URL
            # Format: https://pub-xxx.r2.dev/{key}
            return f"{settings.R2_PUBLIC_URL}/{key}"

        # Fall back to presigned URL (S3/MinIO/on-prem compatible)
        try:
            url = self.s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': bucket, 'Key': key},
                ExpiresIn=expiration
            )
            return url
        except ClientError as e:
            logger.error(f"Failed to generate presigned URL for {key}: {e}")
            raise Exception(f"Failed to generate presigned URL: {str(e)}")

    def get_image_url(self, dataset_id: str, filename: str, expiration: int = 3600) -> str:
        """
        Get presigned URL for a specific image.

        Args:
            dataset_id: Dataset ID
            filename: Image filename
            expiration: URL expiration time in seconds

        Returns:
            Presigned URL string
        """
        key = f"datasets/{dataset_id}/images/{filename}"
        return self.generate_presigned_url(
            bucket=self.datasets_bucket,
            key=key,
            expiration=expiration
        )

    def upload_annotation(
        self,
        dataset_id: str,
        annotation_data: bytes,
        filename: str = "annotations.json"
    ) -> str:
        """
        Upload annotation data to S3.

        Args:
            dataset_id: Dataset ID
            annotation_data: Annotation JSON as bytes
            filename: Filename (default: "annotations.json")

        Returns:
            S3 object key
        """
        try:
            key = f"{dataset_id}/{filename}"

            self.s3_client.put_object(
                Bucket=self.annotations_bucket,
                Key=key,
                Body=annotation_data,
                ContentType='application/json',
                Metadata={
                    'dataset_id': dataset_id,
                    'uploaded_at': datetime.utcnow().isoformat()
                }
            )

            logger.info(f"Uploaded annotation: {key}")
            return key

        except ClientError as e:
            logger.error(f"Failed to upload annotation for {dataset_id}: {e}")
            raise Exception(f"Failed to upload annotation: {str(e)}")

    def download_annotation(self, dataset_id: str, filename: str = "annotations.json") -> Optional[bytes]:
        """
        Download annotation data from S3.

        Args:
            dataset_id: Dataset ID
            filename: Filename (default: "annotations.json")

        Returns:
            Annotation data as bytes, or None if not found
        """
        try:
            key = f"{dataset_id}/{filename}"

            response = self.s3_client.get_object(
                Bucket=self.annotations_bucket,
                Key=key
            )

            data = response['Body'].read()
            logger.info(f"Downloaded annotation: {key} ({len(data)} bytes)")
            return data

        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                logger.warning(f"Annotation not found: {dataset_id}/{filename}")
                return None
            logger.error(f"Failed to download annotation for {dataset_id}: {e}")
            raise Exception(f"Failed to download annotation: {str(e)}")

    def _is_image_file(self, filename: str) -> bool:
        """Check if filename is an image file based on extension."""
        image_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif'}
        return any(filename.lower().endswith(ext) for ext in image_extensions)

    def check_bucket_exists(self, bucket: str) -> bool:
        """Check if a bucket exists and is accessible."""
        try:
            self.s3_client.head_bucket(Bucket=bucket)
            return True
        except ClientError:
            return False

    def _ensure_buckets_exist(self):
        """Ensure all required buckets exist, create if missing."""
        required_buckets = [self.datasets_bucket, self.annotations_bucket]

        for bucket in required_buckets:
            if not self.check_bucket_exists(bucket):
                try:
                    self.s3_client.create_bucket(Bucket=bucket)
                    logger.info(f"Created bucket: {bucket}")
                except ClientError as e:
                    logger.error(f"Failed to create bucket {bucket}: {e}")
                    # Don't raise, let the error occur when trying to use it
            else:
                logger.info(f"Bucket exists: {bucket}")

    def upload_export(
        self,
        project_id: str,
        task_type: str,
        version_number: str,
        export_data: bytes,
        export_format: str,
        filename: str
    ) -> tuple[str, str, datetime]:
        """
        Upload export file to S3.

        Args:
            project_id: Project ID
            task_type: Task type (classification, detection, segmentation)
            version_number: Version number (e.g., "v1.0")
            export_data: Export file data as bytes
            export_format: Export format (coco, yolo, dice, etc.)
            filename: Export filename

        Returns:
            Tuple of (s3_key, presigned_url, expires_at)
        """
        try:
            # Phase 2.9: S3 key includes task_type
            # exports/{project_id}/{task_type}/{version_number}/{filename}
            key = f"exports/{project_id}/{task_type}/{version_number}/{filename}"

            # Determine content type
            content_type = 'application/json' if export_format in ['coco', 'dice'] else 'application/zip'

            # Upload to S3
            self.s3_client.put_object(
                Bucket=self.annotations_bucket,
                Key=key,
                Body=export_data,
                ContentType=content_type,
                Metadata={
                    'project_id': project_id,
                    'version': version_number,
                    'format': export_format,
                    'uploaded_at': datetime.utcnow().isoformat()
                }
            )

            # Generate presigned URL (valid for 7 days)
            expiration_seconds = 7 * 24 * 3600  # 7 days
            presigned_url = self.generate_presigned_url(
                bucket=self.annotations_bucket,
                key=key,
                expiration=expiration_seconds
            )

            expires_at = datetime.utcnow() + timedelta(seconds=expiration_seconds)

            logger.info(f"Uploaded export: {key} ({len(export_data)} bytes)")
            return key, presigned_url, expires_at

        except ClientError as e:
            logger.error(f"Failed to upload export for {project_id}: {e}")
            raise Exception(f"Failed to upload export: {str(e)}")

    def regenerate_presigned_url(
        self,
        s3_key: str,
        expiration: int = 7 * 24 * 3600
    ) -> tuple[str, datetime]:
        """
        Regenerate presigned URL for an existing export file.

        Args:
            s3_key: S3 object key
            expiration: URL expiration time in seconds (default: 7 days)

        Returns:
            Tuple of (presigned_url, expires_at)
        """
        try:
            presigned_url = self.generate_presigned_url(
                bucket=self.annotations_bucket,
                key=s3_key,
                expiration=expiration
            )

            expires_at = datetime.utcnow() + timedelta(seconds=expiration)

            logger.info(f"Regenerated presigned URL for: {s3_key}")
            return presigned_url, expires_at

        except ClientError as e:
            logger.error(f"Failed to regenerate presigned URL for {s3_key}: {e}")
            raise Exception(f"Failed to regenerate presigned URL: {str(e)}")

    def update_platform_annotations(
        self,
        dataset_id: str,
        task_type: str,
        dice_data: bytes,
        version_number: str
    ) -> str:
        """
        Update official task-specific annotations file in Platform S3.

        Phase 2.9: Each task has its own annotation file.
        This is the authoritative DICE format file that Platform uses.

        Args:
            dataset_id: Dataset ID
            task_type: Task type (classification, detection, segmentation)
            dice_data: DICE format data as bytes
            version_number: Version number for metadata

        Returns:
            S3 key
        """
        try:
            # Phase 2.9: Task-specific annotation files
            # S3 key: datasets/{dataset_id}/annotations_{task_type}.json
            key = f"datasets/{dataset_id}/annotations_{task_type}.json"

            # Upload to Platform datasets bucket
            self.s3_client.put_object(
                Bucket=self.datasets_bucket,
                Key=key,
                Body=dice_data,
                ContentType='application/json',
                Metadata={
                    'dataset_id': dataset_id,
                    'task_type': task_type,
                    'version': version_number,
                    'format': 'dice',
                    'updated_at': datetime.utcnow().isoformat(),
                    'source': 'labeler_publish'
                }
            )

            logger.info(f"Updated Platform S3 annotations: {key} (task: {task_type}, version: {version_number})")
            return key

        except ClientError as e:
            logger.error(f"Failed to update Platform annotations for {dataset_id} (task: {task_type}): {e}")
            raise Exception(f"Failed to update Platform annotations: {str(e)}")


# Global storage client instance
storage_client = StorageClient()
