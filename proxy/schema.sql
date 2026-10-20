-- 每天每个设备号 / IP / 所有人合计用掉的 token。不存任何请求内容。
CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,     -- 北京时间 YYYY-MM-DD
  who TEXT NOT NULL,     -- d:<设备号> / ip:<IP> / all
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, who)
);
