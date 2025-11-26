'use client';

/**
 * Dashboard Page
 *
 * 사이드바 + 데이터셋 상세 정보 표시
 */

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/context';
import { listDatasets, updateDataset } from '@/lib/api/datasets';
import { getProjectForDataset, getDatasetImages, getDatasetSize, type DatasetImage, type DatasetSize } from '@/lib/api/datasets';
import { getProjectHistory, type AnnotationHistory } from '@/lib/api/annotations';
import { getProjectStats, type ProjectStats } from '@/lib/api/projects';
import { listPermissions, inviteUser, updateUserRole, removeUser, type Permission } from '@/lib/api/permissions';
import type { Dataset, Project } from '@/lib/types';
import { toast } from '@/lib/stores/toastStore';
import Sidebar from '@/components/Sidebar';
import DeleteDatasetModal from '@/components/datasets/DeleteDatasetModal';
import DatasetMembersAvatars from '@/components/datasets/DatasetMembersAvatars';
import InviteDialog from '@/components/datasets/InviteDialog';
import InvitationsPanel from '@/components/invitations/InvitationsPanel';
import CreateDatasetModal from '@/components/datasets/CreateDatasetModal';
import MultiStepUploadModal from '@/components/datasets/upload/MultiStepUploadModal';

// Phase 2.9: Task progress stats
interface TaskStats {
  taskType: string;
  completedImages: number;
  totalImages: number;
  progressPercent: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading: authLoading, logout } = useAuth();

  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [selectedDataset, setSelectedDataset] = useState<Dataset | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [history, setHistory] = useState<AnnotationHistory[]>([]);
  const [images, setImages] = useState<DatasetImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectLoading, setProjectLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [error, setError] = useState('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [invitationsPanelOpen, setInvitationsPanelOpen] = useState(false); // Phase 8.2
  // Phase 2.9: Task-based stats
  const [taskStats, setTaskStats] = useState<TaskStats[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [primaryTask, setPrimaryTask] = useState<string | null>(null); // Task with most progress
  // Phase 2.10.2: Permission management
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [settingsDropdownOpen, setSettingsDropdownOpen] = useState(false);
  const settingsDropdownRef = useRef<HTMLDivElement>(null);
  // Phase 2.12: Dataset size
  const [datasetSize, setDatasetSize] = useState<DatasetSize | null>(null);

  useEffect(() => {
    // Redirect to login if not authenticated
    if (!authLoading && !user) {
      router.push('/login');
      return;
    }

    if (user) {
      fetchDatasets();
    }
  }, [user, authLoading, router]);

  // Close settings dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (settingsDropdownRef.current && !settingsDropdownRef.current.contains(event.target as Node)) {
        setSettingsDropdownOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchDatasets = async () => {
    try {
      const data = await listDatasets();
      setDatasets(data);
      setError('');

      // Performance: Don't auto-select - let user explicitly select dataset
      // This prevents loading 6+ APIs on initial page load
    } catch (err) {
      setError(err instanceof Error ? err.message : '데이터셋을 불러오는데 실패했습니다');
    } finally {
      setLoading(false);
    }
  };

  const handleDatasetSelect = async (datasetId: string) => {
    setSelectedDatasetId(datasetId);
    const dataset = datasets.find(d => d.id === datasetId);
    setSelectedDataset(dataset || null);

    // Performance: Parallelize independent API calls
    setPermissionsLoading(true);
    setProjectLoading(true);

    try {
      // Phase 1: Fetch permissions and project info in parallel
      const [perms, projectData] = await Promise.all([
        listPermissions(datasetId),
        getProjectForDataset(datasetId)
      ]);

      setPermissions(perms);
      setPermissionsLoading(false);
      setProject(projectData);

      // Phase 2: Parallelize all project-related API calls
      setHistoryLoading(true);
      setImagesLoading(true);

      const projectApiCalls = [
        // Stats (conditionally)
        projectData.task_types && projectData.task_types.length > 0
          ? getProjectStats(projectData.id).catch(err => {
              console.error('Failed to load project stats:', err);
              return null;
            })
          : Promise.resolve(null),
        // History
        getProjectHistory(projectData.id, 0, 10).catch(err => {
          console.error('Failed to fetch history:', err);
          return [];
        }),
        // Images
        getDatasetImages(datasetId, 8).catch(err => {
          console.error('Failed to fetch images:', err);
          return [];
        }),
        // Size
        getDatasetSize(datasetId).catch(err => {
          console.error('Failed to fetch dataset size:', err);
          return null;
        })
      ];

      const [statsResponse, historyData, imagesData, sizeData] = await Promise.all(projectApiCalls) as [
        ProjectStats | null,
        AnnotationHistory[],
        DatasetImage[],
        DatasetSize | null
      ];

      // Process stats
      if (statsResponse && projectData.task_types && projectData.task_types.length > 0) {
        const stats: TaskStats[] = [];
        let maxProgress = -1;
        let bestTask = projectData.task_types[0];

        for (const taskStat of (statsResponse as ProjectStats).task_stats) {
          const completedCount = taskStat.completed + taskStat.confirmed;
          const total = taskStat.total_images;
          const percent = total > 0 ? Math.round((completedCount / total) * 100) : 0;

          stats.push({
            taskType: taskStat.task_type,
            completedImages: completedCount,
            totalImages: total,
            progressPercent: percent,
          });

          if (completedCount > maxProgress) {
            maxProgress = completedCount;
            bestTask = taskStat.task_type;
          }
        }

        setTaskStats(stats);
        setSelectedTask(bestTask);
        setPrimaryTask(bestTask);
      } else {
        setTaskStats([]);
        setSelectedTask(null);
        setPrimaryTask(null);
      }

      // Set history
      setHistory(historyData);
      setHistoryLoading(false);

      // Set images
      console.log('Fetched images:', imagesData);
      setImages(imagesData);
      setImagesLoading(false);

      // Set size
      setDatasetSize(sizeData);
    } catch (err) {
      console.error('Failed to fetch project:', err);
      setProject(null);
      setHistory([]);
      setImages([]);
    } finally {
      setProjectLoading(false);
    }
  };

  const handleStartLabeling = () => {
    if (project) {
      router.push(`/annotate/${project.id}`);
    }
  };

  const handleDeleteSuccess = async () => {
    toast.success('데이터셋이 성공적으로 삭제되었습니다');

    // Refresh dataset list
    await fetchDatasets();
  };

  const handleEditDataset = async () => {
    // Refresh datasets to get updated data
    await fetchDatasets();

    // If we're viewing this dataset, refresh its details
    if (selectedDatasetId) {
      const updatedDataset = datasets.find(d => d.id === selectedDatasetId);
      if (updatedDataset) {
        // The dataset will be automatically updated in the UI via datasets state
      }
    }

    toast.success('데이터셋 정보가 업데이트되었습니다');
  };

  const handleUploadSuccess = async () => {
    // Refresh dataset info and images
    if (selectedDatasetId) {
      // Refresh datasets to update image counts
      await fetchDatasets();

      // Refresh images
      setImagesLoading(true);
      try {
        const imagesData = await getDatasetImages(selectedDatasetId, 8);
        setImages(imagesData);
      } catch (err) {
        console.error('Failed to refresh images:', err);
      } finally {
        setImagesLoading(false);
      }
    }
  };

  // Permission management handlers
  const handleInviteSuccess = () => {
    // Phase 8.2: Invitation sent successfully (user needs to accept)
    toast.success('Invitation sent successfully. The user will receive a notification to accept.');
  };

  const handleChangeRole = async (userId: number, newRole: 'admin' | 'reviewer' | 'annotator' | 'viewer') => {
    if (!selectedDatasetId) return;

    await updateUserRole(selectedDatasetId, userId, { role: newRole });

    // Refresh permissions
    const perms = await listPermissions(selectedDatasetId);
    setPermissions(perms);

    const roleNames = {
      admin: '관리자',
      reviewer: '리뷰어',
      annotator: '어노테이터',
      viewer: '뷰어',
    };
    toast.success(`역할이 ${roleNames[newRole]}로 변경되었습니다`);
  };

  const handleRemove = async (userId: number) => {
    if (!selectedDatasetId) return;

    await removeUser(selectedDatasetId, userId);

    // Refresh permissions
    const perms = await listPermissions(selectedDatasetId);
    setPermissions(perms);

    toast.success('멤버가 제거되었습니다');
  };

  // Check if current user is owner
  const isOwner = permissions.some(p => p.user_id === user?.id && p.role === 'owner');

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <svg className="animate-spin h-10 w-10 text-violet-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <p className="text-gray-600">로딩 중...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <Sidebar
        datasets={datasets}
        selectedDatasetId={selectedDatasetId}
        onDatasetSelect={handleDatasetSelect}
        onDatasetRefresh={fetchDatasets}
        onLogout={logout}
        onInvitationsClick={() => setInvitationsPanelOpen(true)}
      />

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-8">
          {error && (
            <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {!selectedDataset ? (
            <div className="text-center py-20">
              <svg className="w-16 h-16 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <h3 className="text-lg font-medium text-gray-900 mb-2">데이터셋을 선택해주세요</h3>
              <p className="text-sm text-gray-500">
                왼쪽 사이드바에서 작업할 데이터셋을 선택하세요
              </p>
            </div>
          ) : (
            <div>
              {/* Dataset Header */}
              <div className="mb-8">
                {/* Title Row with Settings and Members */}
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center space-x-3">
                    <h1 className="text-3xl font-bold text-gray-900">{selectedDataset.name}</h1>

                    {/* Settings Dropdown - Owner Only */}
                    {isOwner && (
                      <div className="relative" ref={settingsDropdownRef}>
                        <button
                          onClick={() => setSettingsDropdownOpen(!settingsDropdownOpen)}
                          className="p-2 rounded-lg hover:bg-gray-100 text-gray-600 hover:text-gray-900 transition-colors"
                          title="설정"
                        >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                      </button>

                      {/* Dropdown Menu */}
                      {settingsDropdownOpen && (
                        <div className="absolute top-12 left-0 z-50 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1">
                          <button
                            onClick={() => {
                              setSettingsDropdownOpen(false);
                              setEditModalOpen(true);
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center space-x-2"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                            <span>정보 수정</span>
                          </button>
                          <button
                            onClick={() => {
                              setSettingsDropdownOpen(false);
                              setDeleteModalOpen(true);
                            }}
                            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center space-x-2"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            <span>데이터셋 삭제</span>
                          </button>
                        </div>
                      )}
                      </div>
                    )}
                  </div>

                  {/* Members Avatars */}
                  {!permissionsLoading && permissions.length > 0 && user && (
                    <DatasetMembersAvatars
                      members={permissions}
                      currentUserId={user.id}
                      isOwner={isOwner}
                      onInvite={() => setInviteModalOpen(true)}
                      onChangeRole={handleChangeRole}
                      onRemove={handleRemove}
                    />
                  )}
                </div>

                {/* Description */}
                <p className="text-gray-600 mb-4">{selectedDataset.description || '설명 없음'}</p>

                {/* Info Tags and Start Button */}
                <div className="flex items-center justify-between">
                  <div className="flex flex-wrap gap-2">
                    {selectedDataset.format && (
                      <span className="px-3 py-1 text-sm rounded-lg bg-gray-100 text-gray-700">
                        {selectedDataset.format}
                      </span>
                    )}
                    {selectedDataset.source && (
                      <span className="px-3 py-1 text-sm rounded-lg bg-gray-100 text-gray-700">
                        {selectedDataset.source}
                      </span>
                    )}
                    {selectedDataset.visibility && (
                      <span className="px-3 py-1 text-sm rounded-lg bg-gray-100 text-gray-700">
                        {selectedDataset.visibility}
                      </span>
                    )}
                    {selectedDataset.labeled && (
                      <span className="px-3 py-1 text-sm rounded-lg bg-green-100 text-green-700">
                        라벨링 완료
                      </span>
                    )}
                  </div>

                  {/* Action Buttons */}
                  {project && (
                    <div className="flex items-center space-x-3">
                      {/* Upload Button - Owner Only */}
                      {isOwner && (
                        <button
                          onClick={() => setUploadModalOpen(true)}
                          className="px-4 py-2 rounded-lg border border-violet-600 text-violet-600 font-medium hover:bg-violet-50 transition-colors flex items-center space-x-2"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                          </svg>
                          <span>이미지 업로드</span>
                        </button>
                      )}
                      <button
                        onClick={handleStartLabeling}
                        className="px-6 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-purple-600 text-white font-medium hover:shadow-lg hover:shadow-violet-500/50 transition-all flex items-center space-x-2"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                        </svg>
                        <span>레이블링 시작</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Project Info */}
              {projectLoading ? (
                <div className="text-center py-8">
                  <svg className="animate-spin h-8 w-8 text-violet-600 mx-auto" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
              ) : project ? (
                <div className="space-y-6">
                  {/* Phase 2.9: Task Tabs */}
                  {taskStats.length > 1 && (
                    <div className="flex space-x-2">
                      {taskStats.map((stat) => (
                        <button
                          key={stat.taskType}
                          onClick={() => setSelectedTask(stat.taskType)}
                          className={`relative px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            selectedTask === stat.taskType
                              ? 'bg-violet-600 text-white'
                              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                        >
                          {/* Primary task star indicator */}
                          {stat.taskType === primaryTask && (
                            <svg
                              className={`absolute -top-0.5 -left-0.5 w-5 h-5 ${
                                selectedTask === stat.taskType ? 'text-yellow-300' : 'text-yellow-500'
                              }`}
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                            </svg>
                          )}
                          {stat.taskType === 'classification' && '분류'}
                          {stat.taskType === 'detection' && '객체 탐지'}
                          {stat.taskType === 'segmentation' && '세그멘테이션'}
                          {stat.taskType === 'geometry' && '기하'}
                          {!['classification', 'detection', 'segmentation', 'geometry'].includes(stat.taskType) && stat.taskType}
                          <span className="ml-2 text-xs opacity-75">({stat.progressPercent}%)</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Statistics Cards */}
                  {(() => {
                    const currentStats = taskStats.find(s => s.taskType === selectedTask) || {
                      completedImages: project.annotated_images,
                      totalImages: project.total_images,
                      progressPercent: project.total_images > 0
                        ? Math.round((project.annotated_images / project.total_images) * 100)
                        : 0
                    };

                    return (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                        <div className="bg-white rounded-xl p-6 border border-gray-200">
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-medium text-gray-500">전체 이미지</h3>
                            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                          </div>
                          <p className="text-3xl font-bold text-gray-900">{currentStats.totalImages}</p>
                        </div>

                        <div className="bg-white rounded-xl p-6 border border-gray-200">
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-medium text-gray-500">
                              완료된 이미지
                              {selectedTask && <span className="text-xs ml-1">({selectedTask})</span>}
                            </h3>
                            <svg className="w-5 h-5 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </div>
                          <p className="text-3xl font-bold text-violet-600">{currentStats.completedImages}</p>
                        </div>

                        <div className="bg-white rounded-xl p-6 border border-gray-200">
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-medium text-gray-500">진행률</h3>
                            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                            </svg>
                          </div>
                          <p className="text-3xl font-bold text-green-600">{currentStats.progressPercent}%</p>
                        </div>

                        {/* Phase 2.12: Dataset size card */}
                        <div className="bg-white rounded-xl p-6 border border-gray-200">
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-medium text-gray-500">데이터셋 용량</h3>
                            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                            </svg>
                          </div>
                          <p className="text-3xl font-bold text-blue-600">
                            {datasetSize
                              ? datasetSize.total_gb >= 1
                                ? `${datasetSize.total_gb.toFixed(2)} GB`
                                : `${datasetSize.total_mb.toFixed(1)} MB`
                              : '-'}
                          </p>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Two Column Layout: Activity History & Dataset Info */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Activity History */}
                    <div className="bg-white rounded-lg border border-gray-200">
                      <div className="px-4 py-3 border-b border-gray-200">
                        <h3 className="text-sm font-semibold text-gray-900">최근 활동</h3>
                        <p className="text-xs text-gray-500 mt-0.5">어노테이션 수정 이력</p>
                      </div>
                      <div className="p-4">
                        {historyLoading ? (
                          <div className="text-center py-8">
                            <svg className="animate-spin h-6 w-6 text-violet-600 mx-auto" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                          </div>
                        ) : !history || history.length === 0 ? (
                          <div className="text-center py-8 text-gray-500">
                            <p className="text-sm">아직 활동 이력이 없습니다</p>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            {history.slice(0, 5).map((item, idx) => (
                              <div key={idx} className="flex items-start space-x-3 text-sm">
                                <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                                  item.action === 'create' ? 'bg-green-500' :
                                  item.action === 'update' ? 'bg-blue-500' :
                                  item.action === 'delete' ? 'bg-red-500' : 'bg-gray-500'
                                }`} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-gray-900">
                                    <span className="font-medium">{item.changed_by_name || 'Unknown'}</span>
                                    {' '}
                                    <span className="text-gray-600">
                                      {item.action === 'create' && '생성'}
                                      {item.action === 'update' && '수정'}
                                      {item.action === 'delete' && '삭제'}
                                    </span>
                                  </p>
                                  <p className="text-xs text-gray-500">
                                    {(() => {
                                      // Backend stores in UTC without 'Z', so we need to add it for correct parsing
                                      const utcDateString = item.timestamp.endsWith('Z') ? item.timestamp : item.timestamp + 'Z';
                                      return new Date(utcDateString).toLocaleString('ko-KR', {
                                        year: 'numeric',
                                        month: '2-digit',
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        second: '2-digit',
                                        hour12: false,
                                        timeZone: 'Asia/Seoul',
                                      });
                                    })()}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Dataset Metadata */}
                    <div className="bg-white rounded-lg border border-gray-200">
                      <div className="px-4 py-3 border-b border-gray-200">
                        <h3 className="text-sm font-semibold text-gray-900">데이터셋 정보</h3>
                      </div>
                      <div className="p-4">
                        <dl className="space-y-3 text-sm">
                          <div>
                            <dt className="text-xs text-gray-500 mb-1">프로젝트 ID</dt>
                            <dd className="text-gray-900 font-mono text-xs">{project.id}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-gray-500 mb-1">데이터셋 ID</dt>
                            <dd className="text-gray-900 font-mono text-xs">{project.dataset_id}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-gray-500 mb-1">설명</dt>
                            <dd className="text-gray-900">{project.description || '설명 없음'}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-gray-500 mb-1">생성일</dt>
                            <dd className="text-gray-900">{(() => {
                              // Backend stores in UTC without 'Z', so we need to add it for correct parsing
                              const utcDateString = project.created_at.endsWith('Z') ? project.created_at : project.created_at + 'Z';
                              return new Date(utcDateString).toLocaleString('ko-KR', {
                                year: 'numeric',
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: false,
                                timeZone: 'Asia/Seoul',
                              });
                            })()}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-gray-500 mb-1">상태</dt>
                            <dd>
                              <span className={`px-2 py-1 rounded text-xs font-medium ${
                                project.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                              }`}>
                                {project.status === 'active' ? '활성' : project.status}
                              </span>
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </div>
                  </div>

                  {/* Image Thumbnails */}
                  <div className="bg-white rounded-lg border border-gray-200">
                    <div className="px-4 py-3 border-b border-gray-200">
                      <h3 className="text-sm font-semibold text-gray-900">이미지 미리보기</h3>
                    </div>
                    <div className="p-4">
                      {imagesLoading ? (
                        <div className="text-center py-8">
                          <svg className="animate-spin h-6 w-6 text-violet-600 mx-auto" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          <p className="text-xs text-gray-500 mt-2">이미지 로딩 중...</p>
                        </div>
                      ) : !images || images.length === 0 ? (
                        <div className="text-center py-8 text-gray-500">
                          <svg className="w-12 h-12 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          <p className="text-sm">이미지를 불러올 수 없습니다</p>
                        </div>
                      ) : (
                        <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
                          {images.slice(0, 8).map((image) => (
                            <div key={image.id} className="aspect-square relative rounded border border-gray-200 overflow-hidden hover:border-violet-400 transition-colors group">
                              <img
                                src={image.thumbnail_url || image.url}
                                alt={image.file_name}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  console.error('Image failed to load:', image.file_name, image.thumbnail_url || image.url);
                                  // If thumbnail fails, try original
                                  if (image.thumbnail_url && (e.target as HTMLImageElement).src !== image.url) {
                                    (e.target as HTMLImageElement).src = image.url;
                                  } else {
                                    (e.target as HTMLImageElement).style.display = 'none';
                                  }
                                }}
                                onLoad={() => console.log('Image loaded:', image.file_name)}
                              />
                              <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center">
                                <span className="text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity truncate px-2">
                                  {image.file_name}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Classes Table - Phase 2.9: Filter by selected task */}
                  {(() => {
                    // Get classes for selected task, or fallback to project.classes
                    const displayClasses = selectedTask && project.task_classes?.[selectedTask]
                      ? project.task_classes[selectedTask]
                      : project.classes;

                    if (!displayClasses || Object.keys(displayClasses).length === 0) {
                      return null;
                    }

                    return (
                      <div className="bg-white rounded-lg border border-gray-200">
                        <div className="px-4 py-3 border-b border-gray-200">
                          <h3 className="text-sm font-semibold text-gray-900">
                            클래스 목록
                            {selectedTask && <span className="text-xs font-normal text-gray-500 ml-2">({selectedTask})</span>}
                          </h3>
                          <p className="text-xs text-gray-500 mt-0.5">{Object.keys(displayClasses).length}개 클래스</p>
                        </div>
                        <div className="overflow-x-auto max-h-80 overflow-y-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                              <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">클래스명</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">색상</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">이미지</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">BBox</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                              {Object.entries(displayClasses).map(([classId, classInfo]: [string, any]) => (
                                <tr key={classId} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 text-gray-900">{classInfo.name}</td>
                                  <td className="px-4 py-2">
                                    <div className="flex items-center space-x-2">
                                      <div
                                        className="w-4 h-4 rounded border border-gray-300"
                                        style={{ backgroundColor: classInfo.color }}
                                      />
                                      <span className="text-xs text-gray-500">{classInfo.color}</span>
                                    </div>
                                  </td>
                                  <td className="px-4 py-2 text-right text-gray-600">{classInfo.image_count || 0}</td>
                                  <td className="px-4 py-2 text-right text-gray-600">{classInfo.bbox_count || 0}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
                  <svg className="w-12 h-12 text-gray-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-gray-600">프로젝트 정보를 불러올 수 없습니다</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Delete Dataset Modal */}
      {selectedDataset && (
        <DeleteDatasetModal
          datasetId={selectedDataset.id}
          datasetName={selectedDataset.name}
          isOpen={deleteModalOpen}
          onClose={() => setDeleteModalOpen(false)}
          onSuccess={handleDeleteSuccess}
        />
      )}

      {/* Invite Member Modal (Phase 8.2) */}
      {selectedDataset && (
        <InviteDialog
          isOpen={inviteModalOpen}
          onClose={() => setInviteModalOpen(false)}
          projectId={selectedDataset.id}
          onInviteSuccess={handleInviteSuccess}
        />
      )}

      {/* Edit Dataset Modal */}
      {selectedDataset && (
        <CreateDatasetModal
          mode="edit"
          isOpen={editModalOpen}
          onClose={() => setEditModalOpen(false)}
          onSuccess={handleEditDataset}
          dataset={selectedDataset}
        />
      )}

      {/* Upload Images Modal */}
      {selectedDataset && (
        <MultiStepUploadModal
          datasetId={selectedDataset.id}
          datasetName={selectedDataset.name}
          isOpen={uploadModalOpen}
          onClose={() => setUploadModalOpen(false)}
          onSuccess={handleUploadSuccess}
        />
      )}

      {/* Invitations Panel (Phase 8.2) */}
      <InvitationsPanel
        isOpen={invitationsPanelOpen}
        onClose={() => setInvitationsPanelOpen(false)}
      />
    </div>
  );
}
