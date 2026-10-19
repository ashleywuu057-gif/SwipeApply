# 无效输入样例

这些文件用于验证导入校验：任何一个都不能改变已有数据，并且必须给出具体的错误路径与原因。

| 文件 | 预期错误 |
| --- | --- |
| `profile.wrong-kind.json` | kind 是投递记录文件，履历入口应拒绝 |
| `profile.bad-date.json` | 2 月 30 日不存在 |
| `profile.day-without-month.json` | 有「日」但没有「月」 |
| `profile.future-version.json` | schemaVersion 不受支持 |
| `profile.bad-url.json` | 主页不是 http/https 链接 |
| `applications.applied-without-evidence.json` | 状态 applied 但缺少 appliedAt 与提交证据 |
