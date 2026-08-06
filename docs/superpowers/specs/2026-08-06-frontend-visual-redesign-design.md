# 前端视觉重做设计文档

日期：2026-08-06
状态：待实施
范围：`frontend/` 视觉层与布局，**不改动任何功能逻辑，不改动后端**

---

## 1. 问题诊断

用户反馈「前端整体太丑」。根因不是配色，而是**层级系统失效**。

现有主题是新拟态（neumorphism），用同色系双向阴影（`6px 6px 12px #c8cdd4, -6px -6px 12px #ffffff`）表达深度。这套语言有三个固有代价：

1. **对比度天然低** —— 阴影与底色同色系，边界靠明度微差
2. **边界模糊** —— 没有硬边，元素轮廓不确定
3. **每个盒子都在发光** —— 全站 39 处 `nm-*` / `box-shadow`，视觉重点被均摊掉

本项目是密集数据工具：结果网格一次渲染几十张卡片，每张含 13 行参数对比。这恰好是新拟态最不擅长的场景。

### 1.1 实测的无障碍缺陷

以下为脚本实测（WCAG 2.1 相对亮度公式），非估计：

| 用法 | 前景/背景 | 实测对比度 | 要求 | 结论 |
|---|---|---|---|---|
| 强调色文字 | `#6C9BD1` / `#E8EDF2` | **2.46:1** | 4.5:1 | 不合格 |
| 次要文字 | `#8a9ab0` / `#E8EDF2` | **2.43:1** | 4.5:1 | 不合格 |
| 主按钮白字 | `#ffffff` / `#6C9BD1` | **2.90:1** | 4.5:1 | 不合格 |
| 正文 | `#3a4a5c` / `#E8EDF2` | 7.70:1 | 4.5:1 | 合格 |

即：**全站主按钮文字、次要说明文字、所有强调色文字均低于可读门槛**。

### 1.2 另外两个既有缺陷

- `global.css` 声明 `font-family: 'Inter', ...`，但项目从未加载该字体（无 `@font-face`、无 `<link>`、无 npm 包），一直静默回退到系统字体。
- 全站无任何 `:focus-visible` 样式，键盘操作时无法看到焦点位置。

---

## 2. 方向

采用 Linear / Vercel / Raycast 一类开发者工具的视觉语言：

- **边框优先，阴影退场** —— 1px 细边框 + 背景色微差划分区域；阴影只保留给真正的浮层（弹窗、抽屉）
- **层级交给字重与间距** —— 而非光影
- **颜色只用于状态与强调** —— 表面近单色
- **数字用等宽字体** —— 参数对比表逐列对齐

---

## 3. 设计令牌

替换 `frontend/src/assets/styles/variables.css` 全部内容。

```css
:root {
  /* 表面：近单色，层级靠微差 */
  --bg:             #FBFBFC;
  --surface:        #FFFFFF;
  --surface-sunken: #F3F4F6;
  --surface-hover:  #F7F8F9;

  /* 边框承担原本阴影的职责 */
  --border:         #E8EAED;
  --border-strong:  #D8DBDF;

  /* 文字三级 */
  --text:           #16181D;
  --text-secondary: #5A6069;
  --text-muted:     #8B919B;

  /* 强调色：accent 用于填充，accent-ink 用于淡底上的文字 */
  --accent:         #2F6FE0;
  --accent-ink:     #1F5AC4;
  --accent-soft:    #EEF3FE;

  /* 语义色 */
  --danger:         #C7362F;
  --success:        #1F7F4F;
  --warning:        #9A5B00;

  /* 焦点环 —— 现有代码完全缺失 */
  --ring:           0 0 0 3px rgba(47,111,224,.20);

  /* 圆角 */
  --r-sm: 6px;  --r-md: 8px;  --r-lg: 10px;  --r-xl: 14px;

  /* 浮层阴影（仅弹窗/抽屉使用） */
  --shadow-overlay: 0 12px 32px rgba(16,18,24,.14), 0 2px 8px rgba(16,18,24,.08);

  --sidebar-w: 224px;
}
```

### 3.1 对比度验证结果

全部 13 项实测通过：

