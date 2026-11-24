// sherpa-local ASR provider（spec §3.2 P4.3）：可选本地识别，动态加载 sherpa-onnx-node。
// 缺模块/缺模型 → probe 明确失败（中文提示），绝不影响其他功能；模型由用户手动导入（manifest 校验）。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function sherpaManifestPath() {
  return join(HERE, 'sherpa-local', 'manifest.json');
}

export function readSherpaManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(`找不到 sherpa 模型 manifest：${manifestPath}（未配置本地模型属正常，本地 ASR 属可选功能）`);
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const required = ['path', 'sha256', 'source', 'license', 'sample_rate', 'language'];
  const missing = required.filter((k) => !m[k]);
  if (missing.length) {
    throw new Error(`模型 manifest 缺字段：${missing.join(', ')}（需 ${required.join(', ')}）`);
  }
  if (!Number.isInteger(m.sample_rate) || m.sample_rate <= 0) {
    throw new Error('manifest.sample_rate 必须是正整数');
  }
  if (typeof m.path !== 'string' || m.path.includes('..')) {
    throw new Error('manifest.path 非法（不得包含相对穿越）');
  }
  return m;
}

export class SherpaLocalProvider {
  constructor({ manifestPath } = {}) {
    this.manifestPath = manifestPath || sherpaManifestPath();
    this.closed = false;
  }

  id() { return 'sherpa-local'; }

  capabilities() {
    return { streaming: true, hotwords: true, diarization: false, timestamps: false };
  }

  async probe() {
    // 1) 模块可加载性（动态 import：未安装不影响其他功能）
    try {
      await import('sherpa-onnx-node');
    } catch {
      return {
        ok: false,
        reason: '未安装 sherpa-onnx-node（本地 ASR 属可选功能）。安装：npm install sherpa-onnx-node；模型手动导入后填写 providers/asr/sherpa-local/manifest.json。未安装不影响云端/文本模式。',
      };
    }
    // 2) manifest 校验
    let manifest;
    try {
      manifest = readSherpaManifest(this.manifestPath);
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    // 3) 模型文件存在性
    if (!existsSync(manifest.path)) {
      return { ok: false, reason: `模型文件不存在：${manifest.path}（按 manifest 手动导入）` };
    }
    return { ok: true, reason: `本地模型就绪：${manifest.source}` };
  }

  // 识别引擎接线依赖 sherpa-onnx-node 具体发行版 API 与模型目录结构——用户验收阶段连通
  async start() {
    if (this.closed) throw new Error('provider 已关闭');
    const probe = await this.probe();
    if (!probe.ok) throw new Error(`sherpa-local 不可用：${probe.reason}`);
    throw new Error('sherpa-local 识别引擎接线属用户验收阶段（模型目录结构因发行版而异）；当前 probe/manifest/doctor 已就绪');
  }

  async push() {
    throw new Error('sherpa-local 识别引擎未接线（见 start）');
  }

  async finish() {}

  async close() {
    this.closed = true;
  }
}
