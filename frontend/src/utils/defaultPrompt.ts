/** The prompt every surface starts with, and the one the compatibility suite
 *  probes with.
 *
 *  Single source because it was previously duplicated byte-for-byte across the
 *  two stores. It is not arbitrary filler: dense Simplified Chinese labels are
 *  what expose the failure this lab is most often used to check for — garbled or
 *  missing glyphs — so the three surfaces have to send the *same* text for their
 *  results to be comparable against each other.
 */
export const DEFAULT_PROMPT = `深圳一日游手绘地图插画，清新可爱手绘风格，旅行手账风，地图式俯视构图（top-down map illustration），整体布局清晰有层次，色彩明亮柔和，带轻微水彩质感。

画面中展示深圳主要景点，使用卡通手绘插画表现，每个景点独立标注，并配有清晰、规范、标准简体中文文字说明（非常重要：文字必须正确、无错别字、无乱码、可读性强）。

📍 景点与文字（要求严格按以下内容生成）
世界之窗
文字：世界文化景观缩影
深圳湾公园
文字：滨海休闲好去处
大梅沙海滨公园
文字：深圳经典海滩
东部华侨城
文字：生态旅游度假区
莲花山公园
文字：俯瞰深圳城市风光
平安金融中心
文字：深圳第一高楼
华强北
文字：电子科技天堂

🎨 风格细化（提高出图质量关键）
手绘插画风格（hand-drawn illustration）
旅行手账 / 地图插画风（travel sketch map style）
线条干净柔和（clean soft lines）
色彩清新明亮（bright pastel colors）
轻微水彩渲染（light watercolor texture）
元素可爱卡通化（cute cartoon landmarks）
布局类似旅游导览图（tourist guide map layout）

🔤 中文文字优化约束（非常关键）
所有文字必须为简体中文
字体工整清晰（类似印刷体 / 手写清晰体）
禁止乱码、拼写错误、缺字、多字
每个景点文字紧贴对应图标
文字大小适中，保证可读性
不要生成无意义符号或英文替代

highly legible Chinese text, correct spelling, no garbled characters, no distorted glyphs

🖼️ 输出要求
横版 16:9
高分辨率（4K / high resolution）
适合海报或旅游宣传册展示`
