# Demo 验收记录

最新全量复验：2026-09-16。`npm run verify` 通过：118 个单元测试和 52 个扩展端到端场景全部成功；覆盖北森精确敏感字段、通用敏感字段拦截、教育日期默认值、原生日期、Ant Mobile 日期，以及既有 Moka、北森和飞书流程。生产包 629.2 KiB，权限仍为 `activeTab, scripting, storage`。

2026-09-10 的全量复验覆盖飞书招聘 ATSX 的 ARIA/portal 下拉、带序号的多选回读、候选城市唯一交集、树形地区、连续双端年月、“至今”、年份选择、动态经历、自我评价展开、浏览器原生文本编辑、文本延迟回滚恢复与第二轮幂等；北森和 Moka 专项保持通过。升级开发工具并修复手动映射的异步完成竞态后，全量 `npm run verify` 通过：110 个单元测试、44 个真实扩展端到端测试；权限仍为 `activeTab, scripting, storage`。v10 飞书实页已达到 53 项填写、6 项待处理、0 项失败，v11 等待“至今”和邮箱最后写入复验。

2026-09-05 已按真实 Moka 的双层年月范围、年份自动补月和已选值展示结构扩展回归。该轮 `npm run verify` 通过：101 个单元测试、40 个真实扩展端到端测试（2.1 分钟）；生产包 515.8 KiB。其中专用 Moka 回归先复现未修复版本失败，再验证修复版本通过。

以下为 2026-09-03 的历史验收记录；真实招聘页当前验证状态见 `SITE-COMPATIBILITY.md`。

历史执行日期：2026-09-03
机器：macOS（darwin，Apple Silicon）
Node：v24.9.0 / npm 11.6.0
自动化浏览器：Playwright 1.62.1 自带 Chrome Headless Shell 151.0.7922.34（独立临时 profile，未使用日常 Chrome 配置）

所有数字都来自实际执行输出，没有预填。

## 1. 执行的命令

```text
$ npm run typecheck
（无输出，通过）

$ npm test
 ✓ tests/unit/matching.test.ts (13 tests)
 ✓ tests/unit/projection.test.ts (17 tests)
 ✓ tests/unit/schemas.test.ts (14 tests)
 ✓ tests/unit/urls-csv.test.ts (18 tests)
 ✓ tests/unit/storage-planner.test.ts (10 tests)
 ✓ tests/unit/state.test.ts (22 tests)
 Test Files  6 passed (6)
      Tests  94 passed (94)

$ npm run build
[build] dist/ 完成，471.1 KiB，权限: activeTab, scripting, storage

$ npm run build:e2e
[build:e2e] .test-dist/ 完成（仅用于自动化测试，不作为安装交付）

$ npm run test:e2e
26 passed (43.8s)
```

## 2. 单元测试覆盖的验收点

| 编号 | 场景 | 结果 | 用例位置 |
| --- | --- | --- | --- |
| U01 | 布尔 false、数字 0、null、空数组 | 通过 | `schemas.test.ts` |
| U02 | 日期精度、闰年、至今、未来毕业时间 | 通过 | `schemas.test.ts` / `projection.test.ts` |
| U03 | 分区内同名字段（姓名/学校/公司、三种地址） | 通过 | `matching.test.ts` |
| U04 | 多教育、多项目、排序、同名歧义 | 通过 | `matching.test.ts` |
| U05 | 枚举匹配（唯一等价、无等价、多等价、学历≠学位） | 通过 | `projection.test.ts` |
| U06 | 缓存规则复用与结构变化失效 | 通过 | `state.test.ts` |
| U07 | URL 清洗、canonicalUrl、去重键、身份完整度 | 通过 | `urls-csv.test.ts` |
| U08 | CSV 往返（中文、逗号、引号、换行、公式保护、空值） | 通过 | `urls-csv.test.ts` |
| U09 | schema / 版本 / 大小 / 类型错误的具体路径 | 通过 | `schemas.test.ts` |
| U10 | 状态迁移与提交证据 | 通过 | `state.test.ts` |
| U11 | 消息来源检查与 mutation 去重、revision 冲突 | 通过 | `state.test.ts` / `storage-planner.test.ts` |
| U12 | 存储版本升级与损坏数据保护 | 通过 | `state.test.ts` |

## 3. 端到端验收场景

真实加载 `.test-dist/` 扩展，断言的是**网页控件的实际值**与**演示页自己事件监听器记录的状态**，不是插件自己的统计数字。

