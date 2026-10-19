/**
 * 后台定时器：项目启动后每 5 分钟检查一次，到了每天设定的时间（默认 9:00）就更新岗位库，
 * 到了 12:00、15:00、19:00 就同步邮件。
 * 电脑关机或项目没开的时候不会运行；下次打开项目时，如果当天还没更新过，会自动补上。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { __jobprepTimer?: NodeJS.Timeout };
  if (g.__jobprepTimer) return;

  const port = process.env.PORT || "3000";
  const post = (api: string) =>
    fetch(`http://127.0.0.1:${port}${api}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto: true }),
    }).catch(() => undefined);
  // 岗位库每天一次；邮件在 12:00、15:00、19:00 各同步一次（时间点见 mail/sync 路由）
  const tick = () => post("/api/tracker/feeds/run").then(() => post("/api/tracker/mail/sync"));

  setTimeout(tick, 15_000); // 启动后稍等一下，服务就绪后先检查一次
  g.__jobprepTimer = setInterval(tick, 5 * 60_000);
}
