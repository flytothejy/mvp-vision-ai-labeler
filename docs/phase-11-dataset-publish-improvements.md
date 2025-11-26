# Phase 11: Dataset Publish Format Improvements

**Created**: 2025-11-26
**Status**: Planning
**Branch**: `feature/dataset-publish-improvements`

## Overview

Phase 11에서는 published annotations.json 파일 구조를 개선하여 데이터 일관성, 추적성, 그리고 다운스트림 ML 파이프라인 호환성을 향상시킵니다.

## Current State Analysis

### 1. Image ID Format (현재: Sequential Integer)

**Current Implementation** (`dice_export_service.py:165`):
```python
dice_id = idx + 1  # Sequential: 1, 2, 3, ...
```

**Current Output**:
```json
{
  "images": [
    {
      "id": 1,
      "file_name": "images/zipper/combined/001.png",
      ...
    }
  ]
}
```

**Issues**:
- Image ID (1, 2, 3)와 file_name (path) 사이에 연결성 없음
- 이미지 추가/삭제 시 ID 재배정 필요 (순서 의존성)
- 멀티 배치 export 시 ID 충돌 가능성
- Version diff 시 file_name으로만 매칭 가능 (ID는 무의미)

**Proposal**:
- **Option 1A (Recommended)**: file_name을 ID로 사용
  ```json
  {
    "id": "images/zipper/combined/001.png",
    "file_name": "images/zipper/combined/001.png"
  }
  ```
  - ✅ 영구적이고 안정적인 ID
  - ✅ Version diff 간소화
  - ✅ 이미지 순서 무관
  - ❌ COCO format 호환성 깨짐 (integer ID 필요)

- **Option 1B**: Hybrid approach (both ID formats)
  ```json
  {
    "id": 1,
    "file_path": "images/zipper/combined/001.png",
    "file_name": "001.png",  // filename only
  }
  ```
  - ✅ COCO format 호환성 유지
  - ✅ file_path로 영구 참조 가능
  - ✅ file_name으로 간단한 표시
  - ❌ 필드 중복 (id vs file_path)

- **Option 1C**: UUID-based stable IDs
  ```json
  {
    "id": "img_550e8400-e29b-41d4-a716-446655440000",
    "file_name": "images/zipper/combined/001.png"
  }
  ```
  - ✅ 영구적이고 충돌 없는 ID
  - ✅ 멀티 배치 병합 용이
  - ❌ COCO format 호환성 깨짐
  - ❌ 가독성 낮음

**Decision Required**: 어떤 옵션을 선택할지? COCO 호환성이 중요한가?

---

### 2. File Format Information (현재: 없음)

**Current Implementation**:
```json
{
  "file_name": "images/zipper/combined/001.png"
}
```

**Issues**:
- 파일 확장자를 file_name에서 파싱해야 함
- Image format validation 어려움
- Metadata에 명시적 정보 없음

**Proposal**:
```json
{
  "file_name": "images/zipper/combined/001.png",
  "file_format": "png",  // or "jpg", "jpeg", "bmp", etc.
  "file_ext": ".png"      // optional: with dot
}
```

**Implementation**:
```python
import os
file_name = image_id  # e.g., "images/zipper/combined/001.png"
file_ext = os.path.splitext(file_name)[1]  # ".png"
file_format = file_ext[1:].lower() if file_ext else "unknown"  # "png"
```

**Value**:
- ✅ 명시적 format 정보
- ✅ Validation 용이
- ✅ ML 파이프라인에서 format별 처리 가능
- ❌ file_name에서 유도 가능하므로 일부 중복

**Decision Required**: 추가할 필요가 있는가? (낮은 우선순위)

---

### 3. iscrowd Field (현재: 하드코딩 0)

**Current Implementation** (`dice_export_service.py:321, 363`):
```python
"iscrowd": 0,
```

