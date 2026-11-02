# AShop 命令参考

> 本文件由 `node scripts/gen-docs.mjs` 从命令注册表生成，请勿手工编辑。

所有命令默认输出 JSON：成功为 `{ok, command, data, warnings?}`，失败为
`{ok:false, error:{code,message,hint,details?}}`。加 `--text` 输出人类可读文本，
`--pretty` 美化 JSON，`--no-daemon` 跳过守护进程。

全局参数：`--project <path.ashop>`、`--session <name>`、`--json`、`--text`、`--pretty`、`--no-daemon`。

## adjust

### `adjust.add`

Add a non-destructive adjustment layer (optionally clipped to a layer)

别名：`adjust`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<adjustment>` | string | 必填 | adjustment name, e.g. curves |
| `--layer` | string |  | alias for --clip-to |
| `--clip-to` | string |  | restrict the adjustment to this layer |
| `--target` | string |  | alias for --clip-to |
| `--name` | string |  |  |
| `--z-index` | int |  |  |
| `--opacity` | number | `1` |  |

```bash
ashop adjust.add curves --layer base --rgb "[[0,0],[128,150],[255,255]]"
ashop adjust.add brightness-contrast --brightness 10 --contrast 15
```

> 写操作（自动保存）

### `adjust.list`

List available adjustments and their parameters

> 只读 · 不需要工程

### `adjust.set`

Update an existing adjustment layer’s parameters

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |

> 写操作（自动保存）

## close

### `close`

Forget the current project pointer

> 写操作（自动保存） · 不需要工程

## commit

### `commit`

Snapshot the working document into history

别名：`history.commit`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--message` | string | `""` | commit message |

```bash
ashop commit -m "SKU 1024 main image"
```

> 写操作（自动保存）

## daemon

### `daemon.start`

Start the project daemon in the background

> 只读 · 不需要工程

### `daemon.status`

Report whether the project daemon is running

> 只读 · 不需要工程

### `daemon.stop`

Stop the project daemon

> 只读 · 不需要工程

## describe

### `describe`

Describe a command or operator family (adjustments, filters, styles, blends, paints)

别名：`info`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<name>` | string |  | command name or family |

```bash
ashop describe layer.import
ashop describe filters
ashop describe paints
```

> 只读 · 不需要工程

## diff

### `diff`

Compare two images pixel by pixel (threshold, MAE, SSIM, diff image)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<a>` | path | 必填 | baseline image |
| `<b>` | path | 必填 | candidate image |
| `--threshold` | number | `0.001` | max allowed mismatchRatio |
| `--tolerance` | int | `16` | per-channel delta counted as a mismatch |
| `--ssim` | bool | `true` |  |
| `--diff-out` | path |  | write an amplified diff image here |
| `--amplify` | number | `4` |  |

```bash
ashop diff baseline/a.png out/a.png --threshold 0.001 --diff-out out/diff.png
```

> 只读 · 不需要工程

## export

### `export`

Export the canvas at specific sizes, or run a preset list

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<out>` | path |  | output file |
| `--width` | int |  | target width |
| `--resize` | int |  | alias for --width |
| `--height` | int |  | target height |
| `--scale` | number | `1` |  |
| `--format` | enum |  |  |
| `--quality` | int | `90` |  |
| `--presets` | string |  | JSON file with [{out,width,height,format,quality}] |

```bash
ashop export out/final_1200.png --width 1200
ashop export --presets presets.json
```

> 只读

## filter

### `filter.add`

Add a filter to a layer (stackable, applied in content space)

别名：`filter`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<filter>` | string | 必填 | filter name, e.g. gaussian-blur |
| `--layer` | string | 必填 |  |

```bash
ashop filter.add gaussian-blur --layer base --radius 6
ashop filter.add noise --layer base --amount 10 --seed 7
```

> 写操作（自动保存）

### `filter.clear`

Remove all filters from a layer

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string | 必填 |  |

