// ストレージ抽象化層 — 原則①「データの所有権は各サロンオーナーへ」
// fs:     オーナーのGoogle Drive同期フォルダ等のローカルディレクトリ
// github: オーナー自身のGitHubリポジトリ（Contents API・オーナーのPATで認証）
import fs from 'node:fs/promises';
import path from 'node:path';

export function createFsBackend({ dataDir }) {
  const abs = p => path.join(dataDir, p);
  return {
    kind: 'fs',
    async readFile(p) {
      try { return await fs.readFile(abs(p), 'utf8'); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async writeFile(p, content, opts = {}) {
      await fs.mkdir(path.dirname(abs(p)), { recursive: true });
      if (opts.binaryBase64) {
        await fs.writeFile(abs(p), Buffer.from(content, 'base64'));
      } else {
        const tmp = abs(p) + '.tmp';
        await fs.writeFile(tmp, content, 'utf8');
        await fs.rename(tmp, abs(p));
      }
    },
    async listDir(p) {
      try { return (await fs.readdir(abs(p))).filter(n => !n.startsWith('.')); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
  };
}

export function createGithubBackend({ token, repo, branch = 'main', apiBase = 'https://api.github.com', fetchImpl = fetch }) {
  if (!token || !repo) throw new Error('GitHubバックエンドには GITHUB_TOKEN と GITHUB_REPO が必要です');
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hair-ravel-line-connect',
  };
  const url = p => `${apiBase}/repos/${repo}/contents/${encPath(p)}?ref=${encodeURIComponent(branch)}`;

  async function getRaw(p) {
    const res = await fetchImpl(url(p), { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub読み取り失敗 ${res.status}: ${p}`);
    return res.json();
  }
  return {
    kind: 'github',
    async readFile(p) {
      const json = await getRaw(p);
      if (!json || Array.isArray(json)) return null;
      return Buffer.from(json.content, 'base64').toString('utf8');
    },
    async writeFile(p, content, opts = {}) {
      const existing = await getRaw(p);
      const body = {
        message: `hair-ravel: update ${p}`,
        content: opts.binaryBase64 ? content : Buffer.from(content, 'utf8').toString('base64'),
        branch,
      };
      if (existing && existing.sha) body.sha = existing.sha;
      const res = await fetchImpl(`${apiBase}/repos/${repo}/contents/${encPath(p)}`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`GitHub書き込み失敗 ${res.status}: ${p}`);
    },
    async listDir(p) {
      const json = await getRaw(p);
      if (!json) return [];
      if (!Array.isArray(json)) return [];
      return json.filter(e => e.type === 'file').map(e => e.name);
    },
  };
}

export function createBackend(cfg) {
  if (cfg.storage === 'github') {
    return createGithubBackend({
      token: cfg.githubToken, repo: cfg.githubRepo, branch: cfg.githubBranch || 'main',
      apiBase: cfg.githubApiBase, fetchImpl: cfg.fetchImpl,
    });
  }
  return createFsBackend({ dataDir: cfg.dataDir });
}
