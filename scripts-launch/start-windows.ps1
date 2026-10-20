# SwipeApply · Windows 启动脚本（双击「启动 SwipeApply.bat」会运行它）
# 第一次：下载 Node（放在本文件夹的 runtime 里，不装到系统）→ 填 Key → 安装依赖；以后：直接启动并打开浏览器
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot  # 脚本在 scripts-launch 里，工作台在上一层
Set-Location -LiteralPath $Root
$Host.UI.RawUI.WindowTitle = "SwipeApply（关掉这个窗口，SwipeApply 就停了）"

$NodeVersion = "v24.22.0"
$Mirror = "https://npmmirror.com/mirrors/node"
$Registry = "https://registry.npmmirror.com"
$Url = "http://localhost:3000"

function Say($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }

try {
  # 1. Node：没有就下载（国内镜像）
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $nodeDir = Join-Path $Root "runtime\node-$NodeVersion-win-$arch"
  if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
    Say "第一次运行：下载 Node.js $NodeVersion（约 30MB，只放在这个文件夹里）"
    New-Item -ItemType Directory -Force (Join-Path $Root "runtime") | Out-Null
    $zip = Join-Path $Root "runtime\node.zip"
    Invoke-WebRequest "$Mirror/$NodeVersion/node-$NodeVersion-win-$arch.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $Root "runtime") -Force
    Remove-Item -LiteralPath $zip -Force
  }
  $env:Path = "$nodeDir;$env:Path"

  # 2. Key：没有 .env.local 就从朋友给的配置或模板复制一份，打开记事本让你填
  if (-not (Test-Path ".env.local")) {
    Copy-Item ".env.example" ".env.local"
    Say "不用填 Key 也能用：AI 功能每天有免费额度。想不受限制地用，以后在这个文件夹的 .env.local 里填自己的 Key（见 README）"
  }

  # 3. 依赖：第一次安装（国内镜像，几分钟）
  if (-not (Test-Path "node_modules\next")) {
    Say "第一次运行：安装依赖（需要几分钟，请耐心等）"
    & "$nodeDir\npm.cmd" ci --registry=$Registry --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "安装依赖失败，请检查网络后再双击一次" }
  }

  # 4. 已经开着就直接打开浏览器
  try {
    Invoke-WebRequest "http://127.0.0.1:3000" -UseBasicParsing -TimeoutSec 3 | Out-Null
    Start-Process $Url
    exit 0
  } catch {}

  # 5. 启动；等它准备好了自动打开浏览器
  Say "正在启动，准备好后会自动打开浏览器（第一次打开页面要多等一会儿）"
  Start-Job -ScriptBlock {
    param($u)
    for ($i = 0; $i -lt 150; $i++) {
      Start-Sleep -Seconds 2
      try { Invoke-WebRequest "http://127.0.0.1:3000" -UseBasicParsing -TimeoutSec 60 | Out-Null; Start-Process $u; break } catch {}
    }
  } -ArgumentList $Url | Out-Null
  & "$nodeDir\npm.cmd" run dev
} catch {
  Write-Host ""
  Write-Host "出错了：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "把这个窗口截图发给分享给你的人。" -ForegroundColor Red
  Read-Host "按回车关闭"
}