| 用法 | 对比度 | 要求 |
|---|---|---|
| `--text` / `--surface` | 17.76:1 | 4.5 |
| `--text` / `--bg` | 17.17:1 | 4.5 |
| `--text` / `--surface-sunken` | 16.14:1 | 4.5 |
| `--text-secondary` / `--surface` | 6.34:1 | 4.5 |
| `--text-muted` / `--surface` | 3.17:1 | 3.0（仅用于 11px 以下辅助信息） |
| `--accent` / `--surface` | 4.70:1 | 4.5 |
| `--accent-ink` / `--surface` | 6.33:1 | 4.5 |
| `--accent-ink` / `--accent-soft` | 5.69:1 | 4.5 |
| 白字 / `--accent` 填充 | 4.70:1 | 4.5 |
| `--danger` / `--surface` | 5.25:1 | 4.5 |
| 白字 / `--danger` 填充 | 5.25:1 | 4.5 |
| `--success` / `--surface` | 4.99:1 | 4.5 |
| `--warning` / `--surface` | 5.43:1 | 4.5 |

**约束**：`--text-muted` 仅可用于 11px 及以下的辅助文字（3.17:1，达到非正文门槛）。任何需要阅读的正文必须用 `--text` 或 `--text-secondary`。

### 3.2 字体与字号

```css
--font-sans: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono: "SF Mono", "Cascadia Mono", "JetBrains Mono", Consolas, monospace;
```

不引入外部字体文件：Docker 部署环境可能无外网，加载失败会造成字体闪烁。移除现有 `'Inter'` 声明（本就未生效）。

字号从现有的 8 种零散值（9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13）收敛为 6 级：

```css
--fs-xs: 11px;  --fs-sm: 12px;  --fs-md: 13px;
--fs-lg: 14px;  --fs-xl: 16px;  --fs-2xl: 20px;
```

间距统一到 4px 网格：`4 / 8 / 12 / 16 / 20 / 24 / 32`。

`--font-mono` 应用于：尺寸、token 计数、耗时、文件大小、时间戳、百分比、计数徽章。

---

## 4. 通用样式类

`variables.css` 中的 `.nm-raised` / `.nm-inset` / `.nm-btn` 三个类被替换为：

```css
.card    { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xl); }
.panel   { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); }
.sunken  { background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--r-md); }
.overlay { background: var(--surface); border-radius: var(--r-xl); box-shadow: var(--shadow-overlay); }
```

新增全局焦点样式（当前完全缺失）：

```css
:focus-visible { outline: none; box-shadow: var(--ring); border-radius: var(--r-sm); }
```

---

## 5. 结果卡片重构

改动量最大的部分。现状：13 行等分量小字，其中 4 行的「实际」列恒为 `—`。

### 5.1 新结构

```
┌──────────────────────────────┐
│         [ 图片 ]         2/2 │  ← 图像区
├──────────────────────────────┤
│ 1024×1024 · low          ●   │  ← 身份行（等宽 + 状态点）
├──────────────────────────────┤
│ 尺寸  1024×1024 → 1024×1024 │  ← 对比区：仅放真能对比的项
│ 格式  默认 png  → png       │
│ 张数  1         → 1         │
├──────────────────────────────┤
│ 质量 low  审核 默认  参考图 1 │  ← chip 区：仅有请求值的项
├──────────────────────────────┤
│ 720 KB · 27.6s · 15:40:41   │  ← 页脚（等宽）
│ ↓391  ↑940/0                │
└──────────────────────────────┘
```

### 5.2 分区规则

「chip」指小号圆角标签，形如 `质量 low`，标签名用 `--text-muted`、值用 `--text-secondary`，横向排列并可换行。

| 区域 | 放什么 | 依据 |
|---|---|---|
| 对比区 | 尺寸、格式、张数 n、API 声称格式、模型（仅不一致时） | API 会回传或可从像素测得，「实际」列有真实值 |
| chip 区 | 质量、审核、压缩、参考图数、蒙版 | API 不回传，「实际」列恒为 `—`，占等同分量属噪音 |
| 页脚 | 文件大小、耗时、生成时间、token | 度量值，非参数 |

不一致的对比行加 2px 左侧 `--danger` 标记条，替代现有的纯文字变红。

错误态与取消态卡片保持现有结构（图像区显示错误文案），不套用上述分区。

信息一条不减，行数从 13 降至 3 行 + 1 行 chip + 2 行页脚。

---

## 6. 组件拆分

