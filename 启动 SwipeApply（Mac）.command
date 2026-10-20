#!/bin/bash
# SwipeApply · Mac 启动脚本（双击运行；第一次如果提示「无法打开」，右键 → 打开）
# 第一次：下载 Node（放在本文件夹的 runtime 里，不装到系统）→ 填 Key → 安装依赖；以后：直接启动并打开浏览器
set -e
cd "$(dirname "$0")"
NODE_VERSION="v24.22.0"
MIRROR="https://npmmirror.com/mirrors/node"
REGISTRY="https://registry.npmmirror.com"
URL="http://localhost:3000"
say() { echo; echo "== $1"; }
fail() { echo; echo "出错了：$1"; echo "把这个窗口截图发给分享给你的人。"; read -r -p "按回车关闭"; exit 1; }
trap 'fail "第 $LINENO 行出错"' ERR

# 1. Node：没有就下载（国内镜像）
case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
NODE_DIR="$PWD/runtime/node-$NODE_VERSION-darwin-$ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  say "第一次运行：下载 Node.js $NODE_VERSION（约 50MB，只放在这个文件夹里）"
  mkdir -p runtime
  curl -fL "$MIRROR/$NODE_VERSION/node-$NODE_VERSION-darwin-$ARCH.tar.gz" -o runtime/node.tar.gz
  tar -xzf runtime/node.tar.gz -C runtime
  rm -f runtime/node.tar.gz
fi
export PATH="$NODE_DIR/bin:$PATH"

# 2. Key：没有 .env.local 就从朋友给的配置或模板复制一份，打开文本编辑让你填
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  say "不用填 Key 也能用：AI 功能每天有免费额度。想不受限制地用，以后在这个文件夹的 .env.local 里填自己的 Key（见 README）"
fi

# 3. 依赖：第一次安装（国内镜像，几分钟）
if [ ! -d node_modules/next ]; then
  say "第一次运行：安装依赖（需要几分钟，请耐心等）"
  npm ci --registry="$REGISTRY" --no-audit --no-fund || fail "安装依赖失败，请检查网络后再双击一次"
fi

# 4. 已经开着就直接打开浏览器
if curl -s -o /dev/null -m 3 http://127.0.0.1:3000; then open "$URL"; exit 0; fi

# 5. 启动；等它准备好了自动打开浏览器
say "正在启动，准备好后会自动打开浏览器（第一次打开页面要多等一会儿）。关掉这个窗口，SwipeApply 就停了"
( for _ in $(seq 150); do sleep 2; if curl -s -o /dev/null -m 60 http://127.0.0.1:3000; then open "$URL"; break; fi; done ) &
trap - ERR
npm run dev
