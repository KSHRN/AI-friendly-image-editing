# AShop 设计说明

本文记录实现里那些「以后返工代价很高」的决定。读它可以少踩坑。

## 1. 坐标系与内容单元

- 画布是整数像素网格，左上角为原点，y 向下。
- 每个可渲染图层有「内容单元」尺寸（`content.width/height`）：
  - 栅格层：内容单元 = 源图像像素；
  - 文字/形状层：内容单元 = 排版/图形框，单位是画布像素（缩放 1 时）；
- 图层变换 `{x, y, scaleX, scaleY, rotation, anchorX, anchorY, skewX, skewY}` 把内容单元映射到画布：

  ```
  M = T(x,y) · R(rotation) · Skew · S(scaleX,scaleY) · T(-anchorX*w, -anchorY*h)
  ```

- 渲染缩放在合成时左乘 `S(scale)`，所以同一份文档可以任意分辨率输出。
- 采样使用双线性 + 预乘 alpha（避免透明边缘渗色）；缩得很小时先 Lanczos 降采样，避免锯齿。
- 图层的「锚点」是内容框内的归一化点，默认左上角 `(0,0)`，所以 `--pos` 总是可预测的。

## 2. 图层类型

| 类型 | 内容 | 变换 | 备注 |
|---|---|---|---|
| `raster` | `{assetId,width,height,filters[]}` | 支持 | 导入的图片或合并结果 |
| `text` | 文本 + 字体 + 排版参数 | 支持 | 每帧按 `deviceScale` 重渲染轮廓，缩放不糊 |
| `shape` | 若干矢量图元 + 填充/描边 | 支持 | rect / ellipse / polygon / path |
| `adjustment` | 调整算子 + 参数 | 忽略 | 作用于「已合成的下方像素」 |
| `group` | `children[]` | 必须单位矩阵 | 子图层各自变换 |

组内图层先合成到隔离缓冲，再按组的不透明度/混合模式/蒙版/样式整体合成。**组不支持自身变换**，这是有意为之：避免「组变换 + 子变换 + 蒙版坐标」三套坐标互相打架。

## 3. 合成顺序与公式

从底到顶遍历：

1. `visible === false` 跳过；`opacity === 0` 跳过（调整层除外）。
2. 调整层：对当前画布做逐像素变换，`alpha` 保持不变，覆盖度由蒙版/剪切/不透明度加权。
3. 组：递归渲染子层到隔离缓冲 → 组蒙版（画布空间）→ 组样式 → 合成。
4. 普通层：解析内容栅格（含滤镜栈）→ 局部蒙版 → `fillOpacity` → 样式（下方阴影、上方发光/描边）→ 变换合成。
5. 剪切（`clipTo`）：被剪切的层，其 alpha 再乘以「基准层渲染后的 alpha」。

逐像素混合采用 W3C 直通 alpha 公式：

```
αo = αs + αb·(1-αs)
Co = [αs·(1-αb)·Cs + αs·αb·B(Cb,Cs) + (1-αs)·αb·Cb] / αo
```

`B` 是可选混合模式函数（26 种，含 HSL 非可分离模式）。

## 4. 选区与蒙版

- 选区是**画布空间**的单通道 `Mask`（0..255 覆盖率）。
- 图层蒙版是**内容空间**的单通道 `Mask`，尺寸等于内容单元尺寸；渲染时按 `u/contentWidth` 采样。
- 组的蒙版按画布空间处理；调整层同理。
- 布尔运算：`replace/add/subtract/intersect`；没有现有选区时，`subtract`/`intersect` 从空开始。
- 羽化、扩展、收缩用精确欧氏距离变换 + 抗锯齿覆盖，边缘不会出现阶梯。
- 蒙版可导出为灰度 PNG；`mask apply` 只支持栅格层（矢量层保留蒙版更合理）。

## 5. 调整 vs 滤镜

