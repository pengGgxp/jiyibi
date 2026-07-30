# 记一笔

一个强调“几秒钟记完一笔”的本地优先 PWA。它把账目和截图保存在浏览器的 IndexedDB 中，不需要账号，也不会把数据上传到服务器。

## 功能

- 支出/收入切换与人民币金额输入
- 文字或单张截图凭证，支持选择、拍摄与粘贴
- 当前余额、初始余额与本月收支概览
- 记录编辑、软删除与 8 秒撤销
- 密码加密的单文件备份与整体恢复
- 手机、平板和桌面响应式界面
- 安装到主屏幕并在首次访问后离线使用

## 本地开发

需要 Node.js 20.19+ 或 22.12+。

```bash
npm install
npm run dev
```

检查与构建：

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

开发、预览和生产构建统一使用 GitHub Pages 子路径 `/jiyibi/`，本地地址通常为 `http://localhost:5173/jiyibi/`。

## 数据与备份

- 金额以人民币“分”的整数形式保存，避免浮点误差。
- 账目、设置和截图仅保存在当前浏览器配置中。
- 清除网站数据、卸载浏览器或更换设备可能导致数据丢失，请定期导出加密备份。
- 备份密码不会保存，也无法找回。恢复前会展示备份摘要，确认后整体替换本机数据。

详细说明见 [PRIVACY.md](./PRIVACY.md)。

## 部署

`.github/workflows/deploy.yml` 会在 `main` 分支更新后构建并发布 GitHub Pages。仓库设置中的 Pages 来源应为 **GitHub Actions**。

## 当前边界

首版不提供账号、云同步、OCR、分类、预算、多账本或银行接口。
