#!/bin/bash

# 构建 Pages 的脚本 - 自动从 wrangler.toml 读取 WORKERS_URL

echo "📦 准备部署 Pages..."

# 检查 wrangler.toml 是否存在
if [ ! -f "wrangler.toml" ]; then
    echo "❌ 错误：找不到 wrangler.toml"
    echo "请先运行: cp wrangler.toml.example wrangler.toml"
    exit 1
fi

# 从 wrangler.toml 读取 WORKERS_URL
WORKERS_URL=$(grep 'WORKERS_URL' wrangler.toml | cut -d'"' -f2)

if [ "$WORKERS_URL" = "YOUR_WORKERS_URL" ] || [ -z "$WORKERS_URL" ]; then
    echo "❌ 错误：请先在 wrangler.toml 中设置 WORKERS_URL"
    echo ""
    echo "步骤："
    echo "1. 运行 'npm run deploy' 部署 Workers"
    echo "2. 记下 Workers URL"
    echo "3. 编辑 wrangler.toml，设置 WORKERS_URL"
    echo "4. 再次运行 'npm run deploy:pages'"
    exit 1
fi

echo "✅ 检测到 Workers URL: $WORKERS_URL"

# 创建临时目录
rm -rf .pages-build
mkdir -p .pages-build

# 复制 public 目录
cp -r public/* .pages-build/

# 替换 API_BASE（兼容 Linux 和 macOS）
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s|const API_BASE = '';|const API_BASE = '$WORKERS_URL';|g" .pages-build/index.html
else
    # Linux
    sed -i "s|const API_BASE = '';|const API_BASE = '$WORKERS_URL';|g" .pages-build/index.html
fi

echo "✅ 已设置 API_BASE = $WORKERS_URL"
echo ""
echo "🚀 部署到 Pages..."

# 部署
wrangler pages deploy .pages-build --project-name=cloudflare-rag

# 清理
rm -rf .pages-build

echo ""
echo "✅ 部署完成！"
