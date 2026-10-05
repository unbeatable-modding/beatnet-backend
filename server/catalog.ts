import { basename } from "node:path";
import type { Metadata, Project } from "./registry";
import { extractAudio, previewClip } from "./preview";
import { prepareCover } from "./cover";
import type { Submissions } from "./submissions";
import type { Uploads } from "./uploads";

function describeBeatmap(project: Project) {
  const info = project.chart_info ? JSON.parse(project.chart_info) as Metadata["chartInfo"] : undefined;
  return {
    id: project.id,
    title: project.title,
    artist: project.artist,
    creator: project.creator,
    submitter: project.submitter,
    difficulties: project.difficulties ? JSON.parse(project.difficulties) as string[] : [],
    levels: info?.levels ?? {},
    difficultyLabels: info?.labels ?? {},
    rating: project.rating ?? 0,
    ratingCount: project.rating_count ?? 0,
    cover: info?.cover ? `/api/beatmaps/${project.id}/revisions/${project.current_revision_id}/cover` : null,
    preview: info?.preview ? {
      url: `/api/beatmaps/${project.id}/revisions/${project.current_revision_id}/preview`,
      start: info.preview.start,
    } : null,
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

  list(query: string, offset: number, limit: number, sorting = "title", difficulties: string[] = []) {
    const result = this.submissions.registry.list(query, offset, limit, "", sorting, difficulties);
    return { items: result.items.map(describeBeatmap), total: result.total, offset, limit };
  }

  ratings(ids: string[]) {
    return { items: ids.map(id => {
      const project = this.submissions.registry.get(id);
      return { id, average: project?.rating ?? 0, count: project?.rating_count ?? 0 };
    }) };
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
    if (this.submissions.registry.get(projectId)?.current_revision_id !== revisionId) {
      return null;
    }
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

  async audio(projectId: string, revisionId: string) {
    const project = this.submissions.registry.get(projectId);
    if (!project || project.current_revision_id !== revisionId || !project.chart_info) {
      return null;
    }
    const info = JSON.parse(project.chart_info) as Metadata["chartInfo"];
    if (!info?.preview) {
      return null;
    }
    const stored = this.download(projectId, revisionId, info.preview.fileId);
    const audio = stored ? await extractAudio(stored.path, stored.sha256, info.preview.path) : null;
    return audio ? previewClip(audio, info.preview.start) : null;
  }

  async cover(projectId: string, revisionId: string) {
    const revision = this.submissions.registry.byRevision(revisionId);
    if (!revision || revision.project_id !== projectId) {
      return null;
    }
    const project = this.submissions.registry.get(projectId);
    if (project?.current_revision_id !== revisionId || !project.chart_info) {
      return null;
    }
    const info = JSON.parse(project.chart_info) as Metadata["chartInfo"];
    if (!info?.cover) {
      return null;
    }
    const stored = this.download(projectId, revisionId, info.cover.fileId);
    return stored ? prepareCover(stored.path, stored.sha256, info.cover.path) : null;
  }
}
