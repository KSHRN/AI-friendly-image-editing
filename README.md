# AShop

**无头、有状态、确定性可复现的图像合成引擎。给脚本、CI 和 Agent 用的「命令行 Photoshop」。**

```bash
ashop init 1200 1200 --session sku_1024
ashop layer import shoot.jpg --name base --fit cover
ashop select color --color "#f2f2f2" --tolerance 12
ashop select invert
ashop mask from-selection --layer base --feather 1
ashop layer import bg_teal.png --name bg --z-index 0 --fit cover
ashop adjust add curves --layer base --rgb "[[0,0],[128,150],[255,255]]"
ashop text add --content "SUMMER" --font "Arial" --size 72 --color "#FF0055" --pos "600,100"
ashop export out/final_1200.png --resize 1200
ashop commit -m "SKU 1024 主图"
```

没有 GUI，没有模型权重，不联网。同样的输入 + 同样的脚本 = **逐字节相同的 PNG**（内置 `diff` 做回归）。

---

## 1. 它解决什么

| 痛点 | AShop 的做法 |
|---|---|
| 重复的尺寸适配 / 调色 / 蒙版 / 多渠道导出无法沉淀 | 全部变成命令与 JSON 脚本，进 CI |
| ImageMagick 没有图层树、选区语义、历史回滚 | 图层 DOM + 选区/蒙版 + Git 式历史 |
| 生产环境要求逐像素稳定 | 固定算法、固定色彩路径、像素哈希校验 |
| Agent 需要「无头可编程」的图像编辑 | 每步都是幂等命令，输出机器可读 JSON，错误带稳定 code 与修复提示 |

## 2. 快速开始

```bash
# 安装依赖（Node 22+）
npm install

# 创建工程（也可 --from-image 用图片尺寸建画布）
node bin/ashop.js init 1200 1200 --session demo

# 看一眼状态（默认 JSON，--text 给人看）
node bin/ashop.js status --text

# 渲染
node bin/ashop.js render out/preview.png

# 跑完整示例（会生成素材并走完 PDR 的电商主图流程）
npm run demo
```

把 `bin/ashop.js` 链接到 PATH 后即可直接 `ashop ...`。

## 3. 面向 AI 的设计取舍

这个工具的第一消费者是自动化调用者，所以超出原 PDR 的地方：

- **默认输出 JSON**，每个成功响应都是 `{ok, command, data, warnings}`；失败是 `{ok:false, error:{code, message, hint, details}}`，`hint` 会直接告诉你下一步该跑什么。
- **自描述**：`ashop schema` 一次拿到全部命令/算子/参数；`ashop describe <命令|filters|styles|blends>` 按需取；`ashop help` 给人看。
- **动态算子参数**：`filter add` / `style add` / `adjust add` 的合法参数由算子定义自动生成，新增算子即自动获得 CLI 参数校验与报错建议。
- **可干跑**：`ashop run ops.json --dry-run` 先校验计划；`--atomic` 任一步失败自动回滚文档与历史。
- **像素探针**：`inspect pixel/region/layer/histogram/colors` 让没有视觉的调用者也能验证「这块是不是红的」「选区覆盖多少」。
- **稳定寻址**：图层用 ID 或唯一名字寻址；裁剪/顺序/变换全部参数化，不模拟鼠标。
- **确定性优先**：噪声用种子 PRNG，排版用字形轮廓，模糊/距离变换自己实现，不依赖平台随机或字体回退。

## 4. 命令地图

| 域 | 命令 |
|---|---|
| 工程 | `init` · `open` · `close` · `status` · `save` · `render` · `export` |
| 守护进程 | `daemon.start` · `daemon.status` · `daemon.stop` |
| 图层 | `layer.import` · `layer.fill` · `layer.list` · `layer.info` · `layer.set` · `layer.move` · `layer.transform` · `layer.duplicate` · `layer.remove` · `layer.group` · `layer.ungroup` · `layer.merge-down` |
| 选区 | `select.rect` · `select.ellipse` · `select.polygon` · `select.path` · `select.color` · `select.luminance` · `select.alpha` · `select.all` · `select.none` · `select.invert` · `select.modify` |
| 蒙版 | `mask.from-selection` · `mask.modify` · `mask.apply` · `mask.remove` · `mask.export` |
| 调整（非破坏） | `adjust.add` · `adjust.set` · `adjust.list` |
| 滤镜 | `filter.add` · `filter.clear` · `filter.list` |
| 图层样式 | `style.add` · `style.remove` · `style.info` · `style.list` |
| 排版/矢量 | `text.add` · `text.set` · `text.measure` · `shape.add` · `shape.info` · `fonts.list` · `fonts.info` |
| 批处理 | `run` |
| 回归 | `diff` · `inspect.*` |
| 历史 | `commit` · `history.log` · `history.show` · `history.diff` · `history.branch` · `history.checkout` · `history.reset` · `history.branches` |
| 扩展 | `plugin.add` · `plugin.list` · `plugin.remove` · `plugin.run` |
| 自描述 | `describe` · `schema` · `help` |

完整参数见 [`docs/COMMANDS.md`](docs/COMMANDS.md)，或 `ashop help <command>`。

### 4.1 选区的两种用法

```bash
# 矩形 / 椭圆 / 多边形 / SVG path（画布坐标系）
ashop select rect --rect "100,80,400,300"
ashop select ellipse --ellipse "600,400,200,120"
ashop select polygon --polygon "0,0 300,0 150,240"
ashop select path --svg-path "M10 10 H 90 V 90 H 10 Z"

# 颜色范围（对标 PS「色彩范围」）
ashop select color --color "#f2f2f2" --tolerance 12
ashop select color --color "#ffffff" --at "600,40" --contiguous --tolerance 24

# 组合与修饰
ashop select color --color "#00ff00" --mode add
ashop select modify --grow 3 --feather 2
```

