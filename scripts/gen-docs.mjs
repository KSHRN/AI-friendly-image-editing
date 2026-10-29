#!/usr/bin/env node
/**
 * Generate docs/COMMANDS.md from the live command registry.
 *
 * Docs that are generated cannot drift from the implementation.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCommands, commandCatalog } from '../src/cli/registry.js';
import { adjustmentCatalog } from '../src/core/adjustments/index.js';
import { filterCatalog } from '../src/core/filters/index.js';
import { styleCatalog } from '../src/core/styles/index.js';
import { BLEND_MODE_NAMES } from '../src/core/blend.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'docs', 'COMMANDS.md');

const { list } = await loadCommands();
const catalog = commandCatalog(list);

const lines = [
  '# AShop 命令参考',
  '',
  '> 本文件由 `node scripts/gen-docs.mjs` 从命令注册表生成，请勿手工编辑。',
  '',
  '所有命令默认输出 JSON：成功为 `{ok, command, data, warnings?}`，失败为',
  '`{ok:false, error:{code,message,hint,details?}}`。加 `--text` 输出人类可读文本，',
  '`--pretty` 美化 JSON，`--no-daemon` 跳过守护进程。',
  '',
  '全局参数：`--project <path.ashop>`、`--session <name>`、`--json`、`--text`、`--pretty`、`--no-daemon`。',
  '',
];

const groups = new Map();
for (const c of catalog) {
  const [group] = c.name.split('.');
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(c);
}

for (const [group, commands] of [...groups.entries()].sort()) {
  lines.push(`## ${group}`, '');
  for (const command of commands.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`### \`${command.name}\``, '', command.summary, '');
    if (command.aliases.length) lines.push(`别名：${command.aliases.map((a) => `\`${a}\``).join(', ')}`, '');
    const params = Object.entries(command.params ?? {});
    if (params.length) {
      lines.push('| 参数 | 类型 | 默认 | 说明 |', '|---|---|---|---|');
      for (const [name, def] of params) {
        const flags = def.positional ? `\`<${name}>\`` : `\`--${name}\``;
        const req = def.required ? '必填' : (def.default !== undefined ? `\`${JSON.stringify(def.default)}\`` : '');
        lines.push(`| ${flags} | ${def.type ?? 'string'} | ${req} | ${(def.desc ?? '').replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }
    if (command.examples.length) {
      lines.push('```bash');
      for (const ex of command.examples) lines.push(ex);
      lines.push('```', '');
    }
    const mutates = command.mutates ? '写操作（自动保存）' : '只读';
    lines.push(`> ${mutates}${command.needsSession ? '' : ' · 不需要工程'}`);
    lines.push('');
  }
}

lines.push('## 算子目录', '');
lines.push('### 混合模式', '', BLEND_MODE_NAMES.map((m) => `\`${m}\``).join(' · '), '');

function operatorSection(title, items, extra) {
  lines.push(`### ${title}`, '');
  for (const item of items) {
    lines.push(`#### \`${item.name}\` — ${item.label}`, '');
    const entries = Object.entries(item.params ?? {});
    if (entries.length) {
      lines.push('| 参数 | 类型 | 默认 | 说明 |', '|---|---|---|---|');
      for (const [name, def] of entries) {
        lines.push(`| \`--${name}\` | ${def.type ?? 'string'} | ${def.default !== undefined ? `\`${JSON.stringify(def.default)}\`` : ''} | ${(def.desc ?? '').replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }
    if (extra) lines.push(extra(item), '');
  }
}

operatorSection('调整（adjust.add）', adjustmentCatalog());
operatorSection('滤镜（filter.add）', filterCatalog());
operatorSection('图层样式（style.add）', styleCatalog());

lines.push('## 批处理文件格式', '',
  '```json',
  JSON.stringify({
    vars: { tolerance: 12 },
    steps: [
      { op: 'select.color', args: { color: '#f2f2f2', tolerance: '${tolerance}' } },
      { op: 'select.invert' },
      { op: 'mask.from-selection', args: { layer: 'base', feather: 1 } },
      { op: 'assign', args: { var: 'maskedLayer', path: 'layer.id' } },
      { op: 'echo', args: { message: 'done' } },
    ],
  }, null, 2),
  '```',
  '',
  '- `${var}` 支持整串替换（保留类型）与字符串内插；变量来自文件 `vars` 与 `--vars`。',
  '- `assign` 把上一步结果里的某个路径存进变量；`echo` 只记录一条消息。',
  '- `--atomic` 失败回滚文档与历史；`--dry-run` 只校验计划（不检查运行时状态）。',
  '');

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${OUT} (${catalog.length} commands)`);
