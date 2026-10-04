import { AppError } from '../src/i18n.js';
import { execFileSync } from 'node:child_process';

export const SHALLOW_MESSAGE = '此仓库为浅克隆，提交历史不完整，无法准确统计累计变更和最终留存。请在仓库中执行 git fetch --unshallow 补全历史，然后重新读取分支。';

export function repositoryInfo(repo) {
  const git = flag => execFileSync('git', ['-C', repo, 'rev-parse', flag], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const bare = git('--is-bare-repository') === 'true';
    return { bare, path: git(bare ? '--absolute-git-dir' : '--show-toplevel'), shallow: git('--is-shallow-repository') === 'true' };
  } catch { throw new AppError('error.notRepository', {repo}); }
}

export function requireFullHistory(repo) {
  const info = repositoryInfo(repo);
  if (info.shallow) throw new AppError('error.shallow');
  return info;
}