### 4.2 蒙版

```bash
ashop mask from-selection --layer base --feather 1   # 选区 → 图层蒙版（会换算到图层局部坐标）
ashop mask modify --layer base --grow 2 --feather 1
ashop mask export --layer base --out out/mask.png    # 灰度 PNG，便于人工检查边缘
ashop mask apply --layer base                        # 烘焙进像素，仅栅格层
```

### 4.3 非破坏调整与滤镜

```bash
# 调整层：影响下方全部图层，或用 --layer/--clip-to 只作用于某一层
ashop adjust add curves --layer base --rgb "[[0,0],[128,150],[255,255]]"
ashop adjust add hue-saturation --hue 15 --saturation 1.2
ashop adjust set curves_2 --brightness 5      # 按图层 id/名字更新

# 滤镜：记录在图层上、按内容空间作用，可堆叠
ashop filter add gaussian-blur --layer base --radius 6
ashop filter add noise --layer base --amount 8 --seed 7
ashop filter clear --layer base
```

### 4.4 图层样式

```bash
ashop style add drop-shadow --layer base --color "#00000066" --offset-y 12 --blur 24
ashop style add stroke --layer logo --width 3 --color "#ffffff" --position outside
ashop style add outer-glow --layer logo --blur 18 --opacity 0.6
ashop style add bevel --layer button --size 6 --depth 1
```

### 4.5 批处理

`ops.json`：

```json
{
  "vars": { "tolerance": 12, "maskFeather": 2 },
  "steps": [
    { "op": "select.color", "args": { "color": "#f2f2f2", "tolerance": "${tolerance}" } },
    { "op": "select.invert" },
    { "op": "mask.from-selection", "args": { "layer": "base", "feather": "${maskFeather}" } },
    { "op": "layer.fill", "args": { "color": "#102030", "name": "bg", "z-index": 0 } },
    { "op": "assign", "args": { "var": "lastLayer", "path": "layer.id" } }
  ]
}
```

```bash
ashop run ops.json --dry-run          # 只校验
ashop run ops.json --atomic           # 失败回滚
ashop run ops.json --atomic --commit -m "batch"
```

### 4.6 历史

```bash
ashop commit -m "第一版"
ashop history.branch warm --checkout
ashop history.reset --hard HEAD~1
ashop history.checkout main
ashop history.log --limit 10
```

## 5. 工程包格式

```
my.ashop/
  manifest.json        # 文档 + 历史 DAG + 资源索引（每次命令后原子写入）
  assets/<sha256>.<ext> # 内容寻址的图片/蒙版，重复内容只存一份
```

选择目录 bundle 而不是单文件，是为了让自动保存只重写一个小 JSON，而不是每次搬运几十 MB 像素。整个目录可以直接拷贝/压缩/进 Git LFS。

## 6. 确定性

- 所有像素运算在 `RGBA8` 直通 alpha 上完成，固定算法与固定顺序；
- 噪声使用种子 PRNG（xorshift32），不用 `Math.random`；
- 文字排版走「fontkit 度量 → 字形轮廓 → resvg 光栅化」，不依赖系统字体回退；
- PNG 编码固定参数，同版本下逐字节稳定；
- `ashop render` 返回 `sha256`（文件）与 `pixelHash`（像素），可直接进 CI 断言。

`npm test` 覆盖 105 项，包括「两次渲染哈希一致」「diff 全零」「原子回滚不改文档」等；`npm run smoke` 会用 103 条命令把 CLI 全表面跑一遍。

## 7. 扩展方式（三层）

1. **加算子**：在 `src/core/adjustments/`、`filters/`、`styles/` 丢一个默认导出文件，自动注册，CLI 参数与文档随之生效。
2. **加命令**：在 `src/cli/commands/` 丢一个命令对象（或数组），自动出现在 `help`/`schema`，守护进程与批处理直接可用。
3. **外部插件**：任何可执行程序，遵守 stdin/stdout JSON + 原始 RGBA 文件交换协议即可；见 [`docs/PLUGINS.md`](docs/PLUGINS.md) 与 `examples/plugins/sepia.mjs`。

## 8. 与 PDR 的差异（有意为之）

- **`.ashop` 是目录 bundle**，不是单文件（理由见 §5）。
- **组图层不支持自身变换**（子图层各自变换），保证合成语义可预测。
- **滤镜是记录式而非即时烘焙**：存在图层内容上、每次渲染重放，方便回滚；语义上仍等价于破坏性滤镜。
- **YAML 脚本暂未实现**，`run` 只接受 JSON；`schema`/`describe` 为将来的 DSL 生成器留好了接口。
- **Phase 3/4 未做**：PSD 解析、钢笔工具、通道混合器、CMYK、网格叠加式 Web 观战 GUI。

## 9. 目录

```
bin/ashop.js              CLI 入口
src/cli/                  参数解析、命令注册、输出、守护进程客户端
src/cli/commands/         每个域一个文件，自动加载
src/core/                 文档模型、合成器、选区/蒙版、算子、排版、历史
src/core/adjustments/     调色算子（丢文件即注册）
src/core/filters/         滤镜算子
src/core/styles/          图层样式
src/daemon/               命名管道 RPC 守护进程
test/                     单元 + 端到端（node:test）
examples/                 演示脚本、批处理、插件
docs/                     设计、命令参考、插件协议
```

## 10. 性能参考

1600×1600、5 个图层（含羽化蒙版 + 文字 + 投影 + 调整层）单次渲染约 **0.7s**（冷启动 CLI，含读工程与解码）；守护进程内复用缓存后更快。小画布（≤1024）通常 < 200ms。

## 11. 许可

MIT
