# Cloudflare RAG 知识库系统

基于 Cloudflare 生态的 Serverless 个人知识库 RAG（检索增强生成）系统。

## ✨ 特性

- 🚀 **完全 Serverless** - 基于 Cloudflare Workers + Pages + Vectorize + R2 + KV
- 📚 **文档管理** - 支持 TXT、Markdown 文件上传和管理
- � **多文件上传** - 支持同时选择多个文件，队列自动处理
- �🔍 **智能检索** - 向量语义搜索，自动过滤不相关内容
- 💬 **智能问答** - 结合知识库内容生成准确回答，不相关时使用通用知识
- 📐 **数学公式** - 完整支持 LaTeX 数学公式渲染（KaTeX）
- 🎨 **Markdown** - 完整的 Markdown 渲染支持
- 🔐 **密码保护** - 首次使用设置密码，保护你的知识库
- ⚡ **智能速率限制** - 自动等待而非失败，支持 RPM/TPM 配置
- 🌐 **API 兼容** - 支持任何 OpenAI 兼容的 API
- 📄 **分页存储** - 文档列表分页存储，支持海量文档（理论上无限）
- 🚫 **重复检测** - 自动检测同名文件，避免重复上传

## 🚀 快速开始

### 数据迁移说明（仅针对已有旧数据的用户）

如果你之前已经使用过旧版本并上传了文档，在 Cloudflare Dashboard 手动迁移：

1. 打开 **Cloudflare Dashboard → Workers & Pages → KV → 你的命名空间**
2. 找到 `documents_list` 键，复制它的值（JSON 数组）
3. 删除 `documents_list` 键
4. 创建新键 `documents_index`，值为 `{"total":你的文档数量,"pages":1}`
5. 创建新键 `documents_list_page_0`，值为刚才复制的 JSON 数组

**新用户直接跳过此步骤。**

### 1. 安装依赖

```bash
git clone https://github.com/your-username/cloudflare-rag.git
cd cloudflare-rag
npm install
npm install -g wrangler
wrangler login
```

### 2. 创建 Cloudflare 资源

```bash
# 创建 Vectorize 索引（根据你的 embedding 模型维度选择）
wrangler vectorize create knowledge-base-index --dimensions=768 --metric=cosine

# 创建 R2 存储桶
wrangler r2 bucket create knowledge-base-chunks

# 创建 KV 命名空间
wrangler kv namespace create "KV"
```

### 3. 配置

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml`，填写 KV 命名空间 ID（第 2 步输出的 ID）。

### 4. 部署

```bash
# 部署 Workers
npm run deploy

# 记下 Workers URL，编辑 wrangler.toml 填写 WORKERS_URL

# 部署 Pages
npm run deploy:pages
```

或一次性部署：

```bash
npm run deploy:all
```

**注意**：首次部署 Pages 时，需要在 Cloudflare Dashboard 中设置生产分支：
1. Workers & Pages → cloudflare-rag → Settings → Builds & deployments
2. 设置 "Production branch" 为 `main`

### 5. 使用

1. 访问 Pages URL
2. 首次使用设置密码
3. 配置 Embedding 和 LLM API
4. 上传文档，开始提问

## 📖 配置说明

### 向量维度

常见 embedding 模型维度：
- `bce-embedding-base_v1`: 768
- `text-embedding-ada-002`: 1536
- `text-embedding-3-large`: 3072

**重要**：Vectorize 索引维度必须与模型匹配。

### API 配置

支持任何 OpenAI 兼容的 API，包括：
- OpenAI 官方 API
- [New API](https://github.com/Calcium-Ion/new-api)
- 其他兼容服务

在前端设置页面配置：
- Embedding API（Base URL、API Key、模型）
- LLM API（Base URL、API Key、模型）
- 速率限制（RPM/TPM，可选）

## 🛠️ 开发

```bash
# 本地开发
wrangler dev

# 更新部署
npm run deploy        # 只更新 Workers
npm run deploy:pages  # 只更新 Pages
npm run deploy:all    # 同时更新

# 查看日志
wrangler tail
```

## 💰 成本

Cloudflare 免费计划额度：
- Workers: 100,000 请求/天
- Vectorize: 500 万查询/月，3000 万维度存储
- R2: 10GB 存储，100 万次 Class A 操作/月
- KV: 100,000 读取/天，1,000 写入/天
- Pages: 无限请求

个人使用完全免费。

## 🔧 常见问题

### 向量维度不匹配

```bash
wrangler vectorize delete knowledge-base-index
wrangler vectorize create knowledge-base-index --dimensions=768 --metric=cosine
npm run deploy
```

### 清空知识库

```bash
wrangler r2 object delete knowledge-base-chunks --all
wrangler vectorize delete knowledge-base-index
wrangler vectorize create knowledge-base-index --dimensions=768 --metric=cosine
```

### 修改密码

删除 KV 中的 `password_hash`，重新访问前端设置新密码：

```bash
wrangler kv key delete password_hash --namespace-id=YOUR_KV_ID
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！查看 [CONTRIBUTING.md](CONTRIBUTING.md) 了解详情。

## 📄 许可证

MIT License - 查看 [LICENSE](LICENSE) 文件

## 🙏 致谢

- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/)
- [KaTeX](https://katex.org/)
- [Marked](https://marked.js.org/)
