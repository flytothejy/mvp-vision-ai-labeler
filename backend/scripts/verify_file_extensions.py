"""
Verify that image_ids now have file extensions after migration.
"""

import sys
from pathlib import Path

# Add backend to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

# Load .env file
from dotenv import load_dotenv
env_path = backend_dir / '.env'
load_dotenv(dotenv_path=env_path, override=True)

import logging
from app.core.database import LabelerSessionLocal
from app.db.models.labeler import ImageAnnotationStatus, AnnotationProject

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def verify_dataset(dataset_id: str):
    """Verify image_ids have extensions for a dataset."""
    labeler_db = LabelerSessionLocal()

    try:
        # Get projects for this dataset
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
        ).limit(10).all()  # Sample first 10

        logger.info(f"\nSample image_ids from dataset {dataset_id}:")
        logger.info("=" * 60)

        has_extension = 0
        no_extension = 0

        for status in statuses:
            image_id = status.image_id
            filename = image_id.split('/')[-1] if '/' in image_id else image_id

            # Check if filename has extension
            if '.' in filename:
                has_extension += 1
                logger.info(f"✅ {image_id}")
            else:
                no_extension += 1
                logger.error(f"❌ {image_id} (no extension)")

        logger.info("=" * 60)
        logger.info(f"Sample results: {has_extension} with extensions, {no_extension} without")

        if no_extension == 0:
            logger.info("✅ All sampled images have file extensions!")
        else:
            logger.warning(f"⚠️  {no_extension} images still missing extensions")

    finally:
        labeler_db.close()

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Verify file extensions in image_ids")
    parser.add_argument("--dataset-id", type=str, required=True, help="Dataset ID to verify")

    args = parser.parse_args()

    verify_dataset(args.dataset_id)