**Purpose** (COCO format standard):
- `iscrowd = 0`: Individual object instance (instance segmentation)
- `iscrowd = 1`: Crowd/group annotation (semantic segmentation)

**Current Issues**:
- 항상 0으로 하드코딩됨
- Crowd annotation 지원 불가
- UI에서 설정할 방법 없음

**Use Cases**:
- **Detection/Segmentation**: 대부분 instance annotation (iscrowd=0)
- **Crowd scenes**: 사람 군중, 나무 숲 등 개별 구분 불가능한 경우 (iscrowd=1)

**Proposal**:
- **Short-term**: 현재 상태 유지 (항상 0)
  - 대부분의 use case에 충분
  - Complexity 낮음

- **Long-term** (Phase 12+): Crowd annotation 지원
  ```json
  {
    "iscrowd": 1,
    "attributes": {
      "crowd_type": "dense",
      "estimated_count": 50
    }
  }
  ```
  - UI에 "Mark as Crowd" 옵션 추가
  - Database: `Annotation.attributes` 또는 새 필드

**Decision**: 현재는 유지, Phase 12+에서 필요시 구현

---

### 4. attributes Field (현재: DB attributes 그대로 저장)

**Current Implementation** (`dice_export_service.py:322, 364`):
```python
"attributes": ann.attributes or {}
```

**Purpose**:
- Additional metadata for each annotation
- Use cases:
  - Object properties: `{"damaged": true, "color": "red"}`
  - Quality flags: `{"occluded": true, "truncated": false}`
  - ML model outputs: `{"confidence": 0.95, "model_version": "v1.2"}`

**Current State**:
- ✅ Flexible JSON structure
- ✅ DB에서 직접 전달
- ❌ Schema validation 없음
- ❌ UI에서 설정 방법 제한적

**Proposal**:
- **Keep current flexible structure**
- Add optional schema validation (Phase 12):
  ```python
  # Project-level attribute schema
  project.attribute_schema = {
    "detection": {
      "damaged": {"type": "boolean", "default": false},
      "color": {"type": "string", "enum": ["red", "blue", "green"]}
    }
  }
  ```

**Decision**: 현재 구조 유지, 검증은 나중에

---

### 5. labeled_by / reviewed_by (현재: null)

**Current Implementation** (`dice_export_service.py:228-230`):
```python
"metadata": {
  "labeled_by": labeled_by_user.email if labeled_by_user else None,
  "labeled_at": to_kst_isoformat(image_annotations[0].created_at) if image_annotations else None,
  "reviewed_by": reviewed_by_user.email if reviewed_by_user else None,
  "reviewed_at": to_kst_isoformat(status.confirmed_at) if status and status.confirmed_at else None,
  "source": "platform_labeler_v1.0"
}
```

**Why null?**:
- `labeled_by`: `first_annotation.created_by` 조회
  - ✅ Logic 정상
  - ❌ Data가 없으면 null (User 테이블에 created_by 미존재?)

- `reviewed_by`: `annotation.confirmed_by` 조회
  - ✅ Logic 정상
  - ❌ Confirmed 되지 않은 경우 null

**Issues**:
1. **created_by 추적 누락**
   - Phase 8.1 RBAC 이후 모든 annotation은 `created_by` 가져야 함
   - DB constraint 확인 필요

2. **confirmed_by 조건**
   - Draft/Working annotations는 confirmed_by가 없음 (정상)
   - Published annotations도 null이면 문제

**Proposal**:

**A. 즉시 수정 (Data Integrity)**:
```python
# dice_export_service.py:180-183
if image_annotations:
    first_annotation = image_annotations[0]
    if first_annotation.created_by:
        labeled_by_user = platform_db.query(User).filter(
            User.id == first_annotation.created_by
        ).first()
    else:
        # Fallback: Check all annotations
        for ann in image_annotations:
            if ann.created_by:
                labeled_by_user = platform_db.query(User).filter(
                    User.id == ann.created_by
                ).first()
                break
```