> 写操作（自动保存）

### `filter.list`

List available filters and their parameters

> 只读 · 不需要工程

## fonts

### `fonts.info`

Show how many font files were indexed and where they live

> 只读 · 不需要工程

### `fonts.list`

List installed font families usable by text layers

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--filter` | string |  | substring match on the family name |
| `--limit` | int | `200` |  |

> 只读 · 不需要工程

## help

### `help`

List commands or show help for one command

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<command>` | string |  | command name |

> 只读 · 不需要工程

## history

### `history.branch`

Create a branch at the current commit

别名：`branch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<name>` | string | 必填 |  |
| `--checkout` | bool | `true` | switch to the new branch |

> 写操作（自动保存）

### `history.branches`

List branches

> 只读

### `history.checkout`

Check out a branch or commit (discards uncommitted changes with --force)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<ref>` | string | 必填 |  |
| `--force` | bool | `false` |  |

> 写操作（自动保存）

### `history.diff`

Structural diff between two commits

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<a>` | string | 必填 |  |
| `<b>` | string | `"HEAD"` |  |

> 只读

### `history.log`

Show the commit history of the current branch

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--limit` | int | `20` |  |

> 只读

### `history.reset`

Hard reset the current branch to a ref (e.g. HEAD~1)

别名：`reset`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<ref>` | string | 必填 |  |
| `--hard` | bool | `true` | PDR compatibility flag; resets are always hard in v1 |

> 写操作（自动保存）

### `history.show`

Show one commit and its document summary

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<ref>` | string | `"HEAD"` |  |

> 只读

## init

### `init`

Create a new project (canvas size, or dimensions from an image)

别名：`create`, `new`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<width>` | int |  | canvas width in pixels |
| `<height>` | int |  | canvas height in pixels |
| `--from-image` | path |  | use the dimensions of this image as the canvas |
| `--background` | color | `"transparent"` | canvas background colour |
| `--name` | string |  | project name |

```bash
ashop init 1200 1200
ashop init --from-image shoot.jpg --session sku_1024
```

> 写操作（自动保存） · 不需要工程

## inspect

### `inspect.colors`

Most common colours in the composite or in one layer

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string |  |  |
| `--limit` | int | `8` |  |
| `--quantize` | int | `16` |  |

> 只读

### `inspect.histogram`

Channel histograms of the composite or of one layer

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string |  |  |
| `--bins` | int | `256` |  |

> 只读

### `inspect.image`

Overall summary of the composite or of one layer

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string |  |  |

> 只读

### `inspect.layer`

Render one layer in isolation and report bounds, coverage and hash

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |

> 只读

### `inspect.pixel`

Read the RGBA value at one canvas coordinate

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--at` | point | 必填 | "x,y" |
| `--layer` | string |  | probe one layer instead of the composite |

> 只读

### `inspect.region`

Statistics for a canvas rectangle (mean/min/max/alpha coverage)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--rect` | rect | 必填 | "x,y,w,h" |
| `--layer` | string |  |  |
| `--alpha-threshold` | int | `0` |  |

> 只读

### `inspect.selection`

Bounds and coverage of the active selection

> 只读

## layer

### `layer.duplicate`

Duplicate a layer (and its group children)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |
| `--name` | string |  |  |

> 写操作（自动保存）

### `layer.fill`

Add a fill layer covering the canvas (solid colour or gradient)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--color` | color |  | fill colour |
| `--fill` | paint |  | fill colour or gradient (overrides --color) |
| `--name` | string | `"Fill"` |  |
| `--z-index` | int |  |  |
| `--opacity` | number | `1` |  |
| `--blend` | string | `"normal"` |  |

```bash
ashop layer.fill --color "#102030"
ashop layer.fill --fill "linear-gradient(180deg,#ff0055,#0000ff)" --name backdrop
```

> 写操作（自动保存）

### `layer.group`

Group several layers into a new group

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layers>` | string | 必填 | layer ids/names |
| `--name` | string | `"Group"` |  |