- **调整层**是非破坏的：它不修改任何图层像素，只在合成到它时变换「下方已经合成的结果」。因此它天然受蒙版/剪切/不透明度控制。
- **滤镜**记录在图层 `content.filters[]` 里，渲染时按内容空间重放。虽然描述为「破坏性」，但记录式让历史回滚仍然完整；`filter clear` 即可撤销。
- 滤镜参数里的长度量会按内容栅格比例缩放，所以同一个滤镜在文字层（会以 2× 光栅化）和栅格层上视觉一致。

## 6. 文字排版

```
fontkit 打开字体 → layout() 得到 glyphs/advances → 生成 SVG path → resvg 光栅化
```

- 度量、字距、换行都在内容单元里完成；字形以路径输出，所以不依赖 resvg 的字体匹配。
- `deviceScale = clamp(变换后的最大缩放, 0.05..4)`，文字在放大时重新按高分辨率渲染，不会糊。
- 字体解析：扫描系统字体目录，按 family + weight + italic 选面，结果缓存到用户缓存目录；也支持 `--font-file` 直接指定。
- 当前限制：没有连字/复杂脚本的进阶排版（fontkit 的 shaping 覆盖常见情况）；文本沿路径尚未实现。

## 7. 历史

- 提交保存「文档 JSON 快照」，像素留在内容寻址资源里，所以快照很小。
- 提交 id = `sha256(doc + parent + message + ts)` 前 12 位。
- 分支只是提交指针；`checkout` 切换工作文档，`reset` 移动指针。
- 工作区有未提交修改时 `checkout` 会拒绝，需 `--force`。
- 未提交的修改在每次命令后自动保存（autosave），崩溃不会丢工作区。

## 8. 守护进程

- 每个工程一个守护进程，Windows 命名管道 / POSIX UDS。
- 协议：换行分隔 JSON，`{id, command, args, project}` → `{id, ok, data|error}`。
- 所有请求串行执行，避免并发写同一文档。
- 空闲 10 分钟自动退出并保存；`ashop daemon.stop` 主动退出。
- 连不上时 CLI 自动回退到进程内模式，并在 `warnings` 里说明——CI 里不会因为守护进程问题挂掉。

## 9. 错误模型

```json
{"ok": false, "error": {"code": "E_LAYER_NOT_FOUND", "message": "...", "hint": "...", "details": {}}}
```

- `code` 稳定，适合程序分支；`hint` 面向人或 Agent 的下一步动作；`details` 放候选值/失败步骤等上下文。
- 退出码：`0` 成功，`2` 用法错误（`E_USAGE`），`1` 其他失败。

## 10. 扩展契约

### 10.1 调整算子

```js
export default {
  name: 'my-lut',
  label: 'My LUT',
  params: { amount: { type: 'number', default: 1 } },
  create(params) {
    return { map(r, g, b, out) { /* 写 out[0..2]，0..255 */ } };
  },
};
```

### 10.2 滤镜

```js
export default {
  name: 'my-filter',
  label: 'My Filter',
  params: { radius: { type: 'number', default: 4 } },
  lengthParams: ['radius'],        // 会按内容栅格比例缩放
  apply(raster, params) { return raster.clone(); },
};
```

### 10.3 样式

```js
export default {
  name: 'my-style',
  lengthParams: ['blur'],
  params: { blur: { type: 'number', default: 8 } },
  apply(contentRaster, params) {
    // 返回 {under|over: {raster, pad}}；raster 比 content 每边大 pad
    return {};
  },
};
```

### 10.4 命令

```js
export default {
  name: 'my.command',
  summary: '...',
  params: { layer: { type: 'string', required: true } },
  async run(ctx, args) { return { ok: true }; },
};
```

`ctx.session` 是 Engine；写操作要 `touch` 文档并 `markDirty`（命令框架负责保存）。

## 11. 已知限制

- 组图层不能变换；没有智能对象/引用层。
- 没有液化网格缓存、没有 SIMD；超大画布（>8000px）内存与耗时会明显上升。
- 选区没有「快速蒙版/画笔」——只支持确定性参数化方式（这本来就是产品边界）。
- `.psd` 导入、CMYK、通道混合器、YAML DSL、Web 观战 GUI 属于路线图，未实现。
- 单个工程同一时刻只应有写者（守护进程会缓存状态）；外部改文件后需要重启守护进程。