**B. Database Migration** (Phase 12):
- Add NOT NULL constraint to `annotations.created_by`
- Backfill missing created_by from session logs or default user
- Add DB index on `created_by` for faster lookups

**C. Annotation Confirmation Workflow**:
- 현재 `annotation_state`: `draft` → `confirmed` → `verified`
- `confirmed_by`: "Confirm" 버튼 클릭한 사용자
- `reviewed_by`: `verified` 상태로 변경한 reviewer

**Decision**:
1. 즉시 fallback 로직 추가 (Option A)
2. Phase 12에서 DB constraint 추가 (Option B)
3. Confirmation workflow 검토 및 문서화

---

### 6. split Field (현재: 하드코딩 "train")

**Current Implementation** (`dice_export_service.py:222`):
```python
"split": "train",  # TODO: Implement train/val/test split logic
```

**Issues**:
- 모든 이미지가 "train"으로 고정
- ML 파이프라인에서 train/val/test split 불가능
- Manual split 필요

**Use Cases**:
- **ML Training**: 70% train / 20% val / 10% test
- **Cross-validation**: k-fold splits
- **Temporal split**: 시간순 분할 (older=train, recent=test)

**Proposal Options**:

**Option 6A: Manual Split (UI)**:
```typescript
// frontend: 이미지 선택 후 split 할당
<SplitSelector
  images={selectedImages}
  onAssign={(imageIds, split) => updateSplit(imageIds, split)}
/>
```
- DB: `ImageAnnotationStatus.split` (new column)
- Export: DB에서 split 읽어서 사용

**Option 6B: Auto Split (Random)**:
```python
# dice_export_service.py
import random
random.seed(42)  # Reproducible
for idx, (image_id, ...) in enumerate(sorted_images):
    rand = random.random()
    split = "train" if rand < 0.7 else ("val" if rand < 0.9 else "test")
```
- ✅ Zero configuration
- ❌ Non-deterministic (이미지 추가 시 변경)

**Option 6C: Hash-based Split (Deterministic)**:
```python
import hashlib
def get_split(image_id: str, train=0.7, val=0.2) -> str:
    hash_val = int(hashlib.md5(image_id.encode()).hexdigest(), 16)
    rand = (hash_val % 1000) / 1000.0
    if rand < train:
        return "train"
    elif rand < train + val:
        return "val"
    else:
        return "test"
```
- ✅ Deterministic (image_id 기반)
- ✅ 이미지 추가해도 기존 split 유지
- ✅ Zero configuration

**Option 6D: Stratified Split (Class-balanced)**:
```python
from sklearn.model_selection import train_test_split
# Split by class to maintain class distribution
```
- ✅ Class balance 유지
- ❌ Dependency 추가 (sklearn)
- ❌ Complexity 높음

**Decision Required**:
- Short-term: Option 6C (Hash-based, deterministic)
- Long-term: Option 6A (Manual UI) + 6C (default)

---

## Implementation Plan

### Priority 1: Critical Fixes (Phase 11.1)

- [ ] **1.1 Fix labeled_by / reviewed_by null issue**
  - Add fallback logic for missing created_by
  - Test with existing data
  - Estimated: 2h

- [ ] **1.2 Implement hash-based split**
  - Add `get_split()` function
  - Update dice_export_service.py
  - Test split distribution
  - Estimated: 2h

### Priority 2: Image ID Strategy (Phase 11.2)

- [ ] **2.1 Decide on Image ID format**
  - Review COCO format requirements
  - Choose Option 1A, 1B, or 1C
  - Update DICE format documentation
  - Estimated: 1h (decision) + 3h (implementation)

- [ ] **2.2 Implement chosen ID format**
  - Update dice_export_service.py
  - Update version_diff_service.py (ID 매칭 로직)
  - Update all consumers (YOLO, COCO exporters)
  - Add migration script for existing exports
  - Estimated: 4h

