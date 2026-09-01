const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = process.env.VIDEO_WORKFLOW_ROOT || 'D:\\抖音信息视频工作流';
const inputFolder = path.join(projectRoot, '01_待入库');
const catalogPath = path.join(projectRoot, '02_素材库', '视频素材库.json');
const localFfprobePath = path.join(projectRoot, 'tools', 'ffmpeg', 'ffprobe.exe');
const ffprobePath = fs.existsSync(localFfprobePath) ? localFfprobePath : 'ffprobe';
const supportedExtensions = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm']);

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseFps(value) {
  if (!value) return 0;
  if (value.includes('/')) {
    const [numerator, denominator] = value.split('/').map(Number);
    return denominator ? numerator / denominator : 0;
  }
  return Number(value) || 0;
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function scanFile(fileName) {
  const filePath = path.join(inputFolder, fileName);
  const extension = path.extname(fileName).toLowerCase();
  const stat = fs.statSync(filePath);
  const base = {
    asset_id: '',
    file_name: fileName,
    file_path: filePath,
    extension,
    size_mb: round(stat.size / 1024 / 1024),
    duration_seconds: 0,
    width: 0,
    height: 0,
    fps: 0,
    codec: '',
    sha256: '',
    status: '读取失败',
    imported_at: new Date().toISOString(),
    error: '',
  };

  try {
    const rawProbe = execFileSync(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', filePath],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const probe = JSON.parse(rawProbe);
    const videoStream = (probe.streams || []).find((stream) => stream.codec_type === 'video');
    if (!videoStream) throw new Error('No video stream was found');

    const sha256 = await hashFile(filePath);
    const duration = Number(probe.format?.duration ?? videoStream.duration ?? 0);
    return {
      ...base,
      asset_id: `VID-${sha256.slice(0, 12).toUpperCase()}`,
      duration_seconds: round(duration),
      width: Number(videoStream.width) || 0,
      height: Number(videoStream.height) || 0,
      fps: round(parseFps(String(videoStream.avg_frame_rate || '0'))),
      codec: String(videoStream.codec_name || ''),
      sha256,
      status: '待剪辑',
      error: '',
    };
  } catch (error) {
    return { ...base, error: error.message || String(error) };
  }
}

async function main() {
  if (!fs.existsSync(inputFolder)) throw new Error(`Input folder does not exist: ${inputFolder}`);

  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  const fileNames = fs.readdirSync(inputFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  const scannedItems = [];
  for (const fileName of fileNames) scannedItems.push(await scanFile(fileName));

  let catalogItems = [];
  if (fs.existsSync(catalogPath)) {
    const existingText = fs.readFileSync(catalogPath, 'utf8').trim();
    if (existingText) catalogItems = JSON.parse(existingText);
  }

  const findExistingIndex = (item) => catalogItems.findIndex((row) =>
    (item.sha256 && row.sha256 === item.sha256) || row.file_path === item.file_path,
  );

  const runResults = [];
  for (const item of scannedItems) {
    const index = findExistingIndex(item);
    if (index < 0) {
      catalogItems.push({ ...item });
      runResults.push({ ...item, sync_action: '新增' });
      continue;
    }

    const existing = catalogItems[index];
    if (item.status === '读取失败' && existing.status !== '读取失败') {
      runResults.push({ ...item, imported_at: existing.imported_at, sync_action: '读取失败' });
      continue;
    }

    const stored = {
      ...item,
      imported_at: existing.imported_at || item.imported_at,
      status: existing.status && existing.status !== '读取失败' ? existing.status : item.status,
      error: item.status === '读取失败' ? item.error : '',
    };
    catalogItems[index] = stored;
    runResults.push({ ...stored, sync_action: '已存在' });
  }

  const cleanCatalog = catalogItems.map(({ sync_action: _ignored, ...item }) => item);
  fs.writeFileSync(catalogPath, `${JSON.stringify(cleanCatalog, null, 2)}\n`, 'utf8');
  process.stdout.write(JSON.stringify(runResults));
}

main().catch((error) => {
  process.stderr.write(error.stack || error.message || String(error));
  process.exit(1);
});
