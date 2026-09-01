const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = process.env.VIDEO_WORKFLOW_ROOT || 'D:\\抖音信息视频工作流';
const scriptsFolder = path.join(projectRoot, 'scripts');
const tasksFolder = path.join(projectRoot, '04_制作任务');
const videoSyncScript = path.join(scriptsFolder, 'sync_video_library.js');
const voiceoverSyncScript = path.join(scriptsFolder, 'sync_voiceover_tasks.js');
const eligibleStatuses = new Set(['等待处理', '文案已解析']);

function runJsonScript(scriptPath) {
  if (!fs.existsSync(scriptPath)) throw new Error(`缺少执行脚本：${scriptPath}`);
  const stdout = execFileSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, VIDEO_WORKFLOW_ROOT: projectRoot },
  }).trim();
  return stdout ? JSON.parse(stdout) : [];
}

function countActions(items) {
  const counts = {};
  for (const item of items) {
    const key = item.status === '读取失败' ? '读取失败' : (item.sync_action || item.status || '未知');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function loadTasks() {
  if (!fs.existsSync(tasksFolder)) return [];
  const tasks = [];
  for (const entry of fs.readdirSync(tasksFolder, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('TASK-')) continue;
    const taskPath = path.join(tasksFolder, entry.name, 'task.json');
    if (!fs.existsSync(taskPath)) continue;
    try {
      const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
      tasks.push({ task, taskPath });
    } catch (error) {
      tasks.push({
        task: { task_id: entry.name, status: '任务文件读取失败', created_at: '' },
        taskPath,
        readError: error.message || String(error),
      });
    }
  }
  return tasks;
}

function isReadyTask(row) {
  const task = row.task || {};
  const primaryVideo = task.materials?.primary_video;
  return eligibleStatuses.has(task.status)
    && Number(task.schema_version) >= 2
    && primaryVideo?.file_path
    && fs.existsSync(primaryVideo.file_path)
    && task.content?.title
    && task.content?.narration_text
    && task.content?.exact_segment_join_verified === true;
}

function taskSortKey(row) {
  const timestamp = Date.parse(row.task?.created_at || '');
  const timePart = Number.isFinite(timestamp) ? String(timestamp).padStart(16, '0') : '9999999999999999';
  return `${timePart}\u0000${row.task?.task_id || ''}`;
}

function summarizeTask(row) {
  if (!row) return null;
  const task = row.task;
  const video = task.materials.primary_video;
  return {
    task_id: task.task_id,
    status: task.status,
    task_path: row.taskPath,
    title: task.content.title,
    narration_character_count: [...task.content.narration_text].length,
    segment_count: Array.isArray(task.content.segments) ? task.content.segments.length : 0,
    video_file: video.file_name,
    video_path: video.file_path,
    video_duration_seconds: Number(video.duration_seconds) || 0,
    created_at: task.created_at || '',
  };
}

function main() {
  fs.mkdirSync(tasksFolder, { recursive: true });

  const videoResults = runJsonScript(videoSyncScript);
  const voiceoverResults = runJsonScript(voiceoverSyncScript);
  const allTasks = loadTasks();
  const readyTasks = allTasks.filter(isReadyTask).sort((a, b) => taskSortKey(a).localeCompare(taskSortKey(b)));
  const selected = readyTasks[0] || null;

  const result = {
    schema_version: 1,
    action: '一键准备下一条',
    prepared_at: new Date().toISOString(),
    ready_for_next_stage: Boolean(selected),
    message: selected
      ? `已准备下一条任务：${selected.task.task_id}`
      : '没有可继续制作的待处理任务',
    library_sync: {
      processed_count: videoResults.length,
      action_counts: countActions(videoResults),
      failures: videoResults
        .filter((item) => item.status === '读取失败')
        .map((item) => ({
          file_name: item.file_name || '',
          file_path: item.file_path || '',
          error: item.error || '视频信息读取失败',
        })),
    },
    voiceover_sync: {
      processed_count: voiceoverResults.length,
      action_counts: countActions(voiceoverResults),
      failures: voiceoverResults
        .filter((item) => item.sync_action === '失败' || item.status === '文案解析失败')
        .map((item) => ({
          source_file: item.source_file || '',
          block_index: item.block_index || null,
          error: item.error || item.status,
        })),
    },
    queue: {
      total_task_count: allTasks.length,
      ready_task_count: readyTasks.length,
      unreadable_task_count: allTasks.filter((item) => item.readError).length,
    },
    next_task: summarizeTask(selected),
  };

  process.stdout.write(JSON.stringify(result));
}

try {
  main();
} catch (error) {
  process.stderr.write(error.stack || error.message || String(error));
  process.exit(1);
}
