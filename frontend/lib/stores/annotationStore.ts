/**
 * Annotation Store (Zustand) - REFACTORED
 *
 * Manages all annotation state including:
 * - Current image and navigation
 * - Annotations (bboxes, polygons, etc.)
 * - Canvas state (zoom, pan)
 * - UI state (panels, tools)
 * - Undo/redo history
 *
 * REFACTORING CHANGES:
 * - Removed legacy classes field (use taskClasses only)
 * - Use TaskType enum for type safety
 * - Task-specific class management throughout
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { TaskType } from '@/lib/tasks/types';

// ============================================================================
// Types
// ============================================================================

export interface Point {
  x: number;
  y: number;
}

export interface ImageData {
  id: string;
  file_name: string;
  folder_path?: string;  // Folder path for folder-structured datasets
  url: string;
  thumbnail_url?: string;  // Phase 2.12: Thumbnail for performance
  width?: number;
  height?: number;
  annotated?: boolean;
  annotation_count?: number;

  // Phase 2.7: Image status fields
  is_confirmed?: boolean;
  status?: string;  // not-started, in-progress, completed
  confirmed_at?: string;

  // Phase 2.12: Track if no_object annotation exists for current task
  has_no_object?: boolean;
}

export interface BboxGeometry {
  type: 'bbox';
  bbox: [number, number, number, number]; // [x, y, width, height]
  area?: number;
}

export interface PolygonGeometry {
  type: 'polygon';
  points: [number, number][];
  area?: number;
  bbox?: [number, number, number, number];
}

export interface PolylineGeometry {
  type: 'polyline';
  points: [number, number][];
  image_width?: number;
  image_height?: number;
}

export interface CircleGeometry {
  type: 'circle';
  center: [number, number];
  radius: number;
  image_width?: number;
  image_height?: number;
}

export interface ClassificationGeometry {
  type: 'classification';
  labels?: string[];
  confidence?: number;
}

export type AnnotationGeometry = BboxGeometry | PolygonGeometry | PolylineGeometry | CircleGeometry | ClassificationGeometry;

export interface Annotation {
  id: string;
  projectId: string;
  imageId: string;
  annotationType: 'bbox' | 'polygon' | 'classification' | 'keypoints' | 'line' | 'polyline' | 'circle';
  geometry: AnnotationGeometry;
  classId?: string;
  className?: string;
  attributes?: Record<string, any>;
  confidence?: number;
  isAiAssisted?: boolean;
  createdBy?: number;
  createdAt?: Date;
  updatedAt?: Date;

  // Phase 2.7: Confirmation fields
  annotation_state?: string;  // 'draft', 'confirmed', 'verified'
  confirmed_at?: string;
  confirmed_by?: number;
  confirmed_by_name?: string;

  // Phase 8.5.1: Optimistic locking
  version?: number;
}

export interface Project {
  id: string;
  name: string;
  datasetId: string;
  taskTypes: string[];
  // REFACTORING: Task-based classes structure (legacy classes field removed)
  taskClasses: Record<string, Record<string, ClassInfo>>;  // {task_type: {class_id: ClassInfo}}
  taskConfig: Record<string, any>;
  // Backward compatibility: API still returns classes field
  classes?: Record<string, ClassInfo>;
}

export interface ClassInfo {
  name: string;
  color: string;
  order?: number;
  image_count?: number;
  bbox_count?: number;
}

export type Tool = 'select' | 'bbox' | 'polygon' | 'classification' | 'keypoints' | 'line' | 'polyline' | 'circle' | 'circle3p';

export interface CanvasState {
  zoom: number; // 0.1 to 4.0
  pan: Point;
  cursor: Point;
}

export interface PanelState {
  left: boolean;
  right: boolean;
}

export interface Preferences {
  autoSave: boolean;
  snapToEdges: boolean;
  showLabels: boolean;
  showGrid: boolean;
  darkMode: boolean;
  autoSelectClass: boolean;
  imageListView: 'grid' | 'list';
  // Phase 2.10.2: Magnifier settings
  autoMagnifier: boolean; // Auto-show in drawing tools
  magnifierMode: 'following' | 'fixed'; // Position mode
  magnifierSize: number; // Diameter in pixels
  magnificationLevel: number; // Default zoom level
}

export interface AnnotationSnapshot {
  timestamp: Date;
  annotations: Annotation[];
  action: 'create' | 'update' | 'delete' | 'move' | 'resize' | 'undo' | 'redo';
  affectedIds: string[];
}

export type SaveStatus = 'saved' | 'saving' | 'error';

// ============================================================================
// Store Interface
// ============================================================================

interface AnnotationState {
  // Project & Images
  project: Project | null;
  images: ImageData[];
  totalImages: number;  // Phase 2.12: Total image count for pagination
  currentIndex: number;
  currentImage: ImageData | null;

  // Phase 2.9: Current task context
  currentTask: string | null;  // 'classification', 'detection', 'segmentation', etc.

  // Annotations
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  selectedVertexIndex: number | null;  // For polygon vertex editing
  selectedBboxHandle: string | null;  // For bbox handle editing ('nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w')
  clipboard: Annotation | null;

  // UI State
  tool: Tool;
  canvas: CanvasState;
  panels: PanelState;

  // Interaction State
  isDrawing: boolean;
  drawingStart: Point | null;
  isDragging: boolean;
  dragTarget: 'bbox' | 'handle' | 'canvas' | null;

  // Settings
  preferences: Preferences;

  // History (Undo/Redo)
  history: {
    past: AnnotationSnapshot[];
    future: AnnotationSnapshot[];
  };

  // Network
  saveStatus: SaveStatus;
  lastSaved: Date | null;
  loading: boolean;
  backgroundLoading: boolean;  // Phase 2.12: Background pagination loading
  error: string | null;

  // Last selected class (for auto-select)
  lastSelectedClassId: string | null;

  // Visibility
  hiddenAnnotationIds: Set<string>;
  showAllAnnotations: boolean;

  // Multi-image selection
  selectedImageIds: string[];
  lastClickedImageIndex: number | null;

  // Phase 2.10.3: Canvas refs and Minimap state
  canvasRef: React.RefObject<HTMLCanvasElement> | null;
  imageRef: React.RefObject<HTMLImageElement> | null;
  showMinimap: boolean;

  // Phase 8.5: Image locks
  projectLocks?: any[]; // Lock info array

  // Undo/Redo operation flags (prevent concurrent operations)
  isUndoing: boolean;
  isRedoing: boolean;

  // Phase 11: Version Diff Mode
  diffMode: {
    enabled: boolean;
    versionA: { id: number; version_number: string; version_type: string } | null;
    versionB: { id: number; version_number: string; version_type: string } | null;
    viewMode: 'overlay' | 'side-by-side' | 'animation';
    diffData: any | null; // Full diff response from API
    filters: {
      showAdded: boolean;
      showRemoved: boolean;
      showModified: boolean;
      showUnchanged: boolean;
    };
  };

  // ========================================================================
  // Actions
  // ========================================================================

  // Project & Images
  setProject: (project: Project) => void;
  setImages: (images: ImageData[]) => void;
  loadMoreImages: (newImages: ImageData[]) => void;  // Phase 2.12: Append more images for pagination
  setCurrentIndex: (index: number) => void;
  goToNextImage: () => void;
  goToPrevImage: () => void;
  goToImage: (index: number) => void;

  // Phase 2.9: Task switching
  setCurrentTask: (taskType: string) => void;
  switchTask: (taskType: string) => void;
  getCurrentClasses: () => Record<string, ClassInfo>;

  // Annotations
  setAnnotations: (annotations: Annotation[]) => void;
  addAnnotation: (annotation: Annotation) => void;
  updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
  deleteAnnotation: (id: string) => void;
  selectAnnotation: (id: string | null) => void;
  clearAnnotations: () => void;

  // Canvas
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToScreen: () => void;
  setPan: (pan: Point) => void;
  setCursor: (cursor: Point) => void;

  // Tools
  setTool: (tool: Tool) => void;

  // Drawing State
  startDrawing: (point: Point) => void;
  updateDrawing: (point: Point) => void;
  finishDrawing: () => void;
  cancelDrawing: () => void;

  // Panels
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  setLeftPanel: (open: boolean) => void;
  setRightPanel: (open: boolean) => void;

  // Preferences
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  loadPreferences: () => void;
  savePreferences: () => void;

  // History (Undo/Redo)
  recordSnapshot: (action: AnnotationSnapshot['action'], affectedIds: string[]) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Network
  setSaveStatus: (status: SaveStatus) => void;
  setLoading: (loading: boolean) => void;
  setBackgroundLoading: (loading: boolean) => void;  // Phase 2.12: Background loading
  setError: (error: string | null) => void;

  // Class Selection
  setLastSelectedClass: (classId: string | null) => void;

  // Clipboard
  copyAnnotation: (annotation: Annotation) => void;
  pasteAnnotation: () => void;

  // Visibility
  toggleAnnotationVisibility: (id: string) => void;
  toggleAllAnnotationsVisibility: () => void;
  isAnnotationVisible: (id: string) => boolean;

  // Multi-image selection
  selectImages: (ids: string[]) => void;
  toggleImageSelection: (id: string, index: number) => void;
  selectImageRange: (toIndex: number) => void;
  clearImageSelection: () => void;
  isImageSelected: (id: string) => boolean;

  // Phase 11: Version Diff
  enterDiffMode: (versionA: any, versionB: any) => Promise<void>;
  exitDiffMode: () => Promise<void>;
  setDiffViewMode: (mode: 'overlay' | 'side-by-side' | 'animation') => void;
  setDiffFilter: (filter: keyof typeof initialState.diffMode.filters, value: boolean) => void;
  switchDiffVersion: (side: 'A' | 'B', version: any) => Promise<void>;
  getDiffForCurrentImage: () => any | null;

  // Reset
  reset: () => void;
}

// ============================================================================
// Initial State
// ============================================================================

const DEFAULT_PREFERENCES: Preferences = {
  autoSave: true,
  snapToEdges: true,
  showLabels: true,
  showGrid: false,
  darkMode: true,
  autoSelectClass: true,
  imageListView: 'grid',
  // Phase 2.10.2: Magnifier defaults
  autoMagnifier: true, // Auto-show in drawing tools
  magnifierMode: 'following', // Follow cursor by default
  magnifierSize: 200, // 200px diameter
  magnificationLevel: 3.0, // 3x zoom
};

const initialState = {
  project: null,
  images: [],
  totalImages: 0,  // Phase 2.12: Total image count for pagination
  currentIndex: 0,
  currentImage: null,
  currentTask: null,  // Phase 2.9: Current task context
  annotations: [],
  selectedAnnotationId: null,
  selectedVertexIndex: null,
  selectedBboxHandle: null,
  clipboard: null,
  tool: 'select' as Tool,
  canvas: {
    zoom: 1.0,
    pan: { x: 0, y: 0 },
    cursor: { x: 0, y: 0 },
  },
  panels: {
    left: true,
    right: true,
  },
  isDrawing: false,
  drawingStart: null,
  isDragging: false,
  dragTarget: null,
  preferences: DEFAULT_PREFERENCES,
  history: {
    past: [],
    future: [],
  },
  saveStatus: 'saved' as SaveStatus,
  lastSaved: null,
  loading: false,
  backgroundLoading: false,  // Phase 2.12: Background pagination loading
  error: null,
  lastSelectedClassId: null,
  hiddenAnnotationIds: new Set<string>(),
  showAllAnnotations: true,
  selectedImageIds: [],
  lastClickedImageIndex: null,
  canvasRef: null,
  imageRef: null,
  showMinimap: true,
  projectLocks: [],
  isUndoing: false,
  isRedoing: false,
  diffMode: {
    enabled: false,
    versionA: null,
    versionB: null,
    viewMode: 'overlay',
    diffData: null,
    filters: {
      showAdded: true,
      showRemoved: true,
      showModified: true,
      showUnchanged: false,
    },
  },
};

// ============================================================================
// Store
// ============================================================================

export const useAnnotationStore = create<AnnotationState>()(
  devtools(
    (set, get) => ({
      ...initialState,

      // ======================================================================
      // Project & Images
      // ======================================================================

      setProject: (project) => {
        // Phase 2.9: Set initial task to first task type
        const initialTask = project?.taskTypes?.[0] || null;
        set({ project, currentTask: initialTask });
      },

      setImages: (images) => {
        // Remove duplicates based on image ID (just in case)
        const uniqueImages = Array.from(
          new Map(images.map(img => [img.id, img])).values()
        );

        if (uniqueImages.length < images.length) {
          console.warn(`[Store] Removed ${images.length - uniqueImages.length} duplicate images during setImages`);
        }

        const currentImage = uniqueImages.length > 0 ? uniqueImages[0] : null;
        set({ images: uniqueImages, currentImage, currentIndex: 0 });
      },

      // Phase 2.12: Load more images (append to existing images)
      loadMoreImages: (newImages) => {
        const { images } = get();

        // Filter out duplicates based on image ID
        const existingIds = new Set(images.map(img => img.id));
        const uniqueNewImages = newImages.filter(img => !existingIds.has(img.id));

        if (uniqueNewImages.length > 0) {
          set({ images: [...images, ...uniqueNewImages] });
          console.log(`[Store] Added ${uniqueNewImages.length} new images (${newImages.length - uniqueNewImages.length} duplicates filtered)`);
        } else {
          console.log(`[Store] No new images to add (all ${newImages.length} were duplicates)`);
        }
      },

      setCurrentIndex: (index) => {
        const { images } = get();
        if (index >= 0 && index < images.length) {
          set({
            currentIndex: index,
            currentImage: images[index],
            annotations: [], // Clear annotations for new image
            selectedAnnotationId: null,
            selectedVertexIndex: null,
            selectedBboxHandle: null,
          });
        }
      },

      goToNextImage: () => {
        const { currentIndex, images } = get();
        if (currentIndex < images.length - 1) {
          get().setCurrentIndex(currentIndex + 1);
        }
      },

      goToPrevImage: () => {
        const { currentIndex } = get();
        if (currentIndex > 0) {
          get().setCurrentIndex(currentIndex - 1);
        }
      },

      goToImage: (index) => {
        get().setCurrentIndex(index);
      },

      // ======================================================================
      // Phase 2.9: Task Switching
      // ======================================================================

      setCurrentTask: (taskType) => {
        set({ currentTask: taskType });
      },

      /**
       * Switch to a different task type.
       * This resets the entire annotation context:
       * - Clears current annotations
       * - Resets tool to select
       * - Clears selection
       * - Resets canvas zoom/pan
       * - Clears undo/redo history
       */
      switchTask: (taskType) => {
        const { project } = get();

        // Validate task exists in project
        if (!project?.taskTypes?.includes(taskType)) {
          console.error(`Task type "${taskType}" not found in project`);
          return;
        }

        // Reset annotation context for new task
        set({
          currentTask: taskType,
          annotations: [],
          selectedAnnotationId: null,
          selectedVertexIndex: null,
          selectedBboxHandle: null,
          tool: 'select',
          canvas: {
            zoom: 1.0,
            pan: { x: 0, y: 0 },
            cursor: { x: 0, y: 0 },
          },
          history: {
            past: [],
            future: [],
          },
          lastSelectedClassId: null,
          hiddenAnnotationIds: new Set(),
          showAllAnnotations: true,
        });

        console.log(`Switched to task: ${taskType}`);
      },

      /**
       * Get classes for the current task.
       * Returns empty object if no task is selected or project has no task_classes.
       *
       * REFACTORED: No legacy fallback - taskClasses only.
       */
      getCurrentClasses: () => {
        const { project, currentTask } = get();

        if (!project || !currentTask) {
          return {};
        }

        // Return current task's classes or empty object if not configured
        return project.taskClasses?.[currentTask] || {};
      },

      // ======================================================================
      // Annotations
      // ======================================================================

      setAnnotations: (annotations) => set({ annotations }),

      addAnnotation: (annotation) => {
        const { annotations, preferences, lastSelectedClassId } = get();

        // Auto-select class if enabled
        if (preferences.autoSelectClass && !annotation.classId && lastSelectedClassId) {
          annotation.classId = lastSelectedClassId;
        }

        // Record BEFORE changing state
        get().recordSnapshot('create', [annotation.id]);

        set({ annotations: [...annotations, annotation] });

        // Update last selected class
        if (annotation.classId) {
          set({ lastSelectedClassId: annotation.classId });
        }
      },

      updateAnnotation: (id, updates) => {
        // Record BEFORE changing state
        get().recordSnapshot('update', [id]);

        const { annotations } = get();
        const updatedAnnotations = annotations.map((ann) =>
          ann.id === id ? { ...ann, ...updates } : ann
        );
        set({ annotations: updatedAnnotations });
      },

      deleteAnnotation: (id) => {
        // Record BEFORE changing state
        get().recordSnapshot('delete', [id]);

        const { annotations } = get();
        const filtered = annotations.filter((ann) => ann.id !== id);
        set({ annotations: filtered, selectedAnnotationId: null });
      },

      selectAnnotation: (id) => set({ selectedAnnotationId: id }),

      clearAnnotations: () => {
        const { annotations } = get();
        const ids = annotations.map((a) => a.id);
        set({ annotations: [], selectedAnnotationId: null });
        get().recordSnapshot('delete', ids);
      },

      // ======================================================================
      // Canvas
      // ======================================================================

      setZoom: (zoom) => {
        const clampedZoom = Math.max(0.1, Math.min(4.0, zoom));
        set((state) => ({
          canvas: { ...state.canvas, zoom: clampedZoom },
        }));
      },

      zoomIn: () => {
        const { canvas } = get();
        get().setZoom(canvas.zoom + 0.25);
      },

      zoomOut: () => {
        const { canvas } = get();
        get().setZoom(canvas.zoom - 0.25);
      },

      fitToScreen: () => {
        get().setZoom(1.0);
        set((state) => ({
          canvas: { ...state.canvas, pan: { x: 0, y: 0 } },
        }));
      },

      setPan: (pan) => {
        set((state) => ({
          canvas: { ...state.canvas, pan },
        }));
      },

      setCursor: (cursor) => {
        set((state) => ({
          canvas: { ...state.canvas, cursor },
        }));
      },

      // ======================================================================
      // Tools
      // ======================================================================

      setTool: (tool) => set({ tool }),

      // ======================================================================
      // Drawing State
      // ======================================================================

      startDrawing: (point) => {
        set({
          isDrawing: true,
          drawingStart: point,
        });
      },

      updateDrawing: (point) => {
        // Update cursor position for preview
        get().setCursor(point);
      },

      finishDrawing: () => {
        set({
          isDrawing: false,
          drawingStart: null,
        });
      },

      cancelDrawing: () => {
        set({
          isDrawing: false,
          drawingStart: null,
        });
      },

      // ======================================================================
      // Panels
      // ======================================================================

      toggleLeftPanel: () => {
        set((state) => ({
          panels: { ...state.panels, left: !state.panels.left },
        }));
      },

      toggleRightPanel: () => {
        set((state) => ({
          panels: { ...state.panels, right: !state.panels.right },
        }));
      },

      setLeftPanel: (open) => {
        set((state) => ({
          panels: { ...state.panels, left: open },
        }));
      },

      setRightPanel: (open) => {
        set((state) => ({
          panels: { ...state.panels, right: open },
        }));
      },

      // ======================================================================
      // Preferences
      // ======================================================================

      setPreference: (key, value) => {
        set((state) => ({
          preferences: { ...state.preferences, [key]: value },
        }));
        get().savePreferences();
      },

      loadPreferences: () => {
        try {
          const saved = localStorage.getItem('annotation-preferences');
          if (saved) {
            const preferences = JSON.parse(saved);
            set({ preferences: { ...DEFAULT_PREFERENCES, ...preferences } });
          }
        } catch (err) {
          console.error('Failed to load preferences:', err);
        }
      },

      savePreferences: () => {
        try {
          const { preferences } = get();
          localStorage.setItem('annotation-preferences', JSON.stringify(preferences));
        } catch (err) {
          console.error('Failed to save preferences:', err);
        }
      },

      // ======================================================================
      // History (Undo/Redo)
      // ======================================================================

      recordSnapshot: (action, affectedIds) => {
        const { annotations, history } = get();
        const snapshot: AnnotationSnapshot = {
          timestamp: new Date(),
          annotations: JSON.parse(JSON.stringify(annotations)),
          action,
          affectedIds,
        };

        const newPast = [...history.past, snapshot].slice(-50); // Keep last 50
        set({
          history: {
            past: newPast,
            future: [], // Clear redo stack
          },
        });
      },

      undo: async () => {
        const state = get();

        // Prevent concurrent undo operations
        if (state.isUndoing) {
          return;
        }

        const { history, annotations, project, currentImage } = state;
        if (history.past.length === 0) {
          return;
        }

        // Set undoing flag
        set({ isUndoing: true });

        try {
          const previous = history.past[history.past.length - 1];
          const newPast = history.past.slice(0, -1);

          const currentSnapshot: AnnotationSnapshot = {
            timestamp: new Date(),
            annotations: JSON.parse(JSON.stringify(annotations)),
            action: 'undo',
            affectedIds: [],
          };

          // Phase 8.5.2: Try to acquire lock for undo (will fail if locked by another user)
          if (project && currentImage) {
            try {
              const { imageLockAPI } = await import('@/lib/api/image-locks');
              const acquireResult = await imageLockAPI.acquireLock(project.id, currentImage.id);

              // Accept: 'acquired', 'already_acquired', 'refreshed'
              if (acquireResult.status === 'already_locked') {
                const { toast } = await import('@/lib/stores/toastStore');
                toast.error('Cannot undo: Image is locked by another user');
                set({ isUndoing: false });
                return;
              }

              // Update lock state if newly acquired
              if (acquireResult.status === 'acquired' && acquireResult.lock) {
                set((state) => {
                  const existingLocks = state.projectLocks || [];
                  const updatedLocks = existingLocks.filter(lock => lock.image_id !== currentImage.id);
                  return { projectLocks: [...updatedLocks, acquireResult.lock!] };
                });
              }
            } catch (error) {
              console.error('[Undo] Failed to acquire lock:', error);
              const { toast } = await import('@/lib/stores/toastStore');
              toast.error('Cannot undo: Failed to acquire image lock');
              set({ isUndoing: false });
              return;
            }
          }

          // Sync with backend: compare current and previous annotations
          try {
            const { createAnnotation, updateAnnotation, deleteAnnotation } = await import('@/lib/api/annotations');

            const currentIds = new Set(annotations.map(a => a.id));
            const previousIds = new Set(previous.annotations.map(a => a.id));

            const toDelete = annotations.filter(a => !previousIds.has(a.id));
            const toCreate = previous.annotations.filter(a => !currentIds.has(a.id));
            const toUpdate = previous.annotations.filter(prevAnn => {
              const currAnn = annotations.find(a => a.id === prevAnn.id);
              return currAnn && JSON.stringify(prevAnn.geometry) !== JSON.stringify(currAnn.geometry);
            });

            // Annotations that exist in current but not in previous → were added → delete them
            for (const ann of toDelete) {
              await deleteAnnotation(ann.id);
            }

            // Annotations that exist in previous but not in current → were deleted → recreate them
            for (const ann of toCreate) {
              const annotationData = {
                project_id: ann.projectId,
                image_id: ann.imageId,
                annotation_type: ann.annotationType,
                geometry: ann.geometry,
                class_id: ann.classId || null,
                class_name: ann.className || null,
              };
              await createAnnotation(annotationData);
            }

            // Annotations that exist in both but with different content → update them
            for (const prevAnn of toUpdate) {
              await updateAnnotation(prevAnn.id, {
                geometry: prevAnn.geometry,
              });
            }
          } catch (error) {
            console.error('[Undo] Failed to sync with backend:', error);
            const { toast } = await import('@/lib/stores/toastStore');
            toast.error('Undo completed locally but failed to sync with backend');
          }

          set({
            annotations: previous.annotations,
            history: {
              past: newPast,
              future: [currentSnapshot, ...history.future],
            },
          });
        } finally {
          set({ isUndoing: false });
        }
      },

      redo: async () => {
        const state = get();

        // Prevent concurrent redo operations
        if (state.isRedoing) {
          return;
        }

        const { history, annotations, project, currentImage } = state;
        if (history.future.length === 0) {
          return;
        }

        // Set redoing flag
        set({ isRedoing: true });

        try {
          const next = history.future[0];
          const newFuture = history.future.slice(1);

          const currentSnapshot: AnnotationSnapshot = {
            timestamp: new Date(),
            annotations: JSON.parse(JSON.stringify(annotations)),
            action: 'redo',
            affectedIds: [],
          };

          // Phase 8.5.2: Try to acquire lock for redo (will fail if locked by another user)
          if (project && currentImage) {
            try {
              const { imageLockAPI } = await import('@/lib/api/image-locks');
              const acquireResult = await imageLockAPI.acquireLock(project.id, currentImage.id);

              // Accept: 'acquired', 'already_acquired', 'refreshed'
              if (acquireResult.status === 'already_locked') {
                const { toast } = await import('@/lib/stores/toastStore');
                toast.error('Cannot redo: Image is locked by another user');
                set({ isRedoing: false });
                return;
              }

              // Update lock state if newly acquired
              if (acquireResult.status === 'acquired' && acquireResult.lock) {
                set((state) => {
                  const existingLocks = state.projectLocks || [];
                  const updatedLocks = existingLocks.filter(lock => lock.image_id !== currentImage.id);
                  return { projectLocks: [...updatedLocks, acquireResult.lock!] };
                });
              }
            } catch (error) {
              console.error('[Redo] Failed to acquire lock:', error);
              const { toast } = await import('@/lib/stores/toastStore');
              toast.error('Cannot redo: Failed to acquire image lock');
              set({ isRedoing: false });
              return;
            }
          }

          // Sync with backend: compare current and next annotations
          try {
            const { createAnnotation, updateAnnotation, deleteAnnotation } = await import('@/lib/api/annotations');

            const currentIds = new Set(annotations.map(a => a.id));
            const nextIds = new Set(next.annotations.map(a => a.id));

            // Annotations that exist in current but not in next → were added → delete them
            for (const ann of annotations) {
              if (!nextIds.has(ann.id)) {
                await deleteAnnotation(ann.id);
              }
            }

            // Annotations that exist in next but not in current → were deleted → recreate them
            for (const ann of next.annotations) {
              if (!currentIds.has(ann.id)) {
                const annotationData = {
                  project_id: ann.projectId,
                  image_id: ann.imageId,
                  annotation_type: ann.annotationType,
                  geometry: ann.geometry,
                  class_id: ann.classId || null,
                  class_name: ann.className || null,
                };
                await createAnnotation(annotationData);
              }
            }

            // Annotations that exist in both but with different content → update them
            for (const nextAnn of next.annotations) {
              const currAnn = annotations.find(a => a.id === nextAnn.id);
              if (currAnn && JSON.stringify(nextAnn.geometry) !== JSON.stringify(currAnn.geometry)) {
                await updateAnnotation(nextAnn.id, {
                  geometry: nextAnn.geometry,
                });
              }
            }
          } catch (error) {
            console.error('[Redo] Failed to sync with backend:', error);
            const { toast } = await import('@/lib/stores/toastStore');
            toast.error('Redo completed locally but failed to sync with backend');
          }

          set({
            annotations: next.annotations,
            history: {
              past: [...history.past, currentSnapshot],
              future: newFuture,
            },
          });
        } finally {
          set({ isRedoing: false });
        }
      },

      canUndo: () => get().history.past.length > 0,
      canRedo: () => get().history.future.length > 0,

      // ======================================================================
      // Network
      // ======================================================================

      setSaveStatus: (status) => {
        set({ saveStatus: status });
        if (status === 'saved') {
          set({ lastSaved: new Date() });
        }
      },

      setLoading: (loading) => set({ loading }),
      setBackgroundLoading: (loading) => set({ backgroundLoading: loading }),
      setError: (error) => set({ error }),

      // ======================================================================
      // Class Selection
      // ======================================================================

      setLastSelectedClass: (classId) => set({ lastSelectedClassId: classId }),

      // ======================================================================
      // Clipboard
      // ======================================================================

      copyAnnotation: (annotation) => {
        set({ clipboard: JSON.parse(JSON.stringify(annotation)) });
      },

      pasteAnnotation: async () => {
        const { clipboard, currentImage, project } = get();
        if (!clipboard || !currentImage || !project) return;

        // Create new annotation with offset
        const newGeometry = JSON.parse(JSON.stringify(clipboard.geometry));
        const offset = 20;

        // Offset based on annotation type
        if (newGeometry.type === 'bbox') {
          const [x, y, w, h] = newGeometry.bbox;
          newGeometry.bbox = [x + offset, y + offset, w, h];
        } else if (newGeometry.type === 'polygon') {
          newGeometry.points = newGeometry.points.map(([px, py]: [number, number]) => [
            px + offset,
            py + offset,
          ]);
        }

        // Create annotation via API
        try {
          const { createAnnotation } = await import('@/lib/api/annotations');
          const response = await createAnnotation({
            project_id: project.id,
            image_id: currentImage.id,
            annotation_type: clipboard.annotationType,
            class_id: clipboard.classId,
            class_name: clipboard.className,
            geometry: newGeometry,
          });

          // Add to local store with the ID from backend
          const newAnnotation: Annotation = {
            id: response.id,
            imageId: currentImage.id,
            annotationType: clipboard.annotationType,
            classId: clipboard.classId,
            className: clipboard.className,
            geometry: newGeometry,
            createdAt: new Date(),
          };

          const { annotations } = get();
          set({
            annotations: [...annotations, newAnnotation],
            selectedAnnotationId: newAnnotation.id,
          });

          // Record for undo
          get().recordSnapshot('create', [newAnnotation.id]);

        } catch (error) {
          console.error('Failed to paste annotation:', error);
        }
      },

      // ======================================================================
      // Visibility
      // ======================================================================

      toggleAnnotationVisibility: (id) => {
        const { hiddenAnnotationIds } = get();
        const newHidden = new Set(hiddenAnnotationIds);
        if (newHidden.has(id)) {
          newHidden.delete(id);
        } else {
          newHidden.add(id);
        }
        set({ hiddenAnnotationIds: newHidden });
      },

      toggleAllAnnotationsVisibility: () => {
        const { showAllAnnotations } = get();
        set({ showAllAnnotations: !showAllAnnotations, hiddenAnnotationIds: new Set() });
      },

      isAnnotationVisible: (id) => {
        const { hiddenAnnotationIds, showAllAnnotations } = get();
        if (!showAllAnnotations) return false;
        return !hiddenAnnotationIds.has(id);
      },

      // ======================================================================
      // Multi-image Selection
      // ======================================================================

      selectImages: (ids) => {
        set({ selectedImageIds: ids });
      },

      toggleImageSelection: (id, index) => {
        const { selectedImageIds } = get();
        const isSelected = selectedImageIds.includes(id);

        if (isSelected) {
          set({
            selectedImageIds: selectedImageIds.filter(i => i !== id),
            lastClickedImageIndex: index,
          });
        } else {
          set({
            selectedImageIds: [...selectedImageIds, id],
            lastClickedImageIndex: index,
          });
        }
      },

      selectImageRange: (toIndex) => {
        const { images, lastClickedImageIndex, currentIndex } = get();
        // Use lastClickedImageIndex if set, otherwise use currentIndex
        const fromIndex = lastClickedImageIndex ?? currentIndex;

        const start = Math.min(fromIndex, toIndex);
        const end = Math.max(fromIndex, toIndex);

        const rangeIds = images
          .slice(start, end + 1)
          .map(img => img.id);

        // Replace selection with range (not merge)
        set({
          selectedImageIds: rangeIds,
          lastClickedImageIndex: toIndex,
        });
      },

      clearImageSelection: () => {
        set({ selectedImageIds: [], lastClickedImageIndex: null });
      },

      isImageSelected: (id) => {
        const { selectedImageIds } = get();
        return selectedImageIds.includes(id);
      },

      // ======================================================================
      // Phase 11: Version Diff
      // ======================================================================

      enterDiffMode: async (versionA, versionB) => {
        try {
          set({ loading: true });

          console.log('[DiffMode] Entering diff mode:', versionA.version_number, 'vs', versionB.version_number);

          // Import API function
          const { compareVersions } = await import('@/lib/api/version-diff');

          // Fetch diff data from backend
          const diffData = await compareVersions(versionA.id, versionB.id);

          console.log('[DiffMode] Diff data loaded:', {
            totalImages: diffData.summary?.total_images,
            imagesWithChanges: diffData.summary?.images_with_changes,
            totalChanges: diffData.summary?.total_changes,
            totalAdded: diffData.summary?.total_added,
            totalRemoved: diffData.summary?.total_removed,
            totalModified: diffData.summary?.total_modified,
            imageDiffsCount: Object.keys(diffData.image_diffs || {}).length,
          });

          // Debug: Log sample image diff data
          const imageIds = Object.keys(diffData.image_diffs || {});
          console.log('[DiffMode] image_diffs keys (first 10):', imageIds.slice(0, 10));
          if (imageIds.length > 0) {
            const sampleId = imageIds[0];
            const sampleDiff = diffData.image_diffs[sampleId];
            console.log('[DiffMode] Sample image diff for', sampleId, ':', {
              added: sampleDiff?.added?.length || 0,
              removed: sampleDiff?.removed?.length || 0,
              modified: sampleDiff?.modified?.length || 0,
              unchanged: sampleDiff?.unchanged?.length || 0,
            });
          }

          // Debug: Log current image IDs (from store)
          const { images } = get();
          console.log('[DiffMode] Current image IDs (first 10):', images.slice(0, 10).map(img => img.id));

          // Enter diff mode
          set({
            diffMode: {
              enabled: true,
              versionA,
              versionB,
              viewMode: 'overlay',
              diffData,
              filters: {
                showAdded: true,
                showRemoved: true,
                showModified: true,
                showUnchanged: false,
              },
            },
            annotations: [], // Phase 11: Clear regular annotations in diff mode
            loading: false,
            // Disable editing in diff mode
            tool: 'select',
          });

          console.log('[DiffMode] Entered successfully:', versionA.version_number, 'vs', versionB.version_number);
        } catch (error) {
          console.error('[DiffMode] Failed to enter:', error);
          set({ loading: false, error: 'Failed to load version diff' });
        }
      },

      exitDiffMode: async () => {
        const { currentImage, project, currentTask } = get();

        console.log('[DiffMode] Exiting diff mode...');

        // Reset diff mode state
        set({
          diffMode: {
            enabled: false,
            versionA: null,
            versionB: null,
            viewMode: 'overlay',
            diffData: null,
            filters: {
              showAdded: true,
              showRemoved: true,
              showModified: true,
              showUnchanged: false,
            },
          },
        });

        // Optionally reload current image annotations (ignore errors)
        if (currentImage && project && currentTask) {
          try {
            console.log('[DiffMode] Reloading annotations for current image:', currentImage.id);
            const { getProjectAnnotations } = await import('@/lib/api/annotations');
            const anns = await getProjectAnnotations(
              project.id,
              currentImage.id,
              currentTask
            );
            set({ annotations: anns });
            console.log('[DiffMode] Annotations reloaded successfully:', anns.length);
          } catch (error) {
            // Ignore reload errors - diff mode is already exited
            console.warn('[DiffMode] Could not reload annotations (this is OK):', error instanceof Error ? error.message : error);
          }
        }

        console.log('[DiffMode] Exited successfully');
      },

      setDiffViewMode: (mode) => {
        set((state) => ({
          diffMode: {
            ...state.diffMode,
            viewMode: mode,
          },
        }));
      },

      setDiffFilter: (filter, value) => {
        set((state) => ({
          diffMode: {
            ...state.diffMode,
            filters: {
              ...state.diffMode.filters,
              [filter]: value,
            },
          },
        }));
      },

      switchDiffVersion: async (side, version) => {
        const { diffMode } = get();
        if (!diffMode.enabled) return;

        try {
          set({ loading: true });

          const { compareVersions } = await import('@/lib/api/version-diff');

          const newVersionA = side === 'A' ? version : diffMode.versionA;
          const newVersionB = side === 'B' ? version : diffMode.versionB;

          if (!newVersionA || !newVersionB) return;

          console.log('[DiffMode] Comparing versions:', newVersionA.version_number, 'vs', newVersionB.version_number);

          // Fetch new diff data
          const diffData = await compareVersions(newVersionA.id, newVersionB.id);

          console.log('[DiffMode] Diff data loaded:', {
            totalImages: diffData.summary?.total_images,
            imagesWithChanges: diffData.summary?.images_with_changes,
            totalChanges: diffData.summary?.total_changes,
            imageDiffsCount: Object.keys(diffData.image_diffs || {}).length,
          });

          // Debug: Log sample image diff data
          const imageIds = Object.keys(diffData.image_diffs || {});
          if (imageIds.length > 0) {
            const sampleId = imageIds[0];
            const sampleDiff = diffData.image_diffs[sampleId];
            console.log('[DiffMode] Sample image diff for', sampleId, ':', {
              added: sampleDiff?.added?.length || 0,
              removed: sampleDiff?.removed?.length || 0,
              modified: sampleDiff?.modified?.length || 0,
              unchanged: sampleDiff?.unchanged?.length || 0,
            });
          }

          set({
            diffMode: {
              ...diffMode,
              versionA: newVersionA,
              versionB: newVersionB,
              diffData,
            },
            annotations: [], // Phase 11: Clear annotations when switching versions
            loading: false,
          });

          console.log('[DiffMode] Switched version:', side, '→', version.version_number);
        } catch (error) {
          console.error('[DiffMode] Failed to switch version:', error);
          set({ loading: false, error: 'Failed to load version diff' });
        }
      },

      getDiffForCurrentImage: () => {
        const { diffMode, currentImage } = get();
        if (!diffMode.enabled || !diffMode.diffData || !currentImage) {
          return null;
        }

        // Return diff data for current image
        return diffMode.diffData.image_diffs?.[currentImage.id] || null;
      },

      // ======================================================================
      // Reset
      // ======================================================================

      reset: () => set(initialState),
    }),
    { name: 'AnnotationStore' }
  )
);