> 写操作（自动保存）

### `layer.import`

Import an image file as a raster layer

别名：`import`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<file>` | path | 必填 | image file (PNG/JPEG/WebP/GIF/TIFF/BMP) |
| `--name` | string |  | layer name (defaults to the file name) |
| `--at` | point |  | top-left position, e.g. "100,50" |
| `--fit` | enum | `"none"` |  |
| `--align` | enum | `"center"` |  |
| `--scale` | number | `1` |  |
| `--rotation` | number | `0` |  |
| `--z-index` | int |  | 0 = bottom |
| `--parent` | string |  | group layer id |
| `--opacity` | number | `1` |  |
| `--blend` | string | `"normal"` |  |

```bash
ashop layer import bg.png --name bg --z-index 0 --fit cover
```

> 写操作（自动保存）

### `layer.info`

Show one layer in full

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |

> 只读

### `layer.list`

List layers bottom-to-top

> 只读

### `layer.merge-down`

Merge a layer into the one below (produces a raster layer)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |

> 写操作（自动保存）

### `layer.move`

Move a layer to another index or parent group

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |
| `--to-index` | int |  | target index in its sibling list (0 = bottom) |
| `--to-parent` | string |  | target group id; omit to keep the current parent |

> 写操作（自动保存）

### `layer.remove`

Delete a layer

别名：`layer.delete`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |

> 写操作（自动保存）

### `layer.set`

Set visibility, opacity, blend mode, name, clipping or lock state

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |
| `--visible` | bool |  | true/false |
| `--opacity` | number |  | 0..1 |
| `--fill-opacity` | number |  | 0..1, affects pixels but not styles |
| `--blend` | enum |  | blend mode |
| `--name` | string |  |  |
| `--clip-to` | string |  | clip this layer to the alpha of a layer below |
| `--locked` | bool |  |  |

```bash
ashop layer set base --blend multiply --opacity 0.8
```

> 写操作（自动保存）

### `layer.transform`

Move / scale / rotate a layer

别名：`transform`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |
| `--x` | number |  | absolute x of the anchor |
| `--y` | number |  |  |
| `--dx` | number |  | relative x shift |
| `--dy` | number |  |  |
| `--scale` | number |  | uniform scale |
| `--scale-x` | number |  |  |
| `--scale-y` | number |  |  |
| `--rotation` | number |  | degrees clockwise |
| `--anchor-x` | number |  | 0..1 of content width |
| `--anchor-y` | number |  | 0..1 of content height |

```bash
ashop layer transform base --dx 20 --dy -10
ashop layer transform logo --scale 0.5 --rotation 15
```

> 写操作（自动保存）

### `layer.ungroup`

Dissolve a group, keeping its children

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |

> 写操作（自动保存）

## mask

### `mask.apply`

Bake a raster layer mask into its pixels and remove the mask

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string | 必填 |  |

> 写操作（自动保存）

### `mask.export`

Export a layer mask as a grayscale PNG

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string | 必填 |  |
| `--out` | path | 必填 | output PNG path |

> 只读

### `mask.from-selection`

Turn the current selection into a layer mask

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string | 必填 |  |
| `--feather` | number | `0` |  |
| `--invert` | bool | `false` |  |

```bash
ashop mask from-selection --layer base --feather 1
```

> 写操作（自动保存）

### `mask.modify`

Feather, grow, shrink, border or invert a layer mask

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string | 必填 |  |
| `--feather` | number | `0` |  |
| `--grow` | number | `0` |  |
| `--shrink` | number | `0` |  |
| `--border` | number | `0` |  |
| `--invert` | bool | `false` |  |

> 写操作（自动保存）

### `mask.remove`

Remove a layer mask

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string | 必填 |  |

> 写操作（自动保存）

## open

### `open`

Open a project bundle and make it current

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<path>` | path | 必填 | path to the .ashop bundle |

