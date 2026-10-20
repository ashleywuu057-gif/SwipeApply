# SwipeApply 免费额度中转

没填自己 Key 的 SwipeApply，AI 请求会发到这里（https://swipeapply-api.pages.dev），由这里加上作者的 Key 转给 DeepSeek / 通义千问。

- **只转 4 个接口**：DeepSeek 对话、千问对话、千问向量、千问联网搜索；只允许 `deepseek-*`、`qwen-flash/turbo/plus`、`text-embedding-v*` 这几类模型
- **按天限额**（北京时间 0 点重置）：每台电脑 20 万 token、每个 IP 40 万、所有人合计 300 万。改 `wrangler.toml` 的 `[vars]` 后重新部署
- **不存请求内容**：D1 里只有「哪天、哪个设备号 / IP / 合计、用了多少 token」
- 用 `pages.dev` 而不是 `workers.dev`：workers.dev 在国内 DNS 被污染，直连打不开；pages.dev 实测国内能直连

## 部署

```bash
npx wrangler login
npx wrangler d1 create swipeapply-usage          # 把输出的 database_id 填进 wrangler.toml
npx wrangler d1 execute swipeapply-usage --remote --file=schema.sql
npx wrangler pages project create swipeapply-api --production-branch main
npx wrangler pages secret put DEEPSEEK_KEY --project-name swipeapply-api
npx wrangler pages secret put DASHSCOPE_KEY --project-name swipeapply-api
npx wrangler pages deploy public --project-name swipeapply-api --branch main
```

## 看用量

```bash
npx wrangler d1 execute swipeapply-usage --remote --command "SELECT * FROM usage WHERE who = 'all' ORDER BY day DESC LIMIT 7"
```

## 出事了怎么办

有人滥用、或者想暂停免费额度：把 `GLOBAL_TOKENS` 改成 `"0"` 重新部署，所有免费请求立刻停止；或者去 DeepSeek / 百炼后台作废对应的 Key。
