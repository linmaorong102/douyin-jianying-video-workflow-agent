const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = process.env.VIDEO_WORKFLOW_ROOT || 'D:\\抖音信息视频工作流';
const skillRoot = process.env.VIDEO_WORKFLOW_SKILL_ROOT || 'D:\\codex的skill\\douyin-jianying-video-workflow-agent';
const sourceFolder = path.join(projectRoot, '03_口播文案');
const tasksFolder = path.join(projectRoot, '04_制作任务');
const catalogPath = path.join(projectRoot, '02_素材库', '视频素材库.json');
const wordExtractor = path.join(projectRoot, 'scripts', 'extract_word_text.ps1');
const supportedDocumentExtensions = new Set(['.txt', '.doc', '.docx']);
const supportedVideoExtensions = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm']);
const minimumFileAgeMs = Number(process.env.VIDEO_WORKFLOW_MIN_FILE_AGE_MS || 5000);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function canonicalNarration(value) {
  // 排版空白不会被朗读，因此不把空格和换行写入字幕正文。
  return normalizeText(value).replace(/\s+/g, '');
}

function extractSourceText(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.txt') {
    const buffer = fs.readFileSync(filePath);
    let text = buffer.toString('utf8');
    if (text.includes('\ufffd')) text = buffer.toString('utf16le');
    return normalizeText(text.replace(/^\ufeff/, ''));
  }

  if (!fs.existsSync(wordExtractor)) {
    throw new Error(`缺少 Word 文案读取脚本：${wordExtractor}`);
  }
  return normalizeText(execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wordExtractor, '-Path', filePath],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  ));
}

function parseVoiceoverDocument(rawText) {
  const text = normalizeText(rawText);
  const bodyMarkers = [...text.matchAll(/(?:字幕|正文)\s*[：:]/g)];
  if (bodyMarkers.length === 0) throw new Error('未找到“字幕：”或“正文：”字段');
  if (bodyMarkers.length > 1) throw new Error('检测到多组“字幕/正文”字段；每个文案文件只能对应一条视频');

  const marker = bodyMarkers[0];
  const beforeBody = text.slice(0, marker.index);
  const rawBody = text.slice(marker.index + marker[0].length);
  if (/(?:^|\n)\s*(?:视频\s*[一二三四五六七八九十\d]*\s*[：:]\s*)?标题\s*[：:]/m.test(rawBody)) {
    throw new Error('正文中检测到第二条视频标题；请把每条视频保存为独立文案文件');
  }

  const titleMatch = /(?:^|\n)\s*标题\s*[：:]\s*([^\n]+)/m.exec(beforeBody)
    || /标题\s*[：:]\s*([^，,；;\n]+)/.exec(beforeBody);
  const videoMatch = /(?:^|\n)\s*视频(?:文件|素材)?\s*[：:]\s*([^\n]+)/m.exec(beforeBody);
  const title = normalizeText(titleMatch?.[1] || '');
  const declaredVideo = normalizeText(videoMatch?.[1] || '').replace(/^["“]|["”]$/g, '');
  const body = canonicalNarration(rawBody);

  if (!title) throw new Error('标题为空或缺少“标题：”字段');
  if (!body) throw new Error('字幕正文为空');
  return { title, body, declaredVideo };
}

function splitVoiceoverDocument(rawText) {
  const text = normalizeText(rawText);
  const startToken = '【任务开始】';
  const endToken = '【任务结束】';
  const startCount = text.split(startToken).length - 1;
  const endCount = text.split(endToken).length - 1;

  if (startCount === 0 && endCount === 0) {
    return [{ block_index: 1, ingestion_mode: 'single_document', raw_text: text }];
  }
  if (startCount === 0 || startCount !== endCount) {
    throw new Error(`批量文案分隔符不完整：检测到${startCount}个“${startToken}”和${endCount}个“${endToken}”`);
  }

  const blockPattern = /【任务开始】([\s\S]*?)【任务结束】/g;
  const matches = [...text.matchAll(blockPattern)];
  const outsideText = text.replace(blockPattern, '').trim();
  if (matches.length !== startCount || outsideText) {
    throw new Error('批量文案格式错误：所有任务内容都必须放在【任务开始】和【任务结束】之间');
  }

  return matches.map((match, index) => ({
    block_index: index + 1,
    ingestion_mode: 'batch_document',
    raw_text: normalizeText(match[1]),
  }));
}

