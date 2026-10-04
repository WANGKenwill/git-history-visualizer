export function normalizedTimeline(commits, duration) {
  // Square-root gap compression preserves ordering without long inactive stretches.
  const weights = commits.map((commit, index) => index ? Math.sqrt(Math.max(0, Date.parse(commit.authoredAt) - Date.parse(commits[index - 1].authoredAt))) : 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  return commits.map((commit, index) => {
    elapsed += weights[index];
    const fraction = total ? elapsed / total : index / Math.max(1, commits.length - 1);
    return { ...commit, at: 0.6 + fraction * Math.max(0, duration - 3.6) };
  });
}
