import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentRuntime } from '@felan-ai/agent-core';

const REMOVE_JOB = `
import os, stat, sys
root, job = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fds = []
try:
    current = os.open('/', flags)
    fds.append(current)
    for part in root.split('/'):
        if not part:
            continue
        current = os.open(part, flags, dir_fd=current)
        fds.append(current)
    parts = job.split('/')
    for part in parts[:-1]:
        current = os.open(part, flags, dir_fd=current)
        fds.append(current)
    parent = current
    current = os.open(parts[-1], flags, dir_fd=parent)
    fds.append(current)
    allowed = {'info.json', 'completion.json', 'meta.json', 'status.json',
               'output.log', 'command.sh', 'runner.sh', 'runner-heartbeat'}
    names = []
    with os.scandir(current) as entries:
        for entry in entries:
            if len(names) == 32:
                sys.exit(1)
            temporary = entry.name.endswith('.tmp') and entry.name.startswith(('completion.json.', 'runner-heartbeat.'))
            if entry.name not in allowed and not temporary:
                sys.exit(1)
            if not stat.S_ISREG(os.stat(entry.name, dir_fd=current, follow_symlinks=False).st_mode):
                sys.exit(1)
            names.append(entry.name)
    for name in names:
        os.unlink(name, dir_fd=current)
    os.rmdir(parts[-1], dir_fd=parent)
finally:
    for fd in reversed(fds):
        os.close(fd)
`;

export async function removeRetainedJob(runtime: AgentRuntime, root: string, jobDir: string): Promise<boolean> {
  const path = relative(resolve(root), resolve(jobDir));
  if (!path || path.startsWith('..') || isAbsolute(path) || !/^background-bash\/[a-z0-9._-]+\/jobs\/bash-\d{14}-[a-f0-9]{6}$/u.test(path.split(sep).join('/'))) return false;
  try {
    const result = await runtime.exec('python3', ['-c', REMOVE_JOB, resolve(root), path.split(sep).join('/')]);
    return result.code === 0 && !result.killed;
  } catch { return false; }
}
