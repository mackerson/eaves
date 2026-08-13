import { getFileRepository, getProjectRepository } from '../repositories';

/**
 * Every directory a project's tools may reach, in one place.
 *
 * There used to be two answers to this question that quietly disagreed.
 * `builtinTools.getProjectDirectories()` read the `files` table; `buildToolset`
 * built its own list for the auto-injected MCP filesystem servers. Neither knew
 * about `projects.directory` — the folder the app creates for every project at
 * `userData/projects/<slug>-<hash>/` — so a fresh project had a real directory
 * on disk that no tool could see, and answered `write_file` with "No project
 * directories configured."
 *
 * Two kinds of root, and the distinction is the point:
 *
 *  - `attached` — folders the user picked (`files:add`). Somebody's actual work.
 *  - `workspace` — the project's own directory. Nobody chose its contents, so
 *    it is the safe place for an agent to put scratch files, generated output
 *    and script results. It is always available, which is what makes the file
 *    tools usable on a project with nothing attached yet.
 *
 * Order is load-bearing: the first root is where relative paths resolve and
 * where `bash` runs. Attached folders come first (oldest first, so attaching a
 * new one never silently repoints existing relative paths), and the workspace
 * is the fallback when nothing is attached.
 */
export interface ProjectRoot {
  name: string;
  path: string;
  kind: 'attached' | 'workspace';
}

export function getProjectRoots(projectId: string | null): ProjectRoot[] {
  if (!projectId) return [];

  const attached: ProjectRoot[] = getFileRepository()
    .getByProjectId(projectId)
    .filter(f => f.type === 'directory')
    // getByProjectId sorts newest-first for the files UI; oldest-first is what
    // keeps roots[0] — the relative-path base — stable as folders are added.
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(d => ({ name: d.name, path: d.path, kind: 'attached' as const }));

  const project = getProjectRepository().getById(projectId);
  // `directory` is backfilled for every project at repository construction, so
  // it is effectively always set; the guard is for a row mid-migration.
  const workspace: ProjectRoot[] = project?.directory
    ? [{ name: 'workspace', path: project.directory, kind: 'workspace' as const }]
    : [];

  return [...attached, ...workspace];
}
