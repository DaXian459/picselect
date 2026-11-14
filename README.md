# PicSelect

轻量、快速的本地照片查看与标记工具。单目录浏览 + 缩略图预加载 + 星级/收藏/标签，支持 JPEG / PNG / GIF / WebP / BMP / AVIF / SVG / TIFF，以及索尼 ARW、佳能 CR2/CR3、尼康 NEF 等 20 余种 RAW 格式——RAW 是**真解码传感器数据**（LibRaw/WASM），不是拿相机内嵌的 JPEG 凑数。

- 运行时只有两个包：Electron 本体 + `libraw-wasm`（约 2MB 的 WASM）。无打包构建、无前端框架，改代码即时生效。
- 界面为原生 ES Module + CSS，深/浅色双主题，窗口宽度 720px 至全屏自适应。

![网格视图](docs/screenshot-grid.png)

<p align="center"><img src="docs/screenshot-viewer.png" alt="大图查看" width="100%"></p>

## 快速开始

```bash
npm install     # 装 electron 与 libraw-wasm
npm start
```

Windows 上也可以直接双击 `start.bat`（会自动检查依赖，缺失时执行 `npm install`）。

启动后点左上角「打开文件夹」，或直接把文件夹/图片拖进窗口。程序会记住上次打开的目录，下次启动自动恢复。

命令行参数：

```bash
npx electron . --open "D:\Photos"      # 启动即打开指定目录
npx electron . --select 3             # 打开后定位到第 3 张（配合 --open）
npx electron . --theme light          # 强制浅色
```

## 打包成 Windows 程序

```bash
npm run pack    # 只出免安装目录 dist/win-unpacked（约 10 秒，用来快速验证）
npm run dist    # 出安装包 + 便携版（首次约 2 分钟，需下载 NSIS 等打包工具）
```

产物在 `dist/`：

| 文件 | 体积 | 说明 |
| --- | --- | --- |
| `PicSelect-1.0.0-setup.exe` | 116 MB | NSIS 安装包，可选安装目录，建桌面/开始菜单快捷方式 |
| `PicSelect-1.0.0-portable.exe` | 106 MB | 单文件便携版，双击即用，不写注册表 |
| `win-unpacked/` | 358 MB | 免安装目录，可直接运行 `PicSelect.exe` |

几点说明：

- **体积**基本就是 Electron 运行时（约 355 MB 解压后），应用自身的代码只有 268 KB。
- **便携版是绿色版**：数据写在 exe 同级的 `PicSelectData/`，整个文件夹拷到 U 盘换台机器打开，标记和偏好都还在。放在只读目录时会自动退回 `%APPDATA%\PicSelect`。
- **没有 asar 打包**：`app://` 协议是把真实文件路径交给 `net.fetch` 处理，保持散文件可以让打包版和开发时行为完全一致，避免 asar 虚拟路径取不到图片。
- **未做代码签名**：首次运行 Windows SmartScreen 会提示「未知发布者」，点「更多信息 → 仍要运行」即可。要消除提示需自备签名证书。
- 打包脚本内置 npmmirror 镜像（`scripts/dist.js`），国内网络不会卡在 GitHub 下载。

## 功能结构

```
┌──────────────────────────────────────────────┐
│ 标题栏  打开文件夹 / 重扫 / 搜索  缩略图大小 主题 信息 │
├──────────────────────────────────────────────┤
│ 筛选条  全部 · 收藏 · 3星以上 · 未标记  |  标签 排序 计数 │
├───────────────────────────┬──────────────────┤
│                           │                  │
│   网格视图 / 大图查看器      │   图片信息面板     │
│                           │   EXIF + 标记     │
├───────────────────────────┴──────────────────┤
│ 状态栏  当前目录 · 缓存条数 · 位置 · 缩放比例        │
└──────────────────────────────────────────────┘
```

- **网格视图**：虚拟化渲染，无论目录里有 10 张还是 1 万张，DOM 里始终只有可视区附近的瓦片。每张瓦片带角标（格式/RAW）、收藏心形和可点击的星级。
- **大图查看器**：A/B 双层 `<img>` 交叉淡入，切图无白闪；支持滚轮以光标为锚点缩放、拖拽平移、双击在「适应窗口 / 100%」间切换。
- **信息面板**：文件名、尺寸、体积、修改时间、格式、预览来源，以及相机/镜头/光圈/快门/ISO/焦距/拍摄时间/方向。
- **标记**：0–5 星评分、收藏、任意标签（去重，单张最多 24 个）。网格、查看器、信息面板三处操作实时同步。
- **导出**：把当前筛选结果复制到一个目录，并附一份 CSV 清单（星级、标签、EXIF、原路径）。范围就是「网格里现在看到的东西」，所以「筛收藏 → 导出」就是交付收藏。
- **外部程序**：查看器里一键把当前照片送到 Photoshop / Lightroom，RAW 交给 Photoshop 会自动进入 Camera Raw。

