/**
 * Diff Actions Component
 *
 * Exit button (top-left) and utility buttons (top-right) for diff mode
 */

'use client';

import { useAnnotationStore } from '@/lib/stores/annotationStore';
import { toast } from '@/lib/stores/toastStore';
import { confirm } from '@/lib/stores/confirmStore';

export default function DiffActions() {
  const { diffMode, exitDiffMode } = useAnnotationStore();

  if (!diffMode.enabled) return null;

  const handleExitDiff = async () => {
    try {
      console.log('[DiffActions] Exit button clicked, calling exitDiffMode...');
      await exitDiffMode();
      console.log('[DiffActions] exitDiffMode completed successfully');
      toast.success('Exited diff mode');
    } catch (error) {
      console.error('[DiffActions] Error in handleExitDiff:', error);
      toast.error('Failed to exit diff mode');
    }
  };

  const handleRevertChanges = async () => {
    // Only available when comparing Working version vs Published version
    const isWorkingVsPublished =
      (diffMode.versionA?.version_type === 'working' && diffMode.versionB?.version_type === 'published') ||
      (diffMode.versionA?.version_type === 'published' && diffMode.versionB?.version_type === 'working');

    if (!isWorkingVsPublished) {
      toast.error('Revert is only available when comparing Working vs Published versions');
      return;
    }

    const confirmed = await confirm({
      title: 'Revert to Published Version',
      message:
        'This will revert all working annotations to match the published version. This action cannot be undone. Continue?',
      confirmText: 'Revert',
      cancelText: 'Cancel',
    });

    if (confirmed) {
      // TODO: Implement revert API call
      toast.info('Revert functionality coming soon');
    }
  };

  const handleExportDiff = () => {
    if (!diffMode.diffData) {
      toast.error('No diff data available to export');
      return;
    }

    // Export diff data as JSON
    const blob = new Blob([JSON.stringify(diffMode.diffData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diff_${diffMode.versionA?.version_number}_vs_${diffMode.versionB?.version_number}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success('Diff data exported successfully');
  };

  // Check if revert should be enabled
  const isRevertEnabled =
    (diffMode.versionA?.version_type === 'working' && diffMode.versionB?.version_type === 'published') ||
    (diffMode.versionA?.version_type === 'published' && diffMode.versionB?.version_type === 'working');

  return (
    <>
      {/* Exit Button - Top Left */}
      <div className="absolute top-4 left-4 z-10">
        <button
          onClick={handleExitDiff}
          className="px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-900 dark:text-white rounded-lg shadow-lg transition-colors flex items-center gap-2"
          title="Exit Diff Mode (Esc)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span className="font-medium">Exit Diff</span>
        </button>
      </div>

      {/* Utility Buttons - Top Right */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        {/* Revert Button - Circular Icon */}
        <button
          onClick={handleRevertChanges}
          disabled={!isRevertEnabled}
          className={`w-10 h-10 rounded-full shadow-lg transition-colors flex items-center justify-center ${
            isRevertEnabled
              ? 'bg-orange-500 hover:bg-orange-600 text-white'
              : 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-600 cursor-not-allowed'
          }`}
          title={
            isRevertEnabled
              ? 'Revert Working to Published Version'
              : 'Only available when comparing Working vs Published'
          }
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
            />
          </svg>
        </button>

        {/* Export Button - Circular Icon */}
        <button
          onClick={handleExportDiff}
          className="w-10 h-10 rounded-full bg-violet-600 hover:bg-violet-700 text-white shadow-lg transition-colors flex items-center justify-center"
          title="Export Diff Data"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
        </button>
      </div>
    </>
  );
}
