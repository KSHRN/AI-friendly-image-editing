# 插件协议（ashop-plugin/1）

AShop 核心不内置任何模型或重型依赖。需要额外能力时，交给外部进程插件：任何可执行文件，只要能读写文件、说 JSON，就能接入。

## 1. 交换格式

引擎启动插件进程，向 **stdin 写一行 JSON**：

```json
{
  "protocol": "ashop-plugin/1",
  "op": "transform",
  "input":  { "path": "C:\\...\\input.rgba",  "width": 1600, "height": 1200, "channels": 4, "format": "rgba8" },
  "output": { "path": "C:\\...\\output.rgba", "width": 1600, "height": 1200, "channels": 4, "format": "rgba8" },
  "params": { "amount": 0.8 },
  "project": { "path": "C:\\...\\sku.ashop", "width": 1200, "height": 1200 },
  "layer":   { "id": "lyr_1", "name": "base", "type": "raster" }
}
```

插件从 `input.path` 读原始 RGBA8（直通 alpha、每像素 4 字节、行优先），处理完后写回 `output.path`，**必须保持相同尺寸**，然后向 **stdout 输出一行 JSON**：

```json
{ "ok": true, "meta": { "your": "diagnostics" } }
```

失败时：

```json
{ "ok": false, "error": { "code": "E_MY_FAILURE", "message": "原因" } }
```

- 进程退出码必须为 0（失败也用 JSON 报错，非 0 会被视为崩溃并带出 stderr 末尾）。
- stderr 可以自由打日志，出错时会回填到 `details.stderr`。
- 超时 120 秒，超时会被终止。

## 2. 注册与运行

```bash
ashop plugin.add --name sepia --command node --args '["examples/plugins/sepia.mjs"]'
ashop plugin.run --name sepia --layer base --params '{"amount":0.8}'
ashop plugin.list
ashop plugin.remove --name sepia
```

- 注册时会把 `cwd` 固定为当前工作目录（默认为调用处），相对路径参数因此稳定。
- 插件作用于图层**内容空间**：变换、蒙版、样式不受影响。
- 文字/形状层运行插件后会转成栅格层（矢量信息无法保留，这是协议边界）。

## 3. 参考实现（Node）

见 [`examples/plugins/sepia.mjs`](../examples/plugins/sepia.mjs)：

```js
import { readFileSync, writeFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
const buf = readFileSync(request.input.path);
const out = Buffer.alloc(buf.length);
// ... 改 out ...
writeFileSync(request.output.path, out);
process.stdout.write(JSON.stringify({ ok: true }) + '\n');
```

## 4. Python 骨架

```python
import json, sys
req = json.load(sys.stdin)
data = open(req["input"]["path"], "rb").read()
out = bytearray(data)
# 例如：把红色通道减半
for i in range(0, len(out), 4):
    out[i] //= 2
open(req["output"]["path"], "wb").write(out)
print(json.dumps({"ok": True}))
```

注册：`ashop plugin.add --name half-red --command python --args '["plugins/half_red.py"]'`

## 5. 边界与建议

- 插件不参与历史快照的语义：运行后图层内容被新像素替换，历史里记录的是结果。
- 插件不应用于需要逐像素可复现的 CI 关键路径，除非插件本身是确定性的。
- 大图建议按行块处理，避免一次读入多份副本；缓冲区大小 = `width * height * 4`。
- 不要把网络请求放进插件——这个工具的设计前提是离线可复现。
