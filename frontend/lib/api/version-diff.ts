/**
 * Version Diff API client functions
 */

import { apiClient } from './client';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface VersionMetadata {
  id: number;
  version_number: string;
  version_type: 'working' | 'draft' | 'published';
  created_at: string;
  created_by: number;
}

export interface VersionDiffSummary {
  images_with_changes: number;
  total_images: number;
  total_added: number;
  total_removed: number;
  total_modified: number;
  total_unchanged: number;
  total_changes: number;
}

export interface ClassStats {
  added: number;
  removed: number;
  modified: number;
}

export interface AnnotationSnapshot {
  annotation_id?: number;
  image_id: string;
  annotation_type: string;
  geometry: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    [key: string]: any;
  };
  class_id?: string;
  class_name?: string;
  attributes?: Record<string, any>;
  confidence?: number;
}

export interface AnnotationChanges {
  class_changed?: boolean;
  old_class?: string;
  new_class?: string;
  geometry_changed?: boolean;
  position_changed?: boolean;
  size_changed?: boolean;
  old_geometry?: any;
  new_geometry?: any;
  confidence_changed?: boolean;
  old_confidence?: number;
  new_confidence?: number;
  attributes_changed?: boolean;
  old_attributes?: Record<string, any>;
  new_attributes?: Record<string, any>;
}

export interface ModifiedAnnotation {
  old: AnnotationSnapshot;
  new: AnnotationSnapshot;
  changes: AnnotationChanges;
}

export interface ImageDiff {
  added: AnnotationSnapshot[];
  removed: AnnotationSnapshot[];
  modified: ModifiedAnnotation[];
  unchanged: AnnotationSnapshot[];
  summary: {
    added_count: number;
    removed_count: number;
    modified_count: number;
    unchanged_count: number;
    total_changes: number;
  };
}

export interface VersionDiffResponse {
  version_a: VersionMetadata;
  version_b: VersionMetadata;
  project_id: string;
  task_type: string;
  image_diffs: Record<string, ImageDiff>;  // image_id -> diff data
  summary: VersionDiffSummary;
  class_stats: Record<string, ClassStats>;  // class_name -> stats
}

export interface VersionDiffSummaryResponse {
  version_a: VersionMetadata;
  version_b: VersionMetadata;
  project_id: string;
  task_type: string;
  summary: VersionDiffSummary;
  class_stats: Record<string, ClassStats>;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Compare two annotation versions (full diff data)
 *
 * @param versionAId - Old version ID
 * @param versionBId - New version ID
 * @param imageId - Optional: compare only specific image
 * @returns Complete diff data with per-image changes and summary statistics
 */
export async function compareVersions(
  versionAId: number,
  versionBId: number,
  imageId?: string
): Promise<VersionDiffResponse> {
  const params = new URLSearchParams();
  if (imageId) {
    params.set('image_id', imageId);
  }

  const queryString = params.toString();
  const url = `/api/v1/version-diff/versions/${versionAId}/compare/${versionBId}${
    queryString ? `?${queryString}` : ''
  }`;

  return apiClient.get<VersionDiffResponse>(url);
}

/**
 * Get version diff summary (compact overview)
 *
 * @param versionAId - Old version ID
 * @param versionBId - New version ID
 * @returns Summary statistics only without detailed per-image diffs
 */
export async function getVersionDiffSummary(
  versionAId: number,
  versionBId: number
): Promise<VersionDiffSummaryResponse> {
  return apiClient.get<VersionDiffSummaryResponse>(
    `/api/v1/version-diff/versions/${versionAId}/compare/${versionBId}/summary`
  );
}