function loadVideoCatalog() {
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`视频素材库不存在，请先运行“01-视频素材自动入库-v1”：${catalogPath}`);
  }
  const text = fs.readFileSync(catalogPath, 'utf8').trim();
  const records = text ? JSON.parse(text) : [];
  if (!Array.isArray(records)) throw new Error('视频素材库格式错误：根节点必须是数组');
  return records.filter((row) => row && row.status !== '读取失败');
}

function normalizePathKey(value) {
  return path.resolve(String(value || '')).toLocaleLowerCase('zh-CN');
}

function normalizeNameKey(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function hasCurrentTaskSchema(task) {
  return Boolean(
    task
    && Number(task.schema_version) >= 2
    && task.materials?.primary_video?.file_path
    && task.content?.exact_segment_join_verified === true,
  );
}

function findUniqueVideo(candidates, reason) {
  const uniqueByPath = [...new Map(candidates.map((row) => [normalizePathKey(row.file_path), row])).values()];
  if (uniqueByPath.length === 0) return null;
  if (uniqueByPath.length > 1) {
    throw new Error(`${reason}匹配到多个视频，请在文案中填写包含扩展名的“视频：文件名”`);
  }
  return uniqueByPath[0];
}

function resolveVideoBinding({ declaredVideo, sourceFile, catalog }) {
  const usable = catalog.filter((row) => {
    const extension = path.extname(String(row.file_name || row.file_path || '')).toLowerCase();
    return supportedVideoExtensions.has(extension) && row.file_path && fs.existsSync(row.file_path);
  });

  if (declaredVideo) {
    const declaredName = path.basename(declaredVideo);
    const declaredPathKey = path.isAbsolute(declaredVideo) ? normalizePathKey(declaredVideo) : '';
    const exact = usable.filter((row) =>
      (declaredPathKey && normalizePathKey(row.file_path) === declaredPathKey)
      || normalizeNameKey(row.file_name) === normalizeNameKey(declaredName),
    );
    const selected = findUniqueVideo(exact, `“视频：${declaredVideo}”`);
    if (!selected) {
      throw new Error(`视频素材库中没有“${declaredVideo}”；请先放入01_待入库并运行01流程`);
    }
    return { row: selected, matchMethod: '文案视频字段' };
  }

  const sourceBaseName = path.basename(sourceFile, path.extname(sourceFile));
  const sameBaseName = usable.filter((row) =>
    normalizeNameKey(path.basename(row.file_name, path.extname(row.file_name))) === normalizeNameKey(sourceBaseName),
  );
  const selected = findUniqueVideo(sameBaseName, `同名文案“${sourceBaseName}”`);
  if (!selected) {
    throw new Error(`未找到与文案同名的视频；请将视频命名为“${sourceBaseName}.mp4”，或在文案首行填写“视频：文件名”`);
  }
  return { row: selected, matchMethod: '同名文件' };
}

function visibleLength(text) {
  return [...text.replace(/[\s，。！？!?；;、,.]/g, '')].length;
}

function splitLongClause(clause, maxChars = 16) {
  if (visibleLength(clause) <= maxChars) return [clause];
  const punctuation = clause.match(/[，。！？!?；;、]$/)?.[0] || '';
  const core = punctuation ? clause.slice(0, -1) : clause;
  const chars = [...core];
  const chunks = [];
  while (chars.length) chunks.push(chars.splice(0, maxChars).join(''));
  if (punctuation && chunks.length) chunks[chunks.length - 1] += punctuation;
  return chunks.filter(Boolean);
}

function segmentNarration(body) {
  const clauses = body.match(/[^，。！？!?；;]+[，。！？!?；;]?/g) || [body];
  const texts = clauses.flatMap((clause) => splitLongClause(clause, 16)).filter(Boolean);
  if (texts.join('') !== body) throw new Error('字幕拆分改变了原始正文，已停止生成任务');

  let cursor = 0;
  return texts.map((text, index) => {
    const characters = visibleLength(text);
    const pause = /[。！？!?]$/.test(text) ? 0.45 : 0.2;
    const duration = Math.max(1, Math.round((characters / 4.6 + pause) * 100) / 100);
    const start = Math.round(cursor * 100) / 100;
    cursor += duration;
    return {
      segment_index: index + 1,
      text,
      character_count: characters,
      estimated_start_seconds: start,
      estimated_end_seconds: Math.round(cursor * 100) / 100,
      estimated_duration_seconds: duration,
      final_timing: false,
    };
  });
}

function buildTask({
  taskId,
  sourceFile,
  sourcePath,
  sourceDocumentSha256,
  blockSha256,
  blockIndex,
  ingestionMode,
  title,
  body,
  segments,
  video,
  matchMethod,
}) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    parser_version: '3.0.0',
    task_id: taskId,
    status: '等待处理',
    source: {
      file_name: sourceFile,
      file_path: sourcePath,
      sha256: sourceDocumentSha256,
      document_sha256: sourceDocumentSha256,
      block_sha256: blockSha256,
      block_index: blockIndex,
      ingestion_mode: ingestionMode,
    },
    materials: {
      primary_video: {
        asset_id: video.asset_id || '',
        file_name: video.file_name,
        file_path: video.file_path,
        sha256: video.sha256 || '',
        duration_seconds: Number(video.duration_seconds) || 0,
        width: Number(video.width) || 0,
        height: Number(video.height) || 0,
        fps: Number(video.fps) || 0,
        match_method: matchMethod,
      },
    },
    content: {
      title,
      narration_text: body,
      segments,
      exact_segment_join_verified: segments.map((segment) => segment.text).join('') === body,
      final_timing_source: '剪映文本朗读生成后回填',
    },
    jianying_defaults: {
      canvas: { aspect_ratio: '9:16', width: 1080, height: 1920, fps: 30 },
      voice: { provider: '剪映文本朗读', voice_name: '解说小帅', speed: 1.1 },
      audio: {
        mute_original_video: true,
        background_music_enabled: true,
        background_music_source: '剪映-音频-我的-收藏',
        background_music_name: '舒缓 煽情 唯美 浪漫 轻音乐',
        background_music_author: 'Lance',
        background_music_library_duration: '02:52',
        background_music_reference_asset: path.join(skillRoot, 'assets', 'background-music-reference.png'),
        background_music_trim_to_voiceover: true,
      },
      layout: {
        landscape_video: '清晰主画面居中，复制原视频作为模糊背景铺满画布',
        transitions: '直接切换',
        clip_duration_seconds: { min: 2, max: 4 },
      },
      title_style: {
        preset_location: '预设样式第一行第4个黄色T',
        preset_visual: '黄色文字、黑色描边',
        preset_asset: path.join(skillRoot, 'assets', 'title-style-position-reference.png'),
        edit_preset_internal_style: false,
        font: '得意黑',
        font_size: 15,
        position: { x: 0, y: 854 },
        duration: '全程',
      },
      subtitle_style: {
        use_styled_preset: false,
        style_source: '剪映基础字幕样式',
        style_visual: '纯白文字，无描边、无背景、无阴影',
        position_reference_asset: path.join(skillRoot, 'assets', 'caption-style-position-reference.png'),
        font: '得意黑',
        font_size: 10,
        text_color: '白色',
        outline_enabled: false,
        outline_color: '',
        background_enabled: false,
        shadow_enabled: false,
        position: { x: 102, y: -810 },
        max_lines: 1,
        max_characters_per_line: 16,
        text_source: '原始口播文案；自动识别仅用于时间点',
        exact_text_match_required: true,
        proofreading_required: true,
        concatenated_text_must_equal_narration: true,
      },
      timeline_sync: {
        master_clock: '剪映解说小帅文本朗读音频',
        align_start_at_seconds: 0,
        tracks_required_equal_duration: ['背景音乐', '主视频', '模糊背景', '标题', '口播音频'],
        max_end_time_error_seconds: 0.033,
        background_music_longer_than_voiceover: '从音乐开头使用，在口播音频结束点裁剪',
        video_longer_than_audio: '在音频结束点裁剪视频',
        material_library_fill_threshold_seconds: 2,
        video_shorter_than_audio: '缺口不超过2秒可用当前素材尾部、短衔接或末帧定格；缺口大于2秒必须从素材库截取相关片段补齐',
        never_truncate_voiceover: true,
      },
      export: { approved: false, format: 'MP4', codec: 'H.264', bitrate: '推荐码率' },
    },
    created_at: now,
    updated_at: now,
  };
}

