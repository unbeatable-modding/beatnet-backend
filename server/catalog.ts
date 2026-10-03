import { basename } from "node:path";
import type { Project } from "./registry";
import type { Submissions } from "./submissions";
import type { Uploads } from "./uploads";

function describeBeatmap(project: Project) {
  return {
    id: project.id,
    title: project.title,
    artist: project.artist,
    creator: project.creator,
    submitter: project.submitter,
    revision: { id: project.current_revision_id, number: project.number },
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

function downloadUrl(projectId: string, revisionId: string, fileId: string) {
  return `/api/beatmaps/${projectId}/revisions/${revisionId}/files/${fileId}`;
}

export class Catalog {
  constructor(
    private readonly submissions: Submissions,
    private readonly uploads: Uploads,
  ) {}

  list(query: string, offset: number, limit: number) {
    const result = this.submissions.registry.list(query, offset, limit);
    return { items: result.items.map(describeBeatmap), total: result.total, offset, limit };
  }

  get(id: string) {
    const project = this.submissions.registry.get(id);
    if (!project) {
      return null;
    }
    const revision = this.submissions.registry.byRevision(project.current_revision_id);
    if (!revision) {
      return null;
    }
    return {
      ...describeBeatmap(project),
      revision: {
        id: revision.id,
        number: revision.number,
        changelog: revision.changelog,
        createdAt: revision.created_at,
      },
      files: this.submissions.files(revision.submission_id).map((file) => ({
        id: file.id,
        name: file.name,
        size: file.size,
        sha256: file.sha256,
        url: downloadUrl(id, revision.id, file.id),
      })),
    };
  }

  download(projectId: string, revisionId: string, fileId: string) {
    const revision = this.submissions.registry.byRevision(revisionId);
    if (!revision || revision.project_id !== projectId || this.submissions.get(revision.submission_id)?.status !== "accepted") {
      return null;
    }
    const file = this.submissions.files(revision.submission_id).find((file) => file.id === fileId);
    if (!file) {
      return null;
    }
    return { ...file, path: this.uploads.path(revision.submission_id, basename(file.storage_key)) };
  }
}