| 编号 | 场景 | 结果 | 用例 |
| --- | --- | --- | --- |
| E01 | 导入样例 → 填 basic → 对照网页值与页面事件状态 → 保存记录 | 通过 | `01-basic.spec.ts` |
| E02 | 填 experience → 两学历不串位 → 年月正确 → 新增第二项目恰好一次 | 通过 | `02-experience.spec.ts` |
| E03 | 未知字段首次 pending → 用户映射 → 清空重填 → 本地规则命中 | 通过 | `03-edge-cases.spec.ts` |
| E04 | 改变标签与选项 → 旧规则失效，不误填 | 通过 | `03-edge-cases.spec.ts` |
| E05 | 扫描后用户编辑 → 保留用户新值；连续点击不创建并行运行 | 通过 | `01-basic.spec.ts` |
| E06 | 关闭发起页面后填写继续；取消后不再执行后续动作 | 通过 | `01-basic.spec.ts` |
| E07 | 填写中导航 → 停止旧计划，新页面未被写入 | 通过 | `02-experience.spec.ts` |
| E08 | 声明/文件/隐藏/密码/iframe/无语义自定义控件不被操作；教育日期按 9 月 1 日/6 月 30 日补全 | 通过 | `01-basic.spec.ts` / `03-edge-cases.spec.ts` |
| E09 | 插件填完仍未投递；网页手动成功后用户确认，记录才变更 | 通过 | `04-applications.spec.ts` |
| E10 | 相同岗位提示已有记录，不同岗位独立保存；CSV 重复项可选择跳过 | 通过 | `04-applications.spec.ts` |
| E11 | 完整备份 → 新测试 profile 恢复 → 履历、规则、记录一致且可直接填写 | 通过 | `05-persistence.spec.ts` |
| E12 | 浏览器重启后资料存在，旧任务不重复执行 | 通过 | `05-persistence.spec.ts` |

额外场景：

| 场景 | 结果 | 用例 |
| --- | --- | --- |
| 网页异步把字段标为无效 → 报告为 `failed / VALIDATION_FAILED`，不谎报成功 | 通过 | `01-basic.spec.ts` |
| 无效履历文件（5 种）导入失败后已有数据不变 | 通过 | `05-persistence.spec.ts` |
| 结果清单统计与实际字段数一致，可筛选、可定位、源字段选择器是中文 | 通过 | `07-ui.spec.ts` |
| 弹窗可打开、显示当前履历与页面、扫描后显示真实统计 | 通过 | `07-ui.spec.ts` |
| Moka 式四段年月范围真实点选并回读；扫描预览区分「可自动填写」与「待处理」 | 通过 | `08-ats-style.spec.ts` / `07-ui.spec.ts` |
| 北森 Phoenix 表单根节点、深层标签、portal 下拉、视觉单选、年月和 div 新增经历 | 通过 | `10-beisen-adapter.spec.ts` |
| 飞书 ATSX 分区、ARIA 下拉、树形地区、双端年月、年份和动态经历 | 通过 | `11-feishu-adapter.spec.ts` |
| 编辑保存生成新版本且旧版本不变；格式检查拦截错误邮箱 | 通过 | `07-ui.spec.ts` |

## 4. 三个演示页面的字段结果

数据来自一次完整运行（`npm run test:e2e` 中 `06-performance.spec.ts` 的最后一轮）。

| 页面 | 纳入报告的逻辑字段 | 已填写 | 其余分布 |
| --- | --- | --- | --- |
| basic.html | 16 | 8 | 原值相同 2（英文名、是否接受异地）、保留原值 1（现居城市）、待处理 5 |
| experience.html | 23 | 23 | 无 |
| edge-cases.html | 17 | 5 | 原值相同 1、待处理 11 |

basic.html 的 5 项待处理分别是：GitHub（履历中为 null）、出生日期（需逐项确认）、意向岗位（履历里有 2 个意向，不擅自选一个）、「我同意接收职位推荐邮件」（声明类）、演示页自己的「模拟邮箱异步校验失败」开关。

edge-cases.html 的 11 项待处理：联系信箱入口（首次未知标签）、户籍地、学校地址、毕业时间（精度不足）、补充说明、第二个同名项目的名称与职责（身份歧义）、简历附件、声明勾选、内嵌 iframe、无语义自定义控件。

**预先标注为 P0 支持且资料齐全的字段全部正确填写；预先列出的不支持字段全部正确进入待处理。** 覆盖错误的次数为 0，教育/项目串位次数为 0，自动提交次数为 0，模型调用次数为 0。

## 5. 性能

每页连续跑 5 次，耗时包含扫描、匹配、DOM 操作与回读，不含用户手动处理与提交。原始数据：`test-results/performance.json`。

| 页面 | 字段数 | 中位数 | 最大值 | 目标 | 结论 |
| --- | --- | --- | --- | --- | --- |
| basic.html | 16 | 802 ms | 810 ms | < 5 s | 达标 |
| experience.html | 23（含异步下拉与新增经历） | 1446 ms | 1462 ms | < 15 s | 达标 |
| edge-cases.html | 17 | 647 ms | 677 ms | < 5 s | 达标 |

说明：这三页的字段数是 16–23，没有达到 30 个普通字段的规模；上表不能直接外推成「30 字段 5 秒内」的实测结论，只能说明当前受控页面远在预算之内。

## 6. 未通过 / 未执行的项目

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 工具栏点击触发 activeTab 的手工验证 | **未执行** | 自动化无法真实点击扩展图标。请按 README 第 3 节在日常 Chrome 中加载 `dist/`，点击图标后在演示页填写一次，并把结果记到本表。 |
| 真实招聘网站验证 | **部分完成** | Moka、北森 Phoenix 和飞书招聘 ATSX 已实际填写复验；其它网站见 `SITE-COMPATIBILITY.md`。 |
| 截图 / 录屏 | **未提供** | 本次验收以自动化断言与本文件记录为准。 |

## 7. 手工验证记录（待填）

| 日期 | Chrome 版本 | 步骤 | 结果 |
| --- | --- | --- | --- |
| （待填） | （待填） | 加载 `dist/` → 打开 `http://127.0.0.1:4173/basic.html` → 点击工具栏图标 → 一键填写 | （待填） |
