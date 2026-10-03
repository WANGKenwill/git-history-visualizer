# Git 历史可视化协作约定

- 预览和 MP4 导出共用 `src/visualizer.js` 的确定性绘制函数；相同 manifest 和时间应得到相同画面。
- 运行时依赖与资源全部来自本地。导出只使用已安装的 Playwright Chromium 和 FFmpeg；缺少依赖时提示用户，不自动联网安装。
- 修改统计、时间轴或导出后运行 `npm run check`；修改导出后额外生成短 MP4，检查解码、时长及最终累计量。
- 视觉要求见 `frame.md`，统计与使用说明见 `README.md`。
