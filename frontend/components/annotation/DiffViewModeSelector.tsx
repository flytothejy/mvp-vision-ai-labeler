/**
 * Diff View Mode Selector Component
 *
 * Positioned at bottom-left canvas, above zoom controls
 * Shows Overlay / Side-by-Side / Animation view options
 */

'use client';

import { useAnnotationStore } from '@/lib/stores/annotationStore';

export default function DiffViewModeSelector() {
  const { diffMode, setDiffViewMode } = useAnnotationStore();

  if (!diffMode.enabled) return null;

  const viewModes = [
    { id: 'overlay', label: 'Overlay', icon: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v7a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v7a1 1 0 01-1 1h-4a1 1 0 01-1-1V5z' },
    { id: 'side-by-side', label: 'Side-by-Side', icon: 'M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4m0-16v16m0-16h6a2 2 0 012 2v12a2 2 0 01-2 2h-6' },
    { id: 'animation', label: 'Animation', icon: 'M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  ] as const;

  return (
    <div className="absolute bottom-24 left-4 z-10 bg-gray-100 dark:bg-gray-800 rounded-lg p-2 shadow-lg">
      <div className="flex flex-col gap-2">
        {viewModes.map((mode) => (
          <button
            key={mode.id}
            onClick={() => setDiffViewMode(mode.id as 'overlay' | 'side-by-side' | 'animation')}
            className={`p-2 rounded transition-colors ${
              diffMode.viewMode === mode.id
                ? 'bg-violet-600 text-white'
                : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
            title={mode.label}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" clipRule="evenodd" d={mode.icon} />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