```bash
ashop open ./shop.ashop
```

> 写操作（自动保存） · 不需要工程

## plugin

### `plugin.add`

Register an external plugin executable

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--name` | string | 必填 |  |
| `--command` | string | 必填 | executable, e.g. node or python |
| `--args` | json | `[]` | JSON array of arguments |
| `--description` | string | `""` |  |
| `--cwd` | path |  |  |

```bash
ashop plugin.add --name sepia --command node --args "['examples/plugins/sepia.mjs']"
```

> 写操作（自动保存）

### `plugin.list`

List external plugins registered on this project

> 只读

### `plugin.remove`

Unregister a plugin

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--name` | string | 必填 |  |

> 写操作（自动保存）

### `plugin.run`

Run a plugin on a layer (exchanges raw RGBA over stdin/stdout files)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--name` | string | 必填 |  |
| `--layer` | string | 必填 |  |
| `--params` | json | `{}` | plugin-specific parameters |

```bash
ashop plugin.run --name sepia --layer base --params "{\"amount\":0.8}"
```

> 写操作（自动保存）

## render

### `render`

Render the current canvas to an image file

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<out>` | path | 必填 | output file (.png/.jpg/.webp) |
| `--scale` | number | `1` |  |
| `--format` | enum |  | defaults from the extension |
| `--quality` | int | `90` |  |

```bash
ashop render out/preview.png
ashop render out/half.png --scale 0.5
```

> 只读

## run

### `run`

Run a declarative ops JSON script (atomic, dry-run, variables)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<file>` | path | 必填 | ops JSON file |
| `--atomic` | bool | `false` | roll back everything if any step fails |
| `--dry-run` | bool | `false` | validate the plan without changing the document |
| `--commit` | bool | `false` | create one commit after a successful run |
| `--message` | string |  | commit message for --commit |
| `--vars` | json |  | extra variables as JSON object, e.g. {"bg":"#ffffff"} |

```bash
ashop run ops/sku_batch.json --atomic --commit -m "sku batch"
ashop run ops/sku_batch.json --dry-run
```

> 写操作（自动保存）

## save

### `save`

Persist the working document to disk

> 只读

## schema

### `schema`

Dump the full machine-readable command/operator schema

> 只读 · 不需要工程

## select

### `select.all`

Select the whole canvas

> 写操作（自动保存）

### `select.alpha`

Select by the alpha channel of a layer or of the composite

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--threshold` | number | `1` |  |
| `--softness` | number | `0` |  |
| `--layer` | string |  |  |
| `--mode` | enum | `"replace"` |  |
| `--feather` | number | `0` |  |

> 写操作（自动保存）

### `select.color`

Select by colour similarity (like Photoshop’s colour range)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--color` | color | 必填 |  |
| `--tolerance` | number | `20` | 0..255 euclidean RGB distance |
| `--metric` | enum | `"rgb"` |  |
| `--layer` | string |  | sample this layer instead of the composited canvas |
| `--contiguous` | bool | `false` | only the connected region around --at |
| `--at` | point |  | seed point for contiguous mode |
| `--mode` | enum | `"replace"` |  |
| `--feather` | number | `0` |  |

```bash
ashop select color --color "#f2f2f2" --tolerance 12
ashop select color --color "#ffffff" --at "600,40" --contiguous --tolerance 24
```

> 写操作（自动保存）

### `select.ellipse`

Select an ellipse

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--ellipse` | numberList | 必填 | "cx,cy,rx,ry[,rotation]" |
| `--mode` | enum | `"replace"` |  |
| `--feather` | number | `0` |  |

> 写操作（自动保存）

### `select.invert`

Invert the current selection

> 写操作（自动保存）

### `select.luminance`

