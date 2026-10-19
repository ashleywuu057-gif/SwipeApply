# SwipeApply对 ApplyKit 的本地改动

本目录来自开源项目 [ApplyKit](https://github.com/DeepestWind/ApplyKit)（MIT，见 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`），
取自 2026-09-25 的 `main` 分支。以后合并上游更新时，只需要把下面这些改动重新套上。

| 文件 | 改动 |
| --- | --- |
| `src/background/jobprep.ts` | 新增：从本机SwipeApply（localhost:3000）同步履历；确认已提交后回传 |
| `src/shared/protocol.ts` | 新增 `SYNC_JOBPREP` 消息 |
| `src/background/index.ts` | 处理 `SYNC_JOBPREP`（导入履历，内容相同则幂等）；`CONFIRM_SUBMITTED` 成功后调用 `notifyJobprepSubmitted` |
| `src/ui/popup.ts`、`public/popup.html` | 弹窗加「从SwipeApply同步履历」按钮；标题改为「SwipeApply · 投简助手」 |
| `public/manifest.json` | 名称和描述；`host_permissions` 只加 `http://localhost:3000/*`、`http://127.0.0.1:3000/*` |
| `scripts/build.mjs` | 构建检查原来禁止任何 `host_permissions`，改为只放行上面两个本机地址 |
| `src/content/adapters/feishu-formily.ts`（新增）、`adapters/registry.ts` | 新版飞书招聘申请表（ud-formily 组件库，例如小鹏）：按 `formily-item-*` 编号绑定字段、划分经历卡片、自动点「添加」。配套：`dom-utils.ts` 从 `.ud-formily-item-label` 读标签；`scanner.ts` 检查孤儿标签时认 `.ud-formily-item`。回归页 `demo/feishu-formily-style.*`，测试 `tests/e2e/13-feishu-formily-adapter.spec.ts`。下拉、日期暂未适配 |
| 新版飞书下拉（`custom-select.ts`、`dom-utils.ts`、`scanner.ts`、`verify.ts`） | 认 `.ud__select__list__item` 选项和 `.ud__select__selector__selectItem` 已选值；ud 下拉 mousedown 展开；带 readonly 的 ud 下拉不当锁定字段（selector 标 disabled 才算锁定）；包在 `.ud__select` 里的学校搜索框按可搜索下拉处理 |
| **记住你手动补填的内容**（新增 `background/remembered.ts`；改 `planner.ts`、`coordinator.ts`、`index.ts`、`protocol.ts`、`content/index.ts`、`ui/popup.ts`、`ui/rules.ts`） | 填写后弹窗出现「记住我补填的内容」：新命令 `READ_FIELD_VALUES` 只读这一轮待处理 / 失败字段现在的值（**唯一**把字段值带回后台的命令，只在你点按钮时发）→ 清单勾选 → 存进单独的 storage 键 `applykit.remembered-answers.v1`（不进 AppState、不进备份）。下次规划时，履历里没有的同名字段（经历类还要同一段经历）用记住的值，来源标 `remembered`。证件号、银行卡、社保公积金、密码永远不记；婚姻状况等敏感字段默认不勾、你勾了才记。「规则」页可查看和删除。测试：`tests/unit/remembered.test.ts`、`tests/e2e/13-*` 第 3 条 |
| `src/content/index.ts` | **修 bug**：单页应用（飞书招聘从岗位列表点进申请表）换路由后 `stale` 永远为 true，之后每次「扫描页面」都报"页面已经跳转或刷新，请重新扫描"。现在新的 `SCAN_PAGE` 会清掉 `stale` 并按当前路由重扫（旧计划照样作废）；`CONTENT_VERSION` 15 → 16，已打开的标签页会注入新脚本 |

v3 这边对应的接口：`src/app/api/applykit/profile`（提供履历）、`src/app/api/applykit/submitted`（接收已提交），
转换逻辑在 `src/lib/applykit.ts`。

## 构建

```bash
npm ci
npm run build   # 生成 dist/，在 edge://extensions 里「加载解压缩的扩展」选这个文件夹
```

在 Windows 上，ApplyKit 用的 TypeScript 7 可能缺平台二进制包；类型检查可以用主项目的 TypeScript：
`../node_modules/.bin/tsc --noEmit -p .`
