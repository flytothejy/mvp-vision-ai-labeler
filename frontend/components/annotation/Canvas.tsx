/**
 * Canvas Component
 *
 * Main image viewer with zoom/pan controls and annotation rendering
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAnnotationStore } from '@/lib/stores/annotationStore';
import ClassSelectorModal from './ClassSelectorModal';
import { createAnnotation, updateAnnotation, deleteAnnotation as deleteAnnotationAPI, getProjectAnnotations } from '@/lib/api/annotations';
import type { AnnotationCreateRequest, AnnotationUpdateRequest } from '@/lib/api/annotations';
import { confirmImage, getProjectImageStatuses } from '@/lib/api/projects';
import { ToolRegistry, bboxTool, polygonTool, polylineTool, circleTool, circle3pTool } from '@/lib/annotation';
import type { CanvasRenderContext } from '@/lib/annotation';
import { Circle3pTool } from '@/lib/annotation/tools/Circle3pTool';
import { toast } from '@/lib/stores/toastStore';
import { confirm } from '@/lib/stores/confirmStore';
import { ArrowUturnLeftIcon, ArrowUturnRightIcon } from '@heroicons/react/24/outline';
import Magnifier from './Magnifier';
// Phase 8.5.2: Image Locks
import { imageLockAPI } from '@/lib/api/image-locks';
import type { LockAcquireResponse } from '@/lib/api/image-locks';
// Phase 8.5.1: Conflict Dialog
import { AnnotationConflictDialog } from '../annotations/AnnotationConflictDialog';
import type { ConflictInfo } from '../annotations/AnnotationConflictDialog';
// Phase 11: Diff Mode Components
import DiffToolbar from './DiffToolbar';
import DiffActions from './DiffActions';
import DiffViewModeSelector from './DiffViewModeSelector';

export default function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const {
    currentImage,
    annotations,
    selectedAnnotationId,
    selectAnnotation,
    canvas: canvasState,
    tool,
    setTool,
    isDrawing,
    drawingStart,
    preferences,
    setZoom,
    setPan,
    setCursor,
    startDrawing,
    updateDrawing,
    finishDrawing,
    addAnnotation,
    project,
    isAnnotationVisible,
    currentIndex,
    images,
    goToNextImage,
    goToPrevImage,
    setCurrentIndex,
    currentTask, // Phase 2.9
    deleteAnnotation,
    updateAnnotation: updateAnnotationStore, // Phase 2.10: For undo/redo history
    // Multi-image selection
    selectedImageIds,
    clearImageSelection,
    getCurrentClasses, // Phase 2.9: Get task-specific classes
    selectedVertexIndex, // Polygon vertex editing
    selectedBboxHandle, // Bbox handle editing
    // Phase 2.10: Undo/Redo
    undo,
    redo,
    canUndo,
    canRedo,
    // Phase 2.10.3: Minimap state
    showMinimap,
    // Phase 11: Diff mode
    diffMode,
    getDiffForCurrentImage,
  } = useAnnotationStore();

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number } | null>(null);
  const [showClassSelector, setShowClassSelector] = useState(false);
  const [pendingBbox, setPendingBbox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingImage, setConfirmingImage] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const [resizeStart, setResizeStart] = useState<{ x: number; y: number; bbox: number[] } | null>(null);
  const [canvasCursor, setCanvasCursor] = useState('default');
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [polygonVertices, setPolygonVertices] = useState<[number, number][]>([]);
  // Polygon editing state
  const [isDraggingVertex, setIsDraggingVertex] = useState(false);
  const [draggedVertexIndex, setDraggedVertexIndex] = useState<number | null>(null);
  const [isDraggingPolygon, setIsDraggingPolygon] = useState(false);
  const [polygonDragStart, setPolygonDragStart] = useState<{ x: number; y: number; points: [number, number][] } | null>(null);
  // Polyline drawing state (canvas coordinates)
  const [polylineVertices, setPolylineVertices] = useState<[number, number][]>([]);
  // Circle drawing state (canvas coordinates)
  const [circleCenter, setCircleCenter] = useState<[number, number] | null>(null);
  // Circle 3-point drawing state (canvas coordinates)
  const [circle3pPoints, setCircle3pPoints] = useState<[number, number][]>([]);
  // Circle editing state
  const [isDraggingCircle, setIsDraggingCircle] = useState(false);
  const [circleDragStart, setCircleDragStart] = useState<{ x: number; y: number; center: [number, number] } | null>(null);
  const [isResizingCircle, setIsResizingCircle] = useState(false);

  // Phase 2.10.2: Magnifier state
  const [manualMagnifierActive, setManualMagnifierActive] = useState(false);
  const [magnifierForceOff, setMagnifierForceOff] = useState(false);
  const [magnification, setMagnification] = useState(preferences.magnificationLevel);

  // Phase 8.5.2: Image Lock state
  const [heartbeatInterval, setHeartbeatInterval] = useState<NodeJS.Timeout | null>(null);
  const [isImageLocked, setIsImageLocked] = useState(false);
  const [lockedByUser, setLockedByUser] = useState<string | null>(null);
  const [showLockedDialog, setShowLockedDialog] = useState(false);

  // Phase 8.5.1: Version Conflict state
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [conflictInfo, setConflictInfo] = useState<ConflictInfo | null>(null);
  const [pendingAnnotationUpdate, setPendingAnnotationUpdate] = useState<{
    annotationId: string;
    data: any;
  } | null>(null);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [circleResizeStart, setCircleResizeStart] = useState<{ x: number; y: number; radius: number; handle: string } | null>(null);
  const [selectedCircleHandle, setSelectedCircleHandle] = useState<string | null>(null);

  // Phase 2.10.3: Store canvas refs for Minimap in RightPanel
  useEffect(() => {
    useAnnotationStore.setState({ canvasRef, imageRef });
  }, []);

  // Phase 2.10.2: Reset magnifier force-off when tool changes
  useEffect(() => {
    setMagnifierForceOff(false);
    setManualMagnifierActive(false);
  }, [tool]);

  // Helper to set selectedVertexIndex in store
  const setSelectedVertexIndex = (index: number | null) => {
    useAnnotationStore.setState({ selectedVertexIndex: index });
  };

  // Helper to set selectedBboxHandle in store
  const setSelectedBboxHandle = (handle: string | null) => {
    useAnnotationStore.setState({ selectedBboxHandle: handle });
  };

  // Phase 2.10: Helper to update annotation with history recording
  const updateAnnotationWithHistory = async (annotationId: string, updateData: AnnotationUpdateRequest) => {
    await updateAnnotation(annotationId, updateData);
    // Update store to trigger history recording
    updateAnnotationStore(annotationId, { geometry: updateData.geometry });
  };

  // Phase 2.10.2: Helper to check if current tool is a drawing tool
  const isDrawingTool = (toolName: string | null) => {
    if (!toolName) return false;
    return ['detection', 'polygon', 'polyline', 'circle', 'circle3p'].includes(toolName);
  };

  // Phase 2.10.2: Determine if magnifier should be shown
  const shouldShowMagnifier =
    !magnifierForceOff && ( // Not force disabled by user
      manualMagnifierActive || // Z key pressed
      (isDrawingTool(tool) && preferences.autoMagnifier) // Auto mode
    );

  // Phase 2.7: Calculate draft annotation count
  const draftAnnotations = annotations.filter(ann => {
    const state = (ann as any).annotation_state || (ann as any).annotationState || 'draft';
    return state === 'draft';
  });
  const draftCount = draftAnnotations.length;
  const isImageConfirmed = currentImage ? (currentImage as any).is_confirmed : false;

  // Phase 8.5.1: Helper function to update annotation with version check
  const updateAnnotationWithVersionCheck = async (annotationId: string, updateData: AnnotationUpdateRequest) => {
    try {
      // Find annotation in store to get current version
      const annotation = annotations.find(ann => ann.id === annotationId);

      // Include version in update request
      const dataWithVersion = {
        ...updateData,
        version: annotation?.version,
      };

      await updateAnnotation(annotationId, dataWithVersion);

    } catch (error: any) {
      // Handle version conflict (409 Conflict)
      if (error.response?.status === 409) {
        const detail = error.response.data.detail;

        setConflictInfo({
          annotationId,
          currentVersion: detail.current_version,
          yourVersion: detail.your_version,
          lastUpdatedBy: detail.last_updated_by,
          lastUpdatedAt: detail.last_updated_at,
          message: detail.message,
        });

        setPendingAnnotationUpdate({ annotationId, data: updateData });
        setConflictDialogOpen(true);

        throw error; // Re-throw so caller knows it failed
      } else {
        // Other error
        throw error;
      }
    }
  };

  // Helper function to check if mouse is over a handle
  const getHandleAtPosition = (
    x: number,
    y: number,
    bboxX: number,
    bboxY: number,
    bboxW: number,
    bboxH: number,
    handleSize: number = 8
  ): string | null => {
    // Increase threshold for easier handle detection
    const threshold = handleSize / 2 + 6;

    // Corner handles
    if (Math.abs(x - bboxX) < threshold && Math.abs(y - bboxY) < threshold) return 'nw';
    if (Math.abs(x - (bboxX + bboxW)) < threshold && Math.abs(y - bboxY) < threshold) return 'ne';
    if (Math.abs(x - bboxX) < threshold && Math.abs(y - (bboxY + bboxH)) < threshold) return 'sw';
    if (Math.abs(x - (bboxX + bboxW)) < threshold && Math.abs(y - (bboxY + bboxH)) < threshold) return 'se';

    // Edge handles
    if (Math.abs(x - (bboxX + bboxW / 2)) < threshold && Math.abs(y - bboxY) < threshold) return 'n';
    if (Math.abs(x - (bboxX + bboxW / 2)) < threshold && Math.abs(y - (bboxY + bboxH)) < threshold) return 's';
    if (Math.abs(x - bboxX) < threshold && Math.abs(y - (bboxY + bboxH / 2)) < threshold) return 'w';
    if (Math.abs(x - (bboxX + bboxW)) < threshold && Math.abs(y - (bboxY + bboxH / 2)) < threshold) return 'e';

    return null;
  };

  // Helper function to check if point is inside bbox
  const isPointInBbox = (
    x: number,
    y: number,
    bboxX: number,
    bboxY: number,
    bboxW: number,
    bboxH: number
  ): boolean => {
    return x >= bboxX && x <= bboxX + bboxW && y >= bboxY && y <= bboxY + bboxH;
  };

  // Get cursor style based on handle position
  const getCursorForHandle = (handle: string | null): string => {
    if (!handle) return 'default';
    switch (handle) {
      case 'nw':
      case 'se':
        return 'nwse-resize';
      case 'ne':
      case 'sw':
        return 'nesw-resize';
      case 'n':
      case 's':
        return 'ns-resize';
      case 'w':
      case 'e':
        return 'ew-resize';
      default:
        return 'default';
    }
  };

  // Helper function to find closest point on polygon edge
  const getPointOnEdge = (
    x: number,
    y: number,
    points: [number, number][],
    threshold: number = 8
  ): { edgeIndex: number; point: [number, number] } | null => {
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];

      // Calculate closest point on line segment
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lengthSq = dx * dx + dy * dy;

      if (lengthSq === 0) continue;

      // Parameter t for closest point on line
      let t = ((x - x1) * dx + (y - y1) * dy) / lengthSq;
      t = Math.max(0, Math.min(1, t));

      // Closest point on edge
      const closestX = x1 + t * dx;
      const closestY = y1 + t * dy;

      // Distance from click to closest point
      const distX = x - closestX;
      const distY = y - closestY;
      const distance = Math.sqrt(distX * distX + distY * distY);

      if (distance < threshold) {
        // Round to 2 decimal places
        const roundedX = Math.round(closestX * 100) / 100;
        const roundedY = Math.round(closestY * 100) / 100;
        return { edgeIndex: i, point: [roundedX, roundedY] };
      }
    }
    return null;
  };

  // Update cursor when tool changes
  useEffect(() => {
    if (tool === 'bbox' || tool === 'polygon' || tool === 'polyline' || tool === 'circle' || tool === 'circle3p') {
      setCanvasCursor('crosshair');
    } else {
      setCanvasCursor('default');
    }
  }, [tool]);

  // Phase 8.5.2: Acquire image lock and load image when currentImage changes
  useEffect(() => {
    if (!currentImage?.url || !project?.id) {
      setImage(null);
      imageRef.current = null;
      setImageLoaded(false);
      setIsImageLocked(false);
      return;
    }

    // Phase 8.5.2: Capture current image/project IDs for cleanup
    const capturedImageId = currentImage.id;
    const capturedProjectId = project.id;
    let lockAcquired = false;

    // Phase 8.5.2: Acquire lock on image
    const acquireImageLock = async () => {
      try {
        const result: LockAcquireResponse = await imageLockAPI.acquireLock(
          project.id,
          currentImage.id
        );

        if (result.status === 'already_locked' && result.locked_by) {
          // Image is locked by another user
          // Phase 8.5.2: Show lock overlay instead of dialog
          setLockedByUser(result.locked_by.user_name || 'another user');
          setIsImageLocked(false);
          lockAcquired = false;
          return;
        }

        // Lock acquired or refreshed
        setIsImageLocked(true);
        setLockedByUser(null);
        lockAcquired = true;  // Mark lock as acquired for cleanup

        if (result.status === 'acquired') {
          // toast.success('Image locked for editing');
        }

        // Phase 8.5.2: Update project locks immediately for real-time sync
        if (result.lock) {
          useAnnotationStore.setState((state) => {
            const existingLocks = state.projectLocks || [];
            const updatedLocks = existingLocks.filter(lock => lock.image_id !== currentImage.id);
            return { projectLocks: [...updatedLocks, result.lock!] };
          });
        }

        // Start heartbeat
        startHeartbeat();

      } catch (error) {
        console.error('Failed to acquire lock:', error);
        toast.error('Failed to lock image');
        setIsImageLocked(false);
        lockAcquired = false;
      }
    };

    // Start heartbeat to keep lock alive (every 2 minutes)
    const startHeartbeat = () => {
      // Clear existing interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }

      // Send heartbeat every 2 minutes (lock expires after 5 minutes)
      const interval = setInterval(async () => {
        try {
          await imageLockAPI.sendHeartbeat(project.id, currentImage.id);
        } catch (error) {
          console.error('[Lock] Heartbeat failed:', error);
          toast.error('Lost lock on image');
          clearInterval(interval);
          setIsImageLocked(false);
        }
      }, 2 * 60 * 1000); // Every 2 minutes

      setHeartbeatInterval(interval);
    };

    // Acquire lock first
    acquireImageLock();

    // Load image
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      setImage(img);
      imageRef.current = img;
      setImageLoaded(true);
    };
    img.onerror = () => {
      console.error('Failed to load image:', currentImage.url);
      setImageLoaded(false);
    };
    img.src = currentImage.url;

    // Cleanup: Release lock when unmounting or changing image
    return () => {
      // Clear heartbeat
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        setHeartbeatInterval(null);
      }

      // Phase 8.5.2: Release lock using captured IDs
      if (lockAcquired) {
        imageLockAPI.releaseLock(capturedProjectId, capturedImageId)
          .then(() => {
            // Phase 8.5.2: Update project locks immediately for real-time sync
            useAnnotationStore.setState((state) => {
              const existingLocks = state.projectLocks || [];
              const updatedLocks = existingLocks.filter(lock => lock.image_id !== capturedImageId);
              return { projectLocks: updatedLocks };
            });
          })
          .catch((error) => {
            console.error('[Lock] Failed to release:', error);
          });
      }
    };
  }, [currentImage, project]);

  // Render canvas
  useEffect(() => {
    if (!canvasRef.current || !image || !imageLoaded || !containerRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size to container size
    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    // Clear canvas with dark/light mode aware color
    ctx.fillStyle = preferences.darkMode ? '#1f2937' : '#f3f4f6'; // gray-800 : gray-100
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Calculate image position (centered and scaled)
    const { zoom, pan } = canvasState;
    const scaledWidth = image.width * zoom;
    const scaledHeight = image.height * zoom;

    const x = (canvas.width - scaledWidth) / 2 + pan.x;
    const y = (canvas.height - scaledHeight) / 2 + pan.y;

    // Draw grid if enabled and zoomed in
    if (preferences.showGrid && zoom > 1.0) {
      drawGrid(ctx, canvas.width, canvas.height, x, y, scaledWidth, scaledHeight, zoom);
    }

    // Draw image
    ctx.drawImage(image, x, y, scaledWidth, scaledHeight);

    // Draw annotations
    drawAnnotations(ctx, x, y, zoom);

    // Draw drawing preview
    if (isDrawing && drawingStart && tool === 'bbox') {
      drawBboxPreview(ctx, x, y, zoom);
    }

    // Draw polygon preview
    if (tool === 'polygon' && polygonVertices.length > 0) {
      drawPolygonPreview(ctx, x, y, zoom);
    }

    // Draw polyline preview
    if (tool === 'polyline' && polylineVertices.length > 0) {
      drawPolylinePreview(ctx, x, y, zoom);
    }

    // Draw circle preview (center-edge)
    if (tool === 'circle' && circleCenter) {
      drawCirclePreview(ctx, x, y, zoom);
    }

    // Draw circle 3-point preview
    if (tool === 'circle3p' && circle3pPoints.length > 0) {
      drawCircle3pPreview(ctx, x, y, zoom);
    }

    // Draw crosshair if drawing tool is active
    if ((tool === 'bbox' || tool === 'polygon' || tool === 'polyline' || tool === 'circle' || tool === 'circle3p') && !isDrawing && preferences.showLabels) {
      drawCrosshair(ctx, canvas.width, canvas.height);
    }

    // Draw selected vertex highlight (polygon and polyline)
    if (selectedVertexIndex !== null && selectedAnnotationId) {
      const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
      if (selectedAnn && (selectedAnn.geometry.type === 'polygon' || selectedAnn.geometry.type === 'polyline')) {
        const points = selectedAnn.geometry.points;
        if (selectedVertexIndex < points.length) {
          const [px, py] = points[selectedVertexIndex];
          const scaledPx = px * zoom + x;
          const scaledPy = py * zoom + y;

          // Draw highlight ring around selected vertex
          ctx.strokeStyle = '#f59e0b'; // amber-500
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(scaledPx, scaledPy, 10, 0, Math.PI * 2);
          ctx.stroke();

          // Draw inner fill
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.arc(scaledPx, scaledPy, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Draw selected bbox handle highlight
    if (selectedBboxHandle && selectedAnnotationId) {
      const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
      if (selectedAnn && selectedAnn.geometry.type === 'bbox') {
        const [bx, by, bw, bh] = selectedAnn.geometry.bbox;
        const scaledX = bx * zoom + x;
        const scaledY = by * zoom + y;
        const scaledW = bw * zoom;
        const scaledH = bh * zoom;

        // Get handle position
        let hx = 0, hy = 0;
        switch (selectedBboxHandle) {
          case 'nw': hx = scaledX; hy = scaledY; break;
          case 'ne': hx = scaledX + scaledW; hy = scaledY; break;
          case 'sw': hx = scaledX; hy = scaledY + scaledH; break;
          case 'se': hx = scaledX + scaledW; hy = scaledY + scaledH; break;
          case 'n': hx = scaledX + scaledW / 2; hy = scaledY; break;
          case 's': hx = scaledX + scaledW / 2; hy = scaledY + scaledH; break;
          case 'w': hx = scaledX; hy = scaledY + scaledH / 2; break;
          case 'e': hx = scaledX + scaledW; hy = scaledY + scaledH / 2; break;
        }

        // Draw highlight ring around selected handle
        ctx.strokeStyle = '#f59e0b'; // amber-500
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(hx, hy, 10, 0, Math.PI * 2);
        ctx.stroke();

        // Draw inner fill
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw selected circle handle highlight
    if (selectedCircleHandle && selectedAnnotationId) {
      const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
      if (selectedAnn && selectedAnn.geometry.type === 'circle') {
        const center = selectedAnn.geometry.center;
        const radius = selectedAnn.geometry.radius;
        const scaledCenterX = center[0] * zoom + x;
        const scaledCenterY = center[1] * zoom + y;
        const scaledRadius = radius * zoom;

        // Get handle position
        let hx = 0, hy = 0;
        switch (selectedCircleHandle) {
          case 'n': hx = scaledCenterX; hy = scaledCenterY - scaledRadius; break;
          case 's': hx = scaledCenterX; hy = scaledCenterY + scaledRadius; break;
          case 'e': hx = scaledCenterX + scaledRadius; hy = scaledCenterY; break;
          case 'w': hx = scaledCenterX - scaledRadius; hy = scaledCenterY; break;
        }

        // Draw highlight ring around selected handle
        ctx.strokeStyle = '#f59e0b'; // amber-500
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(hx, hy, 10, 0, Math.PI * 2);
        ctx.stroke();

        // Draw inner fill
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [image, imageLoaded, canvasState, annotations, selectedAnnotationId, isDrawing, drawingStart, tool, preferences, project, polygonVertices, selectedVertexIndex, selectedBboxHandle, polylineVertices, circleCenter, circle3pPoints, selectedCircleHandle]);

  // Draw grid
  const drawGrid = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    imgX: number,
    imgY: number,
    imgWidth: number,
    imgHeight: number,
    zoom: number
  ) => {
    ctx.strokeStyle = 'rgba(75, 85, 99, 0.3)'; // gray-600
    ctx.lineWidth = 1;

    const gridSize = 20 * zoom;

    // Vertical lines
    for (let x = imgX; x < imgX + imgWidth; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, imgY);
      ctx.lineTo(x, imgY + imgHeight);
      ctx.stroke();
    }

    // Horizontal lines
    for (let y = imgY; y < imgY + imgHeight; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(imgX, y);
      ctx.lineTo(imgX + imgWidth, y);
      ctx.stroke();
    }
  };

  // Phase 11: Helper to convert AnnotationSnapshot to Annotation format
  const snapshotToAnnotation = (snapshot: any, tempId: string): any => {
    // Convert backend geometry format to frontend format
    let geometry: any;

    if (snapshot.annotation_type === 'bbox' && snapshot.geometry) {
      // Handle both formats:
      // - DB/Working: {x, y, width, height}
      // - R2/Published: {bbox: [x, y, w, h], type, image_width, image_height}
      if (snapshot.geometry.bbox && Array.isArray(snapshot.geometry.bbox)) {
        // R2 format: already has bbox array
        geometry = {
          type: 'bbox',
          bbox: snapshot.geometry.bbox
        };
      } else {
        // DB format: convert {x, y, width, height} to bbox array
        geometry = {
          type: 'bbox',
          bbox: [
            snapshot.geometry.x || 0,
            snapshot.geometry.y || 0,
            snapshot.geometry.width || 0,
            snapshot.geometry.height || 0
          ]
        };
      }
    } else if (snapshot.annotation_type === 'polygon' && snapshot.geometry) {
      // Polygon: {points: [[x,y], ...]} → same format
      geometry = {
        type: 'polygon',
        points: snapshot.geometry.points || []
      };
    } else if (snapshot.annotation_type === 'polyline' && snapshot.geometry) {
      geometry = {
        type: 'polyline',
        points: snapshot.geometry.points || []
      };
    } else if (snapshot.annotation_type === 'circle' && snapshot.geometry) {
      geometry = {
        type: 'circle',
        center: snapshot.geometry.center || [0, 0],
        radius: snapshot.geometry.radius || 0
      };
    } else {
      // Fallback: spread as-is
      geometry = {
        type: snapshot.annotation_type,
        ...snapshot.geometry,
      };
    }

    return {
      id: tempId,
      image_id: snapshot.image_id,
      geometry,
      class_id: snapshot.class_id,
      class_name: snapshot.class_name,
      annotationType: snapshot.annotation_type,
    };
  };

  // Draw annotations using Tool system
  const drawAnnotations = (ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, zoom: number) => {
    if (!project || !canvasRef.current) return;

    const canvas = canvasRef.current;

    // Create render context for tools
    const renderCtx: CanvasRenderContext = {
      ctx,
      offsetX,
      offsetY,
      zoom,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      showLabels: preferences.showLabels,
      darkMode: preferences.darkMode,
    };

    // Phase 11: Diff mode rendering
    if (diffMode.enabled && diffMode.viewMode === 'overlay') {
      const imageDiff = getDiffForCurrentImage();

      if (imageDiff) {
        // Render diff annotations with color coding
        const currentClasses = getCurrentClasses();

        // 1. Render unchanged annotations (dimmed/gray)
        imageDiff.unchanged?.forEach((snapshot: any, index: number) => {
          const ann = snapshotToAnnotation(snapshot, `unchanged-${index}`);
          const classInfo = ann.class_id ? currentClasses[ann.class_id] : null;
          const color = 'rgba(156, 163, 175, 0.4)'; // gray-400 with opacity

          const tool = ToolRegistry.getTool(ann.geometry.type);
          if (tool) {
            tool.renderAnnotation(renderCtx, ann, false, color, ann.class_name);
          }
        });

        // 2. Render removed annotations (red)
        imageDiff.removed?.forEach((snapshot: any, index: number) => {
          const ann = snapshotToAnnotation(snapshot, `removed-${index}`);
          const color = '#ef4444'; // red-500

          const tool = ToolRegistry.getTool(ann.geometry.type);
          if (tool) {
            tool.renderAnnotation(renderCtx, ann, false, color, ann.class_name);
          }
        });

        // 3. Render added annotations (green)
        imageDiff.added?.forEach((snapshot: any, index: number) => {
          const ann = snapshotToAnnotation(snapshot, `added-${index}`);
          const color = '#22c55e'; // green-500

          const tool = ToolRegistry.getTool(ann.geometry.type);
          if (tool) {
            tool.renderAnnotation(renderCtx, ann, false, color, ann.class_name);
          }
        });

        // 4. Render modified annotations (yellow/orange)
        imageDiff.modified?.forEach((modifiedAnn: any, index: number) => {
          // Render old annotation (dimmed)
          const oldAnn = snapshotToAnnotation(modifiedAnn.old, `modified-old-${index}`);
          const oldColor = 'rgba(251, 146, 60, 0.3)'; // orange-400 with low opacity
          const oldTool = ToolRegistry.getTool(oldAnn.geometry.type);
          if (oldTool) {
            oldTool.renderAnnotation(renderCtx, oldAnn, false, oldColor, oldAnn.class_name);
          }

          // Render new annotation (yellow/orange)
          const newAnn = snapshotToAnnotation(modifiedAnn.new, `modified-new-${index}`);
          const newColor = '#f59e0b'; // amber-500
          const newTool = ToolRegistry.getTool(newAnn.geometry.type);
          if (newTool) {
            newTool.renderAnnotation(renderCtx, newAnn, false, newColor, newAnn.class_name);
          }
        });

        return; // Skip normal rendering
      }
    }

    // Normal rendering (non-diff mode)
    annotations.forEach((ann) => {
      // Skip if annotation is hidden
      if (!isAnnotationVisible(ann.id)) return;

      const isSelected = ann.id === selectedAnnotationId;
      // Support both camelCase and snake_case
      const classId = (ann as any).classId || (ann as any).class_id;
      const className = (ann as any).className || (ann as any).class_name;
      // REFACTORED: Use getCurrentClasses() instead of project.classes
      const currentClasses = getCurrentClasses();
      const classInfo = classId ? currentClasses[classId] : null;
      const color = classInfo?.color || '#9333ea';

      // Handle no_object annotation specially - draw badge
      if (ann.geometry.type === 'no_object' || ann.annotationType === 'no_object') {
        drawNoObjectBadge(ctx, offsetX, offsetY);
        return;
      }

      // Get the appropriate tool for this annotation type
      const tool = ToolRegistry.getTool(ann.geometry.type);

      if (tool) {
        // Use tool to render annotation
        tool.renderAnnotation(renderCtx, ann, isSelected, color, className);

        // Render handles if selected
        if (isSelected) {
          tool.renderHandles(renderCtx, ann, color);
        }
      } else {
        // Fallback for unknown types - use bbox tool for bbox type
        if (ann.geometry.type === 'bbox') {
          bboxTool.renderAnnotation(renderCtx, ann, isSelected, color, className);
          if (isSelected) {
            bboxTool.renderHandles(renderCtx, ann, color);
          }
        }
      }
    });
  };

  // Draw No Object badge (similar to classification badge)
  const drawNoObjectBadge = (ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number) => {
    const badgeX = offsetX + 10;
    const badgeY = offsetY + 10;
    const padding = 8;
    const fontSize = 14;

    const labelText = 'No Object';

    // Measure text
    ctx.font = `${fontSize}px sans-serif`;
    const textWidth = ctx.measureText(labelText).width;

    // Draw badge background (gray color for no object)
    ctx.fillStyle = 'rgba(107, 114, 128, 0.8)'; // gray-500

    const badgeWidth = textWidth + padding * 2;
    const badgeHeight = fontSize + padding * 2;

    // Rounded rectangle
    const radius = 4;
    ctx.beginPath();
    ctx.moveTo(badgeX + radius, badgeY);
    ctx.lineTo(badgeX + badgeWidth - radius, badgeY);
    ctx.quadraticCurveTo(badgeX + badgeWidth, badgeY, badgeX + badgeWidth, badgeY + radius);
    ctx.lineTo(badgeX + badgeWidth, badgeY + badgeHeight - radius);
    ctx.quadraticCurveTo(badgeX + badgeWidth, badgeY + badgeHeight, badgeX + badgeWidth - radius, badgeY + badgeHeight);
    ctx.lineTo(badgeX + radius, badgeY + badgeHeight);
    ctx.quadraticCurveTo(badgeX, badgeY + badgeHeight, badgeX, badgeY + badgeHeight - radius);
    ctx.lineTo(badgeX, badgeY + radius);
    ctx.quadraticCurveTo(badgeX, badgeY, badgeX + radius, badgeY);
    ctx.closePath();
    ctx.fill();

    // Draw text
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, badgeX + padding, badgeY + badgeHeight / 2);
  };

  // Draw bbox preview while drawing using Tool system
  const drawBboxPreview = (ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, zoom: number) => {
    if (!drawingStart || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const currentPos = canvasState.cursor;

    // Create render context for tools
    const renderCtx: CanvasRenderContext = {
      ctx,
      offsetX,
      offsetY,
      zoom,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      showLabels: preferences.showLabels,
      darkMode: preferences.darkMode,
    };

    // Create tool state
    const toolState = {
      isDrawing: true,
      drawingStart,
      currentCursor: currentPos,
    };

    // Use bbox tool to render preview
    bboxTool.renderPreview(renderCtx, toolState);
  };

  // Draw polygon preview while drawing
  const drawPolygonPreview = (ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, zoom: number) => {
    if (polygonVertices.length === 0 || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const currentPos = canvasState.cursor;

    // Create render context for tools
    const renderCtx: CanvasRenderContext = {
      ctx,
      offsetX,
      offsetY,
      zoom,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      showLabels: preferences.showLabels,
      darkMode: preferences.darkMode,
    };

    // Create tool state
    const toolState = {
      isDrawing: true,
      drawingStart: null,
      currentCursor: currentPos,
      vertices: polygonVertices,
    };

    // Use polygon tool to render preview
    polygonTool.renderPreview(renderCtx, toolState);
  };

  // Draw polyline preview while drawing
  const drawPolylinePreview = (ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, zoom: number) => {
    if (polylineVertices.length === 0 || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const currentPos = canvasState.cursor;

    // Create render context for tools
    const renderCtx: CanvasRenderContext = {
      ctx,
      offsetX,
      offsetY,
      zoom,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      showLabels: preferences.showLabels,
      darkMode: preferences.darkMode,
    };

    // Create tool state
    const toolState = {
      isDrawing: true,
      drawingStart: null,
      currentCursor: currentPos,
      vertices: polylineVertices,
    };

    // Use polyline tool to render preview
    polylineTool.renderPreview(renderCtx, toolState);
  };

  // Draw circle preview (center-edge mode)
  const drawCirclePreview = (ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, zoom: number) => {
    if (!circleCenter || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const currentPos = canvasState.cursor;

    // Create render context for tools
    const renderCtx: CanvasRenderContext = {
      ctx,
      offsetX,
      offsetY,
      zoom,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      showLabels: preferences.showLabels,
      darkMode: preferences.darkMode,
    };

    // Create tool state
    const toolState = {
      isDrawing: true,
      drawingStart: null,
      currentCursor: currentPos,
      circleCenter: circleCenter,
    };

    // Use circle tool to render preview
    circleTool.renderPreview(renderCtx, toolState);
  };

  // Draw circle 3-point preview
  const drawCircle3pPreview = (ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number, zoom: number) => {
    if (circle3pPoints.length === 0 || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const currentPos = canvasState.cursor;

    // Create render context for tools
    const renderCtx: CanvasRenderContext = {
      ctx,
      offsetX,
      offsetY,
      zoom,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      showLabels: preferences.showLabels,
      darkMode: preferences.darkMode,
    };

    // Create tool state
    const toolState = {
      isDrawing: true,
      drawingStart: null,
      currentCursor: currentPos,
      circlePoints: circle3pPoints,
    };

    // Use circle3p tool to render preview
    circle3pTool.renderPreview(renderCtx, toolState);
  };

  // Draw crosshair
  const drawCrosshair = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const { cursor } = canvasState;

    ctx.strokeStyle = 'rgba(147, 51, 234, 0.3)'; // violet-600
    ctx.lineWidth = 1;

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(cursor.x, 0);
    ctx.lineTo(cursor.x, height);
    ctx.stroke();

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(0, cursor.y);
    ctx.lineTo(width, cursor.y);
    ctx.stroke();
  };

  // Mouse down handler
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !image) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const { zoom, pan } = canvasState;
    const scaledWidth = image.width * zoom;
    const scaledHeight = image.height * zoom;
    const imgX = (rect.width - scaledWidth) / 2 + pan.x;
    const imgY = (rect.height - scaledHeight) / 2 + pan.y;

    // Phase 8.5.2: Block annotation creation without lock (strict lock policy)
    // Allow pan and selection (read-only), block creation tools
    const isCreationTool = tool !== 'pan' && tool !== 'select';

    if (!isImageLocked && isCreationTool) {
      // Lock overlay is already visible, no need for toast
      return;
    }

    // Only handle selection and resizing in select mode
    if (tool === 'select') {
      // Check if clicking on a handle of the selected annotation
      if (selectedAnnotationId) {
        const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);

        // Handle bbox resize
        if (selectedAnn && selectedAnn.geometry.type === 'bbox') {
          const [bboxX, bboxY, bboxW, bboxH] = selectedAnn.geometry.bbox;

          const scaledX = bboxX * zoom + imgX;
          const scaledY = bboxY * zoom + imgY;
          const scaledW = bboxW * zoom;
          const scaledH = bboxH * zoom;

          const handle = getHandleAtPosition(x, y, scaledX, scaledY, scaledW, scaledH);
          if (handle) {
            // Phase 8.5.2: Block resize without lock
            if (!isImageLocked) {
              return;
            }
            // Select handle and start resizing
            setSelectedBboxHandle(handle);
            setIsResizing(true);
            setResizeHandle(handle);
            setResizeStart({ x, y, bbox: [bboxX, bboxY, bboxW, bboxH] });
            setCanvasCursor(getCursorForHandle(handle));
            return;
          }
        }

        // Handle polygon vertex drag or polygon move
        if (selectedAnn && selectedAnn.geometry.type === 'polygon') {
          const points = selectedAnn.geometry.points;

          // Check if clicking on a vertex
          const vertexThreshold = 8;
          for (let i = 0; i < points.length; i++) {
            const [px, py] = points[i];
            const scaledPx = px * zoom + imgX;
            const scaledPy = py * zoom + imgY;
            const dx = x - scaledPx;
            const dy = y - scaledPy;
            if (Math.sqrt(dx * dx + dy * dy) < vertexThreshold) {
              // Phase 8.5.2: Block vertex drag without lock
              if (!isImageLocked) {
                return;
              }
              // Select and start vertex drag
              setSelectedVertexIndex(i);
              setIsDraggingVertex(true);
              setDraggedVertexIndex(i);
              setCanvasCursor('move');
              return;
            }
          }

          // Check if clicking on an edge (to add vertex)
          const imageX = (x - imgX) / zoom;
          const imageY = (y - imgY) / zoom;
          const edgeResult = getPointOnEdge(imageX, imageY, points, vertexThreshold / zoom);
          if (edgeResult && image) {
            // Phase 8.5.2: Block vertex addition without lock
            if (!isImageLocked) {
              return;
            }
            // Insert new vertex after the edge's first vertex
            const newPoints = [...points];
            newPoints.splice(edgeResult.edgeIndex + 1, 0, edgeResult.point);

            // Update store
            useAnnotationStore.setState({
              annotations: annotations.map(ann =>
                ann.id === selectedAnnotationId
                  ? {
                      ...ann,
                      geometry: {
                        ...ann.geometry,
                        points: newPoints,
                      },
                    }
                  : ann
              ),
            });

            // Select the new vertex
            setSelectedVertexIndex(edgeResult.edgeIndex + 1);

            // Save to backend
            const updateData: AnnotationUpdateRequest = {
              geometry: {
                type: 'polygon',
                points: newPoints,
                image_width: image.width,
                image_height: image.height,
              },
            };
            updateAnnotation(selectedAnnotationId, updateData)
              .then(() => {
                if (currentImage) {
                  const updatedCurrentImage = {
                    ...currentImage,
                    is_confirmed: false,
                    status: 'in-progress',
                  };
                  useAnnotationStore.setState((state) => ({
                    currentImage: state.currentImage?.id === currentImage.id
                      ? updatedCurrentImage
                      : state.currentImage,
                    images: state.images.map(img =>
                      img.id === currentImage.id
                        ? updatedCurrentImage
                        : img
                    ),
                  }));
                }
              })
              .catch((error) => {
                console.error('Failed to add vertex:', error);
                toast.error('Vertex 추가에 실패했습니다.');
              });

            return;
          }

          // Check if clicking inside polygon (for moving)
          // imageX, imageY already calculated above for edge detection
          if (polygonTool.isPointInside(imageX, imageY, selectedAnn)) {
            // Start polygon drag (clear vertex selection)
            setSelectedVertexIndex(null);
            setIsDraggingPolygon(true);
            setPolygonDragStart({ x, y, points: points.map(p => [...p] as [number, number]) });
            setCanvasCursor('move');
            return;
          }
        }

        // Handle polyline vertex drag or polyline move
        if (selectedAnn && selectedAnn.geometry.type === 'polyline') {
          const points = selectedAnn.geometry.points;

          // Check if clicking on a vertex
          const vertexThreshold = 8;
          for (let i = 0; i < points.length; i++) {
            const [px, py] = points[i];
            const scaledPx = px * zoom + imgX;
            const scaledPy = py * zoom + imgY;
            const dx = x - scaledPx;
            const dy = y - scaledPy;
            if (Math.sqrt(dx * dx + dy * dy) < vertexThreshold) {
              // Select and start vertex drag
              setSelectedVertexIndex(i);
              setIsDraggingVertex(true);
              setDraggedVertexIndex(i);
              setCanvasCursor('move');
              return;
            }
          }

          // Check if clicking on an edge (to add vertex)
          const imageX = (x - imgX) / zoom;
          const imageY = (y - imgY) / zoom;
          const edgeResult = getPointOnEdge(imageX, imageY, points, vertexThreshold / zoom);
          if (edgeResult && image) {
            // Phase 8.5.2: Block vertex addition without lock
            if (!isImageLocked) {
              return;
            }
            // Insert new vertex after the edge's first vertex
            const newPoints = [...points];
            newPoints.splice(edgeResult.edgeIndex + 1, 0, edgeResult.point);

            // Update store
            useAnnotationStore.setState({
              annotations: annotations.map(ann =>
                ann.id === selectedAnnotationId
                  ? {
                      ...ann,
                      geometry: {
                        ...ann.geometry,
                        points: newPoints,
                      },
                    }
                  : ann
              ),
            });

            // Select the new vertex
            setSelectedVertexIndex(edgeResult.edgeIndex + 1);

            // Save to backend
            const updateData: AnnotationUpdateRequest = {
              geometry: {
                type: 'polyline',
                points: newPoints,
                image_width: image.width,
                image_height: image.height,
              },
            };
            updateAnnotation(selectedAnnotationId, updateData)
              .then(() => {
                if (currentImage) {
                  const updatedCurrentImage = {
                    ...currentImage,
                    is_confirmed: false,
                    status: 'in-progress',
                  };
                  useAnnotationStore.setState((state) => ({
                    currentImage: state.currentImage?.id === currentImage.id
                      ? updatedCurrentImage
                      : state.currentImage,
                    images: state.images.map(img =>
                      img.id === currentImage.id
                        ? updatedCurrentImage
                        : img
                    ),
                  }));
                }
              })
              .catch((error) => {
                console.error('Failed to add vertex:', error);
                toast.error('Vertex 추가에 실패했습니다.');
              });

            return;
          }

          // Check if clicking on polyline (for moving)
          if (polylineTool.isPointInside(imageX, imageY, selectedAnn)) {
            // Start polyline drag (clear vertex selection)
            setSelectedVertexIndex(null);
            setIsDraggingPolygon(true); // Reuse polygon drag state for polyline
            setPolygonDragStart({ x, y, points: points.map(p => [...p] as [number, number]) });
            setCanvasCursor('move');
            return;
          }
        }

        // Handle circle move or resize
        if (selectedAnn && selectedAnn.geometry.type === 'circle') {
          const center = selectedAnn.geometry.center;
          const radius = selectedAnn.geometry.radius;

          // Convert to canvas coordinates
          const scaledCenterX = center[0] * zoom + imgX;
          const scaledCenterY = center[1] * zoom + imgY;
          const scaledRadius = radius * zoom;

          // Check if clicking on radius handles (N, S, E, W)
          const handleThreshold = 8;
          const handles = [
            { name: 'n', x: scaledCenterX, y: scaledCenterY - scaledRadius }, // N
            { name: 's', x: scaledCenterX, y: scaledCenterY + scaledRadius }, // S
            { name: 'e', x: scaledCenterX + scaledRadius, y: scaledCenterY }, // E
            { name: 'w', x: scaledCenterX - scaledRadius, y: scaledCenterY }, // W
          ];

          for (const handle of handles) {
            const dx = x - handle.x;
            const dy = y - handle.y;
            if (Math.sqrt(dx * dx + dy * dy) < handleThreshold) {
              // Start circle resize
              setIsResizingCircle(true);
              setCircleResizeStart({ x, y, radius, handle: handle.name });
              setSelectedCircleHandle(handle.name);
              setCanvasCursor('pointer');
              return;
            }
          }

          // Check if clicking on center (for moving)
          const dxCenter = x - scaledCenterX;
          const dyCenter = y - scaledCenterY;
          if (Math.sqrt(dxCenter * dxCenter + dyCenter * dyCenter) < handleThreshold) {
            // Start circle move (clear handle selection)
            setSelectedCircleHandle(null);
            setIsDraggingCircle(true);
            setCircleDragStart({ x, y, center: [...center] as [number, number] });
            setCanvasCursor('move');
            return;
          }

          // Check if clicking inside circle (for moving)
          const imageX = (x - imgX) / zoom;
          const imageY = (y - imgY) / zoom;
          if (circleTool.isPointInside(imageX, imageY, selectedAnn)) {
            // Start circle move (clear handle selection)
            setSelectedCircleHandle(null);
            setIsDraggingCircle(true);
            setCircleDragStart({ x, y, center: [...center] as [number, number] });
            setCanvasCursor('move');
            return;
          }
        }
      }

      // Clear vertex/handle selection when clicking elsewhere
      setSelectedVertexIndex(null);
      setSelectedBboxHandle(null);
      setSelectedCircleHandle(null);

      // Check if clicking on any annotation to select it
      let clickedAnnotation: typeof annotations[0] | null = null;
      for (const ann of annotations) {
        if (!isAnnotationVisible(ann.id)) continue;

        if (ann.geometry.type === 'bbox') {
          const [bboxX, bboxY, bboxW, bboxH] = ann.geometry.bbox;
          const scaledX = bboxX * zoom + imgX;
          const scaledY = bboxY * zoom + imgY;
          const scaledW = bboxW * zoom;
          const scaledH = bboxH * zoom;

          if (isPointInBbox(x, y, scaledX, scaledY, scaledW, scaledH)) {
            clickedAnnotation = ann;
            break;
          }
        } else if (ann.geometry.type === 'polygon') {
          // Convert canvas coords to image coords
          const imageX = (x - imgX) / zoom;
          const imageY = (y - imgY) / zoom;
          if (polygonTool.isPointInside(imageX, imageY, ann)) {
            clickedAnnotation = ann;
            break;
          }
        } else if (ann.geometry.type === 'polyline') {
          // Convert canvas coords to image coords
          const imageX = (x - imgX) / zoom;
          const imageY = (y - imgY) / zoom;
          if (polylineTool.isPointInside(imageX, imageY, ann)) {
            clickedAnnotation = ann;
            break;
          }
        } else if (ann.geometry.type === 'circle') {
          // Convert canvas coords to image coords
          const imageX = (x - imgX) / zoom;
          const imageY = (y - imgY) / zoom;
          if (circleTool.isPointInside(imageX, imageY, ann)) {
            clickedAnnotation = ann;
            break;
          }
        }
      }

      if (clickedAnnotation) {
        // Select the clicked annotation
        selectAnnotation(clickedAnnotation.id);
        // Set cursor to move since we're inside the annotation
        setCanvasCursor('move');
        return;
      }

      // If nothing clicked, deselect
      if (selectedAnnotationId) {
        selectAnnotation(null);
      }
    }

    // If select tool is active, start panning
    if (tool === 'select') {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
      return;
    }

    // If middle button or shift+click, start panning
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
      return;
    }

    // Check if click is within image bounds
    const isInImage = x >= imgX && x <= imgX + scaledWidth && y >= imgY && y <= imgY + scaledHeight;

    // Check if classes are available for the current task
    const currentClasses = getCurrentClasses();
    const hasClasses = Object.keys(currentClasses).length > 0;

    // If bbox tool is active, start drawing (only within image)
    if (tool === 'bbox' && isInImage) {
      if (!hasClasses) {
        toast.warning(`'${currentTask}' task에 등록된 클래스가 없습니다. 먼저 클래스를 추가해주세요.`, 4000);
        return;
      }
      startDrawing({ x, y });
    }

    // If polygon tool is active, add vertex or close polygon (only within image)
    if (tool === 'polygon' && isInImage) {
      if (!hasClasses && polygonVertices.length === 0) {
        toast.warning(`'${currentTask}' task에 등록된 클래스가 없습니다. 먼저 클래스를 추가해주세요.`, 4000);
        return;
      }
      const closeThreshold = 15;

      // Check if closing polygon (click near first vertex)
      if (polygonVertices.length >= 3) {
        const [firstX, firstY] = polygonVertices[0];
        const dx = x - firstX;
        const dy = y - firstY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < closeThreshold) {
          // Close polygon - convert canvas coords to image coords
          const imagePoints = polygonVertices.map(([vx, vy]): [number, number] => [
            (vx - imgX) / zoom,
            (vy - imgY) / zoom,
          ]);

          // Store pending polygon and show class selector
          setPendingBbox(null); // Clear any pending bbox
          // Store polygon points in a temporary state (reuse pendingBbox pattern)
          (window as any).__pendingPolygon = imagePoints;
          setShowClassSelector(true);
          setPolygonVertices([]);
          return;
        }
      }

      // Add vertex
      setPolygonVertices([...polygonVertices, [x, y]]);
    }

    // If classification tool is active, show class selector (only within image)
    if (tool === 'classification' && isInImage) {
      if (!hasClasses) {
        toast.warning(`'${currentTask}' task에 등록된 클래스가 없습니다. 먼저 클래스를 추가해주세요.`, 4000);
        return;
      }
      setShowClassSelector(true);
    }

    // If polyline tool is active, add vertex (only within image)
    if (tool === 'polyline' && isInImage) {
      if (!hasClasses && polylineVertices.length === 0) {
        toast.warning(`'${currentTask}' task에 등록된 클래스가 없습니다. 먼저 클래스를 추가해주세요.`, 4000);
        return;
      }
      // Add vertex
      setPolylineVertices([...polylineVertices, [x, y]]);
    }

    // If circle tool is active (center-edge mode)
    if (tool === 'circle' && isInImage) {
      if (!hasClasses) {
        toast.warning(`'${currentTask}' task에 등록된 클래스가 없습니다. 먼저 클래스를 추가해주세요.`, 4000);
        return;
      }

      if (!circleCenter) {
        // First click: set center
        setCircleCenter([x, y]);
      } else {
        // Second click: complete circle
        const dx = x - circleCenter[0];
        const dy = y - circleCenter[1];
        const radius = Math.sqrt(dx * dx + dy * dy);

        if (radius > 5) {
          // Convert canvas coords to image coords
          const centerImageX = (circleCenter[0] - imgX) / zoom;
          const centerImageY = (circleCenter[1] - imgY) / zoom;
          const radiusImage = radius / zoom;

          // Store pending circle and show class selector
          const pendingCircleData = {
            center: [
              Math.round(centerImageX * 100) / 100,
              Math.round(centerImageY * 100) / 100,
            ] as [number, number],
            radius: Math.round(radiusImage * 100) / 100,
          };
          (window as any).__pendingCircle = pendingCircleData;
          console.log('[Circle] Set pending circle:', pendingCircleData);
          setShowClassSelector(true);
        }
        setCircleCenter(null);
      }
    }

    // If circle3p tool is active (3-point mode)
    if (tool === 'circle3p' && isInImage) {
      if (!hasClasses && circle3pPoints.length === 0) {
        toast.warning(`'${currentTask}' task에 등록된 클래스가 없습니다. 먼저 클래스를 추가해주세요.`, 4000);
        return;
      }

      if (circle3pPoints.length < 2) {
        // Add point
        setCircle3pPoints([...circle3pPoints, [x, y]]);
      } else {
        // Third click: complete circle
        const p1: [number, number] = [(circle3pPoints[0][0] - imgX) / zoom, (circle3pPoints[0][1] - imgY) / zoom];
        const p2: [number, number] = [(circle3pPoints[1][0] - imgX) / zoom, (circle3pPoints[1][1] - imgY) / zoom];
        const p3: [number, number] = [(x - imgX) / zoom, (y - imgY) / zoom];

        const result = Circle3pTool.calculateCircleFrom3Points(p1, p2, p3);

        if (result) {
          // Store pending circle and show class selector
          (window as any).__pendingCircle = result;
          console.log('[Circle3P] Set pending circle:', result);
          setShowClassSelector(true);
        } else {
          toast.warning('세 점이 일직선상에 있어 원을 만들 수 없습니다.', 3000);
        }
        setCircle3pPoints([]);
      }
    }
  };

  // Mouse move handler
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !image) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Phase 2.10.2: Update cursor position for magnifier
    setCursorPos({ x, y });

    // Update cursor style based on position (before setCursor to avoid render race)
    if (!isResizing && !isDrawing && !isPanning && !isDraggingVertex && !isDraggingPolygon && !isDraggingCircle && !isResizingCircle) {
      const { zoom, pan } = canvasState;
      const scaledWidth = image.width * zoom;
      const scaledHeight = image.height * zoom;
      const imgX = (rect.width - scaledWidth) / 2 + pan.x;
      const imgY = (rect.height - scaledHeight) / 2 + pan.y;

      // Check if mouse is within image bounds
      const isInImage = x >= imgX && x <= imgX + scaledWidth && y >= imgY && y <= imgY + scaledHeight;

      // Default cursor based on tool and image position
      let newCursor = 'default';
      if (isInImage) {
        newCursor = (tool === 'bbox' || tool === 'polygon' || tool === 'polyline' || tool === 'circle' || tool === 'circle3p') ? 'crosshair' : 'default';
      }

      // Check if near first vertex for polygon closing
      if (tool === 'polygon' && polygonVertices.length >= 3) {
        const [firstX, firstY] = polygonVertices[0];
        const dx = x - firstX;
        const dy = y - firstY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 15) {
          newCursor = 'pointer';
        }
      }

      // Check if hovering over selected annotation's handle (only in select mode)
      if (tool === 'select' && selectedAnnotationId) {
        const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);

        if (selectedAnn && selectedAnn.geometry.type === 'bbox') {
          const [bboxX, bboxY, bboxW, bboxH] = selectedAnn.geometry.bbox;
          const scaledX = bboxX * zoom + imgX;
          const scaledY = bboxY * zoom + imgY;
          const scaledW = bboxW * zoom;
          const scaledH = bboxH * zoom;

          const handle = getHandleAtPosition(x, y, scaledX, scaledY, scaledW, scaledH);
          if (handle) {
            newCursor = getCursorForHandle(handle);
          } else if (isPointInBbox(x, y, scaledX, scaledY, scaledW, scaledH)) {
            newCursor = 'move';
          }
        }

        // Check polygon vertices and inside
        if (selectedAnn && selectedAnn.geometry.type === 'polygon') {
          const points = selectedAnn.geometry.points;
          const vertexThreshold = 8;

          // Check vertices first
          let onVertex = false;
          for (const [px, py] of points) {
            const scaledPx = px * zoom + imgX;
            const scaledPy = py * zoom + imgY;
            const dx = x - scaledPx;
            const dy = y - scaledPy;
            if (Math.sqrt(dx * dx + dy * dy) < vertexThreshold) {
              newCursor = 'move';
              onVertex = true;
              break;
            }
          }

          // Check inside polygon
          if (!onVertex) {
            const imageX = (x - imgX) / zoom;
            const imageY = (y - imgY) / zoom;
            if (polygonTool.isPointInside(imageX, imageY, selectedAnn)) {
              newCursor = 'move';
            }
          }
        }
      }

      // Check if hovering over any annotation (for click to select) - only in select mode
      if (tool === 'select' && isInImage && newCursor === 'default') {
        for (const ann of annotations) {
          if (!isAnnotationVisible(ann.id)) continue;

          if (ann.geometry.type === 'bbox') {
            const [bboxX, bboxY, bboxW, bboxH] = ann.geometry.bbox;
            const scaledX = bboxX * zoom + imgX;
            const scaledY = bboxY * zoom + imgY;
            const scaledW = bboxW * zoom;
            const scaledH = bboxH * zoom;

            if (isPointInBbox(x, y, scaledX, scaledY, scaledW, scaledH)) {
              newCursor = 'pointer';
              break;
            }
          } else if (ann.geometry.type === 'polygon') {
            const imageX = (x - imgX) / zoom;
            const imageY = (y - imgY) / zoom;
            if (polygonTool.isPointInside(imageX, imageY, ann)) {
              newCursor = 'pointer';
              break;
            }
          } else if (ann.geometry.type === 'polyline') {
            const imageX = (x - imgX) / zoom;
            const imageY = (y - imgY) / zoom;
            if (polylineTool.isPointInside(imageX, imageY, ann)) {
              newCursor = 'pointer';
              break;
            }
          } else if (ann.geometry.type === 'circle') {
            const imageX = (x - imgX) / zoom;
            const imageY = (y - imgY) / zoom;
            if (circleTool.isPointInside(imageX, imageY, ann)) {
              newCursor = 'pointer';
              break;
            }
          }
        }
      }

      // Update cursor state
      setCanvasCursor(newCursor);
    }

    // Update cursor position for crosshair (after cursor style update)
    setCursor({ x, y });

    // Handle resizing
    if (isResizing && resizeStart && resizeHandle && selectedAnnotationId) {
      const { zoom, pan } = canvasState;
      const scaledWidth = image.width * zoom;
      const scaledHeight = image.height * zoom;
      const imgX = (rect.width - scaledWidth) / 2 + pan.x;
      const imgY = (rect.height - scaledHeight) / 2 + pan.y;

      // Calculate delta in image coordinates
      const deltaX = (x - resizeStart.x) / zoom;
      const deltaY = (y - resizeStart.y) / zoom;

      let [newX, newY, newW, newH] = resizeStart.bbox;

      // Apply delta based on handle type
      switch (resizeHandle) {
        case 'nw':
          newX += deltaX;
          newY += deltaY;
          newW -= deltaX;
          newH -= deltaY;
          break;
        case 'ne':
          newY += deltaY;
          newW += deltaX;
          newH -= deltaY;
          break;
        case 'sw':
          newX += deltaX;
          newW -= deltaX;
          newH += deltaY;
          break;
        case 'se':
          newW += deltaX;
          newH += deltaY;
          break;
        case 'n':
          newY += deltaY;
          newH -= deltaY;
          break;
        case 's':
          newH += deltaY;
          break;
        case 'w':
          newX += deltaX;
          newW -= deltaX;
          break;
        case 'e':
          newW += deltaX;
          break;
      }

      // Ensure minimum size
      if (newW < 10) newW = 10;
      if (newH < 10) newH = 10;

      // Update annotation geometry
      const updatedAnnotation = annotations.find(ann => ann.id === selectedAnnotationId);
      if (updatedAnnotation) {
        useAnnotationStore.setState({
          annotations: annotations.map(ann =>
            ann.id === selectedAnnotationId
              ? {
                  ...ann,
                  geometry: {
                    ...ann.geometry,
                    bbox: [newX, newY, newW, newH],
                  },
                }
              : ann
          ),
        });
      }
      return;
    }

    // Handle vertex dragging
    if (isDraggingVertex && draggedVertexIndex !== null && selectedAnnotationId) {
      const { zoom, pan } = canvasState;
      const scaledWidth = image.width * zoom;
      const scaledHeight = image.height * zoom;
      const imgX = (rect.width - scaledWidth) / 2 + pan.x;
      const imgY = (rect.height - scaledHeight) / 2 + pan.y;

      // Convert to image coordinates
      const imageX = (x - imgX) / zoom;
      const imageY = (y - imgY) / zoom;

      // Clip to image bounds and round to 2 decimal places
      const clippedX = Math.round(Math.max(0, Math.min(image.width, imageX)) * 100) / 100;
      const clippedY = Math.round(Math.max(0, Math.min(image.height, imageY)) * 100) / 100;

      // Update annotation geometry (polygon or polyline)
      const updatedAnnotation = annotations.find(ann => ann.id === selectedAnnotationId);
      if (updatedAnnotation && (updatedAnnotation.geometry.type === 'polygon' || updatedAnnotation.geometry.type === 'polyline')) {
        const newPoints = [...updatedAnnotation.geometry.points];
        newPoints[draggedVertexIndex] = [clippedX, clippedY];

        useAnnotationStore.setState({
          annotations: annotations.map(ann =>
            ann.id === selectedAnnotationId
              ? {
                  ...ann,
                  geometry: {
                    ...ann.geometry,
                    points: newPoints,
                  },
                }
              : ann
          ),
        });
      }
      return;
    }

    // Handle polygon dragging
    if (isDraggingPolygon && polygonDragStart && selectedAnnotationId) {
      const { zoom, pan } = canvasState;
      const scaledWidth = image.width * zoom;
      const scaledHeight = image.height * zoom;
      const imgX = (rect.width - scaledWidth) / 2 + pan.x;
      const imgY = (rect.height - scaledHeight) / 2 + pan.y;

      // Calculate delta in image coordinates
      const deltaX = (x - polygonDragStart.x) / zoom;
      const deltaY = (y - polygonDragStart.y) / zoom;

      // Move all vertices
      const newPoints = polygonDragStart.points.map(([px, py]): [number, number] => {
        // Clip to image bounds and round to 2 decimal places
        const newX = Math.round(Math.max(0, Math.min(image.width, px + deltaX)) * 100) / 100;
        const newY = Math.round(Math.max(0, Math.min(image.height, py + deltaY)) * 100) / 100;
        return [newX, newY];
      });

      useAnnotationStore.setState({
        annotations: annotations.map(ann =>
          ann.id === selectedAnnotationId
            ? {
                ...ann,
                geometry: {
                  ...ann.geometry,
                  points: newPoints,
                },
              }
            : ann
        ),
      });
      return;
    }

    // Handle circle dragging
    if (isDraggingCircle && circleDragStart && selectedAnnotationId) {
      const { zoom, pan } = canvasState;
      const scaledWidth = image.width * zoom;
      const scaledHeight = image.height * zoom;
      const imgX = (rect.width - scaledWidth) / 2 + pan.x;
      const imgY = (rect.height - scaledHeight) / 2 + pan.y;

      // Calculate delta in image coordinates
      const deltaX = (x - circleDragStart.x) / zoom;
      const deltaY = (y - circleDragStart.y) / zoom;

      // Move center
      const newCenterX = Math.round(Math.max(0, Math.min(image.width, circleDragStart.center[0] + deltaX)) * 100) / 100;
      const newCenterY = Math.round(Math.max(0, Math.min(image.height, circleDragStart.center[1] + deltaY)) * 100) / 100;

      useAnnotationStore.setState({
        annotations: annotations.map(ann =>
          ann.id === selectedAnnotationId
            ? {
                ...ann,
                geometry: {
                  ...ann.geometry,
                  center: [newCenterX, newCenterY],
                },
              }
            : ann
        ),
      });
      return;
    }

    // Handle circle resizing
    if (isResizingCircle && circleResizeStart && selectedAnnotationId) {
      const { zoom } = canvasState;

      // Calculate delta based on handle direction
      const deltaX = (x - circleResizeStart.x) / zoom;
      const deltaY = (y - circleResizeStart.y) / zoom;

      let delta = 0;
      switch (circleResizeStart.handle) {
        case 'n':
          // N handle: up (negative deltaY) should increase radius
          delta = -deltaY;
          break;
        case 's':
          // S handle: down (positive deltaY) should increase radius
          delta = deltaY;
          break;
        case 'e':
          // E handle: right (positive deltaX) should increase radius
          delta = deltaX;
          break;
        case 'w':
          // W handle: left (negative deltaX) should increase radius
          delta = -deltaX;
          break;
        default:
          delta = Math.sqrt(deltaX * deltaX + deltaY * deltaY) * Math.sign(deltaX + deltaY);
      }

      // New radius
      const newRadius = Math.round(Math.max(5, circleResizeStart.radius + delta) * 100) / 100;

      useAnnotationStore.setState({
        annotations: annotations.map(ann =>
          ann.id === selectedAnnotationId
            ? {
                ...ann,
                geometry: {
                  ...ann.geometry,
                  radius: newRadius,
                },
              }
            : ann
        ),
      });
      return;
    }

    // Handle panning
    if (isPanning && panStart) {
      const deltaX = e.clientX - panStart.x;
      const deltaY = e.clientY - panStart.y;
      setPan({
        x: canvasState.pan.x + deltaX,
        y: canvasState.pan.y + deltaY,
      });
      setPanStart({ x: e.clientX, y: e.clientY });
      return;
    }

    // Handle drawing
    if (isDrawing) {
      updateDrawing({ x, y });
    }
  };

  // Mouse up handler
  const handleMouseUp = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Stop vertex dragging and save to backend
    if (isDraggingVertex && selectedAnnotationId) {
      setIsDraggingVertex(false);
      setDraggedVertexIndex(null);
      setCanvasCursor('move');

      // Save updated polygon/polyline to backend
      const updatedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
      if (updatedAnn && (updatedAnn.geometry.type === 'polygon' || updatedAnn.geometry.type === 'polyline') && project && currentImage && image) {
        try {
          const updateData: AnnotationUpdateRequest = {
            geometry: {
              ...updatedAnn.geometry,
              image_width: image.width,
              image_height: image.height,
            },
          };
          await updateAnnotation(updatedAnn.id, updateData);

          // Update image status to in-progress and unconfirm
          const updatedCurrentImage = {
            ...currentImage,
            is_confirmed: false,
            status: 'in-progress',
          };

          useAnnotationStore.setState((state) => ({
            currentImage: state.currentImage?.id === currentImage.id
              ? updatedCurrentImage
              : state.currentImage,
            images: state.images.map(img =>
              img.id === currentImage.id
                ? updatedCurrentImage
                : img
            ),
          }));
        } catch (error) {
          console.error('Failed to save vertex change:', error);
          toast.error('Failed to save changes');
        }
      }
      return;
    }

    // Stop polygon/polyline dragging and save to backend
    if (isDraggingPolygon && selectedAnnotationId) {
      setIsDraggingPolygon(false);
      setPolygonDragStart(null);
      setCanvasCursor('move');

      // Save updated polygon/polyline to backend
      const updatedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
      if (updatedAnn && (updatedAnn.geometry.type === 'polygon' || updatedAnn.geometry.type === 'polyline') && project && currentImage && image) {
        try {
          const updateData: AnnotationUpdateRequest = {
            geometry: {
              ...updatedAnn.geometry,
              image_width: image.width,
              image_height: image.height,
            },
          };
          await updateAnnotation(updatedAnn.id, updateData);

          // Update image status to in-progress and unconfirm
          const updatedCurrentImage = {
            ...currentImage,
            is_confirmed: false,
            status: 'in-progress',
          };

          useAnnotationStore.setState((state) => ({
            currentImage: state.currentImage?.id === currentImage.id
              ? updatedCurrentImage
              : state.currentImage,
            images: state.images.map(img =>
              img.id === currentImage.id
                ? updatedCurrentImage
                : img
            ),
          }));
        } catch (error) {
          console.error('Failed to save polygon/polyline move:', error);
          toast.error('Failed to save changes');
        }
      }
      return;
    }

    // Stop circle dragging and save to backend
    if (isDraggingCircle && selectedAnnotationId) {
      setIsDraggingCircle(false);
      setCircleDragStart(null);
      setCanvasCursor('move');

      // Save updated circle to backend
      const updatedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
      if (updatedAnn && updatedAnn.geometry.type === 'circle' && project && currentImage && image) {
        try {
          const updateData: AnnotationUpdateRequest = {
            geometry: {
              ...updatedAnn.geometry,
              image_width: image.width,
              image_height: image.height,
            },
          };
          await updateAnnotation(updatedAnn.id, updateData);

          // Update image status to in-progress and unconfirm
          const updatedCurrentImage = {
            ...currentImage,
            is_confirmed: false,
            status: 'in-progress',
          };

          useAnnotationStore.setState((state) => ({
            currentImage: state.currentImage?.id === currentImage.id
              ? updatedCurrentImage
              : state.currentImage,
            images: state.images.map(img =>
              img.id === currentImage.id
                ? updatedCurrentImage
                : img
            ),
          }));
        } catch (error) {
          console.error('Failed to save circle move:', error);
          toast.error('Failed to save changes');
        }
      }
      return;
    }

    // Stop circle resizing and save to backend
    if (isResizingCircle && selectedAnnotationId) {
      setIsResizingCircle(false);
      setCircleResizeStart(null);
      // Keep selectedCircleHandle for keyboard control
      setCanvasCursor('move');

      // Save updated circle to backend
      const updatedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
      if (updatedAnn && updatedAnn.geometry.type === 'circle' && project && currentImage && image) {
        try {
          const updateData: AnnotationUpdateRequest = {
            geometry: {
              ...updatedAnn.geometry,
              image_width: image.width,
              image_height: image.height,
            },
          };
          await updateAnnotation(updatedAnn.id, updateData);

          // Update image status to in-progress and unconfirm
          const updatedCurrentImage = {
            ...currentImage,
            is_confirmed: false,
            status: 'in-progress',
          };

          useAnnotationStore.setState((state) => ({
            currentImage: state.currentImage?.id === currentImage.id
              ? updatedCurrentImage
              : state.currentImage,
            images: state.images.map(img =>
              img.id === currentImage.id
                ? updatedCurrentImage
                : img
            ),
          }));
        } catch (error) {
          console.error('Failed to save circle resize:', error);
          toast.error('Failed to save changes');
        }
      }
      return;
    }

    // Stop resizing and save to backend
    if (isResizing && selectedAnnotationId) {
      setIsResizing(false);
      setResizeHandle(null);
      setResizeStart(null);
      // Reset cursor to move (still inside bbox)
      setCanvasCursor('move');

      // Save updated bbox to backend (with clipping)
      const updatedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
      if (updatedAnn && updatedAnn.geometry.type === 'bbox' && project && currentImage) {
        try {
          // Get bbox values
          const bbox = updatedAnn.geometry.bbox as number[];
          let [bx, by, bw, bh] = bbox;

          // Clip to image bounds
          const imgWidth = image?.width || currentImage.width || 0;
          const imgHeight = image?.height || currentImage.height || 0;
          let wasClipped = false;

          // Clip left edge
          if (bx < 0) {
            bw += bx;
            bx = 0;
            wasClipped = true;
          }
          // Clip top edge
          if (by < 0) {
            bh += by;
            by = 0;
            wasClipped = true;
          }
          // Clip right edge
          if (bx + bw > imgWidth) {
            bw = imgWidth - bx;
            wasClipped = true;
          }
          // Clip bottom edge
          if (by + bh > imgHeight) {
            bh = imgHeight - by;
            wasClipped = true;
          }

          // Ensure positive dimensions
          bw = Math.max(0, bw);
          bh = Math.max(0, bh);

          // Round to 2 decimal places
          bx = Math.round(bx * 100) / 100;
          by = Math.round(by * 100) / 100;
          bw = Math.round(bw * 100) / 100;
          bh = Math.round(bh * 100) / 100;

          // Show warning if clipped
          if (wasClipped) {
            toast.warning('BBox가 이미지 영역을 벗어나 자동으로 조정되었습니다.', 4000);
          }

          // Update geometry with clipped values
          const clippedGeometry = {
            type: 'bbox',
            bbox: [bx, by, bw, bh],
            image_width: imgWidth,
            image_height: imgHeight,
          };

          // Update local store with clipped geometry
          useAnnotationStore.setState((state) => ({
            annotations: state.annotations.map(ann =>
              ann.id === selectedAnnotationId
                ? { ...ann, geometry: clippedGeometry }
                : ann
            )
          }));

          const updateData: AnnotationUpdateRequest = {
            geometry: clippedGeometry,
          };
          await updateAnnotation(selectedAnnotationId, updateData);

          // Update image status to in_progress and unconfirm
          // Update both images array and currentImage for immediate UI update
          const updatedCurrentImage = {
            ...currentImage,
            is_confirmed: false,
            status: 'in-progress',
          };

          useAnnotationStore.setState((state) => ({
            currentImage: state.currentImage?.id === currentImage.id
              ? updatedCurrentImage
              : state.currentImage,
            images: state.images.map(img =>
              img.id === currentImage.id
                ? updatedCurrentImage
                : img
            )
          }));
        } catch (err) {
          console.error('Failed to update annotation:', err);
          // TODO: Show error toast
        }
      }
      return;
    }

    // Stop panning
    if (isPanning) {
      setIsPanning(false);
      setPanStart(null);
      return;
    }

    // Finish drawing
    if (isDrawing && drawingStart && image) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const currentPos = canvasState.cursor;

      // Calculate bbox in canvas coordinates
      const x1 = Math.min(drawingStart.x, currentPos.x);
      const y1 = Math.min(drawingStart.y, currentPos.y);
      const w = Math.abs(currentPos.x - drawingStart.x);
      const h = Math.abs(currentPos.y - drawingStart.y);

      // Only create annotation if bbox has minimum size
      if (w > 5 && h > 5) {
        // Convert canvas coordinates to image coordinates
        const { zoom, pan } = canvasState;
        const scaledWidth = image.width * zoom;
        const scaledHeight = image.height * zoom;
        const imgX = (rect.width - scaledWidth) / 2 + pan.x;
        const imgY = (rect.height - scaledHeight) / 2 + pan.y;

        // Calculate bbox in image coordinates
        const bboxX = (x1 - imgX) / zoom;
        const bboxY = (y1 - imgY) / zoom;
        const bboxW = w / zoom;
        const bboxH = h / zoom;

        // Store pending bbox and show class selector
        setPendingBbox({ x: bboxX, y: bboxY, w: bboxW, h: bboxH });
        setShowClassSelector(true);
      }

      finishDrawing();
    }
  };

  // Handle class selection (supports batch operation for classification)
  const handleClassSelect = async (classId: string, className: string) => {
    if (!project) {
      return;
    }

    setShowClassSelector(false);

    // Check for pending geometry shapes first
    const hasPendingPolygon = !!(window as any).__pendingPolygon;
    const hasPendingPolyline = !!(window as any).__pendingPolyline;
    const hasPendingCircle = !!(window as any).__pendingCircle;
    const hasPendingGeometry = pendingBbox || hasPendingPolygon || hasPendingPolyline || hasPendingCircle;

    // Check if this is a batch classification operation
    const isBatchClassification = !hasPendingGeometry && selectedImageIds.length > 0;

    if (isBatchClassification) {
      // Batch classification for multiple selected images
      // Safety check: Only allow batch classification when in classification task
      if (currentTask !== 'classification') {
        console.error('[handleClassSelect] Batch classification attempted outside classification task!', { currentTask });
        toast.error('Batch classification is only allowed in classification task');
        return;
      }

      try {
        setBatchProgress({ current: 0, total: selectedImageIds.length });

        for (let i = 0; i < selectedImageIds.length; i++) {
          const imageId = selectedImageIds[i];
          setBatchProgress({ current: i + 1, total: selectedImageIds.length });

          // Delete existing classification annotations for this image
          // Safety: Double-check we're only deleting classification annotations
          const existingAnnotations = await getProjectAnnotations(project.id, imageId);

          const classificationAnnotations = existingAnnotations.filter(
            ann => ann.annotation_type === 'classification'
          );

          for (const ann of classificationAnnotations) {
            // Final safety check before delete
            if (ann.annotation_type !== 'classification') {
              console.error('[handleClassSelect] SAFETY VIOLATION: Attempted to delete non-classification annotation!', ann);
              continue; // Skip this annotation
            }

            await deleteAnnotationAPI(ann.id);
            if (imageId === currentImage?.id) {
              deleteAnnotation(ann.id);
            }
          }

          // Create new classification annotation
          const annotationData: AnnotationCreateRequest = {
            project_id: project.id,
            image_id: imageId,
            annotation_type: 'classification',
            geometry: { type: 'classification' },
            class_id: classId,
            class_name: className,
          };

          // Phase 8.5.2: Try to create annotation, skip if locked by another user
          try {
            const savedAnnotation = await createAnnotation(annotationData);

            // If this is the current image, add to store
            if (imageId === currentImage?.id) {
              addAnnotation({
                id: savedAnnotation.id.toString(),
                projectId: project.id,
                imageId: imageId,
                annotationType: 'classification',
                classId: classId,
                className: className,
                geometry: { type: 'classification' },
                confidence: savedAnnotation.confidence,
                attributes: savedAnnotation.attributes,
                createdAt: savedAnnotation.created_at ? new Date(savedAnnotation.created_at) : undefined,
                updatedAt: savedAnnotation.updated_at ? new Date(savedAnnotation.updated_at) : undefined,
              });
            }

            // Update image status
            useAnnotationStore.setState((state) => ({
              images: state.images.map(img =>
                img.id === imageId
                  ? {
                      ...img,
                      annotation_count: 1,
                      is_confirmed: false,
                      status: 'in-progress',
                    }
                  : img
              )
            }));
          } catch (lockError: any) {
            // Image is locked by another user, skip this image
            console.warn(`Skipping image ${imageId}: ${lockError.message}`);
            // Don't throw, just continue to next image
          }
        }

        setBatchProgress(null);
        clearImageSelection();
        toast.success(`${selectedImageIds.length}개 이미지에 '${className}' 클래스를 할당했습니다.`, 3000);
      } catch (err) {
        console.error('Failed to batch assign class:', err);
        setBatchProgress(null);
        toast.error('클래스 할당에 실패했습니다.');
      }
      return;
    }

    // Single image operation (existing logic)
    if (!currentImage) return;

    setIsSaving(true);

    try {
      let annotationData: AnnotationCreateRequest;
      let annotationType: 'bbox' | 'polygon' | 'classification' | 'polyline' | 'circle';
      let geometry: any;

      // Read and immediately clear ALL pending geometry shapes to prevent reuse
      const pendingPolygon = (window as any).__pendingPolygon as [number, number][] | undefined;
      const pendingPolyline = (window as any).__pendingPolyline as [number, number][] | undefined;
      const pendingCircle = (window as any).__pendingCircle as { center: [number, number]; radius: number } | undefined;

      // Clear all pending data immediately after reading
      delete (window as any).__pendingPolygon;
      delete (window as any).__pendingPolyline;
      delete (window as any).__pendingCircle;

      // Check if this is for bbox, polygon, polyline, circle, or classification
      if (pendingPolyline) {
        // Polyline annotation
        annotationType = 'polyline';

        // Clip polyline points to image bounds
        const imgWidth = image?.width || currentImage.width || 0;
        const imgHeight = image?.height || currentImage.height || 0;

        const clippedPoints = pendingPolyline.map(([px, py]): [number, number] => [
          Math.round(Math.max(0, Math.min(imgWidth, px)) * 100) / 100,
          Math.round(Math.max(0, Math.min(imgHeight, py)) * 100) / 100,
        ]);

        geometry = {
          type: 'polyline',
          points: clippedPoints,
          image_width: imgWidth,
          image_height: imgHeight,
        };
      } else if (pendingCircle) {
        // Circle annotation
        annotationType = 'circle';

        const imgWidth = image?.width || currentImage.width || 0;
        const imgHeight = image?.height || currentImage.height || 0;

        geometry = {
          type: 'circle',
          center: pendingCircle.center,
          radius: pendingCircle.radius,
          image_width: imgWidth,
          image_height: imgHeight,
        };
      } else if (pendingPolygon) {
        // Polygon annotation
        annotationType = 'polygon';

        // Clip polygon points to image bounds and round to 2 decimal places
        const imgWidth = image?.width || currentImage.width || 0;
        const imgHeight = image?.height || currentImage.height || 0;

        const clippedPoints = pendingPolygon.map(([px, py]): [number, number] => [
          Math.round(Math.max(0, Math.min(imgWidth, px)) * 100) / 100,
          Math.round(Math.max(0, Math.min(imgHeight, py)) * 100) / 100,
        ]);

        geometry = {
          type: 'polygon',
          points: clippedPoints,
          image_width: imgWidth,
          image_height: imgHeight,
        };
      } else if (pendingBbox) {
        // BBox annotation
        annotationType = 'bbox';

        // Clip bbox to image bounds
        const imgWidth = image?.width || currentImage.width || 0;
        const imgHeight = image?.height || currentImage.height || 0;

        let { x, y, w, h } = pendingBbox;
        let wasClipped = false;

        // Clip left edge
        if (x < 0) {
          w += x; // reduce width by overflow
          x = 0;
          wasClipped = true;
        }
        // Clip top edge
        if (y < 0) {
          h += y; // reduce height by overflow
          y = 0;
          wasClipped = true;
        }
        // Clip right edge
        if (x + w > imgWidth) {
          w = imgWidth - x;
          wasClipped = true;
        }
        // Clip bottom edge
        if (y + h > imgHeight) {
          h = imgHeight - y;
          wasClipped = true;
        }

        // Ensure positive dimensions
        w = Math.max(0, w);
        h = Math.max(0, h);

        // Round to 2 decimal places
        x = Math.round(x * 100) / 100;
        y = Math.round(y * 100) / 100;
        w = Math.round(w * 100) / 100;
        h = Math.round(h * 100) / 100;

        // Show warning if clipped
        if (wasClipped) {
          toast.warning('BBox가 이미지 영역을 벗어나 자동으로 조정되었습니다.', 4000);
        }

        geometry = {
          type: 'bbox',
          bbox: [x, y, w, h],
          image_width: imgWidth,
          image_height: imgHeight,
        };
      } else {
        // Classification annotation
        annotationType = 'classification';
        geometry = {
          type: 'classification',
        };

        // Delete existing classification annotations for this image (only one allowed)
        // Safety: Only delete classification annotations
        const existingClassifications = annotations.filter(
          ann => ann.annotationType === 'classification'
        );
        for (const ann of existingClassifications) {
          // Final safety check before delete
          if (ann.annotationType !== 'classification') {
            console.error('[handleClassSelect] SAFETY VIOLATION: Attempted to delete non-classification annotation in single mode!', ann);
            continue; // Skip this annotation
          }

          await deleteAnnotationAPI(ann.id);
          deleteAnnotation(ann.id);
        }
      }

      annotationData = {
        project_id: project.id,
        image_id: currentImage.id,
        annotation_type: annotationType,
        geometry: geometry,
        class_id: classId,
        class_name: className,
      };

      // Phase 8.5.2: Backend now auto-acquires/refreshes locks
      // No need for complex retry logic - just save the annotation
      // Backend will handle lock management automatically
      const savedAnnotation = await createAnnotation(annotationData);

      // Add to store (use savedAnnotation data from backend)
      addAnnotation({
        id: savedAnnotation.id.toString(),
        projectId: project.id,
        imageId: currentImage.id,
        annotationType: savedAnnotation.annotation_type,
        classId: savedAnnotation.class_id || classId,
        className: savedAnnotation.class_name || className,
        geometry: savedAnnotation.geometry,
        confidence: savedAnnotation.confidence,
        attributes: savedAnnotation.attributes,
        createdAt: savedAnnotation.created_at ? new Date(savedAnnotation.created_at) : undefined,
        updatedAt: savedAnnotation.updated_at ? new Date(savedAnnotation.updated_at) : undefined,
      });

      // Update current image status only (not all images)
      // This prevents resetting other images' status
      // Update both images array and currentImage for immediate UI update
      const updatedCurrentImage = {
        ...currentImage,
        annotation_count: ((currentImage as any).annotation_count || 0) + 1,
        is_confirmed: false,
        status: 'in-progress',
      };

      useAnnotationStore.setState((state) => ({
        currentImage: state.currentImage?.id === currentImage.id
          ? updatedCurrentImage
          : state.currentImage,
        images: state.images.map(img =>
          img.id === currentImage.id
            ? updatedCurrentImage
            : img
        )
      }));

      setPendingBbox(null);
    } catch (err) {
      console.error('Failed to save annotation:', err);
      toast.error('어노테이션 저장에 실패했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  // Handle class selector close
  const handleClassSelectorClose = () => {
    setShowClassSelector(false);
    setPendingBbox(null);
    // Also clear pending polyline and circle
    delete (window as any).__pendingPolyline;
    delete (window as any).__pendingCircle;
    delete (window as any).__pendingPolygon;
  };

  // Phase 2.7: Confirm Image handler
  // Handle No Object annotation (supports batch operation)
  const handleNoObject = useCallback(async () => {
    if (!project) return;

    // Determine target images
    const targetImageIds = selectedImageIds.length > 0 ? selectedImageIds : (currentImage ? [currentImage.id] : []);
    if (targetImageIds.length === 0) return;

    const isBatch = targetImageIds.length > 1;

    const processNoObject = async () => {
      try {
        setBatchProgress({ current: 0, total: targetImageIds.length });

        for (let i = 0; i < targetImageIds.length; i++) {
          const imageId = targetImageIds[i];
          setBatchProgress({ current: i + 1, total: targetImageIds.length });

          // Get existing annotations for this image
          const existingAnnotations = await getProjectAnnotations(project.id, imageId);

          // Delete existing annotations
          for (const ann of existingAnnotations) {
            await deleteAnnotationAPI(ann.id);
            // If this is the current image, also remove from store
            if (imageId === currentImage?.id) {
              deleteAnnotation(ann.id);
            }
          }

          // Create no_object annotation with task context
          const annotationData: AnnotationCreateRequest = {
            project_id: project.id,
            image_id: imageId,
            annotation_type: 'no_object',
            geometry: { type: 'no_object' },
            class_id: null,
            class_name: '__background__',
            attributes: { task_type: currentTask },
          };

          const savedAnnotation = await createAnnotation(annotationData);

          // If this is the current image, add to store
          if (imageId === currentImage?.id) {
            addAnnotation({
              id: savedAnnotation.id.toString(),
              projectId: project.id,
              imageId: imageId,
              annotationType: 'no_object',
              classId: null,
              className: '__background__',
              geometry: { type: 'no_object' },
              confidence: savedAnnotation.confidence,
              attributes: savedAnnotation.attributes,
              createdAt: savedAnnotation.created_at ? new Date(savedAnnotation.created_at) : undefined,
              updatedAt: savedAnnotation.updated_at ? new Date(savedAnnotation.updated_at) : undefined,
            });
          }

          // Update image status
          useAnnotationStore.setState((state) => {
            const updatedImages = state.images.map(img =>
              img.id === imageId
                ? {
                    ...img,
                    annotation_count: 1,
                    status: 'in-progress',
                    has_no_object: true,
                    is_confirmed: false,  // Not confirmed yet, just assigned
                  }
                : img
            );
            // Also update currentImage if it's the same image
            const updatedCurrentImage = state.currentImage?.id === imageId
              ? updatedImages.find(img => img.id === imageId) || state.currentImage
              : state.currentImage;
            return { images: updatedImages, currentImage: updatedCurrentImage };
          });
        }

        setBatchProgress(null);
        // Keep multi-selection after batch operation
        toast.success(`${targetImageIds.length}개 이미지를 No Object로 처리했습니다.`, 3000);
      } catch (err) {
        console.error('Failed to create no_object annotation:', err);
        setBatchProgress(null);
        toast.error('No Object 처리에 실패했습니다.');
      }
    };

    // Show confirm dialog
    const message = isBatch
      ? `선택한 ${targetImageIds.length}개 이미지를 No Object로 처리합니다. 기존 레이블은 삭제됩니다.`
      : annotations.length > 0
        ? `기존 ${annotations.length}개의 레이블이 삭제됩니다. 계속하시겠습니까?`
        : '이 이미지를 No Object로 처리하시겠습니까?';

    confirm({
      title: 'No Object 설정',
      message,
      confirmText: '확인',
      cancelText: '취소',
      onConfirm: processNoObject,
    });
  }, [currentImage, project, addAnnotation, annotations, deleteAnnotation, selectedImageIds]);

  // Handle delete all annotations (supports batch operation)
  const handleDeleteAllAnnotations = useCallback(async () => {
    if (!project) return;

    // Determine target images
    const targetImageIds = selectedImageIds.length > 0 ? selectedImageIds : (currentImage ? [currentImage.id] : []);
    if (targetImageIds.length === 0) return;

    // For single image without selection, check if there are annotations
    if (targetImageIds.length === 1 && targetImageIds[0] === currentImage?.id && annotations.length === 0) {
      return;
    }

    // Phase 8.5.2: Block deletion without lock for single current image
    const isSingleCurrentImage = targetImageIds.length === 1 && targetImageIds[0] === currentImage?.id;
    if (isSingleCurrentImage && !isImageLocked) {
      // Lock overlay is already visible, no need for toast
      return;
    }

    const isBatch = targetImageIds.length > 1;

    const processDelete = async () => {
      try {
        setBatchProgress({ current: 0, total: targetImageIds.length });
        let totalDeleted = 0;

        for (let i = 0; i < targetImageIds.length; i++) {
          const imageId = targetImageIds[i];
          setBatchProgress({ current: i + 1, total: targetImageIds.length });

          // Get existing annotations for this image
          const existingAnnotations = await getProjectAnnotations(project.id, imageId);

          // Delete all annotations
          for (const ann of existingAnnotations) {
            await deleteAnnotationAPI(ann.id);
            // If this is the current image, also remove from store
            if (imageId === currentImage?.id) {
              deleteAnnotation(ann.id);
            }
            totalDeleted++;
          }

          // Update image status
          useAnnotationStore.setState((state) => {
            const updatedImages = state.images.map(img =>
              img.id === imageId
                ? {
                    ...img,
                    annotation_count: 0,
                    status: 'not-started',
                    has_no_object: false,
                    is_confirmed: false,  // Reset confirmation on delete
                  }
                : img
            );
            // Also update currentImage if it's the same image
            const updatedCurrentImage = state.currentImage?.id === imageId
              ? updatedImages.find(img => img.id === imageId) || state.currentImage
              : state.currentImage;
            return { images: updatedImages, currentImage: updatedCurrentImage };
          });
        }

        setBatchProgress(null);
        // Keep multi-selection after batch operation
        toast.success(`${targetImageIds.length}개 이미지에서 ${totalDeleted}개 레이블을 삭제했습니다.`, 3000);
      } catch (err) {
        console.error('Failed to delete annotations:', err);
        setBatchProgress(null);
        toast.error('삭제에 실패했습니다.');
      }
    };

    // Show confirm dialog
    const message = isBatch
      ? `선택한 ${targetImageIds.length}개 이미지의 모든 레이블을 삭제합니다.`
      : `현재 이미지의 ${annotations.length}개 레이블을 모두 삭제하시겠습니까?`;

    confirm({
      title: '모든 레이블 삭제',
      message,
      confirmText: '삭제',
      cancelText: '취소',
      onConfirm: processDelete,
    });
  }, [project, currentImage, annotations, deleteAnnotation, selectedImageIds]);

  const handleConfirmImage = useCallback(async () => {
    if (!project) return;
    if (confirmingImage) return;

    // Determine target images
    const targetImageIds = selectedImageIds.length > 0 ? selectedImageIds : (currentImage ? [currentImage.id] : []);
    if (targetImageIds.length === 0) return;

    const isBatch = targetImageIds.length > 1;

    const processConfirm = async () => {
      setConfirmingImage(true);
      try {
        if (isBatch) {
          // Batch confirm
          setBatchProgress({ current: 0, total: targetImageIds.length });

          for (let i = 0; i < targetImageIds.length; i++) {
            const imageId = targetImageIds[i];
            setBatchProgress({ current: i + 1, total: targetImageIds.length });

            // Call API to confirm image
            await confirmImage(project.id, imageId, currentTask || undefined);
          }

          // Update all confirmed images status
          useAnnotationStore.setState((state) => ({
            images: state.images.map(img =>
              targetImageIds.includes(img.id)
                ? {
                    ...img,
                    is_confirmed: true,
                    status: 'completed',
                    confirmed_at: new Date().toISOString(),
                  }
                : img
            )
          }));

          // If current image was in selection, reload its annotations from server
          if (currentImage && targetImageIds.includes(currentImage.id)) {
            const { getProjectAnnotations } = await import('@/lib/api/annotations');
            const freshAnnotations = await getProjectAnnotations(
              project.id,
              currentImage.id
            );
            useAnnotationStore.setState({ annotations: freshAnnotations });
          }

          setBatchProgress(null);
          clearImageSelection();
          toast.success(`${targetImageIds.length}개 이미지를 확정했습니다.`, 3000);
        } else {
        // Single image confirm (existing logic)
        if (!currentImage) return;

        await confirmImage(project.id, currentImage.id, currentTask || undefined);

        // Reload annotations from server to get updated version and confirm info
        const { getProjectAnnotations } = await import('@/lib/api/annotations');
        const freshAnnotations = await getProjectAnnotations(
          project.id,
          currentImage.id
        );

        useAnnotationStore.setState({ annotations: freshAnnotations });

        // Update current image status
        const updatedImages = images.map(img =>
          img.id === currentImage.id
            ? {
                ...img,
                is_confirmed: true,
                status: 'completed',
                confirmed_at: new Date().toISOString(),
              }
            : img
        );

        useAnnotationStore.setState({ images: updatedImages });

        // Auto-navigate to next incomplete image (in-progress or not-started)
        const nextIncompleteIndex = updatedImages.findIndex((img, idx) => {
          if (idx <= currentIndex) return false;
          const status = (img as any).status || 'not-started';
          return status === 'in-progress' || status === 'not-started';
        });

        if (nextIncompleteIndex !== -1) {
          setCurrentIndex(nextIncompleteIndex);
        } else {
          goToNextImage();
        }
        }
      } catch (err) {
        console.error('Failed to confirm image:', err);
        setBatchProgress(null);
        toast.error('확정에 실패했습니다.');
      } finally {
        setConfirmingImage(false);
      }
    };

    // Show confirm dialog for batch operations
    if (isBatch) {
      confirm({
        title: '이미지 확정',
        message: `선택한 ${targetImageIds.length}개 이미지를 확정하시겠습니까?`,
        confirmText: '확정',
        cancelText: '취소',
        onConfirm: processConfirm,
      });
    } else {
      processConfirm();
    }
  }, [currentImage, project, confirmingImage, annotations, images, currentIndex, goToNextImage, setCurrentIndex, selectedImageIds, clearImageSelection, currentTask]);

  // Phase 2.7: Keyboard shortcuts for Canvas
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in input fields or when modals are open
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        showClassSelector // Don't interfere with ClassSelectorModal keyboard events
      ) {
        return;
      }

      // Phase 11: Escape key to exit diff mode (without confirmation)
      if (e.key === 'Escape' && diffMode.enabled) {
        e.preventDefault();
        console.log('[Canvas] Escape pressed in diff mode, exiting...');
        const { exitDiffMode } = useAnnotationStore.getState();
        exitDiffMode().then(() => {
          console.log('[Canvas] Successfully exited diff mode');
          toast.success('Exited diff mode');
        }).catch((error) => {
          console.error('[Canvas] Failed to exit diff mode:', error);
          toast.error('Failed to exit diff mode');
        });
        return;
      }

      // Phase 2.10.2: Magnifier manual activation (Z key without Ctrl/Cmd) - Toggle mode
      if (e.key === 'z' && !e.ctrlKey && !e.metaKey) {
        // Calculate current magnifier state
        const currentlyShown = !magnifierForceOff && (
          manualMagnifierActive ||
          (isDrawingTool(tool) && preferences.autoMagnifier)
        );

        if (currentlyShown) {
          // Magnifier is currently shown, force it off
          setMagnifierForceOff(true);
          setManualMagnifierActive(false);
        } else {
          // Magnifier is hidden, turn on manual magnifier
          setMagnifierForceOff(false);
          setManualMagnifierActive(true);
        }
        return;
      }

      // Phase 2.10.3: Minimap toggle (M key)
      if (e.key === 'm' && !e.ctrlKey && !e.metaKey) {
        const currentShowMinimap = useAnnotationStore.getState().showMinimap;
        const newShowMinimap = !currentShowMinimap;
        useAnnotationStore.setState({ showMinimap: newShowMinimap });
        toast.success(`Minimap ${newShowMinimap ? 'shown' : 'hidden'}`);
        return;
      }

      // Phase 2.10: Undo/Redo shortcuts
      // Ctrl+Z / Cmd+Z: Undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (canUndo()) {
          undo();
          toast.success('Undone');
        }
        return;
      }

      // Ctrl+Y / Cmd+Y or Ctrl+Shift+Z / Cmd+Shift+Z: Redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (canRedo()) {
          redo();
          toast.success('Redone');
        }
        return;
      }

      // Enter: Close polygon (if drawing)
      if (e.key === 'Enter' && tool === 'polygon' && polygonVertices.length >= 3 && image) {
        e.preventDefault();
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;

        const { zoom, pan } = canvasState;
        const scaledWidth = image.width * zoom;
        const scaledHeight = image.height * zoom;
        const imgX = (rect.width - scaledWidth) / 2 + pan.x;
        const imgY = (rect.height - scaledHeight) / 2 + pan.y;

        // Convert canvas coords to image coords
        const imagePoints = polygonVertices.map(([vx, vy]): [number, number] => [
          (vx - imgX) / zoom,
          (vy - imgY) / zoom,
        ]);

        // Store pending polygon and show class selector
        setPendingBbox(null);
        (window as any).__pendingPolygon = imagePoints;
        setShowClassSelector(true);
        setPolygonVertices([]);
        return;
      }

      // Escape: Cancel polygon drawing
      if (e.key === 'Escape' && tool === 'polygon' && polygonVertices.length > 0) {
        e.preventDefault();
        setPolygonVertices([]);
        return;
      }

      // Enter: Complete polyline (if drawing)
      if (e.key === 'Enter' && tool === 'polyline' && polylineVertices.length >= 2 && image) {
        e.preventDefault();
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;

        const { zoom, pan } = canvasState;
        const scaledWidth = image.width * zoom;
        const scaledHeight = image.height * zoom;
        const imgX = (rect.width - scaledWidth) / 2 + pan.x;
        const imgY = (rect.height - scaledHeight) / 2 + pan.y;

        // Convert canvas coords to image coords
        const imagePoints = polylineVertices.map(([vx, vy]): [number, number] => [
          Math.round(((vx - imgX) / zoom) * 100) / 100,
          Math.round(((vy - imgY) / zoom) * 100) / 100,
        ]);

        // Store pending polyline and show class selector
        (window as any).__pendingPolyline = imagePoints;
        console.log('[Polyline] Set pending polyline:', imagePoints);
        setShowClassSelector(true);
        setPolylineVertices([]);
        return;
      }

      // Escape: Cancel polyline drawing
      if (e.key === 'Escape' && tool === 'polyline' && polylineVertices.length > 0) {
        e.preventDefault();
        setPolylineVertices([]);
        return;
      }

      // Escape: Cancel circle drawing
      if (e.key === 'Escape' && tool === 'circle' && circleCenter) {
        e.preventDefault();
        setCircleCenter(null);
        return;
      }

      // Escape: Cancel circle3p drawing
      if (e.key === 'Escape' && tool === 'circle3p' && circle3pPoints.length > 0) {
        e.preventDefault();
        setCircle3pPoints([]);
        return;
      }

      // Arrow keys: Move selected bbox handle or entire bbox
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectedVertexIndex === null && selectedAnnotationId) {
        const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
        if (selectedAnn && selectedAnn.geometry.type === 'bbox' && image) {
          e.preventDefault();
          e.stopPropagation();

          let [newX, newY, newW, newH] = selectedAnn.geometry.bbox;

          // Move amount (hold Shift for larger steps)
          const step = e.shiftKey ? 10 : 1;

          if (selectedBboxHandle) {
            // Move only the selected handle
            const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
            const dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;

            switch (selectedBboxHandle) {
              case 'nw': // Top-left corner
                newX += dx;
                newY += dy;
                newW -= dx;
                newH -= dy;
                break;
              case 'ne': // Top-right corner
                newY += dy;
                newW += dx;
                newH -= dy;
                break;
              case 'sw': // Bottom-left corner
                newX += dx;
                newW -= dx;
                newH += dy;
                break;
              case 'se': // Bottom-right corner
                newW += dx;
                newH += dy;
                break;
              case 'n': // Top edge
                newY += dy;
                newH -= dy;
                break;
              case 's': // Bottom edge
                newH += dy;
                break;
              case 'w': // Left edge
                newX += dx;
                newW -= dx;
                break;
              case 'e': // Right edge
                newW += dx;
                break;
            }

            // Ensure minimum size
            if (newW < 10) newW = 10;
            if (newH < 10) newH = 10;
          } else {
            // Move entire bbox
            switch (e.key) {
              case 'ArrowUp':
                newY = Math.max(0, newY - step);
                break;
              case 'ArrowDown':
                newY = Math.min(image.height - newH, newY + step);
                break;
              case 'ArrowLeft':
                newX = Math.max(0, newX - step);
                break;
              case 'ArrowRight':
                newX = Math.min(image.width - newW, newX + step);
                break;
            }
          }

          // Clip to image bounds and round to 2 decimal places
          newX = Math.round(Math.max(0, Math.min(image.width - newW, newX)) * 100) / 100;
          newY = Math.round(Math.max(0, Math.min(image.height - newH, newY)) * 100) / 100;
          newW = Math.round(newW * 100) / 100;
          newH = Math.round(newH * 100) / 100;

          // Update annotation in store (with history recording)
          const updatedGeometry = {
            type: 'bbox' as const,
            bbox: [newX, newY, newW, newH] as [number, number, number, number],
          };
          updateAnnotationStore(selectedAnnotationId, {
            geometry: updatedGeometry,
          });

          // Save to backend
          const updateData: AnnotationUpdateRequest = {
            geometry: {
              type: 'bbox',
              bbox: [newX, newY, newW, newH],
              image_width: image.width,
              image_height: image.height,
            },
          };
          updateAnnotation(selectedAnnotationId, updateData)
            .then(() => {
              // Update image status to in-progress
              if (currentImage) {
                const updatedCurrentImage = {
                  ...currentImage,
                  is_confirmed: false,
                  status: 'in-progress',
                };

                useAnnotationStore.setState((state) => ({
                  currentImage: state.currentImage?.id === currentImage.id
                    ? updatedCurrentImage
                    : state.currentImage,
                  images: state.images.map(img =>
                    img.id === currentImage.id
                      ? updatedCurrentImage
                      : img
                  ),
                }));
              }
            })
            .catch((error) => {
              console.error('Failed to move bbox:', error);
            });

          return;
        }
      }

      // Arrow keys: Resize selected circle handle or move entire circle
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectedVertexIndex === null && selectedAnnotationId) {
        const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
        if (selectedAnn && selectedAnn.geometry.type === 'circle' && image) {
          e.preventDefault();
          e.stopPropagation();

          let center = [...selectedAnn.geometry.center] as [number, number];
          let radius = selectedAnn.geometry.radius;

          // Move amount (hold Shift for larger steps)
          const step = e.shiftKey ? 10 : 1;

          if (selectedCircleHandle) {
            // Resize radius based on handle direction
            let radiusDelta = 0;

            switch (selectedCircleHandle) {
              case 'n': // Top handle
                radiusDelta = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
                break;
              case 's': // Bottom handle
                radiusDelta = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;
                break;
              case 'e': // Right handle
                radiusDelta = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
                break;
              case 'w': // Left handle
                radiusDelta = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
                break;
            }

            radius = Math.max(5, radius + radiusDelta);
          } else {
            // Move entire circle
            switch (e.key) {
              case 'ArrowUp':
                center[1] = Math.max(radius, center[1] - step);
                break;
              case 'ArrowDown':
                center[1] = Math.min(image.height - radius, center[1] + step);
                break;
              case 'ArrowLeft':
                center[0] = Math.max(radius, center[0] - step);
                break;
              case 'ArrowRight':
                center[0] = Math.min(image.width - radius, center[0] + step);
                break;
            }
          }

          // Round to 2 decimal places
          center[0] = Math.round(center[0] * 100) / 100;
          center[1] = Math.round(center[1] * 100) / 100;
          radius = Math.round(radius * 100) / 100;

          // Update annotation in store (with history recording)
          const updatedCircleGeometry = {
            type: 'circle' as const,
            center: center as [number, number],
            radius,
          };
          updateAnnotationStore(selectedAnnotationId, {
            geometry: updatedCircleGeometry,
          });

          // Save to backend
          const updateData: AnnotationUpdateRequest = {
            geometry: {
              type: 'circle',
              center,
              radius,
              image_width: image.width,
              image_height: image.height,
            },
          };
          updateAnnotation(selectedAnnotationId, updateData)
            .then(() => {
              // Update image status to in-progress
              if (currentImage) {
                const updatedCurrentImage = {
                  ...currentImage,
                  is_confirmed: false,
                  status: 'in-progress',
                };

                useAnnotationStore.setState((state) => ({
                  currentImage: state.currentImage?.id === currentImage.id
                    ? updatedCurrentImage
                    : state.currentImage,
                  images: state.images.map(img =>
                    img.id === currentImage.id
                      ? updatedCurrentImage
                      : img
                  ),
                }));
              }
            })
            .catch((error) => {
              console.error('Failed to move/resize circle:', error);
            });

          return;
        }
      }

      // Arrow keys: Move selected vertex (polygon or polyline - override image navigation)
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectedVertexIndex !== null && selectedAnnotationId) {
        const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
        if (selectedAnn && (selectedAnn.geometry.type === 'polygon' || selectedAnn.geometry.type === 'polyline') && image) {
          e.preventDefault();
          e.stopPropagation();

          const points = selectedAnn.geometry.points;
          const [px, py] = points[selectedVertexIndex];

          // Move amount (hold Shift for larger steps)
          const step = e.shiftKey ? 10 : 1;

          let newX = px;
          let newY = py;

          switch (e.key) {
            case 'ArrowUp':
              newY = Math.round(Math.max(0, py - step) * 100) / 100;
              break;
            case 'ArrowDown':
              newY = Math.round(Math.min(image.height, py + step) * 100) / 100;
              break;
            case 'ArrowLeft':
              newX = Math.round(Math.max(0, px - step) * 100) / 100;
              break;
            case 'ArrowRight':
              newX = Math.round(Math.min(image.width, px + step) * 100) / 100;
              break;
          }

          // Update annotation in store (with history recording)
          const newPoints = [...points];
          newPoints[selectedVertexIndex] = [newX, newY];

          const updatedPolygonGeometry = {
            type: 'polygon' as const,
            points: newPoints,
          };
          updateAnnotationStore(selectedAnnotationId, {
            geometry: updatedPolygonGeometry,
          });

          // Save to backend (debounced would be better, but for now immediate)
          const updateData: AnnotationUpdateRequest = {
            geometry: {
              type: 'polygon',
              points: newPoints,
              image_width: image.width,
              image_height: image.height,
            },
          };
          updateAnnotation(selectedAnnotationId, updateData)
            .then(() => {
              // Update image status to in-progress
              if (currentImage) {
                const updatedCurrentImage = {
                  ...currentImage,
                  is_confirmed: false,
                  status: 'in-progress',
                };

                useAnnotationStore.setState((state) => ({
                  currentImage: state.currentImage?.id === currentImage.id
                    ? updatedCurrentImage
                    : state.currentImage,
                  images: state.images.map(img =>
                    img.id === currentImage.id
                      ? updatedCurrentImage
                      : img
                  ),
                }));
              }
            })
            .catch((error) => {
              console.error('Failed to move vertex:', error);
            });

          return;
        }
      }

      // Delete/Backspace: Delete selected vertex (minimum 3 for polygon, 2 for polyline)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedVertexIndex !== null && selectedAnnotationId) {
        const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
        if (selectedAnn && (selectedAnn.geometry.type === 'polygon' || selectedAnn.geometry.type === 'polyline')) {
          const points = selectedAnn.geometry.points;
          const geometryType = selectedAnn.geometry.type;
          const minVertices = geometryType === 'polygon' ? 3 : 2;

          // Must keep minimum vertices
          if (points.length <= minVertices) {
            const typeName = geometryType === 'polygon' ? 'Polygon' : 'Polyline';
            toast.warning(`${typeName}은 최소 ${minVertices}개의 vertex가 필요합니다.`, 3000);
            return;
          }

          e.preventDefault();

          // Remove the selected vertex
          const newPoints = points.filter((_, i) => i !== selectedVertexIndex);

          // Update annotation in store (with history recording)
          const updatedPolyGeometry = {
            type: geometryType as 'polygon' | 'polyline',
            points: newPoints,
          };
          updateAnnotationStore(selectedAnnotationId, {
            geometry: updatedPolyGeometry,
          });

          // Save to backend
          const updateData: AnnotationUpdateRequest = {
            geometry: {
              type: geometryType,
              points: newPoints,
              image_width: image.width,
              image_height: image.height,
            },
          };
          updateAnnotation(selectedAnnotationId, updateData)
            .then(() => {
              // Update image status to in-progress
              if (currentImage) {
                const updatedCurrentImage = {
                  ...currentImage,
                  is_confirmed: false,
                  status: 'in-progress',
                };

                useAnnotationStore.setState((state) => ({
                  currentImage: state.currentImage?.id === currentImage.id
                    ? updatedCurrentImage
                    : state.currentImage,
                  images: state.images.map(img =>
                    img.id === currentImage.id
                      ? updatedCurrentImage
                      : img
                  ),
                }));
              }
            })
            .catch((error) => {
              console.error('Failed to delete vertex:', error);
              toast.error('Vertex 삭제에 실패했습니다.');
            });

          // Clear vertex selection
          setSelectedVertexIndex(null);
          return;
        }
      }

      // Space: Confirm Image (supports batch)
      // Must have annotations or no_object to confirm (same condition as button)
      const canConfirm = (annotations.length > 0 || (currentImage as any)?.has_no_object) && !isImageConfirmed;
      if (e.key === ' ' && canConfirm) {
        e.preventDefault();
        handleConfirmImage();
      }

      // 0: No Object
      if (e.key === '0' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleNoObject();
      }

      // Delete: Delete all annotations (supports batch)
      // Only if no annotation is selected (individual annotation delete is handled by useKeyboardShortcuts)
      if (e.key === 'Delete' && !selectedAnnotationId && (selectedImageIds.length > 0 || annotations.length > 0)) {
        e.preventDefault();
        handleDeleteAllAnnotations();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleConfirmImage, isImageConfirmed, annotations, handleNoObject, selectedImageIds, handleDeleteAllAnnotations, currentImage, selectedAnnotationId, tool, polygonVertices, image, canvasState, selectedVertexIndex, selectedBboxHandle, selectedCircleHandle, polylineVertices, circleCenter, circle3pPoints, undo, redo, canUndo, canRedo, diffMode, showClassSelector, manualMagnifierActive, magnifierForceOff, preferences.autoMagnifier, isDrawingTool]);

  // Phase 2.10.2: Z key release handler removed - now using toggle mode instead
  // (Toggle mode is more reliable in remote desktop environments)

  // Mouse wheel handler (zoom)
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(canvasState.zoom + delta);
  };

  if (!currentImage) {
    return (
      <div className="flex-1 bg-gray-900 flex items-center justify-center">
        <p className="text-gray-500">No image selected</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 bg-white dark:bg-gray-900 relative overflow-hidden">
      {/* Phase 11: Diff Mode UI */}
      {diffMode.enabled ? (
        <>
          <DiffToolbar />
          <DiffActions />
          <DiffViewModeSelector />
        </>
      ) : (
        <>
          {/* Tool selector - top center */}
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-gray-100 dark:bg-gray-800 rounded-lg p-2 flex items-center gap-2 shadow-lg z-10">
        <button
          onClick={() => setTool('select')}
          className={`px-4 py-2 rounded transition-all text-sm font-medium flex items-center gap-2 ${
            tool === 'select'
              ? 'bg-violet-500 text-white'
              : 'text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700'
          }`}
          title="Select Tool (Q)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
          </svg>
          <span>Select</span>
        </button>

        {/* Phase 2.9: Show BBox tool for detection tasks */}
        {currentTask === 'detection' && (
          <button
            onClick={() => setTool('bbox')}
            className={`px-4 py-2 rounded transition-all text-sm font-medium flex items-center gap-2 ${
              tool === 'bbox'
                ? 'bg-violet-500 text-white'
                : 'text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
            title="Bounding Box (B)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="4" y="4" width="16" height="16" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 2" />
            </svg>
            <span>BBox</span>
          </button>
        )}

        {/* Polygon tool for segmentation tasks */}
        {currentTask === 'segmentation' && (
          <button
            onClick={() => setTool('polygon')}
            className={`px-4 py-2 rounded transition-all text-sm font-medium flex items-center gap-2 ${
              tool === 'polygon'
                ? 'bg-violet-500 text-white'
                : 'text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
            title="Polygon (P)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            <span>Polygon</span>
          </button>
        )}

        {/* Classification tool for classification tasks */}
        {currentTask === 'classification' && (
          <button
            onClick={() => setTool('classification')}
            className={`px-4 py-2 rounded transition-all text-sm font-medium flex items-center gap-2 ${
              tool === 'classification'
                ? 'bg-violet-500 text-white'
                : 'text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
            title="Classify (W)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            <span>Classify</span>
          </button>
        )}

        {/* Geometry tools for geometry tasks */}
        {currentTask === 'geometry' && (
          <>
            <button
              onClick={() => setTool('polyline')}
              className={`px-4 py-2 rounded transition-all text-sm font-medium flex items-center gap-2 ${
                tool === 'polyline'
                  ? 'bg-violet-500 text-white'
                  : 'text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
              title="Polyline (L)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 17l6-6 4 4 8-8" />
              </svg>
              <span>Polyline</span>
            </button>
            <button
              onClick={() => setTool('circle')}
              className={`px-4 py-2 rounded transition-all text-sm font-medium flex items-center gap-2 ${
                tool === 'circle'
                  ? 'bg-violet-500 text-white'
                  : 'text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
              title="Circle - Center Edge (E)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" strokeWidth={2} />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                <circle cx="12" cy="2" r="1.5" fill="currentColor" />
              </svg>
              <span>Circle(2P)</span>
            </button>
            <button
              onClick={() => setTool('circle3p')}
              className={`px-4 py-2 rounded transition-all text-sm font-medium flex items-center gap-2 ${
                tool === 'circle3p'
                  ? 'bg-violet-500 text-white'
                  : 'text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
              title="Circle - 3 Points (R)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" strokeWidth={2} />
                <circle cx="12" cy="2" r="1.5" fill="currentColor" />
                <circle cx="4" cy="16" r="1.5" fill="currentColor" />
                <circle cx="20" cy="16" r="1.5" fill="currentColor" />
              </svg>
              <span>Circle(3P)</span>
            </button>
          </>
        )}
      </div>
        </>
      )}

      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ cursor: isPanning ? 'grabbing' : canvasCursor }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
      />

      {/* Zoom controls */}
      <div className="absolute bottom-4 left-4 bg-gray-100 dark:bg-gray-800 rounded-lg p-2 flex items-center gap-2 shadow-lg">
        {/* Undo button */}
        <button
          onClick={() => {
            if (canUndo()) {
              undo();
              toast.success('Undone');
            }
          }}
          disabled={!canUndo()}
          className={`
            w-8 h-8 flex items-center justify-center rounded transition-colors
            ${canUndo()
              ? 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-900 dark:text-white'
              : 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
            }
          `}
          title="Undo (Ctrl+Z)"
        >
          <ArrowUturnLeftIcon className="w-4 h-4" />
        </button>

        {/* Redo button */}
        <button
          onClick={() => {
            if (canRedo()) {
              redo();
              toast.success('Redone');
            }
          }}
          disabled={!canRedo()}
          className={`
            w-8 h-8 flex items-center justify-center rounded transition-colors
            ${canRedo()
              ? 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-900 dark:text-white'
              : 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
            }
          `}
          title="Redo (Ctrl+Y)"
        >
          <ArrowUturnRightIcon className="w-4 h-4" />
        </button>

        {/* Divider */}
        <div className="w-px h-6 bg-gray-300 dark:bg-gray-700 mx-1"></div>

        {/* Zoom out button */}
        <button
          onClick={() => setZoom(canvasState.zoom - 0.25)}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors text-gray-900 dark:text-white"
          title="Zoom Out (Ctrl+-)"
        >
          −
        </button>
        <span className="text-xs text-gray-600 dark:text-gray-400 w-12 text-center">
          {Math.round(canvasState.zoom * 100)}%
        </span>
        <button
          onClick={() => setZoom(canvasState.zoom + 0.25)}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors text-gray-900 dark:text-white"
          title="Zoom In (Ctrl++)"
        >
          +
        </button>
        <div className="w-px h-6 bg-gray-300 dark:bg-gray-700 mx-1"></div>
        <button
          onClick={() => {
            setZoom(1.0);
            setPan({ x: 0, y: 0 });
          }}
          className="px-3 h-8 flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors text-xs text-gray-900 dark:text-white"
          title="Fit to Screen (Ctrl+0)"
        >
          Fit
        </button>
      </div>

      {/* Navigation controls */}
      <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-2 flex items-center gap-3 shadow-lg">
        <button
          onClick={goToPrevImage}
          disabled={currentIndex === 0}
          className="text-gray-900 dark:text-white disabled:text-gray-400 dark:disabled:text-gray-600 hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:cursor-not-allowed"
          title="Previous Image (←)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm text-gray-900 dark:text-white font-medium min-w-[60px] text-center">
          {currentIndex + 1} / {images.length}
        </span>
        <button
          onClick={goToNextImage}
          disabled={currentIndex >= images.length - 1}
          className="text-gray-900 dark:text-white disabled:text-gray-400 dark:disabled:text-gray-600 hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:cursor-not-allowed"
          title="Next Image (→)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Image info */}
      {image && (
        <div className="absolute bottom-4 right-20 bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-2 text-xs text-gray-600 dark:text-gray-400 shadow-lg">
          {image.width} x {image.height} px
        </div>
      )}

      {/* Phase 2.7: Confirm Image button */}
      {(annotations.length > 0 || (currentImage as any)?.has_no_object) && !isImageConfirmed && (
        <div className="absolute bottom-20 left-1/2 transform -translate-x-1/2">
          <button
            onClick={handleConfirmImage}
            disabled={confirmingImage}
            className={`px-4 py-2 rounded-lg shadow-lg font-medium text-xs transition-all flex items-center gap-2 whitespace-nowrap ${
              draftCount > 0
                ? 'bg-green-500 hover:bg-green-600 disabled:bg-green-400 text-white'
                : 'bg-blue-500 hover:bg-blue-600 disabled:bg-blue-400 text-white'
            } disabled:cursor-not-allowed`}
            title="Confirm Image (Space)"
          >
            {confirmingImage ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>Confirming...</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                </svg>
                <span>
                  {draftCount > 0
                    ? `Confirm & Next (${draftCount} draft)`
                    : 'Mark Complete & Next'}
                </span>
                <kbd className="ml-1 px-1 py-0.5 text-[10px] bg-white bg-opacity-20 rounded">
                  Space
                </kbd>
              </>
            )}
          </button>
        </div>
      )}

      {/* Image already confirmed */}
      {isImageConfirmed && (
        <div className="absolute bottom-20 left-1/2 transform -translate-x-1/2">
          <div className="px-4 py-2 rounded-lg shadow-lg bg-gray-500 text-white font-medium text-xs flex items-center gap-2 whitespace-nowrap">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
            </svg>
            <span>Image Confirmed</span>
          </div>
        </div>
      )}

      {/* Utility buttons (top-right) */}
      <div className="absolute top-4 right-4 flex flex-row gap-2">
        {/* No Object button */}
        <button
          onClick={handleNoObject}
          className="w-10 h-10 bg-gray-600 hover:bg-gray-700 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105"
          title="No Object (0)"
        >
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="4" y="4" width="16" height="16" rx="2" strokeWidth={2} strokeDasharray="4 2" />
          </svg>
        </button>

        {/* Delete all annotations button */}
        <button
          onClick={handleDeleteAllAnnotations}
          disabled={annotations.length === 0 && selectedImageIds.length === 0}
          className={`w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105 ${
            annotations.length > 0 || selectedImageIds.length > 0
              ? 'bg-red-400 hover:bg-red-500'
              : 'bg-gray-400 cursor-not-allowed'
          }`}
          title="Delete All Annotations (Del)"
        >
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>

      {/* AI Assistant button */}
      <div className="absolute bottom-4 right-4">
        <button
          className="w-12 h-12 bg-violet-600 hover:bg-violet-700 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105"
          title="AI Assistant"
        >
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        </button>
      </div>

      {!imageLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-900 bg-opacity-50">
          <svg className="animate-spin h-8 w-8 text-violet-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
      )}

      {/* Saving indicator */}
      {isSaving && (
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-gray-100 dark:bg-gray-800 px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
          <svg className="animate-spin h-4 w-4 text-violet-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-sm text-gray-900 dark:text-gray-300">Saving annotation...</span>
        </div>
      )}

      {/* Batch progress indicator */}
      {batchProgress && (
        <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 min-w-[300px]">
            <div className="flex items-center gap-3 mb-4">
              <svg className="animate-spin h-5 w-5 text-violet-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                처리 중... {batchProgress.current} / {batchProgress.total}
              </span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-violet-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Phase 2.10.2: Magnifier */}
      {shouldShowMagnifier && (
        <Magnifier
          canvasRef={canvasRef}
          cursorPosition={cursorPos}
          magnification={magnification}
          mode={preferences.magnifierMode}
          size={preferences.magnifierSize}
        />
      )}

      {/* Phase 2.10.3: Minimap moved to RightPanel */}

      {/* Class Selector Modal */}
      <ClassSelectorModal
        isOpen={showClassSelector}
        onClose={handleClassSelectorClose}
        onSelect={handleClassSelect}
      />

      {/* Phase 8.5.1: Version Conflict Dialog */}
      <AnnotationConflictDialog
        isOpen={conflictDialogOpen}
        conflict={conflictInfo}
        onReload={async () => {
          setConflictDialogOpen(false);
          setPendingAnnotationUpdate(null);
          setConflictInfo(null);
          // Reload annotations to get latest version
          if (project && currentImage) {
            try {
              const anns = await getProjectAnnotations(project.id, currentImage.id);
              // Update store with fresh annotations
              useAnnotationStore.setState({
                annotations: anns.map((ann: any) => ({
                  id: String(ann.id),
                  projectId: ann.project_id,
                  imageId: ann.image_id,
                  annotationType: ann.annotation_type,
                  geometry: ann.geometry,
                  classId: ann.class_id,
                  className: ann.class_name,
                  attributes: ann.attributes || {},
                  confidence: ann.confidence,
                  createdBy: ann.created_by,
                  version: ann.version, // Phase 8.5.1: Include version
                })),
              });
              toast.info('Reloaded latest version');
            } catch (error) {
              console.error('Failed to reload annotations:', error);
              toast.error('Failed to reload annotations');
            }
          }
        }}
        onOverwrite={async () => {
          if (!pendingAnnotationUpdate || !conflictInfo) return;

          try {
            // Force update with current version
            await updateAnnotation(pendingAnnotationUpdate.annotationId, {
              ...pendingAnnotationUpdate.data,
              version: conflictInfo.currentVersion,
            });

            setConflictDialogOpen(false);
            setPendingAnnotationUpdate(null);
            setConflictInfo(null);

            // Reload annotations
            if (project && currentImage) {
              const anns = await getProjectAnnotations(project.id, currentImage.id);
              useAnnotationStore.setState({
                annotations: anns.map((ann: any) => ({
                  id: String(ann.id),
                  projectId: ann.project_id,
                  imageId: ann.image_id,
                  annotationType: ann.annotation_type,
                  geometry: ann.geometry,
                  classId: ann.class_id,
                  className: ann.class_name,
                  attributes: ann.attributes || {},
                  confidence: ann.confidence,
                  createdBy: ann.created_by,
                  version: ann.version,
                })),
              });
            }

            toast.success('Changes saved');
          } catch (error) {
            console.error('Overwrite failed:', error);
            toast.error('Failed to overwrite changes');
          }
        }}
        onCancel={() => {
          setConflictDialogOpen(false);
          setPendingAnnotationUpdate(null);
          setConflictInfo(null);
        }}
      />

      {/* Phase 8.5.2: Lock Status Indicator */}
      {isImageLocked && (
        <div className="absolute top-20 left-4 z-10 bg-green-100 text-green-800 px-3 py-1.5 rounded-lg shadow text-sm flex items-center gap-2">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
          </svg>
          <span>You have exclusive editing access</span>
        </div>
      )}

      {/* Image Path Display */}
      {currentImage && (
        <div className="absolute top-32 left-4 z-10 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-3 py-1.5 rounded-lg shadow text-xs font-mono">
          {currentImage.id}
        </div>
      )}

      {/* Phase 8.5.2: Locked Overlay (when lock is not acquired) */}
      {!isImageLocked && currentImage && (
        <div className="absolute inset-0 z-20 bg-black/40 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="bg-white/20 backdrop-blur-md rounded-2xl shadow-2xl p-8 max-w-md mx-4 flex flex-col items-center text-center pointer-events-auto">
            {/* Lock Icon */}
            <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center mb-4">
              <svg className="w-10 h-10 text-gray-600" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
            </div>

            {/* Title */}
            <h3 className="text-xl font-bold text-gray-900 mb-4">
              Image Locked
            </h3>

            {/* Lock Status */}
            {lockedByUser ? (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-800">
                Currently locked by <span className="font-semibold">{lockedByUser}</span>
              </div>
            ) : (
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-sm text-blue-800">
                Click the image to acquire lock
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
