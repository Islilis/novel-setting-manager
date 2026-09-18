# 第三方组件与许可证（Third-Party Notices）

本软件（小说设定管理器）使用了以下开源组件。它们的许可证与本项目自身的 MIT 许可证相互独立，各自的版权归原作者所有。

---

## 1. Electron（运行时，随软件分发）

- **许可证**：MIT
- **版权**：`Copyright (c) Electron contributors` / `Copyright (c) 2013-2020 GitHub Inc.`
- **许可证全文位置**
  - 安装目录（随包附带）：`LICENSE.electron.txt`
  - 源码目录：`node_modules/electron/dist/LICENSE`
- **项目地址**：https://github.com/electron/electron

## 2. Chromium（Electron 内置，随软件分发）

- **许可证**：BSD-3-Clause 以及大量第三方许可证
- **许可证全文位置**
  - 安装目录（随包附带）：`LICENSES.chromium.html`（约 8.9 MB，**含所有第三方组件的许可证原文**）
  - 源码目录：`node_modules/electron/dist/LICENSES.chromium.html`
- **项目地址**：https://www.chromium.org/

## 3. Node.js（Electron 内置）

- **许可证**：MIT
- **项目地址**：https://nodejs.org/

> 上述 `LICENSES.chromium.html` 中的清单为**完整、权威**的第三方组件列表；如与本文档有出入，请以该文件为准。

---

## 4. 仅开发期使用（不随软件分发）

以下组件只在开发 / 打包时使用，**不会包含在最终安装包里**：

| 组件 | 许可证 | 用途 | 地址 |
|---|---|---|---|
| electron | MIT | 运行时框架（开发依赖） | https://github.com/electron/electron |
| electron-builder | MIT | 打包成 Windows 安装包 | https://github.com/electron-userland/electron-builder |

---

## 5. 本项目自身

- **MIT License**，`Copyright (c) 2026 ysqjl`
- 全文见仓库根目录的 [LICENSE](LICENSE)