### Priority 3: Optional Enhancements (Phase 11.3)

- [ ] **3.1 Add file_format field**
  - Extract from file_name
  - Add to DICE output
  - Estimated: 1h

- [ ] **3.2 Document attributes schema**
  - Define common attributes
  - Add examples to docs
  - Estimated: 2h

- [ ] **3.3 Plan iscrowd support** (Phase 12+)
  - Design UI for crowd annotation
  - Define DB schema changes
  - Estimated: Planning only

### Priority 4: Testing & Validation (Phase 11.4)

- [ ] **4.1 Test with existing datasets**
  - Export zipper dataset
  - Validate all fields populated
  - Check labeled_by / reviewed_by
  - Verify split distribution
  - Estimated: 2h

- [ ] **4.2 Version diff compatibility**
  - Test diff with new ID format
  - Ensure backward compatibility
  - Estimated: 2h

- [ ] **4.3 Documentation**
  - Update DICE format spec
  - Add migration guide
  - Document breaking changes
  - Estimated: 3h

---

## Total Estimated Time

- **Priority 1**: 4h (critical)
- **Priority 2**: 8h (important)
- **Priority 3**: 3h (optional)
- **Priority 4**: 7h (testing)
- **Total**: 22h (3 days)

---

## Decision Points

### Immediate Decisions Required:

1. **Image ID Format**: Option 1A (file_name as ID) vs 1B (hybrid) vs 1C (UUID)?
   - **Recommendation**: **Option 1B (Hybrid)** - COCO 호환성 + 영구 참조

2. **Split Strategy**: Hash-based (6C) vs Manual (6A)?
   - **Recommendation**: **6C 먼저 구현** (default), 6A는 Phase 12

3. **File Format Field**: 추가? (낮은 우선순위)
   - **Recommendation**: **추가** (1h만 소요, 명확한 메타데이터)

### Future Decisions (Phase 12+):

4. **iscrowd Support**: 구현?
5. **Attributes Schema Validation**: 필요?
6. **Manual Split UI**: 우선순위?

---

## Breaking Changes

### If Option 1A (file_name as ID):
- ❌ COCO format 호환 깨짐
- ❌ Existing ML pipelines 수정 필요 (integer ID 가정)
- ✅ Version diff 간소화
- ✅ 영구적 ID

### If Option 1B (Hybrid):
- ✅ COCO format 호환 유지
- ✅ Backward compatible
- ✅ file_path로 영구 참조 추가
- ❌ 약간의 필드 중복

### If Option 1C (UUID):
- ❌ COCO format 호환 깨짐
- ✅ 충돌 없는 영구 ID
- ❌ 가독성 낮음

---

## Files to Modify

### Backend:
- `backend/app/services/dice_export_service.py` (main changes)
- `backend/app/services/version_diff_service.py` (ID 매칭 로직)
- `backend/app/services/coco_export_service.py` (COCO export)
- `backend/app/services/yolo_export_service.py` (YOLO export)
- `backend/app/db/models/labeler.py` (split column 추가?)

### Docs:
- `docs/dice-format-spec.md` (new)
- `docs/phase-11-dataset-publish-improvements.md` (this file)
- `docs/ANNOTATION_IMPLEMENTATION_TODO.md` (update)

### Tests:
- `backend/tests/test_dice_export.py` (new)
- `backend/tests/test_version_diff.py` (update)

---

## Next Steps

1. **Review this plan** with team
2. **Make decisions** on Decision Points
3. **Start with Priority 1** (critical fixes)
4. **Test thoroughly** before merge
5. **Update documentation**

---

## Questions for Discussion

1. COCO format 호환성이 얼마나 중요한가?
2. 기존 exported datasets 마이그레이션 필요한가?
3. Split 기능이 얼마나 urgent한가?
4. labeled_by null 문제의 root cause는? (DB 확인 필요)