## 导出与外部程序

### 导出

点筛选条右侧的「导出」（或 `Ctrl + E`）：

1. 选一个目标文件夹（记住上次的选择）；
2. 命中的照片复制过去，同名文件自动改名为 `name (1).jpg`，不会覆盖；
3. 同目录生成 `PicSelect-导出清单-20261114-1305.csv`，带 UTF-8 BOM，Excel 双击直接打开不乱码。

清单列：文件名、星级、收藏、标签、宽、高、体积、修改时间、拍摄时间、相机、镜头、光圈、快门、ISO、焦距、导出文件名、原路径。

导出范围跟随筛选条，所以常见组合是：

| 想要 | 操作 |
| --- | --- |
| 所有收藏 | 筛「收藏」→ 导出 |
| 三星以上精选 | 筛「3 星以上」→ 导出 |
| 某个标签的图 | 标签下拉选标签 → 导出 |
| 搜索结果 | 搜索框输入 → 导出 |
| 挑过的全部（有星或有标签） | 筛「未标记」的反面不好直接选，建议用标签或星级筛选 |

### Photoshop / Lightroom

查看器底部工具条右侧有 **Ps** 和 **Lr** 两个按钮（快捷键 `P` / `L`）。

- **自动探测**：启动时扫 `%ProgramFiles%\Adobe\Adobe Photoshop*` 与 `Adobe Lightroom*`，多版本取最新的。
- **没装 / 装在非标准路径**：按钮变暗，点一下会弹出文件选择器让你指定 `Photoshop.exe` / `Lightroom.exe`，路径存进配置，之后一直有效。
- **Camera Raw**：没有独立的 Camera Raw 程序，RAW 文件直接用 Photoshop 打开时，PS 会自动用 Camera Raw 打开它——这就是「用 Camera Raw 编辑」的常规路径。
- **Lightroom Classic** 接收命令行文件参数时走的是「导入」流程，可能需要在 LR 里确认一次。

> 早期版本用 `reg query` 读注册表定位 Adobe 安装路径，但那样每次启动都要起一个 `reg.exe` 子进程，在开了软件限制策略或行为拦截的机器上会被直接拦住，收益也有限，已改为纯目录扫描 + 手动指定。

## 格式支持

| 类别 | 扩展名 | 处理方式 |
| --- | --- | --- |
| 常见位图 | `.jpg .jpeg .jpe .jfif .png .apng .gif .webp .bmp .avif .ico` | Chromium 原生解码，`img-src` 直出 |
| 矢量 | `.svg` | 原生渲染，缩略图另存为栅格缓存 |
| TIFF | `.tif .tiff` | 主进程纯 JS 解码（无压缩 / LZW / Deflate / PackBits，含 predictor、16bit、CMYK、调色板），转 PNG |
| RAW | `.arw .srf .sr2 .cr2 .cr3 .crw .nef .nrw .dng .orf .rw2 .raf .pef .srw .raw .rwl .x3f .3fr .erf .mrw` | 渲染进程用 LibRaw(WASM) 解码传感器数据，转 JPEG；失败才回退内嵌预览 |

### RAW 是解出来的，不是相机里那张 JPEG

早期版本直接抽文件里内嵌的那张 JPEG 预览给用户看。这样做很快，但看到的是相机的机内处理结果（Picture Style、对比度、锐化、降噪全都烘焙好了），并不是 RAW 数据本身。现在改成真正解码传感器数据。

链路是这样的：

```
主进程  /bytes/<base64url>   → 按需流式吐出 .ARW 原始字节
        /vendor/libraw/*    → 供出 libraw-wasm 的 ESM / worker / .wasm
渲染进程 raw-develop.js      → libraw.open(bytes) → imageData() → RGB → JPEG
```

几个关键参数：

| 参数 | 取值 | 原因 |
| --- | --- | --- |
| `halfSize` | 目标宽 ≤2048 时为 `true` | 半尺寸解码快约 4 倍。6000px 级传感器半尺寸约 3000px，仍高于输出宽，等于白拿速度 |
| `useCameraWb` | `true` | 用机内白平衡，避免偏色 |
| `outputBps` / `outputColor` | `8` / `1` | 8 位、sRGB，直接喂给 JPEG 编码器 |
| `userQual` | `3` | AHD 去马赛克，质量和速度的平衡点 |
| `userFlip` | `-1` | 用 RAW 自带的方向信息，不额外翻转 |

