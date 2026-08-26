/**
 * Cross-platform process lookup for the dev scripts.
 *
 * Shared by clean-dev.js and reset-dev-env.js, which both need the same
 * question answered — "what is still running out of *this* checkout?" — and
 * must both get it right: reset-dev-env deletes the database immediately
 * after, so a lookup that silently finds nothing is how you delete a live
 * app's data out from under it.
 *
 * Git Bash is not a substitute for this. MSYS ships no pgrep, its `ps`
 * rejects `-o`, and it reports only MSYS processes — never electron.exe — so
 * every shell-based version of this check answered "nothing is running" on
 * Windows no matter what was running.
 */

const { spawnSync } = require('child_process');

/**
 * Every process we can see, as `{ pid, ppid, cmd }`.
 *
 * Narrowed to node/electron images on Windows: Win32_Process is the only
 * place a full command line lives, and serialising every process on the
 * machine to JSON to find two of them is a waste.
 */
function listProcesses() {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='electron.exe' OR Name='node.exe'\" | " +
          'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    if (result.status !== 0 || !result.stdout || !result.stdout.trim()) return [];
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    // ConvertTo-Json emits a bare object, not an array, for a single match.
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map(r => ({
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId),
      cmd: r.CommandLine || '',
    }));
  }

  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
}

/**
 * PIDs of the calling process and everything that spawned it.
 *
 * `yarn dev:clean` runs these scripts from inside the very process tree they
 * are about to clean up, so without this they kill their own parent.
 */
function ownProcessTree(processes) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const own = new Set([process.pid]);
  let cursor = process.ppid;
  while (cursor && cursor !== 0 && !own.has(cursor)) {
    own.add(cursor);
    cursor = byPid.get(cursor) ? byPid.get(cursor).ppid : undefined;
  }
  return own;
}

/**
 * Dev processes (Electron or Vite) belonging to `repoRoot`.
 *
 * Matched on the checkout path rather than the binary name: a developer's
 * other Electron app — or a second clone of this one — runs the same
 * electron binary, and killing that would be far worse than a leaked child.
 */
function devProcessesForRepo(repoRoot, { includeOwnTree = false } = {}) {
  const processes = listProcesses();
  const own = includeOwnTree ? new Set() : ownProcessTree(processes);
  // Windows paths are case-insensitive, and the case a process reports is not
  // necessarily the case we resolved.
  const needle = process.platform === 'win32' ? repoRoot.toLowerCase() : repoRoot;
  return processes.filter(p => {
    if (own.has(p.pid)) return false;
    const cmd = process.platform === 'win32' ? p.cmd.toLowerCase() : p.cmd;
    return cmd.includes(needle) && /electron|vite/i.test(cmd);
  });
}

module.exports = { listProcesses, ownProcessTree, devProcessesForRepo };
