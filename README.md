# Acamind（知境）

Acamind 是一个**基于 Chainlit 二次开发**的学术研究助手项目。

它不是简单换皮的聊天页，而是在 Chainlit 的会话、消息、文件上传、前后端通信能力之上，扩展了以下能力：

- 学术检索与论文分析
- PDF 上传、解析与全文阅读辅助
- 联网检索
- 注册 / 登录 / 管理后台
- 权限组、邀请码、模型额度控制
- 多 Provider / 多模型配置

## 项目定位

Acamind 面向“学术检索 + 论文阅读 + AI 分析”场景。

当前版本的核心思路是：

- 用 Chainlit 提供聊天框架、消息流、文件元素、前后端通信能力
- 用自定义后端逻辑补足论文检索、PDF 深读、权限控制、管理后台
- 用自定义前端页面补足登录、注册、管理页和更贴近学术场景的 UI

## 为什么要强调“基于 Chainlit”

这个项目的底层仍然是 Chainlit，不是从零实现的一套聊天系统。

你在仓库里可以直接看到这点：

- 后端核心框架在 [backend/chainlit](E:/myself_prodect/chainlit-main/backend/chainlit)
- 启动方式仍然是 `python -m chainlit run ...`
- 前端仍然基于 Chainlit React 客户端和原有消息体系扩展
- 业务主入口集中在 [backend/demo_openai_compatible_httpx.py](E:/myself_prodect/chainlit-main/backend/demo_openai_compatible_httpx.py)

换句话说：

- `Chainlit` 负责基础聊天框架
- `Acamind` 负责学术工作流和业务能力

## 当前主要功能

- 账号体系
  - 用户注册
  - 用户登录
  - 首个注册用户自动成为管理员
- 管理后台
  - 用户管理
  - 权限组管理
  - 邀请码管理
  - Provider / 模型管理
- 学术能力
  - OpenAlex 学术检索
  - Deep Research / Deep Read 工作流
  - PDF 上传补充全文
  - 中文标题 / 双语分析等论文辅助能力
- 联网能力
  - WebSearch 模式
  - 可对接 SearXNG
- 会话体验
  - 文件上传
  - 图片上传
  - 对话历史
  - 深读侧边面板 / PDF 面板

## 目录结构

- [backend/demo_openai_compatible_httpx.py](E:/myself_prodect/chainlit-main/backend/demo_openai_compatible_httpx.py)
  - Acamind 业务主入口
  - 包含聊天逻辑、论文流程、权限校验、管理接口注册
- [backend/acamind_auth_store.py](E:/myself_prodect/chainlit-main/backend/acamind_auth_store.py)
  - JSON 用户库
  - 密码哈希
  - 权限组 / 邀请码 / 使用额度
- [backend/chainlit](E:/myself_prodect/chainlit-main/backend/chainlit)
  - Chainlit 核心框架代码
- [backend/.chainlit/config.toml](E:/myself_prodect/chainlit-main/backend/.chainlit/config.toml)
  - 当前运行配置
  - UI、监听地址、端口、上传、检索配置等
- [frontend/src](E:/myself_prodect/chainlit-main/frontend/src)
  - 前端页面与组件
  - 包含 `/login`、`/register`、`/admin`
- [searxng](E:/myself_prodect/chainlit-main/searxng)
  - SearXNG 相关配置

## 快速启动

以下是最基本的本地启动方式。

### 1. 环境要求

- Python 3.10+
- Node.js 20+ 或 22+
- `corepack`
- `pnpm`

### 2. 安装 Python 依赖

只做基础运行时：

```bash
pip install -e ./backend
```

如果你需要测试能力，再单独安装测试依赖：

```bash
pip install -e './backend[tests]'
```

注意：

- `-e` 后面必须是路径，例如 `./backend`
- 不能写成 `-e backend[tests]`

### 3. 安装前端依赖并构建

```bash
corepack enable
pnpm install
pnpm buildUi
```

说明：

- 当前项目运行时依赖前端构建产物
- 当前配置中 `custom_build = "../frontend/dist"`
- 因此前端首次运行前必须先构建一次

### 4. 配置认证密钥

项目启用了认证，必须提供 JWT/认证密钥。

推荐使用：

```bash
export CHAINLIT_AUTH_SECRET="your_generated_secret"
```

当前代码也兼容：

```bash
export CHAINLIT_JWT_SECRET="your_generated_secret"
```

生成密钥可使用：

```bash
cd backend && python -m chainlit create-secret
```

### 5. 配置模型服务

最少需要准备一个可用的 OpenAI 兼容接口，例如：

```bash
export OPENAI_BASE_URL="https://your-api-endpoint/v1"
export OPENAI_API_KEY="your_api_key"
export OPENAI_MODEL="gpt-5.2-codex"
```

也可以把这些配置写入 [backend/.chainlit/config.toml](E:/myself_prodect/chainlit-main/backend/.chainlit/config.toml)。

## 启动命令

在 [backend](E:/myself_prodect/chainlit-main/backend) 目录下执行：

```bash
python -m chainlit run demo_openai_compatible_httpx.py
```

当前仓库默认监听：

- Host: `0.0.0.0`
- Port: `5012`

所以默认访问地址是：

```text
http://localhost:5012
```

## 基本使用方式

### 1. 首次访问

如果当前还没有用户：

- 直接进入注册页
- 首个注册用户会自动成为管理员

相关页面：

- `/login`
- `/register`
- `/admin`

### 2. 登录后使用聊天页

登录后进入主页，可以直接：

- 普通对话
- 切换学术检索模式
- 切换联网检索模式
- 上传 PDF / 图片 / 文档

### 3. 论文检索与深读

当前版本支持以下典型流程：

- 输入问题，走 OpenAlex 学术检索
- 选择论文并进入深读
- 如果系统无法自动拿到 PDF，可要求用户上传 PDF
- 上传 PDF 后继续走全文提取和分析流程

### 4. 管理后台

管理员可在 `/admin` 中管理：

- 用户
- 权限组
- 邀请码
- Provider
- 可用模型
- 模型额度
- OpenAlex / WebSearch 可调参数

## 当前权限体系

当前默认逻辑是：

- 首个注册用户自动成为管理员
- 默认普通用户组为 `guest`
- `guest` 默认仅允许 `gpt-5.2-codex`
- 默认总额度为 `30` 次

这些配置可以在管理后台中继续调整。

## 运行配置说明

当前项目的重要运行配置主要集中在：

- [backend/.chainlit/config.toml](E:/myself_prodect/chainlit-main/backend/.chainlit/config.toml)

这里可以配置：

- UI 构建目录
- 监听地址和端口
- 文件上传上限
- OpenAI 兼容接口
- WebSearch
- OpenAlex 参数
- OCR 能力

建议：

- 本地开发可以直接改这个文件
- 生产环境建议通过环境变量或部署配置注入敏感信息
