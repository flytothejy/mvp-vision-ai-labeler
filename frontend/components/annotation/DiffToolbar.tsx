/**
 * Diff Toolbar Component
 *
 * Replaces normal Canvas toolbar when in diff mode
 * Shows version selectors, view mode, and color legend
 */

'use client';

import { useAnnotationStore } from '@/lib/stores/annotationStore';
import { listVersions, type Version } from '@/lib/api/export';
import { useEffect, useState } from 'react';

export default function DiffToolbar() {
  const {
    diffMode,
    setDiffViewMode,
    switchDiffVersion,
    project,
    currentTask,
  } = useAnnotationStore();

  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);

  // Load available versions
  useEffect(() => {
    if (!project?.id || !diffMode.enabled) return;

    const loadVersions = async () => {
      try {
        setLoading(true);
        const result = await listVersions(project.id);

        // Filter to current task type (published + working versions)
        let taskVersions = result.versions
          .filter((v) => v.version_type === 'published' || v.version_type === 'working')
          .filter((v) => !currentTask || v.task_type === currentTask)
          .sort((a, b) => {
            // Working first, then by date
            if (a.version_type === 'working') return -1;
            if (b.version_type === 'working') return 1;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          });

        // Add virtual Working version if not exists
        const hasWorking = taskVersions.some((v) => v.version_type === 'working');
        if (!hasWorking && currentTask) {
          const workingVersion: Version = {
            id: -1,
            project_id: project.id,
            task_type: currentTask,
            version_number: 'Working',
            version_type: 'working',
            created_at: new Date().toISOString(),
            created_by: 0,
            description: 'Current working annotations',
            annotation_count: 0,
            image_count: 0,
            export_format: 'dice',
            export_path: '',
            download_url: null,
            download_url_expires_at: null,
          };
          taskVersions = [workingVersion, ...taskVersions];
        }

        setVersions(taskVersions);
      } catch (error) {
        console.error('Failed to load versions for diff toolbar:', error);
      } finally {
        setLoading(false);
      }
    };

    loadVersions();
  }, [project?.id, currentTask, diffMode.enabled]);

  if (!diffMode.enabled) return null;

  const handleVersionChange = async (side: 'A' | 'B', versionId: number) => {
    const version = versions.find(v => v.id === versionId);
    if (!version) return;

    await switchDiffVersion(side, {
      id: version.id,
      version_number: version.version_number,
      version_type: version.version_type,
    });
  };

  return (
    <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-gray-100 dark:bg-gray-800 rounded-lg p-2 flex items-center gap-4 shadow-lg z-10">
      {/* Version A Selector */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Version A:</span>
        <select
          value={diffMode.versionA?.id || ''}
          onChange={(e) => handleVersionChange('A', Number(e.target.value))}
          disabled={loading}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.version_number} ({version.version_type})
            </option>
          ))}
        </select>
      </div>

      {/* Comparison Arrow */}
      <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
      </svg>

      {/* Version B Selector */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Version B:</span>
        <select
          value={diffMode.versionB?.id || ''}
          onChange={(e) => handleVersionChange('B', Number(e.target.value))}
          disabled={loading}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.version_number} ({version.version_type})
            </option>
          ))}
        </select>
      </div>

      {/* Color Legend */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-red-500" />
          <span className="text-xs text-gray-700 dark:text-gray-300">Removed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-green-500" />
          <span className="text-xs text-gray-700 dark:text-gray-300">Added</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-yellow-500" />
          <span className="text-xs text-gray-700 dark:text-gray-300">Modified</span>
        </div>
      </div>
    </div>
  );
}