function main() {
  fs.mkdirSync(sourceFolder, { recursive: true });
  fs.mkdirSync(tasksFolder, { recursive: true });

  const files = fs.readdirSync(sourceFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => !entry.name.startsWith('~$') && !entry.name.startsWith('.'))
    .filter((entry) => supportedDocumentExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  const catalog = loadVideoCatalog();
  const results = [];
  for (const sourceFile of files) {
    const sourcePath = path.join(sourceFolder, sourceFile);
    const stat = fs.statSync(sourcePath);
    if (Date.now() - stat.mtimeMs < minimumFileAgeMs) {
      results.push({ source_file: sourceFile, status: '等待文件写入完成', sync_action: '跳过' });
      continue;
    }

    const sourceDocumentSha256 = sha256File(sourcePath);
    const legacyTaskId = `TASK-${sourceDocumentSha256.slice(0, 12).toUpperCase()}`;
    const legacyTaskPath = path.join(tasksFolder, legacyTaskId, 'task.json');

    // 当前结构的任务继续保持幂等；旧结构任务保留，但允许生成新的带视频绑定任务。
    let legacyTask = null;
    if (fs.existsSync(legacyTaskPath)) {
      legacyTask = JSON.parse(fs.readFileSync(legacyTaskPath, 'utf8'));
      if (hasCurrentTaskSchema(legacyTask)) {
        results.push({
          task_id: legacyTaskId,
          source_file: sourceFile,
          block_index: legacyTask.source?.block_index || 1,
          video_file: legacyTask.materials.primary_video.file_name || '',
          title: legacyTask.content.title,
          segment_count: legacyTask.content.segments.length,
          status: legacyTask.status,
          task_path: legacyTaskPath,
          sync_action: '已存在',
        });
        continue;
      }
    }

    let taskBlocks;
    try {
      taskBlocks = splitVoiceoverDocument(extractSourceText(sourcePath));
    } catch (error) {
      const failureFolder = path.join(tasksFolder, legacyTaskId);
      fs.mkdirSync(failureFolder, { recursive: true });
      const failure = {
        task_id: legacyTaskId,
        source_file: sourceFile,
        source_path: sourcePath,
        status: '文案解析失败',
        error: error.message || String(error),
        failed_at: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(failureFolder, 'parse_error.json'), `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
      results.push({ ...failure, sync_action: '失败' });
      continue;
    }

    for (const block of taskBlocks) {
      let taskId = '';
      let taskFolder = '';
      try {
        const { title, body, declaredVideo } = parseVoiceoverDocument(block.raw_text);
        const { row: video, matchMethod } = resolveVideoBinding({ declaredVideo, sourceFile, catalog });
        const blockSha256 = sha256Text(`${video.file_name}\u0000${title}\u0000${body}`);
        taskId = block.ingestion_mode === 'single_document' && !legacyTask
          ? legacyTaskId
          : `TASK-${blockSha256.slice(0, 12).toUpperCase()}`;
        taskFolder = path.join(tasksFolder, taskId);
        const taskPath = path.join(taskFolder, 'task.json');

        if (fs.existsSync(taskPath)) {
          const existing = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
          results.push({
            task_id: taskId,
            source_file: sourceFile,
            block_index: block.block_index,
            video_file: existing.materials?.primary_video?.file_name || video.file_name,
            title: existing.content.title,
            segment_count: existing.content.segments.length,
            status: existing.status,
            task_path: taskPath,
            sync_action: '已存在',
          });
          continue;
        }

        const segments = segmentNarration(body);
        const task = buildTask({
          taskId,
          sourceFile,
          sourcePath,
          sourceDocumentSha256,
          blockSha256,
          blockIndex: block.block_index,
          ingestionMode: block.ingestion_mode,
          title,
          body,
          segments,
          video,
          matchMethod,
        });

        fs.mkdirSync(taskFolder, { recursive: true });
        fs.writeFileSync(path.join(taskFolder, 'raw.txt'), `${block.raw_text}\n`, 'utf8');
        fs.writeFileSync(taskPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
        results.push({
          task_id: taskId,
          source_file: sourceFile,
          block_index: block.block_index,
          video_file: video.file_name,
          video_match_method: matchMethod,
          title,
          segment_count: segments.length,
          estimated_duration_seconds: segments.at(-1)?.estimated_end_seconds || 0,
          status: task.status,
          task_path: taskPath,
          sync_action: '新增',
        });
      } catch (error) {
        const errorHash = sha256Text(`ERROR\u0000${block.raw_text}`);
        taskId = taskId || `TASK-${errorHash.slice(0, 12).toUpperCase()}`;
        taskFolder = taskFolder || path.join(tasksFolder, taskId);
        fs.mkdirSync(taskFolder, { recursive: true });
        const failure = {
          task_id: taskId,
          source_file: sourceFile,
          source_path: sourcePath,
          block_index: block.block_index,
          status: '文案解析失败',
          error: error.message || String(error),
          failed_at: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(taskFolder, 'parse_error.json'), `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
        results.push({ ...failure, sync_action: '失败' });
      }
    }
  }

  process.stdout.write(JSON.stringify(results));
}

main();