Select by luminance threshold

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--threshold` | number | `128` |  |
| `--softness` | number | `0` |  |
| `--layer` | string |  |  |
| `--mode` | enum | `"replace"` |  |
| `--feather` | number | `0` |  |

> 写操作（自动保存）

### `select.modify`

Grow / shrink / feather / border the current selection

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--grow` | number | `0` |  |
| `--shrink` | number | `0` |  |
| `--feather` | number | `0` |  |
| `--border` | number | `0` |  |

> 写操作（自动保存）

### `select.none`

Clear the selection

> 写操作（自动保存）

### `select.path`

Select a region from SVG path data

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--svg-path` | string | 必填 | SVG path d, e.g. "M10 10 H90 V90 Z" |
| `--mode` | enum | `"replace"` |  |
| `--feather` | number | `0` |  |
| `--fill-rule` | enum | `"nonzero"` |  |

> 写操作（自动保存）

### `select.polygon`

Select a polygon

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--polygon` | polygon | 必填 | "x1,y1 x2,y2 ..." |
| `--mode` | enum | `"replace"` |  |
| `--feather` | number | `0` |  |
| `--fill-rule` | enum | `"nonzero"` |  |

> 写操作（自动保存）

### `select.rect`

Select a rectangle (canvas space)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--rect` | rect | 必填 | "x,y,w,h" |
| `--mode` | enum | `"replace"` |  |
| `--feather` | number | `0` |  |

> 写操作（自动保存）

## shape

### `shape.add`

Add a vector shape layer (rect / ellipse / polygon / path)

别名：`shape`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<kind>` | enum | 必填 |  |
| `--rect` | rect |  | rect geometry "x,y,w,h" |
| `--ellipse` | numberList |  | ellipse geometry "cx,cy,rx,ry" |
| `--polygon` | polygon |  | polygon points |
| `--svg-path` | string |  | path data |
| `--box` | rect |  | content box for path shapes (defaults to canvas) |
| `--radius` | number | `0` | corner radius for rect |
| `--fill` | paint |  | fill colour or CSS gradient, e.g. "#ff0055" or "linear-gradient(90deg,#f05,#05f)" |
| `--fills` | json |  | JSON array of fills, bottom first (overrides --fill) |
| `--stroke` | paint |  | stroke colour or gradient |
| `--strokes` | json |  | JSON array of strokes, bottom first (overrides --stroke) |
| `--stroke-width` | number |  | stroke width in px (default 2 when --stroke is given) |
| `--stroke-linecap` | enum |  | stroke line cap |
| `--stroke-linejoin` | enum |  | stroke line join |
| `--stroke-miterlimit` | number |  | miter limit for miter joins |
| `--stroke-dash` | numberList |  | dash pattern in px, e.g. "8,4" |
| `--stroke-dash-offset` | number |  | dash phase offset in px |
| `--name` | string | `"Shape"` |  |
| `--z-index` | int |  |  |
| `--opacity` | number | `1` |  |
| `--blend` | string | `"normal"` |  |
| `--rotation` | number | `0` |  |

```bash
ashop shape.add rect --rect "100,80,400,120" --radius 16 --fill "#ff0055"
ashop shape.add ellipse --ellipse "600,400,200,120" --fill "linear-gradient(90deg,#ff0055,#0000ff)"
ashop shape.add rect --rect "100,80,400,120" --fill "#102030" --stroke "#ffffff" --stroke-width 3 --stroke-dash "8,4"
```

> 写操作（自动保存）

### `shape.export`

Export a shape layer as a standalone SVG file

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |
| `<out>` | path | 必填 | output .svg path |
| `--scale` | number | `1` | output scale factor |

```bash
ashop shape.export logo out/logo.svg --scale 2
```

> 只读

### `shape.import`

