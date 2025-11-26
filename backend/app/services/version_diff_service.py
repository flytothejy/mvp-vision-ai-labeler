"""Version diff calculation service."""

import json
import boto3
from botocore.config import Config
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session

from app.db.models.labeler import AnnotationVersion, Annotation
from app.core.config import settings


class VersionDiffService:
    """Service for calculating diffs between annotation versions."""

    @staticmethod
    def _convert_dice_to_db_format(dice_ann: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert DICE format annotation to DB format for diff comparison.

        DICE format:
            {id, image_id, class_id, class_name, bbox: [x,y,w,h], ...}

        DB format:
            {annotation_id, image_id, annotation_type, geometry: {x,y,width,height}, ...}
        """
        # Determine annotation type from DICE fields
        annotation_type = 'bbox'  # default
        geometry = {}

        if 'bbox' in dice_ann:
            # Bounding box annotation
            annotation_type = 'bbox'
            bbox = dice_ann['bbox']
            if isinstance(bbox, list) and len(bbox) >= 4:
                geometry = {
                    'x': bbox[0],
                    'y': bbox[1],
                    'width': bbox[2],
                    'height': bbox[3]
                }
        elif 'segmentation' in dice_ann:
            # Polygon/segmentation annotation
            annotation_type = 'polygon'
            seg = dice_ann['segmentation']
            if isinstance(seg, list) and len(seg) > 0:
                # DICE segmentation format: [[x1,y1,x2,y2,...]]
                flat_points = seg[0] if seg else []
                points = []
                for i in range(0, len(flat_points), 2):
                    if i + 1 < len(flat_points):
                        points.append([flat_points[i], flat_points[i+1]])
                geometry = {'points': points}
        elif 'polyline' in dice_ann:
            # Polyline annotation
            annotation_type = 'polyline'
            polyline = dice_ann['polyline']
            points = []
            for i in range(0, len(polyline), 2):
                if i + 1 < len(polyline):
                    points.append([polyline[i], polyline[i+1]])
            geometry = {'points': points}
        elif 'circle' in dice_ann:
            # Circle annotation
            annotation_type = 'circle'
            circle = dice_ann['circle']
            geometry = {
                'center': circle.get('center', [0, 0]),
                'radius': circle.get('radius', 0)
            }
        elif dice_ann.get('is_background'):
            # No object marker
            annotation_type = 'no_object'
        else:
            # Classification or other
            annotation_type = 'classification'

        # Convert to DB format
        return {
            'annotation_id': dice_ann.get('id'),  # DICE 'id' → DB 'annotation_id'
            'image_id': dice_ann.get('image_id'),
            'annotation_type': annotation_type,
            'geometry': geometry,
            'class_id': str(dice_ann.get('class_id', 0)),  # Ensure string
            'class_name': dice_ann.get('class_name', 'unknown'),
            'attributes': dice_ann.get('attributes', {}),
            'confidence': dice_ann.get('confidence', 1.0),
        }

    @staticmethod
    def _parse_version_number(version_number: str) -> tuple:
        """
        Parse version number into a comparable tuple for sorting.

        This ensures older versions come before newer versions.

        Examples:
            'Working' → (999999, 0)  # Always most recent
            'draft' → (999998, 0)    # Newer than published
            'v1.0' → (1, 0)
            'v2.1' → (2, 1)

        Returns:
            Tuple of (major, minor) for comparison
        """
        # Special case: Working version is always the newest
        if version_number == 'Working':
            return (999999, 0)

        # Special case: Draft versions are newer than published but older than Working
        if version_number.lower() == 'draft':
            return (999998, 0)

        # Parse vX.Y format (e.g., v1.0, v2.5)
        if version_number.startswith('v'):
            try:
                parts = version_number[1:].split('.')
                major = int(parts[0]) if len(parts) > 0 else 0
                minor = int(parts[1]) if len(parts) > 1 else 0
                return (major, minor)
            except (ValueError, IndexError):
                # Fallback for unparseable versions
                return (0, 0)

        # Unknown format - treat as very old (version 0.0)
        return (0, 0)

    @staticmethod
    def calculate_iou(bbox1: Dict[str, Any], bbox2: Dict[str, Any]) -> float:
        """
        Calculate Intersection over Union (IoU) between two bounding boxes.

        Args:
            bbox1: First bbox with keys x, y, width, height
            bbox2: Second bbox with keys x, y, width, height

        Returns:
            IoU value between 0 and 1
        """
        # Extract coordinates
        x1_min = bbox1.get('x', 0)
        y1_min = bbox1.get('y', 0)
        x1_max = x1_min + bbox1.get('width', 0)
        y1_max = y1_min + bbox1.get('height', 0)

        x2_min = bbox2.get('x', 0)
        y2_min = bbox2.get('y', 0)
        x2_max = x2_min + bbox2.get('width', 0)
        y2_max = y2_min + bbox2.get('height', 0)

        # Calculate intersection area
        x_inter_min = max(x1_min, x2_min)
        y_inter_min = max(y1_min, y2_min)
        x_inter_max = min(x1_max, x2_max)
        y_inter_max = min(y1_max, y2_max)

        if x_inter_max < x_inter_min or y_inter_max < y_inter_min:
            return 0.0

        inter_area = (x_inter_max - x_inter_min) * (y_inter_max - y_inter_min)

        # Calculate union area
        bbox1_area = (x1_max - x1_min) * (y1_max - y1_min)
        bbox2_area = (x2_max - x2_min) * (y2_max - y2_min)
        union_area = bbox1_area + bbox2_area - inter_area

        if union_area == 0:
            return 0.0

        return inter_area / union_area

    @staticmethod
    def find_best_match(
        annotation: Dict[str, Any],
        candidates: List[Dict[str, Any]],
        iou_threshold: float = 0.5
    ) -> Optional[Tuple[Dict[str, Any], int]]:
        """
        Find the best matching annotation from candidates using IoU.

        Args:
            annotation: Source annotation
            candidates: List of candidate annotations
            iou_threshold: Minimum IoU to consider a match

        Returns:
            Tuple of (matched annotation, index) or None if no match found
        """
        # First try exact annotation_id match
        ann_id = annotation.get('annotation_id')
        if ann_id:
            for idx, candidate in enumerate(candidates):
                if candidate.get('annotation_id') == ann_id:
                    return (candidate, idx)

        # Phase 11: Try IoU-based matching for bbox annotations
        # Normalize geometry to handle both DB and R2 formats
        geometry = annotation.get('geometry', {})
        if not geometry:
            return None

        normalized_geom = VersionDiffService.normalize_geometry(geometry)
        if 'x' not in normalized_geom:
            return None

        best_iou = 0.0
        best_match = None
        best_idx = -1

        for idx, candidate in enumerate(candidates):
            candidate_geometry = candidate.get('geometry', {})
            if not candidate_geometry:
                continue

            normalized_candidate = VersionDiffService.normalize_geometry(candidate_geometry)
            if 'x' not in normalized_candidate:
                continue

            iou = VersionDiffService.calculate_iou(normalized_geom, normalized_candidate)
            if iou > best_iou and iou >= iou_threshold:
                best_iou = iou
                best_match = candidate
                best_idx = idx

        return (best_match, best_idx) if best_match else None

    @staticmethod
    def normalize_geometry(geometry: Dict[str, Any]) -> Dict[str, Any]:
        """
        Normalize geometry to consistent format for comparison.

        Handles both formats:
        - DB format: {x, y, width, height}
        - R2/DICE format: {bbox: [x, y, w, h], type, image_width, image_height}

        Args:
            geometry: Geometry dict in any format

        Returns:
            Normalized geometry dict with only essential keys
        """
        normalized = {}

        # BBox: Extract from array format or use direct keys
        if 'bbox' in geometry and isinstance(geometry['bbox'], list):
            bbox = geometry['bbox']
            if len(bbox) >= 4:
                normalized['x'] = bbox[0]
                normalized['y'] = bbox[1]
                normalized['width'] = bbox[2]
                normalized['height'] = bbox[3]
        elif 'x' in geometry:
            # Already in normalized format
            normalized['x'] = geometry.get('x')
            normalized['y'] = geometry.get('y')
            normalized['width'] = geometry.get('width')
            normalized['height'] = geometry.get('height')

        # Polygon/Polyline: Keep points
        if 'points' in geometry:
            normalized['points'] = geometry['points']

        # Circle: Keep center and radius
        if 'center' in geometry:
            normalized['center'] = geometry['center']
        if 'radius' in geometry:
            normalized['radius'] = geometry['radius']

        return normalized

    @staticmethod
    def compare_annotations(
        ann_old: Dict[str, Any],
        ann_new: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Compare two matched annotations and return changes.

        Args:
            ann_old: Old annotation
            ann_new: New annotation

        Returns:
            Dict with change details
        """
        changes = {}

        # Check class change
        old_class = ann_old.get('class_name') or ann_old.get('class_id')
        new_class = ann_new.get('class_name') or ann_new.get('class_id')
        if old_class != new_class:
            changes['class_changed'] = True
            changes['old_class'] = old_class
            changes['new_class'] = new_class

        # Phase 11: Normalize geometry formats before comparison
        # Handles both DB format {x, y, width, height} and R2 format {bbox: [...]}
        old_geom_raw = ann_old.get('geometry', {})
        new_geom_raw = ann_new.get('geometry', {})
        old_geom = VersionDiffService.normalize_geometry(old_geom_raw)
        new_geom = VersionDiffService.normalize_geometry(new_geom_raw)

        # Debug: Log first annotation comparison
        ann_id = ann_old.get('annotation_id')
        if ann_id and ann_id == 2129:  # Debug specific annotation
            print(f"\n[Compare Debug] Annotation {ann_id}:")
            print(f"  Old geom raw keys: {list(old_geom_raw.keys())}")
            print(f"  New geom raw keys: {list(new_geom_raw.keys())}")
            print(f"  Old geom normalized: {old_geom}")
            print(f"  New geom normalized: {new_geom}")

        geometry_changed = False
        if old_geom.get('x') != new_geom.get('x') or old_geom.get('y') != new_geom.get('y'):
            geometry_changed = True
            changes['position_changed'] = True
            if ann_id and ann_id == 2129:
                print(f"  Position changed: old ({old_geom.get('x')}, {old_geom.get('y')}) != new ({new_geom.get('x')}, {new_geom.get('y')})")

        if old_geom.get('width') != new_geom.get('width') or old_geom.get('height') != new_geom.get('height'):
            geometry_changed = True
            changes['size_changed'] = True
            if ann_id and ann_id == 2129:
                print(f"  Size changed: old ({old_geom.get('width')}, {old_geom.get('height')}) != new ({new_geom.get('width')}, {new_geom.get('height')})")

        if geometry_changed:
            changes['geometry_changed'] = True
            changes['old_geometry'] = old_geom
            changes['new_geometry'] = new_geom

        # Check confidence change
        # Treat None as 1.0 (default confidence)
        old_confidence = ann_old.get('confidence')
        new_confidence = ann_new.get('confidence')
        if old_confidence is None:
            old_confidence = 1.0
        if new_confidence is None:
            new_confidence = 1.0

        if old_confidence != new_confidence:
            changes['confidence_changed'] = True
            changes['old_confidence'] = old_confidence
            changes['new_confidence'] = new_confidence

        # Check attributes change
        old_attrs = ann_old.get('attributes', {})
        new_attrs = ann_new.get('attributes', {})
        if old_attrs != new_attrs:
            changes['attributes_changed'] = True
            changes['old_attributes'] = old_attrs
            changes['new_attributes'] = new_attrs

        # Debug: Log final comparison result
        if ann_id and ann_id == 2129:
            print(f"  Final changes dict: {changes}")
            print(f"  Old confidence: {ann_old.get('confidence')}")
            print(f"  New confidence: {ann_new.get('confidence')}")
            print(f"  Old attributes: {old_attrs}")
            print(f"  New attributes: {new_attrs}")

        return changes

    @staticmethod
    def calculate_diff_for_image(
        snapshots_a: List[Dict[str, Any]],
        snapshots_b: List[Dict[str, Any]],
        debug_image_id: str = None
    ) -> Dict[str, Any]:
        """
        Calculate diff between two versions for a single image.

        Args:
            snapshots_a: List of annotation snapshots from version A
            snapshots_b: List of annotation snapshots from version B
            debug_image_id: Optional image ID for debug logging

        Returns:
            Dict with categorized changes
        """
        # Phase 11: Debug logging for first image to diagnose false diffs
        if debug_image_id and len(snapshots_a) > 0:
            print(f"\n[Diff Debug] Image: {debug_image_id}")
            print(f"[Diff Debug] Version A ({len(snapshots_a)} annotations):")
            for i, ann in enumerate(snapshots_a[:2]):  # Show first 2
                print(f"  [{i}] annotation_id={ann.get('annotation_id')}, "
                      f"type={ann.get('annotation_type')}, "
                      f"class={ann.get('class_name') or ann.get('class_id')}, "
                      f"geometry_keys={list(ann.get('geometry', {}).keys())}")
            print(f"[Diff Debug] Version B ({len(snapshots_b)} annotations):")
            for i, ann in enumerate(snapshots_b[:2]):  # Show first 2
                print(f"  [{i}] annotation_id={ann.get('annotation_id')}, "
                      f"type={ann.get('annotation_type')}, "
                      f"class={ann.get('class_name') or ann.get('class_id')}, "
                      f"geometry_keys={list(ann.get('geometry', {}).keys())}")

        added = []
        removed = []
        modified = []
        unchanged = []

        # Deep copy to avoid modifying originals
        remaining_b = list(snapshots_b)

        # Find matches for version A annotations
        for ann_a in snapshots_a:
            match_result = VersionDiffService.find_best_match(ann_a, remaining_b)

            if not match_result:
                # No match found - annotation was removed
                removed.append(ann_a)
            else:
                ann_b, match_idx = match_result
                remaining_b.pop(match_idx)

                # Compare for changes
                changes = VersionDiffService.compare_annotations(ann_a, ann_b)

                if changes:
                    # Has changes - modified
                    modified.append({
                        'old': ann_a,
                        'new': ann_b,
                        'changes': changes
                    })
                else:
                    # No changes - unchanged
                    unchanged.append(ann_b)

        # Remaining annotations in B are new additions
        added = remaining_b

        # Debug: Log diff results for specific images
        if debug_image_id and ('combined/013' in debug_image_id or 'combined/012' in debug_image_id):
            print(f"\n[Diff Result] Image: {debug_image_id}")
            print(f"  Added: {len(added)}")
            print(f"  Removed: {len(removed)}")
            print(f"  Modified: {len(modified)}")
            print(f"  Unchanged: {len(unchanged)}")
            if removed:
                print(f"  Removed details:")
                for r in removed:
                    print(f"    - annotation_id={r.get('annotation_id')}, class={r.get('class_name') or r.get('class_id')}")
            if modified:
                print(f"  Modified details:")
                for m in modified:
                    print(f"    - annotation_id={m['old'].get('annotation_id')}, changes={list(m['changes'].keys())}")

        return {
            'added': added,
            'removed': removed,
            'modified': modified,
            'unchanged': unchanged,
            'summary': {
                'added_count': len(added),
                'removed_count': len(removed),
                'modified_count': len(modified),
                'unchanged_count': len(unchanged),
                'total_changes': len(added) + len(removed) + len(modified)
            }
        }

    @staticmethod
    def get_annotations_from_db(
        db: Session,
        project_id: str,
        task_type: str,
        image_id: Optional[str] = None
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Get current annotations from DB for working/draft versions.

        Args:
            db: Database session
            project_id: Project ID
            task_type: Task type
            image_id: Optional - filter by specific image

        Returns:
            Dict mapping image_id to list of annotations
        """
        # Query annotations from DB
        query = db.query(Annotation).filter(
            Annotation.project_id == project_id,
            Annotation.task_type == task_type
        )

        # Filter by image_id if specified
        if image_id:
            query = query.filter(Annotation.image_id == image_id)

        annotations = query.all()

        # Group by image_id
        grouped = {}
        for ann in annotations:
            img_id = ann.image_id

            if img_id not in grouped:
                grouped[img_id] = []

            # Convert to dict format matching R2 structure
            ann_dict = {
                'annotation_id': ann.id,
                'image_id': ann.image_id,
                'annotation_type': ann.annotation_type,
                'geometry': ann.geometry,
                'class_id': ann.class_id,
                'class_name': ann.class_name,
                'attributes': ann.attributes or {},
                'confidence': ann.confidence,
            }

            grouped[img_id].append(ann_dict)

        return grouped

    @staticmethod
    def get_version_annotations_from_r2(
        project_id: str,
        task_type: str,
        version_number: str
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Get annotations for a version from R2 storage, grouped by image_id.

        R2 path: annotations/exports/{project_id}/{task_type}/{version_number}/annotations.json

        Args:
            project_id: Project ID
            task_type: Task type (detection, classification, etc.)
            version_number: Version number (e.g., 'v1.0')

        Returns:
            Dict mapping image_id to list of annotations
        """
        # Initialize S3 client for R2
        s3_client = boto3.client(
            's3',
            endpoint_url=settings.S3_ENDPOINT,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION,
            config=Config(signature_version='s3v4')
        )

        # Construct R2 key
        s3_key = f"exports/{project_id}/{task_type}/{version_number}/annotations.json"

        try:
            # Download annotations.json from R2
            response = s3_client.get_object(
                Bucket='annotations',
                Key=s3_key
            )

            # Parse JSON
            annotations_data = json.loads(response['Body'].read().decode('utf-8'))

            # Phase 11: Handle DICE format structure
            # DICE format: {"images": [{"id": "...", "file_name": "...", "annotations": [...]}]}
            grouped = {}

            if isinstance(annotations_data, dict) and 'images' in annotations_data:
                # DICE format
                for image_obj in annotations_data['images']:
                    # Prioritize file_name (full path) over id (numeric) to match frontend
                    image_id = image_obj.get('file_name') or image_obj.get('id')
                    annotations = image_obj.get('annotations', [])

                    if image_id and annotations:
                        # Convert DICE format to DB format for consistency
                        converted_annotations = []
                        for ann in annotations:
                            converted_ann = VersionDiffService._convert_dice_to_db_format(ann)
                            converted_annotations.append(converted_ann)

                        # Ensure image_id is string (DICE format may use int IDs)
                        grouped[str(image_id)] = converted_annotations
            else:
                # Legacy format: flat list of annotations
                for ann in annotations_data:
                    image_id = ann.get('image_id')

                    if not image_id:
                        continue

                    if image_id not in grouped:
                        grouped[image_id] = []

                    grouped[image_id].append(ann)

            return grouped

        except Exception as e:
            raise ValueError(f"Failed to load version {version_number} from R2: {str(e)}")

    @staticmethod
    def get_version_annotations(
        db: Session,
        version: AnnotationVersion,
        image_id: Optional[str] = None
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Get annotations for a version from appropriate source (DB or R2).

        - Working/Draft versions: DB (current state)
        - Published versions: R2 (immutable snapshot)

        Args:
            db: Database session
            version: AnnotationVersion object
            image_id: Optional - filter by specific image

        Returns:
            Dict mapping image_id to list of annotations
        """
        # Working/Draft versions → Get from DB
        if version.version_type in ['working', 'draft']:
            return VersionDiffService.get_annotations_from_db(
                db,
                version.project_id,
                version.task_type,
                image_id
            )

        # Published versions → Get from R2
        else:  # version.version_type == 'published'
            annotations = VersionDiffService.get_version_annotations_from_r2(
                version.project_id,
                version.task_type,
                version.version_number
            )

            # Filter by image_id if specified
            if image_id:
                return {image_id: annotations.get(image_id, [])}

            return annotations

    @staticmethod
    def calculate_version_diff(
        db: Session,
        version_a_id: int,
        version_b_id: int,
        image_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Calculate diff between two versions.

        Args:
            db: Database session
            version_a_id: Old version ID (use -1 for virtual Working version)
            version_b_id: New version ID (use -1 for virtual Working version)
            image_id: Optional - compare only this image

        Returns:
            Complete diff data with per-image and summary statistics
        """
        # Phase 11: Handle virtual Working version (ID: -1)
        # Get version metadata, handling -1 as special "current working" version
        version_a = None if version_a_id == -1 else db.get(AnnotationVersion, version_a_id)
        version_b = None if version_b_id == -1 else db.get(AnnotationVersion, version_b_id)

        # At least one must be a real version to get project/task context
        if not version_a and not version_b:
            raise ValueError("At least one version must be a published version")

        # Get reference version (the real one) for project/task context
        ref_version = version_a if version_a else version_b

        if not ref_version:
            raise ValueError("Version not found")

        # Create synthetic version object for Working version (-1)
        from datetime import datetime
        if version_a_id == -1:
            version_a = type('obj', (object,), {
                'id': -1,
                'project_id': ref_version.project_id,
                'task_type': ref_version.task_type,
                'version_number': 'Working',
                'version_type': 'working',
                'created_at': datetime.utcnow(),
                'created_by': 0
            })()

        if version_b_id == -1:
            version_b = type('obj', (object,), {
                'id': -1,
                'project_id': ref_version.project_id,
                'task_type': ref_version.task_type,
                'version_number': 'Working',
                'version_type': 'working',
                'created_at': datetime.utcnow(),
                'created_by': 0
            })()

        if version_a.project_id != version_b.project_id:
            raise ValueError("Versions must be from the same project")

        if version_a.task_type != version_b.task_type:
            raise ValueError("Versions must have the same task type")

        # Phase 11: Auto-sort versions so older is always version_a, newer is version_b
        # This ensures "added" means "added in newer version", "removed" means "deleted in newer"
        print(f"\n[Version Diff] Starting comparison:")
        print(f"  Input version_a: {version_a.version_number} (type: {version_a.version_type})")
        print(f"  Input version_b: {version_b.version_number} (type: {version_b.version_type})")

        parsed_a = VersionDiffService._parse_version_number(version_a.version_number)
        parsed_b = VersionDiffService._parse_version_number(version_b.version_number)

        print(f"  Parsed_a: {parsed_a}")
        print(f"  Parsed_b: {parsed_b}")

        # If version_a is newer than version_b, swap them
        if parsed_a > parsed_b:
            version_a, version_b = version_b, version_a
            print(f"[Version Diff] Auto-swapped!")
            print(f"  Final version_a (older/base): {version_a.version_number} (type: {version_a.version_type})")
            print(f"  Final version_b (newer/compare): {version_b.version_number} (type: {version_b.version_type})")
        else:
            print(f"[Version Diff] No swap needed")
            print(f"  Final version_a (older/base): {version_a.version_number} (type: {version_a.version_type})")
            print(f"  Final version_b (newer/compare): {version_b.version_number} (type: {version_b.version_type})")

        # Get annotations (hybrid: DB for working, R2 for published)
        snapshots_a = VersionDiffService.get_version_annotations(db, version_a, image_id)
        snapshots_b = VersionDiffService.get_version_annotations(db, version_b, image_id)

        # Calculate diff for each image
        image_diffs = {}
        all_image_ids = set(snapshots_a.keys()) | set(snapshots_b.keys())

        # Phase 11: Debug first image to diagnose false diffs
        first_image_id = list(all_image_ids)[0] if all_image_ids else None
        debug_count = 0

        for img_id in all_image_ids:
            anns_a = snapshots_a.get(img_id, [])
            anns_b = snapshots_b.get(img_id, [])

            # Enable debug logging for:
            # 1. First 3 images with annotations
            # 2. Specific images (combined/012, combined/013)
            is_target_image = 'combined/012' in img_id or 'combined/013' in img_id
            debug_this = is_target_image or (debug_count < 3 and (len(anns_a) > 0 or len(anns_b) > 0))
            if debug_this and not is_target_image:
                debug_count += 1

            diff = VersionDiffService.calculate_diff_for_image(
                anns_a, anns_b,
                debug_image_id=img_id if debug_this else None
            )

            # Only include images with changes
            if diff['summary']['total_changes'] > 0:
                image_diffs[img_id] = diff

        # Calculate overall summary
        total_added = sum(d['summary']['added_count'] for d in image_diffs.values())
        total_removed = sum(d['summary']['removed_count'] for d in image_diffs.values())
        total_modified = sum(d['summary']['modified_count'] for d in image_diffs.values())
        total_unchanged = sum(d['summary']['unchanged_count'] for d in image_diffs.values())

        # Per-class breakdown
        class_stats = VersionDiffService._calculate_class_stats(image_diffs)

        return {
            'version_a': {
                'id': version_a.id,
                'version_number': version_a.version_number,
                'version_type': version_a.version_type,
                'created_at': version_a.created_at.isoformat(),
                'created_by': version_a.created_by
            },
            'version_b': {
                'id': version_b.id,
                'version_number': version_b.version_number,
                'version_type': version_b.version_type,
                'created_at': version_b.created_at.isoformat(),
                'created_by': version_b.created_by
            },
            'project_id': version_a.project_id,
            'task_type': version_a.task_type,
            'image_diffs': image_diffs,
            'summary': {
                'images_with_changes': len(image_diffs),
                'total_images': len(all_image_ids),
                'total_added': total_added,
                'total_removed': total_removed,
                'total_modified': total_modified,
                'total_unchanged': total_unchanged,
                'total_changes': total_added + total_removed + total_modified
            },
            'class_stats': class_stats
        }

    @staticmethod
    def _calculate_class_stats(image_diffs: Dict[str, Any]) -> Dict[str, Dict[str, int]]:
        """Calculate per-class statistics from image diffs."""
        class_stats = {}

        for diff in image_diffs.values():
            # Count added by class
            for ann in diff['added']:
                class_name = ann.get('class_name') or ann.get('class_id') or 'unknown'
                if class_name not in class_stats:
                    class_stats[class_name] = {'added': 0, 'removed': 0, 'modified': 0}
                class_stats[class_name]['added'] += 1

            # Count removed by class
            for ann in diff['removed']:
                class_name = ann.get('class_name') or ann.get('class_id') or 'unknown'
                if class_name not in class_stats:
                    class_stats[class_name] = {'added': 0, 'removed': 0, 'modified': 0}
                class_stats[class_name]['removed'] += 1

            # Count modified by class (use new class)
            for mod in diff['modified']:
                class_name = mod['new'].get('class_name') or mod['new'].get('class_id') or 'unknown'
                if class_name not in class_stats:
                    class_stats[class_name] = {'added': 0, 'removed': 0, 'modified': 0}
                class_stats[class_name]['modified'] += 1

        return class_stats
