import crypto from 'node:crypto';
import JSZip from 'jszip';
import { safePath } from './analyzer.ts';

const MAX_GITHUB_BYTES = 40 * 1024 * 1024;
const MAX_GITHUB_FILES = 3000;

export function parseGitHubRepoUrl(rawUrl: string): { owner: string; repo: string; branch?: string } {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('Enter a valid GitHub repository URL (for example, https://github.com/owner/repo).');
  }
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
    throw new Error('Only public github.com repository URLs are supported.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('URL must include both repository owner and name (github.com/owner/repo).');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Repository owner or name contains unsupported characters.');
  }
  let branch: string | undefined;
  if (parts[2] === 'tree' && parts[3]) {
    branch = parts.slice(3).join('/');
  }
  return { owner, repo, branch };
}

export async function fetchGitHubArchive(rawUrl: string): Promise<{
  buffer: Buffer;
  digest: string;
  fileCount: number;
  totalBytes: number;
  defaultName: string;
  sourceRef: string;
}> {
  const { owner, repo, branch } = parseGitHubRepoUrl(rawUrl);
  const refPath = branch ? `/${encodeURIComponent(branch)}` : '';
  const zipballUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball${refPath}`;

  const response = await fetch(zipballUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'CodeMind-AI-Workspace',
    },
    redirect: 'follow',
  });

  if (response.status === 404) {
    throw new Error(`Repository ${owner}/${repo} was not found or is private.`);
  }
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status} while downloading the repository archive.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_GITHUB_BYTES) {
    throw new Error('Repository archive exceeds the 40 MB intake limit.');
  }

  const rawZip = await JSZip.loadAsync(Buffer.from(arrayBuffer));
  const cleanZip = new JSZip();
  let fileCount = 0;
  let totalBytes = 0;

  for (const entry of Object.values(rawZip.files)) {
    if (entry.dir) continue;
    // Strip GitHub's outer "<owner>-<repo>-<sha>/" prefix
    const slashIdx = entry.name.indexOf('/');
    const stripped = slashIdx >= 0 ? entry.name.slice(slashIdx + 1) : entry.name;
    if (!stripped) continue;

    let normalized: string;
    try {
      normalized = safePath(stripped);
    } catch {
      continue;
    }

    if (fileCount >= MAX_GITHUB_FILES) break;
    const bytes = await entry.async('nodebuffer');
    cleanZip.file(normalized, bytes);
    fileCount += 1;
    totalBytes += bytes.length;
  }

  if (fileCount === 0) {
    throw new Error('The GitHub repository archive did not contain any readable files.');
  }

  const buffer = await cleanZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    buffer,
    digest,
    fileCount,
    totalBytes,
    defaultName: repo,
    sourceRef: `https://github.com/${owner}/${repo}${branch ? `/tree/${branch}` : ''}`,
  };
}
