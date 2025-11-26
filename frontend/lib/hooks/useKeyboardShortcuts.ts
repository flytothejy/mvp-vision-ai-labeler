/**
 * Keyboard Shortcuts Hook
 *
 * Handles global keyboard shortcuts for annotation interface
 */

import { useEffect } from 'react';
import { useAnnotationStore } from '@/lib/stores/annotationStore';
import { deleteAnnotation as deleteAnnotationAPI } from '@/lib/api/annotations';
import { confirm } from '@/lib/stores/confirmStore';
import { toast } from '@/lib/stores/toastStore';

export function useKeyboardShortcuts() {
  const {
    tool,
    setTool,
    goToNextImage,
    goToPrevImage,
    selectedAnnotationId,
    selectedVertexIndex,
    deleteAnnotation,
    selectAnnotation,
    zoomIn,
    zoomOut,
    fitToScreen,
    undo,
    redo,
    history,
    canvas,
    setPan,
    toggleLeftPanel,
    toggleRightPanel,
    currentTask,
    annotations,
    copyAnnotation,
    pasteAnnotation,
  } = useAnnotationStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in input fields
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Ctrl/Cmd modifier shortcuts
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) {
              // Redo
              if (history.future.length > 0) {
                redo();
              }
            } else {
              // Undo
              if (history.past.length > 0) {
                undo();
              }
            }
            break;
          case 'y':
            // Redo (alternative to Ctrl+Shift+Z)
            e.preventDefault();
            if (history.future.length > 0) {
              redo();
            }
            break;
          case '=':
          case '+':
            // Zoom in
            e.preventDefault();
            zoomIn();
            break;
          case '-':
            // Zoom out
            e.preventDefault();
            zoomOut();
            break;
          case '0':
            // Fit to screen
            e.preventDefault();
            fitToScreen();
            break;
          case 'c':
            // Copy selected annotation
            if (selectedAnnotationId) {
              e.preventDefault();
              const selectedAnn = annotations.find(ann => ann.id === selectedAnnotationId);
              if (selectedAnn) {
                copyAnnotation(selectedAnn);
              }
            }
            break;
          case 'v':
            // Paste annotation
            e.preventDefault();
            pasteAnnotation();
            break;
        }
        return;
      }

      // Regular shortcuts (no modifiers)
      switch (e.key.toLowerCase()) {
        case 'arrowup':
          // Previous image (skip if annotation/vertex is selected - handled by Canvas)
          if (selectedVertexIndex !== null || selectedAnnotationId !== null) return;
          e.preventDefault();
          goToPrevImage();
          break;
        case 'arrowdown':
          // Next image (skip if annotation/vertex is selected - handled by Canvas)
          if (selectedVertexIndex !== null || selectedAnnotationId !== null) return;
          e.preventDefault();
          goToNextImage();
          break;
        case 'arrowleft':
          // Previous image (skip if annotation/vertex is selected - handled by Canvas)
          if (selectedVertexIndex !== null || selectedAnnotationId !== null) return;
          e.preventDefault();
          goToPrevImage();
          break;
        case 'arrowright':
          // Next image (skip if annotation/vertex is selected - handled by Canvas)
          if (selectedVertexIndex !== null || selectedAnnotationId !== null) return;
          e.preventDefault();
          goToNextImage();
          break;
        case 'a':
          // Previous image
          e.preventDefault();
          goToPrevImage();
          break;
        case 'd':
          // Next image
          e.preventDefault();
          goToNextImage();
          break;
        case '1':
          // Slot 1: Select tool (all tasks)
          e.preventDefault();
          setTool('select');
          break;
        case '2':
          // Slot 2: Primary task tool
          e.preventDefault();
          if (currentTask === 'classification') {
            setTool('classification');
          } else if (currentTask === 'detection') {
            setTool('bbox');
          } else if (currentTask === 'segmentation') {
            setTool('polygon');
          } else if (currentTask === 'geometry') {
            setTool('polyline');
          } else {
            // Default to bbox for unknown tasks
            setTool('bbox');
          }
          break;
        case '3':
          // Slot 3: Circle 2-point (geometry only)
          e.preventDefault();
          if (currentTask === 'geometry') {
            setTool('circle');
          }
          break;
        case '4':
          // Slot 4: Circle 3-point (geometry only)
          e.preventDefault();
          if (currentTask === 'geometry') {
            setTool('circle3p');
          }
          break;
        case 'b':
          // BBox tool (detection shortcut)
          e.preventDefault();
          setTool('bbox');
          break;
        case 'p':
          // Polygon tool (segmentation shortcut)
          e.preventDefault();
          setTool('polygon');
          break;
        case 'delete':
        case 'backspace':
          // Delete selected annotation
          if (selectedAnnotationId) {
            e.preventDefault();
            confirm({
              title: '레이블 삭제',
              message: '선택한 레이블을 삭제하시겠습니까?',
              confirmText: '삭제',
              cancelText: '취소',
              onConfirm: async () => {
                try {
                  // Delete from backend first, then from store
                  await deleteAnnotationAPI(selectedAnnotationId);
                  deleteAnnotation(selectedAnnotationId);
                  toast.success('레이블을 삭제했습니다.');
                } catch (err) {
                  console.error('Failed to delete annotation:', err);
                  toast.error('레이블 삭제에 실패했습니다.');
                }
              },
            });
          }
          break;
        case 'escape':
          // Deselect annotation
          e.preventDefault();
          selectAnnotation(null);
          break;
        case '[':
          // Toggle left panel
          e.preventDefault();
          toggleLeftPanel();
          break;
        case ']':
          // Toggle right panel
          e.preventDefault();
          toggleRightPanel();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    tool,
    setTool,
    goToNextImage,
    goToPrevImage,
    selectedAnnotationId,
    selectedVertexIndex,
    deleteAnnotation,
    selectAnnotation,
    zoomIn,
    zoomOut,
    fitToScreen,
    undo,
    redo,
    history,
    canvas,
    setPan,
    toggleLeftPanel,
    toggleRightPanel,
    currentTask,
    annotations,
    copyAnnotation,
    pasteAnnotation,
  ]);
}
