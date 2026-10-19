<p align="center">
  <img src="public/icons/icon-128.png" width="112" height="112" alt="投简助手 ApplyKit 图标">
</p>

<h1 align="center">投简助手 ApplyKit</h1>

<p align="center">
  用一份保存在本机的履历，辅助填写不同招聘网站的在线表单。
</p>

<p align="center">
  <a href="https://github.com/DeepestWind/ApplyKit/actions/workflows/ci.yml"><img src="https://github.com/DeepestWind/ApplyKit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/DeepestWind/ApplyKit" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Manifest V3">
  <img src="https://img.shields.io/badge/data-local%20only-147A45" alt="Data stays local">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/用户使用教程.md">完整教程</a> ·
  <a href="docs/SITE-COMPATIBILITY.md">兼容性记录</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

ApplyKit 是一个开源 Chrome 扩展。它读取你主动保存在扩展里的履历，识别当前招聘页面的字段，填写可以可靠匹配的内容，并把不确定的部分交还给你确认。

**扩展不会替你提交申请。** 附件、声明、验证码和最终提交按钮始终由你操作。只有在你确认网站已经提交成功后，ApplyKit 才会把本地记录标为“已投递”。

> 当前版本为 `0.1.0`，尚未发布到 Chrome Web Store，需要从源码构建并在开发者模式下加载。

## 为什么使用 ApplyKit

| 能力 | 具体行为 |
| --- | --- |
| 一份履历，多站复用 | 姓名、联系方式、教育、实习、项目、获奖、语言等资料集中维护并带版本记录 |
| 识别招聘表单 | 根据字段标签、分区、控件类型和经历位置建立填写计划 |
| 处理复杂控件 | 支持普通输入、单选、多选、自定义下拉、日期范围、至今、地区选择和动态新增经历 |
| 站点适配 | 为 Moka、北森 Phoenix、飞书招聘 ATSX 提供专用适配器，未知网站使用通用模式 |
| 写入后校验 | 每次填写都会回读页面状态，区分已填写、原值相同、保留原值、待处理和失败 |
| 记住陌生字段 | 你可以手动指定字段对应关系，并将可靠规则保存在本机供下次复用 |
| 管理投递记录 | 保存公司、岗位、状态、下一步和备注，支持筛选与 CSV 导入导出 |
| 完整备份 | 履历、字段规则和投递记录可导出为 JSON，并可整库恢复 |

ApplyKit 的策略是“能确认才填写”：

- 页面已经有不同内容时默认保留，除非你明确允许覆盖。
- 多个候选都可能正确时停止并列为待处理。
- 履历缺少事实时不编造答案。
- 证件号码和紧急联系人只有在你主动保存资料、且专用站点适配器精确识别字段时才会填写；通用页面及其他敏感字段仍需手动处理。
- 不绕过验证码，不点击最终提交按钮。

## 快速开始

### 1. 构建扩展

