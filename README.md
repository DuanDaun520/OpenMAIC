<p align="center">
  <img src="assets/banner.png" alt="OpenMAIC Banner" width="680"/>
</p>

<p align="center">
  一键生成沉浸式多智能体互动课堂。
</p>

<p align="center">
  <a href="https://my.feishu.cn/wiki/UIfKw9Knti0LcKkTxDNcqlUrnzh"><img src="https://img.shields.io/badge/%F0%9F%93%99%20%E4%BD%93%E9%AA%8C%E6%8C%87%E5%8D%97-v1.0.0%20%C2%B7%20%E4%B8%AD%E6%96%87-FF6B35?style=for-the-badge" alt="v1.0.0 体验指南（中文）"/></a>
  &nbsp;&nbsp;
  <a href="https://open.maic.chat/"><img src="https://img.shields.io/badge/Demo-Live-brightgreen?style=for-the-badge" alt="Live Demo"/></a>
  &nbsp;&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="License: MIT"/></a>
</p>

---

> 本 README 面向**自部署（Docker）场景**。功能总览、更新动态与 Agent 工作台集成见 [CHANGELOG](CHANGELOG.md)、[docs/](docs/) 与 [skills/openmaic/](skills/openmaic/)。

## 目录

- [项目简介](#项目简介)
- [部署架构](#部署架构)
- [环境要求](#环境要求)
- [快速部署](#快速部署)
- [配置说明](#配置说明)
- [可选组件](#可选组件)
- [构建加速（中国大陆）](#构建加速中国大陆)
- [日常运维](#日常运维)
- [数据与备份](#数据与备份)
- [反向代理与安全](#反向代理与安全)
- [常见问题](#常见问题)

## 项目简介

**OpenMAIC**（Open Multi-Agent Interactive Classroom）是一个开源的 AI 互动课堂平台：输入一个主题或一份文档，多智能体引擎自动生成幻灯片、测验、交互式模拟和项目制学习（PBL）活动，AI 教师与 AI 同学实时语音讲解、白板绘图并参与讨论。支持导出可编辑的 `.pptx`、自包含的交互式 `.html` 与 MP4 视频。

核心能力一览：

- **两阶段生成** — 大纲生成 → 场景生成，流水线全自动
- **多智能体课堂** — 授课、讨论、圆桌辩论、自由问答
- **深度交互模式** — 3D 可视化、模拟实验、游戏、思维导图、在线编程
- **多服务商接入** — LLM / TTS / ASR / 图像 / 视频 / 网络搜索 / 文档解析，均可在管理后台热切换
- **多语言界面** — 12 个区域设置，含简繁中文、英、日、韩、俄、阿等

## 部署架构

Docker Compose 单栈编排，容器名统一 `Openmaic-` 前缀，便于 `docker logs` / `docker exec` / 监控系统直接引用：

| 容器名 | 镜像 | 说明 | 启用方式 |
|--------|------|------|----------|
| `Openmaic-app` | 本仓库构建（Next.js standalone） | 应用本体，端口 `3000`，含全部 API 与内嵌持久化服务 | 默认启动 |
| `Openmaic-postgres` | `postgres:16` | 服务端持久化数据库（会话、课程文档、资产注册中心、模型配置） | `--profile server-persistence` |
| `Openmaic-render` | `render-service/` 构建（Chromium + FFmpeg） | MP4 视频导出渲染服务，仅内网可达 | `--profile video-export` |

数据卷同样固定命名：`Openmaic-data`（应用数据）/ `Openmaic-postgres`（数据库）。

两个注意点：

- **容器名 ≠ 服务名**。栈内互相访问用的是 compose 服务名 DNS（`postgres`、`render-service`），已写死在 `DATABASE_URL` 示例与 `RENDER_SERVICE_URL=http://render-service:9000` 中；`Openmaic-*` 名字只用于宿主机侧运维命令。
- **渲染服务隔离**。`Openmaic-render` 挂在 `internal: true` 的独立网络上（无外网路由），入口脚本还会用 iptables 锁死 Chromium 的主动外连，仅允许响应应用发起的请求。

## 环境要求

- Docker 24+ 与 Docker Compose v2（`docker compose` 子命令）
- 应用本体：约 2 vCPU / 2 GiB 内存即可运行
- 启用视频导出：标准渲染档位需 **8 GiB** 内存上限（低内存档位 4 GiB，见下文）
- 磁盘：镜像构建约需 10 GiB 空间；运行期主要是数据库与资产卷

## 快速部署

```bash
# 1. 拉取代码
git clone https://github.com/THU-MAIC/OpenMAIC.git   # 或你的 fork
cd OpenMAIC

# 2. 准备环境变量
cp .env.example .env.local
# 编辑 .env.local，至少填入一个 LLM 服务商的 API Key（见「配置说明」）

# 3. 构建并启动（仅应用本体）
docker compose up -d --build

# 4. 验证
curl http://localhost:3000/api/health
```

`/api/health` 返回 `status: ok` 与各能力位（webSearch / imageGeneration / videoGeneration / tts），该端点在 `ACCESS_CODE` 锁站时也在白名单内，可直接用于存活探测。

浏览器打开 **http://localhost:3000** 即可使用。

## 配置说明

所有配置通过 `.env.local` 注入（compose 已挂载 `env_file`），完整变量清单见 [.env.example](.env.example)。

### LLM 服务商（必填至少一个）

```env
OPENAI_API_KEY=sk-...
# 或 ANTHROPIC_API_KEY / GOOGLE_API_KEY / AZURE_OPENAI_API_KEY / GLM_API_KEY /
#    MINIMAX_API_KEY / QWEN_API_KEY / DEEPSEEK_API_KEY / KIMI_API_KEY /
#    GROK_API_KEY / OPENROUTER_API_KEY / TENCENT_API_KEY / XIAOMI_API_KEY / ...
DEFAULT_MODEL=openai:gpt-5.5        # 可选，指定服务端默认模型
```

也支持 `server-providers.yml`（挂载进容器即可，compose 里有注释示例），以及任何 OpenAI 兼容服务、本地 **Ollama** / **Lemonade**。

### 推荐姿势：管理后台（免重启热切换）

在 `.env.local` 中加上：

```env
DATABASE_URL=postgres://openmaic:<密码>@postgres:5432/openmaic
OPENMAIC_ADMIN_SECRET=<至少32位随机串>
```

（需以 `--profile server-persistence` 启动，见[可选组件](#可选组件)。）

之后打开 **管理 → 模型配置**：配置存于数据库，优先级高于 env/YAML，改完即时生效，无需重启容器。首次启动时空服务商表会从 env / `server-providers.yml` 一次性种子导入，所有密钥以 `OPENMAIC_ADMIN_SECRET` 加密存储。**请务必保管好该密钥——丢失后加密的配置将无法解密。**

### 站点访问码（共享部署建议开启）

```env
ACCESS_CODE=<至少16位随机串>
```

访客需输入访问码才能使用，全部 API 路由同时受保护；验证后签发 7 天有效的 HTTP-only cookie。密码是唯一防线，请保证长度与随机性。

### TTS / ASR / 图像 / 视频 / 搜索（可选）

按需填写 `TTS_*`（含 VoxCPM2 自托管克隆）、`ASR_*`（含 FunASR 本地转写）、`IMAGE_*`、`VIDEO_*`、搜索（Tavily / 博查 / Brave / 百度 / SearXNG 等）各组变量。未配置的能力会自动降级（如无 TTS 则静默课堂，无搜索则跳过联网检索）。

### 日志级别

生产环境默认只记 `warn` 及以上；排查问题时在 `.env.local` 加 `LOG_LEVEL=info`（或 `debug`）并重启。

### 编译期开关（`NEXT_PUBLIC_*`）

`NEXT_PUBLIC_*` 变量会**打进浏览器 bundle，构建时生效**，改了必须重新 `--build`，运行期注入无效。compose 已把它们映射为构建参数，常用项：

| 变量 | 作用 |
|------|------|
| `NEXT_PUBLIC_PERSISTENCE=1` + `NEXT_PUBLIC_PERSISTENCE_TOKEN` | 启用服务端持久化（必须配运行期 `DATABASE_URL`） |
| `NEXT_PUBLIC_ENABLE_VIDEO_EXPORT=1` | 启用 MP4 导出入口（还需 render 服务在跑） |
| `NEXT_PUBLIC_ENABLE_PPTX_IMPORT` / `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED` / … | 其余功能开关见 docker-compose.yml 顶部注释 |

## 可选组件

### 1. 服务端持久化（PostgreSQL）

会话与课程文档服务端存储（浏览器只留设备级 KV），并解锁管理后台配置：

```bash
cp .env.example .env.local   # 若尚未创建
cat >> .env.local <<'EOF'
DATABASE_URL=postgres://openmaic:<改成强密码>@postgres:5432/openmaic
PERSISTENCE_DEV_TOKEN=<随机串>
PERSISTENCE_POSTGRES_PASSWORD=<与上一行相同的强密码>
EOF

NEXT_PUBLIC_PERSISTENCE=1 \
NEXT_PUBLIC_PERSISTENCE_TOKEN=<与 PERSISTENCE_DEV_TOKEN 相同> \
docker compose --profile server-persistence up -d --build
```

说明：

- 数据库密码只在数据卷首次初始化时生效，之后再改需手动 `ALTER ROLE` 并同步 `DATABASE_URL`。
- 浏览器里已有的课程会在首次访问时自动懒式迁移到服务端。
- 资产回收器默认开启（15 分钟一轮，条目与字节各 1 小时 grace，单 principal 配额默认 10 GiB），存储不会无限增长；相关变量 `ASSET_COLLECTION_*` / `ASSET_QUOTA_BYTES`。
- **安全提醒**：`PERSISTENCE_DEV_TOKEN` 会编译进公开 JS，**不是真正的认证**，仅适合个人/可信网络部署。面向公网多用户时请替换 [`lib/persistence/server-auth.ts`](lib/persistence/server-auth.ts) 为真实会话校验。

### 2. MP4 视频导出（渲染服务）

```bash
docker compose --profile video-export up -d --build
```

不启用该 profile 时应用自动探测失败并隐藏 MP4 导出，退化为 ZIP 下载，无需任何额外配置。内存档位：

```env
RENDER_RESOURCE_PROFILE=standard    # 默认，需 8g
# 或低内存：
RENDER_RESOURCE_PROFILE=low-memory
RENDER_SERVICE_MEMORY_LIMIT=4g
```

两个 profile 可以叠加：`docker compose --profile server-persistence --profile video-export up -d --build`。

### 3. 增强文档解析 / 本地语音

- **MinerU**（更强表格/公式/OCR）：`PDF_MINERU_BASE_URL`（+ 可选 `PDF_MINERU_API_KEY`）
- **AliDocMind**：`ALIDOCMIND_ACCESS_KEY_ID` / `ALIDOCMIND_ACCESS_KEY_SECRET`
- **VoxCPM2**（自托管 TTS 音色克隆）：设置 → 语音合成 → VoxCPM2，或 `TTS_VOXCPM_BASE_URL`
- **FunASR / Lemonade**（本地 ASR / 本地全家桶）：`ASR_FUNASR_BASE_URL` / `LEMONADE_BASE_URL` 等

## 构建加速（中国大陆）

两个构建参数，默认空（用上游源）：

```bash
ALPINE_MIRROR=mirrors.tuna.tsinghua.edu.cn \
NPM_REGISTRY=https://registry.npmmirror.com \
docker compose up -d --build
```

它们只影响 Alpine 软件源和 npm registry，**不要**在参数里嵌 token（可能被写进镜像元数据）。基础镜像拉取慢需单独配置 Docker daemon 的 registry mirror。BuildKit 的 pnpm store 缓存会在多次构建间复用。

## 日常运维

```bash
# 状态与健康（healthy 由容器内 /api/health 探测驱动）
docker compose ps

# 日志
docker logs -f Openmaic-app            # 应用
docker logs -f Openmaic-postgres       # 数据库（启用持久化时）
docker logs -f Openmaic-render         # 渲染服务（启用视频导出时）

# 重启 / 停止
docker compose restart openmaic
docker compose down                    # 停止并移除容器（数据卷保留）
docker compose down -v                 # ⚠️ 连数据卷一起删除

# 进入容器排查
docker exec -it Openmaic-app sh

# 升级到新版本
git pull
docker compose --profile server-persistence --profile video-export up -d --build
# 注意：如果 NEXT_PUBLIC_* 开关有变化，升级命令要带上与首次构建相同的变量
```

## 数据与备份

| 数据 | 位置 | 卷名 |
|------|------|------|
| 应用数据（课堂文件、异步任务等） | 容器内 `/app/data` | `Openmaic-data` |
| PostgreSQL 数据 | 容器内 `/var/lib/postgresql/data` | `Openmaic-postgres` |

```bash
mkdir -p backup

# 数据库逻辑备份（启用持久化时）
docker exec Openmaic-postgres pg_dump -U openmaic -Fc openmaic \
  > backup/openmaic-db-$(date +%F).dump

# 应用数据卷备份
docker run --rm -v Openmaic-data:/data -v "$PWD/backup":/backup alpine \
  tar czf /backup/openmaic-data-$(date +%F).tgz -C /data .

# 数据库恢复
docker exec -i Openmaic-postgres pg_restore -U openmaic -d openmaic --clean \
  < backup/openmaic-db-<日期>.dump
```

建议把这两个备份加入 cron，并定期把 `backup/` 同步到异地。`.env.local` 里全是密钥，同样需要离线备份。

## 反向代理与安全

生产建议在前面挂 Nginx / Caddy 做 TLS 终结：

- **限流归因**：应用只有在 `TRUST_PROXY_HEADERS=true` 且代理正确回写 `x-forwarded-for` / `x-real-ip` 时才按客户端限流，否则完全不限流。
- **iframe 嵌入**：默认 `frame-ancestors 'self'`；需要嵌入其他站点时在**构建时**传 `ALLOWED_FRAME_ANCESTORS`（源列表字符串）。
- **上传体积**：应用已放行 200MB 请求体，代理侧请同步放开 `client_max_body_size`。
- 代理健康检查可直接探 `http://127.0.0.1:3000/api/health`。

## 常见问题

**改了 `.env.local` 不生效？**
运行期变量重启容器即可（`docker compose up -d` 重建）；`NEXT_PUBLIC_*` 是编译期的，必须 `--build`。

**想换端口？**
改 docker-compose.yml 里 `ports: ['3000:3000']` 的左侧宿主端口（如 `'8080:3000'`），容器内始终是 3000。

**视频导出菜单是灰的 / 提示不可用？**
`Openmaic-render` 没在跑（未启用 `--profile video-export`），或内存不足渲染档位要求。不启用时属预期行为，用 ZIP 导出即可。

**容器名冲突？**
容器名固定为 `Openmaic-*`，同一台 Docker 宿主机只能跑一套本栈；需要第二套请改 `container_name` 或用不同宿主机。

**数据库连不上 / 管理后台空白？**
确认是以 `--profile server-persistence` 启动、`DATABASE_URL` 里的主机名是服务名 `postgres` 而非容器名，且密码与 `PERSISTENCE_POSTGRES_PASSWORD` 一致。

**如何确认哪些能力已启用？**
`curl http://localhost:3000/api/health` 的 `capabilities` 字段逐项列出。

---

## 更多资源

- [体验指南（中文）](https://my.feishu.cn/wiki/UIfKw9Knti0LcKkTxDNcqlUrnzh) · [English User Guide](https://lcn6dqn3m0yr.feishu.cn/wiki/CkQSwHFdzibQFvkGzwPcmUOfnXg)
- [更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)
- [docs/](docs/) — 设计文档 · [skills/openmaic/](skills/openmaic/) — Agent 工作台技能包（OpenClaw / Codex 等）
- [JCST'26 论文](https://jcst.ict.ac.cn/en/article/doi/10.1007/s11390-025-6000-0) · [社区与支持](community/feishu.md)

## 引用

如本项目对您的 研究/部署 有帮助，欢迎引用：

```bibtex
@Article{JCST-2509-16000,
  title = {From MOOC to MAIC: Reimagine Online Teaching and Learning through LLM-driven Agents},
  journal = {Journal of Computer Science and Technology},
  year = {2026},
  doi = {10.1007/s11390-025-6000-0},
  url = {https://jcst.ict.ac.cn/en/article/doi/10.1007/s11390-025-6000-0}
}
```

## 许可证

本项目基于 [MIT License](LICENSE) 开源。内置工作区子包 `packages/mathml2omml`（LGPL-3.0-or-later）与 `packages/pptxgenjs`（第三方 MIT）保留各自协议，整体再分发时适用。