Import an SVG file as a vector shape layer

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<file>` | path | 必填 | SVG file to import |
| `--name` | string |  | layer name (defaults to the file name) |
| `--z-index` | int |  | 0 = bottom |
| `--at` | point |  | top-left position on canvas |
| `--scale` | number | `1` |  |
| `--rotation` | number | `0` |  |
| `--opacity` | number | `1` |  |
| `--blend` | string | `"normal"` |  |

```bash
ashop shape.import logo.svg --name logo --at 40,40
```

> 写操作（自动保存）

### `shape.info`

Show a shape layer’s vector content and paint stacks

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |

> 只读

### `shape.set`

Restyle a shape layer: fills, strokes, stroke details, radius, fill rule

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |
| `--fill` | paint |  | fill colour or CSS gradient, e.g. "#ff0055" or "linear-gradient(90deg,#f05,#05f)" |
| `--fills` | json |  | JSON array of fills, bottom first (overrides --fill) |
| `--stroke` | paint |  | stroke colour or gradient |
| `--strokes` | json |  | JSON array of strokes, bottom first (overrides --stroke) |
| `--stroke-width` | number |  | stroke width in px (default 2 when --stroke is given) |
| `--stroke-linecap` | enum |  | stroke line cap |
| `--stroke-linejoin` | enum |  | stroke line join |
| `--stroke-miterlimit` | number |  | miter limit for miter joins |
| `--stroke-dash` | numberList |  | dash pattern in px, e.g. "8,4" |
| `--stroke-dash-offset` | number |  | dash phase offset in px |
| `--fill-rule` | enum |  |  |
| `--radius` | number |  | corner radius for rect objects |
| `--shape-index` | int |  | target one vector object instead of the layer defaults |
| `--opacity` | number |  | per-object opacity (requires --shape-index) |

```bash
ashop shape.set logo --fill "linear-gradient(120deg,#ff0055,#0000ff)"
ashop shape.set logo --stroke "#ffffff" --stroke-width 2 --stroke-linecap round
ashop shape.set logo --shape-index 0 --fill "#00ffaa"
ashop shape.set badge --fill none --stroke "#222222" --stroke-width 4
```

> 写操作（自动保存）

## status

### `status`

Show canvas, layers, selection and history state

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--with-selection` | bool | `false` | include selection bounds/coverage |
| `--layer` | string |  | focus a single layer |

> 只读

## style

### `style.add`

Add a layer style (drop shadow, stroke, glow, bevel)

别名：`style`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<style>` | string | 必填 | style name, e.g. drop-shadow |
| `--layer` | string |  | layer id or name |
| `--target` | string |  | alias for --layer |

```bash
ashop style.add drop-shadow --layer base --color "#00000055" --offset-y 12 --blur 24
ashop style.add stroke --layer logo --width 3 --color "#ffffff"
```

> 写操作（自动保存）

### `style.info`

List the styles on one layer

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string | 必填 |  |

> 只读

### `style.list`

List available layer styles

> 只读 · 不需要工程

### `style.remove`

Remove a layer style by type or index

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--layer` | string | 必填 |  |
| `--type` | string |  |  |
| `--index` | int |  |  |

> 写操作（自动保存）

## text

### `text.add`

Add a text layer (vector outlines, deterministic layout)

别名：`text`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--content` | string | 必填 | text contents; use \n for newlines |
| `--font` | string | `"Segoe UI"` | font family or path |
| `--font-file` | path |  | explicit font file |
| `--size` | number | `72` |  |
| `--color` | color | `"#000000"` |  |
| `--fill` | paint |  | fill colour or gradient (overrides --color) |
| `--pos` | point | `{"x":0,"y":0}` | top-left position |
| `--width` | number | `0` | wrap width in px (0 = no wrap) |
| `--align` | enum | `"left"` |  |
| `--line-height` | number | `1.2` |  |
| `--letter-spacing` | number | `0` |  |
| `--weight` | int | `400` |  |
| `--italic` | bool | `false` |  |
| `--stroke-color` | paint |  |  |
| `--stroke-width` | number | `0` |  |
| `--stroke-linecap` | enum | `"round"` |  |
| `--stroke-linejoin` | enum | `"round"` |  |
| `--stroke-dash` | numberList |  |  |
| `--name` | string |  |  |
| `--z-index` | int |  |  |
| `--opacity` | number | `1` |  |

```bash
ashop text.add --content "SUMMER" --font "Arial" --size 72 --color "#ff0055" --pos "600,100"
ashop text.add --content "GRADIENT" --size 96 --fill "linear-gradient(90deg,#ff0055,#0000ff)" --pos "120,120"
```

> 写操作（自动保存）

### `text.measure`

Measure text without creating a layer

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--content` | string | 必填 |  |
| `--font` | string | `"Segoe UI"` |  |
| `--font-file` | path |  |  |
| `--size` | number | `72` |  |
| `--width` | number | `0` |  |
| `--line-height` | number | `1.2` |  |
| `--letter-spacing` | number | `0` |  |
| `--weight` | int | `400` |  |