`ImageGenPanel.vue` 现为 1030 行，承担五项职责：头部控制栏、参数矩阵、结果网格、卡片渲染、预览接线。视觉重做会进一步增大该文件。

拆分为：

| 文件 | 职责 | 接口 |
|---|---|---|
| `ParamPanel.vue`（新建） | 提示词、尺寸表、chip 组、数值输入、编辑模式输入 | `v-model:matrix`、`v-model:prompt`、`v-model:refImages`、`@mask-change` |
| `ResultCard.vue`（新建） | 单张结果卡渲染 | props: `job`；emits: `preview`、`download` |
| `ImageGenPanel.vue`（保留） | 头部栏、结果网格、批次编排 | 无变化 |

此拆分是重做的前置条件，非顺带重构：否则每次调整卡片样式都需在千行文件中定位。

---

## 7. 动效（anime.js v4）

沿用现有 `src/utils/motion.ts` 作为唯一出口，`prefers-reduced-motion` 在该文件统一处理。

**保留**：卡片入场 stagger、数字滚动、失败晃动、侧栏入场、预览淡入。

**新增**：

| 动效 | 实现 | 目的 |
|---|---|---|
| Tab 滑动指示器 | 动 `x` / `width` | 表达"同一区域切换视图" |
| 图片加载 | `filter: blur(8px)` + `scale(1.02)` → 清晰 | 替代硬切 |
| 骨架微光 | shimmer 循环 | 替代静态 ⏳，表达"进行中" |
| 批次进度条 | 顶部 2px 条，宽度随 done/total | 全局进度可见 |
| 卡片悬停 | 边框变色 + `translateY(-2px)` | 可点击性提示 |
| 按钮反馈 | 轻微 spring | 点击确认 |
| 参数区折叠 | 高度过渡 | 替代瞬间消失 |
| 弹窗入场 | `scale(0.96)` + fade | 建立来源感 |

**约束**：单次动效时长不超过 400ms；悬停类不超过 150ms；不得阻塞输入。

---

## 8. 文件清单

| 文件 | 操作 |
|---|---|
| `assets/styles/variables.css` | 重写 |
| `assets/styles/global.css` | 重写（字体、滚动条、焦点、工具类） |
| `App.vue` | 更新 Naive UI theme overrides |
| `components/layout/AppLayout.vue` | 改样式 |
| `components/layout/SideNav.vue` | 改样式 |
| `components/imageGen/ImageGenPanel.vue` | 拆分 + 改样式 |
| `components/imageGen/ParamPanel.vue` | 新建 |
| `components/imageGen/ResultCard.vue` | 新建 |
| `components/imageGen/MaskEditor.vue` | 改样式 |
| `components/imageGen/RefImages.vue` | 改样式 |
| `components/imageGen/ImagePreview.vue` | 改样式 |
| `components/imageGen/ImageGenConfig.vue` | 改样式 |
| `views/LoginView.vue` | 改样式 |
| `utils/motion.ts` | 新增动效函数 |
| `CLAUDE.md` | 更新 Design tokens 一节 |

**不改动**：所有 `stores/`、`api/`、`types/`、`router/`，以及整个 `backend/`。

`CLAUDE.md` 现将 Neumorphism 及其令牌写为项目约定，重做后该节失真，需同步更新。此项已向用户说明并获确认。

---

## 9. 验收标准

1. `npx vue-tsc --noEmit` 通过
2. `npx vite build` 通过
3. Docker 部署后 `/api/v1/health` 返回 ok，首页 200
4. 对比度脚本 13 项全部通过
5. 全站无残留 `nm-raised` / `nm-inset` / `nm-btn` 引用
6. 键盘 Tab 可见焦点环
7. 开启「减少动态效果」后所有动效跳至终态
8. 功能回归：生成、编辑、蒙版开关、矩阵展开、预览缩放/切换、下载均正常

---

## 10. 风险

| 风险 | 应对 |
|---|---|
| Naive UI 组件（`n-input`、`n-modal` 等）内部样式与新主题不符 | 通过 `themeOverrides` 统一覆盖；残留部分用 `:deep()` 处理 |
| 拆分组件时误改功能逻辑 | 拆分与改样式分两步提交，中间验证一次功能 |
| 结果卡片改版后信息缺失 | 分区规则明确要求信息零删减，仅改变呈现分量 |