需要 [Node.js](https://nodejs.org/) `22.12+`、`24.x` 或 `26+`，以及支持 Manifest V3 的 Chrome。

```bash
git clone https://github.com/DeepestWind/ApplyKit.git
cd ApplyKit
npm ci
npm run build
```

构建完成后会生成 `dist/`。

### 2. 加载到 Chrome

1. 在地址栏打开 `chrome://extensions`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目中的 `dist/` 目录。
5. 在浏览器工具栏的扩展菜单中固定“投简助手 ApplyKit”。

请选择 `dist/`，不要选择项目根目录或 `.test-dist/`。

### 3. 用虚构资料完成五分钟演示

```bash
npm run demo
```

保持终端运行，然后：

1. 点击扩展图标，进入“履历管理”。
2. 导入 [`fixtures/profile.demo.json`](fixtures/profile.demo.json)。这份资料明确标记为虚构，只能用于本地演示页。
3. 打开 [基础表单演示](http://127.0.0.1:4173/basic.html)，点击扩展图标并选择“一键填写”。
4. 继续体验 [多段经历](http://127.0.0.1:4173/experience.html) 和 [字段规则学习](http://127.0.0.1:4173/edge-cases.html)。

更完整的安装、真实履历准备和演示步骤见[用户使用教程](docs/用户使用教程.md)。

## 日常使用流程

```mermaid
flowchart LR
  A[导入并选中履历] --> B[打开招聘表单]
  B --> C[扫描页面]
  C --> D[一键填写]
  D --> E[核对结果并处理空白]
  E --> F[手动上传附件与提交]
  F --> G[确认成功并更新投递记录]
```

每次切换到新的招聘网页，都需要再次点击工具栏图标。`activeTab` 只会临时授权当前标签页，跨站跳转后不会继续保留访问权。

真实投递前建议先使用“扫描页面”查看识别结果，再运行“一键填写”。填写结束后仍应逐项核对，尤其是意向城市、日期、学校候选和网站已有内容。

日期资料需要适配完整日历时，教育开始时间默认使用 9 月 1 日，毕业时间默认使用 6 月 30 日；其他只有年月的日期默认使用当月 1 日。履历中已经保存的月、日始终优先。

## 网站兼容性

| 页面类型 | 当前状态 |
| --- | --- |
| Moka 校招在线简历 | 专用适配器；支持重复经历、自定义下拉、学校/专业和年月选择 |
| 北森招聘云 Phoenix | 专用适配器；支持 portal 下拉、单选/多选省市弹窗、日期、最高学历/英语投影、动态教育字段和空记录折叠提示 |
| 飞书招聘 ATSX | 专用适配器；支持树形地区、双端年月、动态经历和自我评价 |
| 标准 HTML / 常见 ARIA 表单 | 通用扫描与安全填写 |
| Ant Mobile `am-*` 选择器 | 组件级支持单列滚轮和完整日期；两种布局的本地回归通过，京东实页待复验 |
| 未验证的私有组件 | 能识别的字段会处理，其余项保留为待处理 |

同一种招聘系统也可能因公司配置和版本不同而出现新的控件结构。真实页面的验证范围、日期和已知差异记录在 [`docs/SITE-COMPATIBILITY.md`](docs/SITE-COMPATIBILITY.md)。

扩展按“通用识别与校验 → 可复用组件 → 平台语义补充”逐步分层。未知官网不会自动新增经历；如果报告提示区块尚未展开，可先手动添加经历，再重新扫描。

当前仍需人工处理的典型内容：

- 简历附件、证件照、作品集文件和其他上传项。
- 隐私声明、承诺书、验证码和最终提交。
- 履历中缺失、存在歧义或需要本人判断的信息。
- iframe、Shadow DOM、虚拟滚动列表、富文本编辑器及未验证的多级联动控件。

## 数据与隐私

ApplyKit 没有账号、服务器、统计 SDK、广告或运行时模型调用。履历、规则和投递记录保存在 `chrome.storage.local` 中。

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 仅在你点击扩展后访问当前招聘页面 |
| `scripting` | 注入页面扫描、填写和回读校验逻辑 |
| `storage` | 在本机保存履历、映射规则、运行结果和投递记录 |

扩展不申请 `<all_urls>`、`tabs`、`cookies` 或 `downloads`。卸载扩展会删除浏览器中的本地数据；请定期从“备份”页导出完整备份。备份文件是明文 JSON，应按个人敏感资料妥善保存。

详细说明见[隐私政策](PRIVACY.md)和[安全政策](SECURITY.md)。

## 修改代码与验证

源码修改后重新构建：

```bash
npm run build
```

然后在 `chrome://extensions` 中点击扩展的“重新加载”，并刷新目标招聘页面。不要反复卸载；卸载会清除扩展本地数据。

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | TypeScript 静态检查 |
| `npm test` | 运行 Vitest 单元测试 |
| `npm run build` | 生成生产扩展并校验 manifest、文件引用和权限 |
| `npm run build:e2e` | 生成只供测试使用的 `.test-dist/` |
| `npm run test:e2e` | 使用 Playwright Chromium 运行真实扩展端到端测试 |
| `npm run diagnose` | 构建只读兼容性诊断工具，帮助分析新的招聘页面 |
| `npm run verify` | 依次执行类型检查、单元测试、生产构建和端到端测试 |

首次运行端到端测试前需要安装匹配的 Chromium：

```bash
npx playwright install chromium
npm run verify
```

测试范围和验收结果见 [`docs/DEMO-ACCEPTANCE.md`](docs/DEMO-ACCEPTANCE.md)。

## 项目结构

```text
assets/branding/  品牌图标源文件
public/           manifest、扩展页面、样式和运行时图标
src/background/   本地持久化、填写计划、运行协调和投递记录
src/content/      页面扫描、控件操作、回读校验和站点适配器
  components/     可复用组件契约、发现与执行入口（不依赖公司域名）
  adapters/       平台语义、表单范围和已验证的业务补充
src/shared/       数据模型、校验、匹配、日期、URL 和 CSV
src/ui/           工具栏弹窗与管理工作台
demo/             通用、Moka、北森与飞书结构的本地演示页
fixtures/         虚构履历、投递记录样例和无效输入测试集
tests/            单元测试与真实扩展端到端测试
docs/             教程、实施记录、验收与站点兼容性文档
```

图标的 ImageGen 原始 PNG 位于 [`assets/branding/applykit-icon-source.png`](assets/branding/applykit-icon-source.png)，Chrome 使用的 16、32、48、128 像素版本位于 [`public/icons/`](public/icons/)。

## 参与贡献

欢迎提交问题、可脱敏复现的站点兼容性报告和代码改进。请勿在 Issue、截图、HTML 或诊断材料中提交真实姓名、手机号、邮箱、证件号码或完整简历内容。

开始修改前请阅读：

- [`CONTRIBUTING.md`](CONTRIBUTING.md)：开发流程、测试要求和适配器规范。
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)：社区协作行为准则。
- [`CHANGELOG.md`](CHANGELOG.md)：版本变更记录。

## 许可与商标

本项目采用 [MIT License](LICENSE)。运行时依赖及许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

Moka、北森、飞书招聘、蔚来、科大讯飞及文档中出现的其他产品和公司名称归各自权利人所有，仅用于描述兼容性测试。ApplyKit 与这些公司或产品没有隶属、授权或背书关系。