> 只读 · 不需要工程

### `text.set`

Edit a text layer (re-measures automatically)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `<layer>` | string | 必填 |  |
| `--content` | string |  |  |
| `--font` | string |  |  |
| `--size` | number |  |  |
| `--color` | color |  |  |
| `--fill` | paint |  | fill colour or gradient (overrides --color) |
| `--width` | number |  |  |
| `--align` | enum |  |  |
| `--line-height` | number |  |  |
| `--letter-spacing` | number |  |  |
| `--weight` | int |  |  |
| `--stroke-color` | paint |  |  |
| `--stroke-width` | number |  |  |
| `--stroke-linecap` | enum |  |  |
| `--stroke-linejoin` | enum |  |  |
| `--stroke-dash` | numberList |  |  |

> 写操作（自动保存）

## 算子目录

### 混合模式

`normal` · `darken` · `multiply` · `color-burn` · `linear-burn` · `lighten` · `screen` · `color-dodge` · `linear-dodge` · `overlay` · `soft-light` · `hard-light` · `vivid-light` · `linear-light` · `pin-light` · `hard-mix` · `difference` · `exclusion` · `subtract` · `divide` · `darker-color` · `lighter-color` · `hue` · `saturation` · `color` · `luminosity`

### 调整（adjust.add）

#### `brightness-contrast` — Brightness / Contrast

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--brightness` | number | `0` | additive brightness in -255..255 |
| `--contrast` | number | `0` | contrast multiplier delta, -100..100 |

#### `color-balance` — Color Balance

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--shadows` | vec3 | `[0,0,0]` | RGB deltas -100..100 for shadows |
| `--midtones` | vec3 | `[0,0,0]` | RGB deltas -100..100 for midtones |
| `--highlights` | vec3 | `[0,0,0]` | RGB deltas -100..100 for highlights |
| `--preserveLuminosity` | boolean | `true` |  |

#### `curves` — Curves

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--rgb` | curve | `[[0,0],[255,255]]` | control points [[x,y],...] 0..255 |
| `--r` | curve |  | optional red-channel curve |
| `--g` | curve |  | optional green-channel curve |
| `--b` | curve |  | optional blue-channel curve |

#### `desaturate` — Desaturate

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--amount` | number | `1` | 0..1, 1 = fully grey |

#### `gamma` — Gamma

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--gamma` | number | `1` | gamma exponent, 1 = unchanged |

#### `hue-saturation` — Hue / Saturation

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--hue` | number | `0` | hue rotation in degrees |
| `--saturation` | number | `1` | saturation multiplier, 1 = unchanged, 0 = grey |
| `--lightness` | number | `0` | lightness delta -1..1 |

#### `invert` — Invert

#### `levels` — Levels

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--black` | number | `0` | input black point 0..255 |
| `--white` | number | `255` | input white point 0..255 |
| `--gamma` | number | `1` | midpoint gamma |
| `--outBlack` | number | `0` | output black 0..255 |
| `--outWhite` | number | `255` | output white 0..255 |
| `--channel` | string | `"rgb"` | rgb \| r \| g \| b |

#### `posterize` — Posterize

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--levels` | integer | `4` | number of tonal steps (2..255) |

