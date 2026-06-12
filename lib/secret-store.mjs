// 秘密情報ストア — トークンは「オーナーの環境」から一歩も出さない
// 優先順位：環境変数（オーナーのVercel等） ＞ AES-256-GCM暗号化ローカルファイル
// 暗号化ファイルはデータフォルダ（Drive/GitHub同期対象）の外（既定 ~/.hair-ravel/）に置く。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const FILE_NAME = 'settings.enc.json';

const FIELDS = [
  'salonName', 'ownerName', 'accessToken', 'channelSecret', 'ownerUserId',
  'cronSecret', 'adminToken', 'reviewUrl', 'baseUrl', 'bookingUrl', 'careUrl', 'adminUrl',
  'storage', 'dataDir', 'githubToken', 'githubRepo', 'githubBranch',
];

export function encryptJson(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return {
    v: 1, alg: 'aes-256-gcm', kdf: 'scrypt',
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}

export function decryptJson(blob, passphrase) {
  const key = crypto.scryptSync(passphrase, Buffer.from(blob.salt, 'base64'), 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

export function createSecretStore({ configDir, passphrase } = {}) {
  const dir = configDir || process.env.HR_CONFIG_DIR || path.join(os.homedir(), '.hair-ravel');
  const file = path.join(dir, FILE_NAME);
  const pass = passphrase ?? process.env.HR_STORE_KEY ?? '';

  async function readFileSettings() {
    if (!pass) return {};
    try {
      const blob = JSON.parse(await fs.readFile(file, 'utf8'));
      return decryptJson(blob, pass);
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw new Error('暗号化設定の読み込みに失敗しました（HR_STORE_KEYが違う可能性）');
    }
  }

  async function saveFileSettings(settings) {
    if (!pass) throw new Error('暗号化保存には HR_STORE_KEY（合言葉）を設定して起動してください');
    const clean = {};
    for (const k of FIELDS) if (settings[k] !== undefined && settings[k] !== '') clean[k] = String(settings[k]);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(encryptJson(clean, pass), null, 2), { mode: 0o600 });
    return clean;
  }

  function envSettings(env = process.env) {
    const pick = (k, d = '') => env[k] ?? d;
    const out = {
      salonName: pick('SALON_NAME'), ownerName: pick('OWNER_NAME'),
      accessToken: pick('LINE_CHANNEL_ACCESS_TOKEN'), channelSecret: pick('LINE_CHANNEL_SECRET'),
      ownerUserId: pick('LINE_OWNER_USER_ID'), cronSecret: pick('CRON_SECRET'),
      adminToken: pick('ADMIN_TOKEN'), reviewUrl: pick('GOOGLE_MAPS_REVIEW_URL'),
      baseUrl: pick('BASE_URL'), bookingUrl: pick('BOOKING_URL'), careUrl: pick('CARE_URL'), adminUrl: pick('ADMIN_URL'),
      storage: pick('HR_STORAGE'), dataDir: pick('DATA_DIR'),
      githubToken: pick('GITHUB_TOKEN'), githubRepo: pick('GITHUB_REPO'), githubBranch: pick('GITHUB_BRANCH'),
    };
    for (const k of Object.keys(out)) if (out[k] === '') delete out[k];
    return out;
  }

  // env > 暗号化ファイル の順でマージした実効設定を返す
  async function load(env = process.env) {
    const fileSettings = await readFileSettings();
    const merged = { ...fileSettings, ...envSettings(env) };
    merged._sources = {
      file: Object.keys(fileSettings),
      env: Object.keys(envSettings(env)),
    };
    return merged;
  }

  // UI表示用：秘密はマスク。フル値は絶対に返さない。
  function masked(settings) {
    const last4 = v => (v ? `••••${String(v).slice(-4)}` : '');
    return {
      salonName: settings.salonName || '',
      ownerName: settings.ownerName || '',
      accessToken: last4(settings.accessToken),
      channelSecret: settings.channelSecret ? '設定済み' : '',
      ownerUserId: last4(settings.ownerUserId),
      cronSecret: settings.cronSecret ? '設定済み' : '',
      reviewUrl: settings.reviewUrl || '',
      baseUrl: settings.baseUrl || '',
      bookingUrl: settings.bookingUrl || '',
      careUrl: settings.careUrl || '',
      adminUrl: settings.adminUrl || '',
      storage: settings.storage || 'fs',
      dataDir: settings.dataDir || '',
      githubRepo: settings.githubRepo || '',
      githubToken: last4(settings.githubToken),
      sources: settings._sources || { file: [], env: [] },
      canSaveFile: !!pass,
    };
  }

  return { load, saveFileSettings, masked, file };
}
