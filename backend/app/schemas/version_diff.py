"""Version diff schemas."""

from typing import Dict, Any, List, Optional
from pydantic import BaseModel


class VersionMetadata(BaseModel):
    """Version metadata."""
    id: int
    version_number: str
    version_type: str
    created_at: str
    created_by: int


class ImageDiffSummary(BaseModel):
    """Summary of changes for a single image."""
    added_count: int
    removed_count: int
    modified_count: int
    unchanged_count: int
    total_changes: int


class ClassStats(BaseModel):
    """Per-class change statistics."""
    added: int
    removed: int
    modified: int


class VersionDiffSummary(BaseModel):
    """Overall diff summary."""
    images_with_changes: int
    total_images: int
    total_added: int
    total_removed: int
    total_modified: int
    total_unchanged: int
    total_changes: int


class VersionDiffResponse(BaseModel):
    """Complete version diff response."""
    version_a: VersionMetadata
    version_b: VersionMetadata
    project_id: str
    task_type: str
    image_diffs: Dict[str, Any]  # image_id -> diff data
    summary: VersionDiffSummary
    class_stats: Dict[str, ClassStats]


class VersionDiffSummaryResponse(BaseModel):
    """Compact summary-only response."""
    version_a: VersionMetadata
    version_b: VersionMetadata
    project_id: str
    task_type: str
    summary: VersionDiffSummary
    class_stats: Dict[str, ClassStats]
