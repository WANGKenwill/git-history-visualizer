[中文](README.md) | English

# Git History Visualizer

Turn Git commit history into animated contribution visuals, with local interactive playback and 1080p MP4 export.

![DeepSeek Harness commit history visualization](docs/assets/dsh-demo.png)

The bundled [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) demo shows 12,469 non-merge commits and 68 email identities over 60 seconds. Outer circles represent cumulative changes; inner cores represent lines retained at the final HEAD. Final-frame numbers show “changes (retained lines).” **Change volume does not measure contribution quality.**

[Watch the 60-second demo](https://github.com/WANGKenwill/git-history-visualizer/releases/download/v0.1.0/dsh-demo.mp4)

## Quick start

Install **Node.js 22+ (24 recommended) and Git**, then run:

```bash
git clone https://github.com/WANGKenwill/git-history-visualizer.git
cd git-history-visualizer
npm run setup -- --start
```

Initial setup requires internet access to install npm dependencies and Chromium. On macOS, missing FFmpeg is installed through an existing Homebrew installation. On other systems, install FFmpeg and ffprobe yourself; Linux also needs Chromium system libraries. Platform verification: macOS arm64 has been tested manually; Ubuntu installation and tests pass in CI; Windows has not been verified.

<details>
<summary>Ubuntu / Debian dependencies (run from the source directory)</summary>

Install Node.js 22+ first, then run:

```bash
sudo apt-get update && sudo apt-get install -y git ffmpeg
npm ci
npx playwright install --with-deps chromium
npm run studio
```

Chromium system dependencies use the [official Playwright installation command](https://playwright.dev/docs/browsers#install-system-dependencies).

</details>

For subsequent launches:

```bash
npm run studio
```

Open http://127.0.0.1:4173 to play the demo. On macOS, the browser opens automatically; append `-- --no-open` to disable this. Use HTTP rather than opening the HTML file directly. Set `GIT_HISTORY_PORT` to use a different port.

## Usage

Choose 中文 / English in the top-right corner. The first visit follows your browser language; later visits remember your choice. The interface, preview and new video exports share one language. Switching does not require another analysis.

1. Select a local Git repository, or enter a remote GitLab URL and click **Read branches**. Provide a token for private repositories when needed.
2. Choose a branch, duration, time zone, and author limit, then click **Generate visualization**. By default, 16 authors are displayed; the rest are grouped as **Other**.
3. Play, scrub, or enter fullscreen. Click an author circle for statistics, or click **Export MP4** to save a video.

Generation displays analysis stages and file progress for retained lines, reusing the retention cache when available. Only one analysis runs at a time. Remote downloads, updates, and full-history fetches time out after five minutes with retry guidance. Failed analysis preserves the previous visualization.

Identical names with different email addresses remain separate by default. You can link accounts manually and regenerate. Dense commit activity may briefly obscure text; pause or scrub to inspect it.

Regular repositories, Git worktrees, and bare repositories are supported. For shallow clones, click **补全历史（联网）** (“Fetch full history — requires internet”) or run `git fetch --unshallow` manually. Analysis never fetches missing history automatically. Remote analysis downloads and caches the full history of the selected branch, which may require substantial disk space.

Videos are saved to `exports/` as 1920×1080, 30 fps, H.264 MP4 files. Preview and export share the same drawing function, and the final frame shows complete cumulative totals. Only one export runs at a time.

Expand **Add soundtrack** to choose local audio (maximum 100 MB; MP3, WAV, M4A and other formats readable by local FFmpeg). The filename and duration are shown. Shorter audio loops; longer audio is trimmed; the MP4 includes an AAC track. Without audio, exports remain silent. **Match video duration to audio** (15–180 seconds) immediately adjusts the current preview and export timeline without reanalyzing the repository. Audio is for export only; preview remains silent. Files are temporarily stored locally and cleaned up when removed, replaced, or the server exits. Select audio again after refreshing the page.

## What the statistics mean

- Only non-merge commits reachable from the selected branch HEAD are counted, deduplicated by SHA. Change volume = added lines + deleted lines.
- Binary files do not contribute line counts. Lockfiles, vendor directories, node_modules, build outputs, and coverage directories are excluded.
- Authors are identified by lowercase email addresses. Squashed commits are attributed to the author recorded in Git; original contributors are not inferred.
- History is ordered by author timestamp, with idle periods compressed. The clock ring shows commit times in the configured time zone, which may differ from actual working times.
- Retained lines are calculated with Git blame at the final HEAD, including blank lines and comments. They do not represent the repository's size at each historical moment or contribution quality. Cross-file copy detection and whitespace-ignore options are not enabled.
- Each original line is counted once per commit and original file. Duplicate copies, merge conflict resolutions, and other lines not attributable to contribution events are reported as unmapped. Total retained lines = mapped contribution lines + unmapped lines. The animation shows mapped lines; the page overview shows the full total.

## Data and privacy

The server listens only on `127.0.0.1` and serves the required pages, scripts, and exported videos. Tokens are passed through the Git subprocess environment, not written to files or credential helpers. Use the token field rather than embedding credentials in URLs.

Analysis results and repository caches are stored in `.cache/`, without modifying the bundled demo. Startup loads the most recent analysis when available. Results include author names, emails, commit subjects, and repository paths. Review them before sharing, and do not commit private data or credentials.

After setup, local analysis, preview, and export work offline. Remote branch queries, cloning, and updates require internet access. Normal startup and export never install dependencies automatically.

The bundled demo is pinned to DSH's `master` commit [`5badb150`](https://github.com/deepseek-ai/deepseek-harness/commit/5badb15009ae1756c3afe0ae0cef1faafc290ccc). It retains public author information, contains no repository source files or local machine paths, and does not update automatically.

## Development and contributions

```bash
npm run check       # Statistics, UI, and video export tests
npm run licenses    # Update third-party license notices
```

Exports render each frame at a fixed timestamp and send raw Canvas pixels to FFmpeg over a local connection, avoiding PNG compression, Base64 transfer, and PNG decoding. Browser Content Security Policy restricts resources and connections to the same origin; export does not access external networks.

Tests require Chromium and FFmpeg to be installed. CLI usage is also available:

```bash
npm run analyze -- /absolute/path/to/repository main
npm run render -- .cache/current/manifest.json exports/history.mp4
```

- Submit small fixes as PRs; discuss larger features in an Issue first. Include environment details, reproduction steps, and expected results in bug reports, preferably using a synthetic repository.
- Add regression tests for statistics or timeline changes, keeping preview and export consistent. For export changes, also verify a short video's decoding, duration, and final-frame totals.
- Update license notices when dependencies change. Use Chinese commit messages, describe validation in PRs, and include screenshots for visual changes. Do not commit caches, private history, credentials, or local machine paths.
- Keep both READMEs in sync when usage or behavior changes.

Report security vulnerabilities privately to [kenwillwang@gmail.com](mailto:kenwillwang@gmail.com). Do not include tokens, private repository data, or exploit details in public Issues.

## License

[MIT License](LICENSE), copyright WANGKenwill. npm dependency notices are in [Third-party licenses](LICENSES_THIRD_PARTY.md). Git, Chromium, and FFmpeg are installed separately and are not distributed with this project's source.
