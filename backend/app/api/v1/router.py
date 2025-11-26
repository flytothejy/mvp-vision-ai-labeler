"""API v1 router."""

from fastapi import APIRouter

from app.api.v1.endpoints import auth, datasets, projects, annotations, export, image_locks, project_permissions, users, invitations, version_diff

api_router = APIRouter()

# Include all endpoint routers
api_router.include_router(auth.router, prefix="/auth", tags=["Authentication"])
api_router.include_router(datasets.router, prefix="/datasets", tags=["Datasets"])
api_router.include_router(projects.router, prefix="/projects", tags=["Projects"])
api_router.include_router(annotations.router, prefix="/annotations", tags=["Annotations"])
api_router.include_router(export.router, tags=["Export"])
api_router.include_router(image_locks.router, prefix="/image-locks", tags=["Image Locks"])
api_router.include_router(project_permissions.router, prefix="/projects", tags=["Project Permissions"])
api_router.include_router(users.router, prefix="/users", tags=["Users"])
api_router.include_router(invitations.router, prefix="/invitations", tags=["Invitations"])
api_router.include_router(version_diff.router, prefix="/version-diff", tags=["Version Diff"])
