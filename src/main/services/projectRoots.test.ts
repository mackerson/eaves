import { describe, it, expect, vi, beforeEach } from 'vitest';

const { filesRepo, projectRepo } = vi.hoisted(() => ({
  filesRepo: { getByProjectId: vi.fn() },
  projectRepo: { getById: vi.fn() },
}));

vi.mock('../repositories', () => ({
  getFileRepository: () => filesRepo,
  getProjectRepository: () => projectRepo,
}));

import { getProjectRoots } from './projectRoots';

describe('getProjectRoots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectRepo.getById.mockReturnValue({ id: 'p1', directory: '/data/projects/proj-abc12345' });
  });

  it('returns nothing without a project', () => {
    expect(getProjectRoots(null)).toEqual([]);
    expect(filesRepo.getByProjectId).not.toHaveBeenCalled();
  });

  it('gives a project with nothing attached a workspace to work in', () => {
    // The gap this closes: every project has had a directory on disk since it
    // was created, and no tool could see it — so a fresh project answered
    // write_file with "no project directories configured".
    filesRepo.getByProjectId.mockReturnValue([]);

    expect(getProjectRoots('p1')).toEqual([
      { name: 'workspace', path: '/data/projects/proj-abc12345', kind: 'workspace' },
    ]);
  });

  it('puts attached folders first, oldest first, workspace last', () => {
    filesRepo.getByProjectId.mockReturnValue([
      // Newest first, the order the files UI wants.
      { type: 'directory', name: 'newer', path: '/newer', createdAt: 30 },
      { type: 'directory', name: 'older', path: '/older', createdAt: 10 },
      { type: 'file', name: 'readme.md', path: '/older/readme.md', createdAt: 20 },
    ]);

    expect(getProjectRoots('p1')).toEqual([
      { name: 'older', path: '/older', kind: 'attached' },
      { name: 'newer', path: '/newer', kind: 'attached' },
      { name: 'workspace', path: '/data/projects/proj-abc12345', kind: 'workspace' },
    ]);
  });

  it('omits the workspace for a row that has no directory yet', () => {
    filesRepo.getByProjectId.mockReturnValue([]);
    projectRepo.getById.mockReturnValue({ id: 'p1', directory: null });
    expect(getProjectRoots('p1')).toEqual([]);

    projectRepo.getById.mockReturnValue(null);
    expect(getProjectRoots('p1')).toEqual([]);
  });
});
