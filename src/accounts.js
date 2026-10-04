import { AppError } from './i18n.js';
// Commit identities remain untouched; links affect presentation only.
export function accountLinks(authors, links = {}) {
  const ids = new Set(authors.map(a => a.id)), result = {};
  for (const id of ids) {
    let root = id; const seen = new Set();
    while (ids.has(links[root]) && links[root] !== root) {
      if (seen.has(root)) throw new AppError('error.accountCycle');
      seen.add(root); root = links[root];
    }
    if (root !== id) result[id] = root;
  }
  return result;
}

export function changeAccount(authors, links, id, action, target) {
  const next = accountLinks(authors, links), ids = new Set(authors.map(a => a.id));
  if (!ids.has(id)) throw new AppError('error.accountMissing');
  const root = next[id] || id;
  if (action === 'unlink') delete next[id];
  else {
    if (action === 'link' && (!ids.has(target) || next[target])) throw new AppError('error.accountPrimary');
    const main = action === 'primary' ? id : target;
    for (const member of ids) if ((next[member] || member) === root) next[member] = main;
    delete next[main];
  }
  return accountLinks(authors, next);
}

export function groupedAuthors(manifest) {
  const links = accountLinks(manifest.authors, manifest.settings?.accountLinks);
  const groups = new Map();
  for (const author of manifest.authors) {
    const id = links[author.id] || author.id;
    if (!groups.has(id)) groups.set(id, { ...manifest.authors.find(a => a.id === id), additions: 0, deletions: 0, churn: 0, retainedLines: 0, commitCount: 0, memberIds: [] });
    const group = groups.get(id); group.memberIds.push(author.id);
    for (const key of ['additions', 'deletions', 'churn', 'commitCount', 'retainedLines']) group[key] += author[key] || 0;
  }
  return { authors: [...groups.values()], links };
}
