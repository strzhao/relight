# Brainstorm — photos 页面优化

## Q1: 视觉参考

**答**: 无参考，自由设计 — 按 Apple Photos / Google Photos 风格设计。

## Q2: 大图查看器交互范围

**答**: 完整版 — 全屏遮罩 + 翻页（上/下一张）+ 键盘导航 + 缩放/平移手势 + 下载按钮 + 照片元数据展示。

## Q3: 原始图片获取

**答**: 新增后端端点 `GET /api/photos/:id/original`，返回原始文件二进制。前端大图查看器使用此 URL。

## Q4: 间距优化

**答**: 增大上下间距 — 在照片分组之间增加更大的垂直间距。

## Q5: Lightbox 组件架构

**答**: 组合式组件 — 拆分为独立子组件，模块化可复用。

```
components/ui/lightbox/
  index.tsx             # Lightbox 主组件（Context + 状态管理）
  lightbox-image.tsx    # 图片渲染 + 缩放/平移手势
  lightbox-controls.tsx # 翻页箭头 + 关闭 + 下载按钮
  lightbox-info.tsx     # 元数据面板
  use-lightbox-keys.ts  # 键盘快捷键 hook
```

## 技术决策总结

| 决策点 | 选择 |
|--------|------|
| 视觉风格 | Apple Photos / Google Photos 风格 |
| Lightbox 交互 | 完整版（翻页+缩放+下载+元数据） |
| 原始图 API | 新增 `GET /api/photos/:id/original` |
| 间距方案 | 增大分组间垂直间距 |
| 组件架构 | 组合式（lightbox/ 子目录） |
