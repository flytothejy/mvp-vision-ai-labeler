/**
 * Annotation Versions Component
 *
 * Displays published versions with detail modal
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAnnotationStore } from '@/lib/stores/annotationStore';
import { listVersions, type Version } from '@/lib/api/export';
import VersionHistoryModal from './VersionHistoryModal';

export default function AnnotationHistory() {
  const [isCollapsed, setIsCollapsed] = useState(false); // Default: expanded
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [selectedVersions, setSelectedVersions] = useState<Set<number>>(new Set());
  const { project, images, currentTask, enterDiffMode } = useAnnotationStore(); // Phase 2.9

  // Load published versions
  const loadVersions = useCallback(async () => {
    if (!project?.id) return;

    try {
      setLoading(true);
      const result = await listVersions(project.id);

      // Phase 2.9 + Phase 11: Filter versions by current task type
      // Include both published and working versions for diff comparison
      let relevantVersions = result.versions
        .filter((v) => v.version_type === 'published' || v.version_type === 'working')
        .filter((v) => {
          // Show version if: no task selected OR task matches
          // Note: versions without task_type are legacy and should only show when no task is selected
          const shouldShow = !currentTask || v.task_type === currentTask;
          return shouldShow;
        })
        .sort((a, b) => {
          // Sort: Working first, then by date
          if (a.version_type === 'working') return -1;
          if (b.version_type === 'working') return 1;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });

      // Phase 11: Add virtual "Working" version if not exists
      const hasWorking = relevantVersions.some((v) => v.version_type === 'working');
      if (!hasWorking && currentTask) {
        // Create virtual Working version
        const workingVersion: Version = {
          id: -1, // Virtual ID
          project_id: project.id,
          task_type: currentTask,
          version_number: 'Working',
          version_type: 'working',
          created_at: new Date().toISOString(),
          created_by: 0,
          description: 'Current working annotations',
          annotation_count: 0,
          image_count: images.length,
          export_format: 'dice',
          export_path: '',
          download_url: null,
          download_url_expires_at: null,
        };
        relevantVersions = [workingVersion, ...relevantVersions];
      }

      // Show latest 4 (including Working if exists)
      setVersions(relevantVersions.slice(0, 4));
    } catch (error) {
      console.error('Failed to load versions:', error);
    } finally {
      setLoading(false);
    }
  }, [project?.id, currentTask]); // Phase 2.9: Re-load when task changes

  // Initial load
  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  // Listen for version published event
  useEffect(() => {
    const handleVersionPublished = () => {
      loadVersions();
    };

    window.addEventListener('versionPublished', handleVersionPublished);
    return () => window.removeEventListener('versionPublished', handleVersionPublished);
  }, [loadVersions]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleVersionSelect = (versionId: number) => {
    setSelectedVersions((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(versionId)) {
        newSet.delete(versionId);
      } else {
        // Only allow 2 versions to be selected
        if (newSet.size >= 2) {
          const firstId = Array.from(newSet)[0];
          newSet.delete(firstId);
        }
        newSet.add(versionId);
      }
      return newSet;
    });
  };

  const handleStartCompare = async () => {
    if (selectedVersions.size !== 2) return;

    const [versionAId, versionBId] = Array.from(selectedVersions);
    const versionA = versions.find((v) => v.id === versionAId);
    const versionB = versions.find((v) => v.id === versionBId);

    if (!versionA || !versionB) return;

    try {
      await enterDiffMode(
        {
          id: versionA.id,
          version_number: versionA.version_number,
          version_type: versionA.version_type,
        },
        {
          id: versionB.id,
          version_number: versionB.version_number,
          version_type: versionB.version_type,
        }
      );
      // Reset state
      setCompareMode(false);
      setSelectedVersions(new Set());
    } catch (error) {
      console.error('Failed to enter diff mode:', error);
    }
  };

  const handleToggleCompareMode = () => {
    setCompareMode(!compareMode);
    setSelectedVersions(new Set());
  };

  return (
    <div className="border-t border-b border-gray-300 dark:border-gray-700">
      {/* Header */}
      <div
        className="p-3 flex items-center justify-between cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700/50 transition-colors"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-400">
            Annotation Versions
          </h4>
          {/* Phase 2.9: Show current task badge */}
          {currentTask && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-600 dark:text-violet-400 capitalize">
              {currentTask}
            </span>
          )}
          <span className="text-[10px] text-gray-500 dark:text-gray-600">
            ({versions.length})
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Quick Compare button - only show if 2+ versions */}
          {versions.length >= 2 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleToggleCompareMode();
              }}
              className={`px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                compareMode
                  ? 'bg-violet-500 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
              }`}
              title="Quick Compare"
            >
              {compareMode ? 'Cancel' : 'Compare'}
            </button>
          )}
          {/* Expand icon for detailed modal */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsModalOpen(true);
            }}
            className="p-1 hover:bg-gray-300 dark:hover:bg-gray-600 rounded transition-colors"
            title="View detailed version history"
          >
            <svg
              className="w-3.5 h-3.5 text-gray-600 dark:text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
          {/* Collapse icon */}
          <svg
            className={`w-3.5 h-3.5 text-gray-600 dark:text-gray-400 transition-transform ${
              isCollapsed ? '' : 'rotate-180'
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Version List */}
      {!isCollapsed && (
        <div className="max-h-48 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-xs text-gray-500 dark:text-gray-500">
              Loading versions...
            </div>
          ) : versions.length === 0 ? (
            <div className="p-4 text-center text-xs text-gray-500 dark:text-gray-500">
              {/* Phase 2.9 + Phase 11: Task-specific empty message */}
              {currentTask ? `No ${currentTask} versions yet` : 'No versions yet'}
            </div>
          ) : (
            <>
              <div className="divide-y divide-gray-300 dark:divide-gray-700/50">
                {versions.map((version) => {
                  const isSelected = selectedVersions.has(version.id);
                  return (
                    <div
                      key={version.id}
                      className={`p-2 cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-violet-100 dark:bg-violet-900/30'
                          : 'hover:bg-gray-200 dark:hover:bg-gray-700'
                      }`}
                      onClick={() => compareMode ? handleVersionSelect(version.id) : setIsModalOpen(true)}
                      title={`${version.version_number} - ${version.image_count || 0}/${images.length} images${version.created_by_name ? ` by ${version.created_by_name}` : ''}${version.description ? ` - ${version.description}` : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          {compareMode && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleVersionSelect(version.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="w-3 h-3 text-violet-600 border-gray-300 rounded focus:ring-violet-500 flex-shrink-0"
                            />
                          )}
                          <span className="text-xs font-medium text-violet-600 dark:text-violet-400 flex-shrink-0">
                            {version.version_number}
                            {version.version_type === 'working' && (
                              <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-600 dark:text-blue-400">
                                WIP
                              </span>
                            )}
                          </span>
                          <span className="text-[10px] text-gray-600 dark:text-gray-500 flex-shrink-0">
                            {formatDate(version.created_at)}
                          </span>
                          {version.created_by_name && (
                            <span className="text-[10px] text-gray-500 dark:text-gray-600 flex-shrink-0 truncate max-w-[80px]" title={version.created_by_name}>
                              {version.created_by_name}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-600 dark:text-gray-500 flex-shrink-0">
                          {version.image_count || 0}/{images.length}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Start Compare button */}
              {compareMode && selectedVersions.size === 2 && (
                <div className="p-2 border-t border-gray-300 dark:border-gray-700">
                  <button
                    onClick={handleStartCompare}
                    className="w-full px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-xs font-medium rounded transition-colors"
                  >
                    Start Comparison
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Version History Modal */}
      {project && (
        <VersionHistoryModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          projectId={project.id}
        />
      )}
    </div>
  );
}
