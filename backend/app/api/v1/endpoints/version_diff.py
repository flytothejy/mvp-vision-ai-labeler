"""Version diff endpoints."""

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session

from app.core.database import get_labeler_db
from app.core.security import get_current_user
from app.db.models.user import User
from app.db.models.labeler import AnnotationVersion
from app.schemas.version_diff import VersionDiffResponse, VersionDiffSummaryResponse
from app.services.version_diff_service import VersionDiffService

router = APIRouter()


@router.get(
    "/versions/{version_a_id}/compare/{version_b_id}",
    response_model=VersionDiffResponse,
    summary="Compare two annotation versions"
)
async def compare_versions(
    version_a_id: int,
    version_b_id: int,
    image_id: Optional[str] = Query(None, description="Optional: compare only this image"),
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
):
    """
    Calculate detailed diff between two annotation versions.

    - **version_a_id**: Old version ID
    - **version_b_id**: New version ID
    - **image_id**: Optional - compare only specific image

    Returns complete diff data with per-image changes and summary statistics.
    """
    try:
        diff_data = VersionDiffService.calculate_version_diff(
            labeler_db,
            version_a_id,
            version_b_id,
            image_id=image_id
        )
        return diff_data

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to calculate diff: {str(e)}"
        )


@router.get(
    "/versions/{version_a_id}/compare/{version_b_id}/summary",
    response_model=VersionDiffSummaryResponse,
    summary="Get version diff summary"
)
async def get_diff_summary(
    version_a_id: int,
    version_b_id: int,
    labeler_db: Session = Depends(get_labeler_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get compact summary of changes between two versions.

    - **version_a_id**: Old version ID
    - **version_b_id**: New version ID

    Returns summary statistics only without detailed per-image diffs.
    Useful for quick overview before loading full diff data.
    """
    try:
        diff_data = VersionDiffService.calculate_version_diff(
            labeler_db,
            version_a_id,
            version_b_id
        )

        # Return summary only
        return {
            'version_a': diff_data['version_a'],
            'version_b': diff_data['version_b'],
            'project_id': diff_data['project_id'],
            'task_type': diff_data['task_type'],
            'summary': diff_data['summary'],
            'class_stats': diff_data['class_stats']
        }

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to calculate diff summary: {str(e)}"
        )