`LibRaw` 是编译成 WASM 的浏览器形态，依赖 Web Worker 和 `fetch`，所以只能跑在渲染进程——放在主进程会直接报 `self is not defined`。代价是解码在主线程旁边跑，收益是不用为它装任何原生模块，打包体积也只多 2MB 左右。

解码是**单实例串行**的（libraw-wasm 内部状态不可重入），靠一个 Promise 队列排队。结果按 `版本|路径|mtime|目标宽` 缓存进 IndexedDB，再用一个 24 条的 objectURL LRU 兜住频繁来回翻页。

性能实测（索尼 A6700，33MB ARW）：半尺寸 3120×2084 约 670ms，缩略图（880 宽）再快一些；命中缓存后是毫秒级。所以查看器会**先贴缩略图垫底、解码完再替换**，翻页不会有空白等待。

解不出来的文件（异常容器、损坏文件）会被记下来，不再反复重试，并在缩略图与查看器里回退到老路径：IFD 定向抽取 → 全文件扫描 JPEG 标记 → 系统缩略图接口。这条兜底链完整保留在 `src/main/raw/`，也是 fixture 里那几个「假 RAW」能正常显示的原因。

## 快捷键

| 键 | 作用 |
| --- | --- |
| `Ctrl + O` | 打开文件夹 |
| `Ctrl + E` | 导出当前筛选结果 |
| `F5` | 重新扫描当前目录 |
| `/` | 聚焦搜索框 |
| `←` `→` / `J` `K` | 上一张 / 下一张 |
| `空格` / `Shift + 空格` | 下一张 / 上一张 |
| `Home` `End` | 第一张 / 最后一张 |
| `0`–`5` | 打 0–5 星 |
| `F` | 收藏 / 取消收藏 |
| `T` | 添加标签 |
| `I` | 显示 / 隐藏信息面板 |
| `G` | 网格 ⇄ 大图切换 |
| `P` / `L` | 用 Photoshop / Lightroom 打开当前照片 |
| `+` `-` `Ctrl + 0` | 放大 / 缩小 / 适应窗口 |
| 双击图片 | 适应窗口 ⇄ 100% |
| `Esc` | 关闭查看器 / 取消输入 |

## 数据存储

| 内容 | 位置 |
| --- | --- |
| 标记与偏好 | `%APPDATA%\PicSelect\library.json` |
| RAW 解码缓存 | IndexedDB（渲染进程，键含路径/mtime/目标宽） |
| RAW 内嵌预览兜底缓存 | `%APPDATA%\PicSelect\cache\raw\<sha1>.jpg`（上限 500MB，自动清理最旧） |
| 缩略图缓存 | IndexedDB（渲染进程，库名 `picselect`） |

便携版（`PicSelect-*-portable.exe`）把上面三项整体放在 exe 同级的 `PicSelectData\` 下，不再写入 `%APPDATA%`。

`library.json` 采用原子写入（临时文件 + rename，失败指数退避重试）加上 220ms 防抖，程序退出前会强制 `flush()`，不会出现半截文件。删除这个文件即可重置所有标记，照片本身永不被修改。

```json
{
  "version": 1,
  "photos": {
    "d:\\photos\\dsc01835.arw": { "rating": 4, "favorite": true, "tags": ["人像", "待修"] }
  },
  "prefs": {
    "lastDir": "D:\\Photos",
    "exportDir": "D:\\交付\\2026-11-14",
    "theme": "system",
    "thumbSize": 168,
    "sort": "name",
    "external": { "photoshop": "C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe", "lightroom": null }
  }
}
```

`external` 里为 `null` 表示交给自动探测；填了绝对路径就以它为准（每次使用前会校验文件是否还在，失效则回落到自动探测）。

## 目录结构

```
src/main/            主进程
  main.js            启动、命令行参数、单实例
  window.js          无边框窗口 + 标题栏叠加
  protocol.js        app:// 协议（页面、样式、图片字节、RAW/TIFF 转码、libraw 静态资源）
  ipc.js             全部 IPC 通道
  library.js         目录扫描（非递归，中文本地化自然排序）
  store.js           library.json 原子持久化
  exporter.js        导出：复制照片 + 生成 CSV 清单
  external.js        Photoshop / Lightroom 探测与调用
  exif/              TIFF/IFD 解析、EXIF 提取、方向处理、尺寸嗅探
  tiff/              纯 JS TIFF 解码器 + PNG 编码器（LZW/PackBits/Deflate）
  raw/               RAW 内嵌预览兜底链（IFD → 全文件扫描 → 系统兜底）
src/preload/         contextBridge 白名单
src/renderer/        index.html、styles/、js/
  js/raw-develop.js  LibRaw(WASM) 传感器解码，带缓存与串行队列
