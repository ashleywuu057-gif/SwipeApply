import { mergeJobs, rowsToJobs, tablesFrom } from "@/lib/job-import";
import { feishuJobs, isFeishuSite, resumeKeywords } from "@/lib/campus-search";
import { searchConfig, searchJobs, skipApplied } from "@/lib/job-search";
import { fetchJobworthy } from "@/lib/jobworthy";
import { newId, readLibrary } from "@/lib/store";
import { readTracker, updateTracker } from "@/lib/tracker-store";
import { directionsOf, isOverseas } from "@/lib/tracker-logic";
import { DEFAULT_MY_SECTORS, type JobFeed, type JobPosting, type TrackerData } from "@/lib/tracker-types";

/**
 * 更新岗位库：同步 jobworthy 校招公司清单（飞书招聘的官网再按简历关键词找出具体岗位）+ 拉取订阅源 + 可选的千问联网搜索，
 * 新岗位直接入库（重复的跳过）。
 * auto=true 是后台定时器调用的：没到每天设定的时间、或今天已经跑过，就跳过。
 */
export async function POST(req: Request) {
  const { auto } = (await req.json().catch(() => ({}))) as { auto?: boolean };
  const d = await readTracker();
  const today = localDate(new Date());

  if (auto) {
    const [h, m] = (d.settings.dailyTime || "09:00").split(":").map(Number);
    const now = new Date();
    const due = now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
    if (!due || d.settings.lastAutoRunDate === today) return Response.json({ skipped: true });
    // 联网搜索要几分钟，先记下今天已经开始，免得定时器下一轮重复跑
    const claimed = await updateTracker((t) => {
      if (t.settings.lastAutoRunDate === today) return false;
      t.settings.lastAutoRunDate = today;
      return true;
    });
    if (!claimed) return Response.json({ skipped: true });
  }

  let searched: JobPosting[] = [];
  let searchError: string | undefined;
  const doSearch = searchConfig().enabled && d.settings.webSearch === true;
  if (doSearch) {
    try {
      searched = await searchJobs(d.settings.myDirections, d.settings.mySectors ?? DEFAULT_MY_SECTORS, d.applications.map((a) => a.company));
    } catch (e) {
      searchError = (e as Error).message;
    }
  }

  let worthy: JobPosting[] = [];
  let worthyUpdated: string | undefined;
  let worthyError: string | undefined;
  const doWorthy = d.settings.jobworthy !== false;
  if (doWorthy) {
    try {
      const r = await fetchJobworthy(d.settings.myDirections);
      worthy = r.jobs;
      worthyUpdated = r.updated;
    } catch (e) {
      worthyError = (e as Error).message;
    }
  }

  const feeds = d.settings.feeds.filter((f) => f.enabled);
  const results: Pick<JobFeed, "id" | "lastAdded" | "lastError">[] = [];
  const incoming: JobPosting[] = [];
  const errors: string[] = [];

  for (const f of feeds) {
    try {
      const jobs = await fetchFeed(f);
      incoming.push(...jobs);
      results.push({ id: f.id, lastAdded: jobs.length });
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${f.name}：${msg}`);
      results.push({ id: f.id, lastError: msg });
    }
  }

  const summary = await updateTracker((t) => {
    // 按订阅源分别统计新增
    let added = 0;
    for (const r of results) {
      const feed = t.settings.feeds.find((x) => x.id === r.id);
      if (!feed) continue;
      feed.lastFetchedAt = new Date().toISOString();
      if (r.lastError) {
        feed.lastError = r.lastError;
        feed.lastAdded = 0;
        continue;
      }
      const mine = incoming.filter((j) => j.source === `订阅：${feed.name}`);
      const { added: n } = mergeJobs(t.jobs, mine);
      feed.lastAdded = n;
      feed.lastError = undefined;
      added += n;
    }
    if (doSearch) {
      const { added: n } = mergeJobs(t.jobs, skipApplied(searched, t.applications));
      t.settings.lastSearch = { at: new Date().toISOString(), added: n, error: searchError };
      if (searchError) errors.push(`联网搜索：${searchError}`);
      added += n;
    }
    if (doWorthy) {
      const { added: n } = mergeJobs(t.jobs, skipApplied(worthy, t.applications));
      t.settings.lastJobworthy = { at: new Date().toISOString(), added: n, expanded: 0, updated: worthyUpdated, error: worthyError };
      if (worthyError) errors.push(`jobworthy：${worthyError}`);
      added += n;
    }
    t.settings.lastAutoRunDate = today;
    t.settings.lastAutoRun = { at: new Date().toISOString(), added, errors, trigger: auto ? "定时" : "手动" };
    return t.settings.lastAutoRun;
  });

  // 飞书招聘的官网：按简历关键词找出具体岗位
  const found = await expandFeishu(await readTracker());
  if (found.added) {
    await updateTracker((t) => {
      t.settings.lastAutoRun = t.settings.lastAutoRun && { ...t.settings.lastAutoRun, added: t.settings.lastAutoRun.added + found.added };
      if (t.settings.lastJobworthy) t.settings.lastJobworthy.expanded = found.added;
    });
  }

  return Response.json({ ...summary, added: summary.added + found.added, feeds: feeds.length });
}

const MAX_EXPAND = 40; // 每次最多查几家官网，剩下的下次再查
const RECHECK_MS = 3 * 86400000; // 查过的飞书官网 3 天后再查一次：会有新发的岗位（以前查过一次就再也不查，岗位流会空掉）

async function expandFeishu(d: TrackerData): Promise<{ added: number }> {
  const due = (j: JobPosting) => !j.expandedAt || Date.now() - new Date(j.expandedAt).getTime() > RECHECK_MS;
  const todo = d.jobs
    .filter((j) => j.siteOnly && isFeishuSite(j.link) && due(j))
    .sort((a, b) => (a.expandedAt ?? "").localeCompare(b.expandedAt ?? "")) // 没查过的、最久没查的先查
    .slice(0, MAX_EXPAND);
  if (!todo.length) return { added: 0 };
  const keywords = d.settings.jobKeywords?.length ? d.settings.jobKeywords : resumeKeywords((await readLibrary()).cards.map((c) => c.role ?? ""));
  const found: { parentId: string; jobs: JobPosting[] }[] = [];
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(
      todo.slice(i, i + 4).map(async (p) => {
        const list = await feishuJobs(p.link, keywords).catch(() => []);
        const now = new Date().toISOString();
        found.push({
          parentId: p.id,
          jobs: list.map((j) => ({
            id: newId(),
            company: p.company,
            title: j.title,
            location: j.location ?? p.location,
            deadline: p.deadline,
            deadlineAt: p.deadlineAt,
            link: j.url,
            jdUrl: j.url,
            batch: p.batch,
            industry: p.industry,
            note: "",
            directions: directionsOf(j.title),
            overseas: isOverseas(j.title, p.industry, j.location ?? ""),
            source: "官网职位",
            starred: false,
            createdAt: now,
          })),
        });
      }),
    );
  }
  return updateTracker((t) => {
    let added = 0;
    const now = new Date().toISOString();
    for (const f of found) {
      const parent = t.jobs.find((j) => j.id === f.parentId);
      if (parent) parent.expandedAt = now;
      added += mergeJobs(t.jobs, f.jobs).added;
    }
    return { added };
  });
}

async function fetchFeed(f: JobFeed): Promise<JobPosting[]> {
  const url = normalizeUrl(f.url);
  if (/docs\.qq\.com|feishu\.cn|larksuite|shimo\.im|kdocs\.cn/.test(url)) {
    throw new Error("腾讯文档、飞书、石墨、金山文档的链接需要登录才能读取，请导出为 Excel 后手动导入，或找公开的下载链接");
  }
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 jobprep" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`下载失败（${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tables = await tablesFrom(url, buf, res.headers.get("content-type") ?? "");
  const jobs = tables.flatMap((rows) => rowsToJobs(rows, `订阅：${f.name}`).jobs);
  if (!jobs.length) throw new Error("没有找到岗位表格（需要有「公司」和「岗位」或「链接」列）");
  return jobs;
}

/** GitHub 页面链接转成原始文件链接 */
function normalizeUrl(u: string) {
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : u;
}

function localDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