#### `threshold` — Threshold

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--threshold` | number | `128` | luminance cut point 0..255 |
| `--softness` | number | `0` | transition width in levels |

#### `vibrance` — Vibrance

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--amount` | number | `0.5` | -1..1 |

### 滤镜（filter.add）

#### `emboss` — Emboss

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--strength` | number | `1` | edge amplification |
| `--angle` | number | `45` | light direction in degrees |

#### `gaussian-blur` — Gaussian Blur

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--radius` | number | `8` | blur radius in pixels (sigma = radius / 2) |

#### `liquify` — Liquify

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--ops` | json | `[]` | array of {mode,x,y,radius,dx,dy,angle,strength} displacement ops |

#### `motion-blur` — Motion Blur

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--length` | number | `24` | streak length in pixels |
| `--angle` | number | `0` | direction in degrees (0 = horizontal) |
| `--samples` | integer | `24` | sampling density |

#### `noise` — Add Noise

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--amount` | number | `12` | noise amplitude 0..255 |
| `--seed` | integer | `1` | deterministic seed |
| `--monochrome` | boolean | `false` |  |
| `--gaussian` | boolean | `true` |  |

#### `pixelate` — Pixelate

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--size` | integer | `8` | block size in pixels |

#### `sharpen` — Sharpen (Unsharp Mask)

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--amount` | number | `1` | strength, 0..5 |
| `--radius` | number | `2` | detail radius in pixels |
| `--threshold` | number | `0` | ignore differences below this (0..255) |

### 图层样式（style.add）

#### `bevel` — Bevel & Emboss

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--size` | number | `8` |  |
| `--depth` | number | `1` |  |
| `--angle` | number | `120` |  |
| `--highlight` | color | `"#ffffff"` |  |
| `--shadow` | color | `"#000000"` |  |
| `--opacity` | number | `0.7` |  |

#### `drop-shadow` — Drop Shadow

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--color` | color | `"#00000080"` |  |
| `--offsetX` | number | `0` |  |
| `--offsetY` | number | `12` |  |
| `--blur` | number | `24` | blur radius in px |
| `--spread` | number | `0` | dilation in px before blur |
| `--opacity` | number | `1` | 0..1 |

#### `inner-glow` — Inner Glow

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--color` | color | `"#ffff80"` |  |
| `--blur` | number | `12` |  |
| `--opacity` | number | `0.75` |  |

#### `outer-glow` — Outer Glow

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--color` | color | `"#ffffff"` |  |
| `--blur` | number | `16` |  |
| `--opacity` | number | `0.7` |  |

#### `stroke` — Stroke

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--color` | color | `"#ffffff"` |  |
| `--width` | number | `4` |  |
| `--position` | string | `"outside"` | outside \| inside \| center |
| `--opacity` | number | `1` |  |

## 批处理文件格式

```json
{
  "vars": {
    "tolerance": 12
  },
  "steps": [
    {
      "op": "select.color",
      "args": {
        "color": "#f2f2f2",
        "tolerance": "${tolerance}"
      }
    },
    {
      "op": "select.invert"
    },
    {
      "op": "mask.from-selection",
      "args": {
        "layer": "base",
        "feather": 1
      }
    },
    {
      "op": "assign",
      "args": {
        "var": "maskedLayer",
        "path": "layer.id"
      }
    },
    {
      "op": "echo",
      "args": {
        "message": "done"
      }
    }
  ]
}
```

- `${var}` 支持整串替换（保留类型）与字符串内插；变量来自文件 `vars` 与 `--vars`。
- `assign` 把上一步结果里的某个路径存进变量；`echo` 只记录一条消息。
- `--atomic` 失败回滚文档与历史；`--dry-run` 只校验计划（不检查运行时状态）。