scripts/             测试素材生成、解析器断言、UI 端到端测试、截图、CDP 探针
fixtures/            程序生成的测试图片（29 个）
raw/                 放真实 RAW 样片的地方（不纳入版本控制）
```

### 为什么用 `app://` 而不是 `file://`

`file://` 下页面没有正常的 origin，IndexedDB 与 Web Storage 会被禁用，`fetch` 也不可用。所以注册了一个 `standard + secure` 的自定义 scheme：页面和图片同 host（`app://picselect/`），既拿到了存储能力，又避免了跨域与 CORS 问题。

图片路径全部用 base64url 整串编码进 URL，绕开 Windows 反斜杠、中文文件名和 `#?%` 的 URL 解析陷阱。

### 方向为什么不会转两次

Chromium 默认按 EXIF 的 `Orientation` 自动旋转（`image-orientation: from-image`），所以渲染层一律不做旋转。主进程只负责让图片「字节自己说清楚」：RAW 内嵌预览若缺 APP1 就注入一个最小 EXIF 头；TIFF 解码时直接在像素层烘焙旋转并清除方向标记。两层各司其职，图片永远不会被转两遍。

## 测试

```bash
npm run fixtures      # 生成 29 个测试素材（含 8 种方向、6 种 TIFF 编码、3 种 RAW 布局）
npm test              # 解析器 33 项 + 导出 12 项 + 外部程序探测 8 项，纯 Node 运行
npm run test:ui       # 端到端交互：41 项（含 IPC 导出、按钮渲染、持久化、缓存、RAW 解码）
npm run shot -- --scene grid --theme dark --out shots/grid.png
```

测试里有三类值得注意的技巧：

- **导出测试**直接把 fixtures 目录当图库、导出到临时目录，断言文件数、CSV 的 BOM 与列内容、同名冲突改名、目录外路径被拒绝——全在纯 Node 下跑，不用起窗口。
- **外部程序测试**用临时目录伪造出 `Adobe/Adobe Photoshop 2026/Photoshop.exe` 这种结构，验证多版本选新、不会误认 Photoshop Elements、手动路径失效后回落。所以即使没装 Adobe 也能测。
- **RAW 测试**分两层：`app://` 的 vendor 路由、wasm 的 MIME、越界路径被拒绝，这几项任何环境都能断言；真实解码则需要 `raw/` 里有样片（没有就打印跳过、不算失败），断言解出的像素尺寸、JPEG 头、走的是解码分支而非内嵌预览、以及二次取图命中缓存。`raw/` 不进版本控制，所以这段测试跟着本机素材走。

打包产物另有一道验证：exe 带 `--remote-debugging-port=9222` 启动，用 `scripts/cdp-eval.js` 连上去在页面里执行代码。这能证明 wasm 真的从 `resources/app/node_modules` 里被 `app://` 供出来了——`asar: false` 加自定义协议这套组合，恰恰是最容易在打包后失效、而开发模式下永远测不出来的部分。

```bash
node scripts/cdp-eval.js "window.__picselect.state.items.length"
node scripts/peek-preview.js raw/DSC01839.ARW shots/embedded.jpg   # 抽相机内嵌预览做对照
```

## 已知限制

- **HEIC/HEIF 不支持**：Chromium 无 HEVC 解码能力，纯 JS 实现不划算，扫描时直接跳过并在状态栏提示。
- **RAW 是中性解码**：显示的是传感器数据经 LibRaw 中性渲染的结果，没有相机机内风格（对比度、锐化、降噪），所以看起来会比相机直出的 JPEG「平」一些——这正是看 RAW 的意义。LibRaw 不认识的机型会回退到内嵌预览。
- **RAW 首帧要等**：一张没缓存的 ARW 大图约 1~1.5 秒，期间先显示缩略图。缓存后会立刻出来。
- **CR3 是 ISO BMFF 容器**：不走 TIFF/IFD 路径，解码靠 LibRaw，兜底靠全文件扫描或系统缩略图。
- **大尺寸 TIFF**：分块（Tiled）TIFF 暂不支持，会降级为系统缩略图；超过 64MB 的文件只读取头部提取 EXIF。
- **单目录、非递归**：不做目录树，一次只浏览一个文件夹。需要批量操作请配合系统文件管理器。
- **导出是复制不是移动**：原文件始终不动。导出目录里同名文件会加 `(1)` 后缀，不会覆盖已有文件。
- **Lightroom 是「导入」不是「打开」**：Lightroom Classic 收到文件参数会走导入流程，可能需要在 LR 侧确认；想直接调色更适合用 Photoshop（RAW 会自动进 Camera Raw）。
