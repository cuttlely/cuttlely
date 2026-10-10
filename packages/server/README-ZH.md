# Cuttlely 服务器

[English](./README.md) | 中文

Cuttlely 的 Node 服务器。在仓库根目录同时启动 Cuttlely 与 Hermes：

```bash
bash scripts/start-cuttlely.sh
```

打开 [http://localhost:43117](http://localhost:43117)。未设置 `PORT` 时，启动脚本使用 `PORT=43117`；单独启动服务器时默认端口是 `3000`。环境变量见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。包的可执行文件名仍是 `flowise`。

## 许可证

Apache License 2.0。本包里没有商业 enterprise 目录。见 [LICENSE.md](../../LICENSE.md)。
