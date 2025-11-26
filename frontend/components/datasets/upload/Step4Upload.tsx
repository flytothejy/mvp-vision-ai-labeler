'use client';

/**
 * Step 4: Upload Execution with Batch Support
 *
 * - Execute actual upload with progress
 * - Support batch upload for large file sets (>500 files)
 * - Show file-by-file status
 * - Display summary on completion
 */

import { useState, useEffect } from 'react';
import { addImagesToDataset } from '@/lib/api/datasets';
import type { FileMappingInfo } from './MultiStepUploadModal';
import { toast } from '@/lib/stores/toastStore';

interface Step4UploadProps {
  datasetId: string;
  fileMappings: FileMappingInfo[];
  targetFolder: string;
  duplicateResolutions: Record<string, 'overwrite' | 'skip' | 'rename'>;
  annotationFile: File | null;
  onComplete: () => void;
}

type UploadStatus = 'pending' | 'uploading' | 'success' | 'skipped' | 'error';

interface FileStatus {
  path: string;
  status: UploadStatus;
  message?: string;
}

// Batch upload configuration
const BATCH_SIZE = 500; // Upload 500 files at a time

export default function Step4Upload({
  datasetId,
  fileMappings,
  targetFolder,
  duplicateResolutions,
  annotationFile,
  onComplete,
}: Step4UploadProps) {
  const [uploading, setUploading] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const [summary, setSummary] = useState({
    total: 0,
    uploaded: 0,
    skipped: 0,
    errors: 0,
    annotations: 0,
  });

  useEffect(() => {
    startUpload();
  }, []);

  const startUpload = async () => {
    setUploading(true);

    // Prepare files to upload
    const filesToUpload: File[] = [];
    const initialStatuses: FileStatus[] = [];

    fileMappings.forEach(mapping => {
      const resolution = duplicateResolutions[mapping.finalPath];

      if (resolution === 'skip') {
        // Skip this file
        initialStatuses.push({
          path: mapping.finalPath,
          status: 'skipped',
          message: '사용자가 스킵',
        });
      } else if (resolution === 'rename') {
        // Rename and upload
        const ext = mapping.file.name.match(/\.[^.]+$/)?.[0] || '';
        const newName = mapping.file.name.replace(/(\.[^.]+)$/, '_new$1');
        const renamedFile = new File([mapping.file], newName, { type: mapping.file.type });
        filesToUpload.push(renamedFile);
        initialStatuses.push({
          path: mapping.finalPath.replace(/(\.[^.]+)$/, '_new$1'),
          status: 'pending',
        });
      } else {
        // Overwrite (or new file) - Use finalPath as filename to respect folder options
        const fileWithCorrectPath = new File([mapping.file], mapping.finalPath, {
          type: mapping.file.type,
          lastModified: mapping.file.lastModified
        });
        filesToUpload.push(fileWithCorrectPath);
        initialStatuses.push({
          path: mapping.finalPath,
          status: 'pending',
        });
      }
    });

    setFileStatuses(initialStatuses);

    // Calculate number of batches
    const numBatches = Math.ceil(filesToUpload.length / BATCH_SIZE);
    setTotalBatches(numBatches);

    let totalUploaded = 0;
    let totalErrors = 0;
    let annotationsImported = 0;

    try {
      // Upload in batches
      for (let i = 0; i < numBatches; i++) {
        setCurrentBatch(i + 1);

        const start = i * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, filesToUpload.length);
        const batchFiles = filesToUpload.slice(start, end);

        // Only upload annotation file on the last batch
        const batchAnnotationFile = (i === numBatches - 1) ? annotationFile : null;

        try {
          // Mark batch files as uploading (use exact indices for this batch)
          setFileStatuses(prev => {
            const updated = [...prev];
            for (let j = start; j < end; j++) {
              if (updated[j] && updated[j].status === 'pending') {
                updated[j] = { ...updated[j], status: 'uploading' };
              }
            }
            return updated;
          });

          // Upload batch
          const result = await addImagesToDataset(
            datasetId,
            batchFiles,
            batchAnnotationFile || undefined,
            (batchProgress) => {
              // Calculate overall progress
              // Progress = (completed batches * 100 + current batch progress) / total batches
              const completedBatches = i;
              const overallProgress = Math.round(
                ((completedBatches * 100 + batchProgress) / numBatches)
              );
              setProgress(overallProgress);
            }
          );

          // Mark batch files as success (use exact indices for this batch)
          setFileStatuses(prev => {
            const updated = [...prev];
            for (let j = start; j < end; j++) {
              if (updated[j]) {
                updated[j] = { ...updated[j], status: 'success' };
              }
            }
            return updated;
          });

          totalUploaded += batchFiles.length;

          if (batchAnnotationFile) {
            annotationsImported = result.annotations_imported || 0;
          }

        } catch (error) {
          console.error(`Batch ${i + 1}/${numBatches} failed:`, error);

          // Mark batch files as error (use exact indices for this batch)
          setFileStatuses(prev => {
            const updated = [...prev];
            for (let j = start; j < end; j++) {
              if (updated[j]) {
                updated[j] = {
                  ...updated[j],
                  status: 'error',
                  message: error instanceof Error ? error.message : '업로드 실패'
                };
              }
            }
            return updated;
          });

          totalErrors += batchFiles.length;

          // Don't stop - continue with next batch
          toast.error(`배치 ${i + 1}/${numBatches} 업로드 실패. 다음 배치 계속 진행...`);
        }
      }

      // Calculate final summary
      const skipped = initialStatuses.filter(f => f.status === 'skipped').length;

      setSummary({
        total: fileMappings.length,
        uploaded: totalUploaded,
        skipped,
        errors: totalErrors,
        annotations: annotationsImported,
      });

      setCompleted(true);
      setProgress(100);

      if (totalErrors === 0) {
        toast.success(`✅ ${totalUploaded}개 파일이 업로드되었습니다`);
      } else {
        toast.warning(`⚠️ ${totalUploaded}개 성공, ${totalErrors}개 실패`);
      }

    } catch (error) {
      console.error('Upload process failed:', error);

      const uploaded = fileStatuses.filter(f => f.status === 'success').length;
      const skipped = fileStatuses.filter(f => f.status === 'skipped').length;
      const errors = fileStatuses.filter(f => f.status === 'error' || f.status === 'pending').length;

      setSummary({
        total: fileMappings.length,
        uploaded,
        skipped,
        errors,
        annotations: 0,
      });

      setCompleted(true);
      toast.error('업로드 중 오류가 발생했습니다');
    } finally {
      setUploading(false);
    }
  };

  const getStatusIcon = (status: UploadStatus) => {
    switch (status) {
      case 'success':
        return (
          <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        );
      case 'uploading':
        return (
          <svg className="w-4 h-4 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        );
      case 'skipped':
        return (
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        );
      case 'error':
        return (
          <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        );
      default:
        return (
          <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
    }
  };

  if (!completed) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-3">🚀 업로드 중...</h3>

          {/* Batch info */}
          {totalBatches > 1 && (
            <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center justify-between text-sm">
                <span className="text-blue-700 font-medium">
                  배치 업로드 진행 중
                </span>
                <span className="text-blue-600">
                  배치 {currentBatch} / {totalBatches}
                </span>
              </div>
              <p className="text-xs text-blue-600 mt-1">
                대용량 업로드를 위해 {BATCH_SIZE}개씩 분할 전송 중입니다
              </p>
            </div>
          )}

          {/* Progress bar */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">전체 진행률</span>
              <span className="text-sm text-gray-600">{progress}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className="bg-violet-600 h-3 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* File list */}
          <div className="border border-gray-200 rounded-lg bg-gray-50 p-4 max-h-96 overflow-y-auto">
            <div className="space-y-2">
              {fileStatuses.map((file, index) => (
                <div
                  key={index}
                  className={`flex items-center justify-between p-2 rounded text-sm ${
                    file.status === 'uploading' ? 'bg-blue-50' : ''
                  }`}
                >
                  <div className="flex items-center space-x-2 flex-1 min-w-0">
                    {getStatusIcon(file.status)}
                    <span className="truncate text-gray-700">{file.path}</span>
                  </div>
                  {file.message && (
                    <span className="text-xs text-gray-500 ml-2">{file.message}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="text-center py-6">
        <div className={`inline-flex items-center justify-center w-16 h-16 rounded-full mb-4 ${
          summary.errors > 0 ? 'bg-yellow-100' : 'bg-green-100'
        }`}>
          <svg className={`w-8 h-8 ${
            summary.errors > 0 ? 'text-yellow-600' : 'text-green-600'
          }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          {summary.errors > 0 ? '⚠️ 업로드 완료 (일부 실패)' : '✅ 업로드 완료!'}
        </h3>
        <p className="text-sm text-gray-600">
          {summary.errors > 0
            ? `${summary.uploaded}개 성공, ${summary.errors}개 실패`
            : '파일 업로드가 성공적으로 완료되었습니다'
          }
        </p>
      </div>

      {/* Summary */}
      <div className="border border-gray-200 rounded-lg p-6 bg-gray-50">
        <h4 className="text-sm font-semibold text-gray-900 mb-4">📊 요약</h4>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white rounded-lg p-4 border border-gray-200">
            <div className="text-sm text-gray-600 mb-1">업로드됨</div>
            <div className="text-2xl font-bold text-green-600">{summary.uploaded}</div>
          </div>
          <div className="bg-white rounded-lg p-4 border border-gray-200">
            <div className="text-sm text-gray-600 mb-1">스킵됨</div>
            <div className="text-2xl font-bold text-gray-600">{summary.skipped}</div>
          </div>
          {summary.annotations > 0 && (
            <div className="bg-white rounded-lg p-4 border border-gray-200 col-span-2">
              <div className="text-sm text-gray-600 mb-1">어노테이션 등록</div>
              <div className="text-2xl font-bold text-violet-600">{summary.annotations}</div>
            </div>
          )}
          {summary.errors > 0 && (
            <div className="bg-white rounded-lg p-4 border border-red-200 col-span-2">
              <div className="text-sm text-gray-600 mb-1">오류</div>
              <div className="text-2xl font-bold text-red-600">{summary.errors}</div>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-center pt-4 border-t border-gray-200">
        <button
          onClick={onComplete}
          className="px-6 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700"
        >
          완료
        </button>
      </div>
    </div>
  );
}
