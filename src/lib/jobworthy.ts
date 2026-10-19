import "server-only";
import { newId } from "./store";
import { directionsOf, isOverseas, parseDeadline } from "./tracker-logic";
import type { Direction, JobPosting } from "./tracker-types";

/**
 * 校招公司清单：开源项目 jobworthy（github.com/wlunan/jobworthy，Apache-2.0）每天 09:30 汇总 1800 多家公司的校招信息，
 * 每条是"公司 + 招聘方向 + 官方校招入口"，没有具体岗位。入库时标 siteOnly：你在官网搜到合适的岗位后把链接贴回来；
 * 官网是飞书招聘的，会自动按简历关键词找出具体岗位（见 campus-search.ts）。
 */
export const JOBWORTHY_SOURCE = "jobworthy";
// 国内直连 GitHub 原始文件常常超时：先用项目自己的网站和 jsDelivr 镜像，最后才用 GitHub
export const JOBWORTHY_URLS = [
  "https://job.vkfc.dpdns.org/jobs.json",
  "https://cdn.jsdelivr.net/gh/wlunan/jobworthy@main/jobs.json",
  "https://raw.githubusercontent.com/wlunan/jobworthy/main/jobs.json",
];

interface Raw {
  c?: string; // 公司
  p?: string; // 招聘方向
  l?: string; // 地点
  w?: string; // 批次
  d?: string; // 截止
  ind?: string; // 行业
  u?: string; // 投递入口
  a?: string; // 官方公告
}

export async function fetchJobworthy(myDirections: Direction[]): Promise<{ jobs: JobPosting[]; updated?: string }> {
  let data: { updated?: string; jobs?: Raw[] } | undefined;
  let lastError = "";
  for (const url of JOBWORTHY_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`下载失败（${res.status}）`);
      data = (await res.json()) as { updated?: string; jobs?: Raw[] };
      if (Array.isArray(data.jobs)) break;
    } catch (e) {
      lastError = (e as Error).message;
      data = undefined;
    }
  }
  if (!data) throw new Error(`下载失败：${lastError}`);
  const now = new Date().toISOString();
  const jobs: JobPosting[] = [];
  const seen = new Set<string>();
  for (const r of data.jobs ?? []) {
    // 内推清单里的公司名带"(8.14开启）热门优先投"之类的说明，去掉
    const company = r.c?.replace(/[（(][^)）]*[)）]/g, "").replace(/热门优先投|优先投|内推/g, "").trim();
    const link = (r.u || r.a || "").trim();
    if (!company || !/^https?:\/\//.test(link)) continue;
    const batch = r.w?.trim() ?? "";
    if (/实习/.test(batch) && !/转正/.test(batch)) continue; // 只要正式校招
    // 同一家公司在两个清单里各出现一次，名字写法可能不同（"波克"和"波克城市"），按官网链接去重
    const key = link.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = r.p?.trim() || "校园招聘";
    const directions = directionsOf(title);
    // 方向概述里写了好几类（"算法、软件、产品、运营"），有一类是我的方向就收
    if (myDirections.length && !directions.some((d) => myDirections.includes(d))) continue;
    const deadline = r.d?.trim() ?? "";
    const notice = r.a?.trim();
    jobs.push({
      id: newId(),
      company,
      title,
      location: r.l?.trim() ?? "",
      deadline,
      deadlineAt: deadline ? parseDeadline(deadline) : undefined,
      link,
      ...(notice && notice !== link ? { noticeUrl: notice } : {}),
      siteOnly: true,
      batch,
      industry: r.ind?.trim() ?? "",
      note: "",
      directions,
      overseas: isOverseas(title, r.ind ?? "", r.l ?? ""),
      source: JOBWORTHY_SOURCE,
      starred: false,
      createdAt: now,
    });
  }
  return { jobs, updated: data.updated };
}
