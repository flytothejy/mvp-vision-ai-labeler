/**
 * Version History Modal Component
 *
 * Displays list of published versions with download functionality
 */

'use client';

import { useState, useEffect } from 'react';
import { listVersions, downloadExport, type Version } from '@/lib/api/export';
import { useAnnotationStore } from '@/lib/stores/annotationStore';

interface VersionHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
}

export default function VersionHistoryModal({ isOpen, onClose, projectId }: VersionHistoryModalProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [selectedVersions, setSelectedVersions] = useState<Set<number>>(new Set());
  const { enterDiffMode } = useAnnotationStore();

  useEffect(() => {
    if (isOpen && projectId) {
      fetchVersions();
    }
  }, [isOpen, projectId]);

  const fetchVersions = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await listVersions(projectId);
      // Filter to only show published versions, sorted by creation date (newest first)
      const publishedVersions = result.versions
        .filter((v) => v.version_type === 'published')
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setVersions(publishedVersions);
    } catch (err: any) {
      setError(err.message || 'Failed to load versions');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownload = (version: Version) => {
    if (!version.download_url) {
      alert('Download URL not available for this version');
      return;
    }

    const format = version.export_format || 'dice';
    const filename = format === 'dice'
      ? `${version.version_number}_annotations.json`
      : format === 'coco'
      ? `${version.version_number}_annotations_coco.json`
      : `${version.version_number}_annotations_yolo.zip`;

    downloadExport(version.download_url, filename);
  };

  const formatDate = (dateString: string) => {
    // Backend stores in UTC without 'Z', so we need to add it for correct parsing
    const utcDateString = dateString.endsWith('Z') ? dateString : dateString + 'Z';
    const date = new Date(utcDateString);
    return date.toLocaleString('ko-KR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Seoul',
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
          // Remove the first selected version
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
      // Enter diff mode
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

      // Close modal and reset state
      setCompareMode(false);
      setSelectedVersions(new Set());
      onClose();
    } catch (error) {
      console.error('Failed to enter diff mode:', error);
      setError('Failed to compare versions. Please try again.');
    }
  };

  const handleToggleCompareMode = () => {
    setCompareMode(!compareMode);
    setSelectedVersions(new Set());
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Version History</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {compareMode ? 'Select two versions to compare' : 'Published versions with annotations'}
              </p>
            </div>
            {!isLoading && versions.length >= 2 && (
              <button
                onClick={handleToggleCompareMode}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors flex items-center gap-2 ${
                  compareMode
                    ? 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white hover:bg-gray-300 dark:hover:bg-gray-600'
                    : 'bg-violet-600 hover:bg-violet-700 text-white'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                {compareMode ? 'Cancel' : 'Compare Versions'}
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <svg className="animate-spin h-8 w-8 text-violet-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
          ) : error ? (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
            </div>
          ) : versions.length === 0 ? (
            <div className="text-center py-12">
              <svg className="w-16 h-16 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
              <p className="text-gray-600 dark:text-gray-400">No published versions yet</p>
              <p className="text-sm text-gray-500 dark:text-gray-500 mt-2">
                Click "Publish Version" to create your first version
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {versions.map((version) => {
                const isSelected = selectedVersions.has(version.id);
                return (
                  <div
                    key={version.id}
                    onClick={() => compareMode && handleVersionSelect(version.id)}
                    className={`p-4 border rounded-lg transition-colors ${
                      isSelected
                        ? 'border-violet-600 dark:border-violet-500 bg-violet-50 dark:bg-violet-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                    } ${compareMode ? 'cursor-pointer' : ''}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3 flex-1">
                        {/* Checkbox for compare mode */}
                        {compareMode && (
                          <div className="pt-1">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleVersionSelect(version.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="w-4 h-4 text-violet-600 border-gray-300 rounded focus:ring-violet-500"
                            />
                          </div>
                        )}
                        <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                          {version.version_number}
                        </h3>
                        <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-500/20 text-green-600 dark:text-green-400">
                          Published
                        </span>
                        {version.export_format && (
                          <span className="px-2 py-0.5 text-xs font-medium rounded bg-violet-500/20 text-violet-600 dark:text-violet-400 uppercase">
                            {version.export_format}
                          </span>
                        )}
                      </div>

                      <div className="mt-2 space-y-1 text-sm">
                        <div className="flex items-center gap-4 text-gray-600 dark:text-gray-400">
                          <span>
                            <svg className="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            {formatDate(version.created_at)}
                          </span>
                          {version.created_by_name && (
                            <span>
                              <svg className="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                              </svg>
                              {version.created_by_name}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-4 text-gray-600 dark:text-gray-400">
                          {version.image_count !== undefined && (
                            <span>Images: {version.image_count}</span>
                          )}
                          {version.annotation_count !== undefined && (
                            <span>Annotations: {version.annotation_count}</span>
                          )}
                        </div>

                        {version.description && (
                          <p className="text-gray-700 dark:text-gray-300 mt-2">
                            {version.description}
                          </p>
                        )}
                      </div>
                        </div>
                      </div>

                      {/* Download button - hide in compare mode */}
                      {!compareMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownload(version);
                          }}
                          disabled={!version.download_url}
                          className="ml-4 px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:bg-gray-400 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
                          title={version.download_url ? 'Download this version' : 'Download URL expired'}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          Download
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center gap-3">
          {/* Left side: comparison info */}
          <div className="flex-1">
            {compareMode && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {selectedVersions.size === 0 && 'Select two versions to compare'}
                {selectedVersions.size === 1 && 'Select one more version'}
                {selectedVersions.size === 2 && 'Ready to compare'}
              </p>
            )}
          </div>

          {/* Right side: action buttons */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-white rounded-lg transition-colors"
            >
              Close
            </button>
            {!isLoading && versions.length > 0 && !compareMode && (
              <button
                onClick={fetchVersions}
                className="px-4 py-2 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 rounded-lg transition-colors"
              >
                Refresh
              </button>
            )}
            {compareMode && selectedVersions.size === 2 && (
              <button
                onClick={handleStartCompare}
                className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Start Comparison
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
