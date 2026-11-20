import { createHash } from "node:crypto";

const origin = "https://www.shanghaimuseum.cn";
export const eastVisitGuide = `${origin}/mu/frontend/pg/service/visit-east`;

export function directEastVisitTask(outputPath) {
  return `请查上海博物馆东馆官网 ${eastVisitGuide}，把普通周二下午是否开放、开放日几点停止入场写成一句中文参观提示，附上看过的官网网址。请将它写入已打开的空白文档 ${outputPath} 并保存。`;
}

export function museumVisitTask({ outputPath, existingPath } = {}) {
  return [
    `我想在一个普通周二下午去上海博物馆看中国古代青铜器。请从官网（${origin}）查一下，青铜馆在哪个馆区、那天下午能不能看、该馆开放日最晚几点入场。`,
    "请给我一个可行的工作日下午到馆方案，写明星期几和几点到。附上你实际查看过、能核对展厅所在馆区和开放时间的官网链接。",
    outputPath ? `请用桌面文档编辑器把这份中文参观说明保存到 ${outputPath}。` : "把这份中文参观说明直接回复给我。",
    existingPath ? `请保留已有文件 ${existingPath}。` : "",
  ].filter(Boolean).join("");
}

function canonicalOfficialUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password) return undefined;
    url.hash = "";
    url.searchParams.delete("scrollTarget");
    return url.href;
  } catch { return undefined; }
}

/** Run on the submitted answer or independently opened file, never on the task prompt. */
export function checkVisitNote(text, { observedUrls = [] } = {}) {
  const note = String(text ?? "").normalize("NFKC").replace(/[*_]/gu, "");
  const links = note.match(/https?:\/\/[a-z0-9./_?=%&#:+~-]+/giu) ?? [];
  const citedUrls = [...new Set(links.map(url => canonicalOfficialUrl(url.replace(/[.,]+$/u, ""))).filter(Boolean))];
  const observed = new Set(Array.from(observedUrls, canonicalOfficialUrl).filter(Boolean));
  const prose = note.replace(/https?:\/\/\S+/gu, " ");
  const claims = prose.split(/[。；;!?！？\n]+/u);
  const hasVenue = claims.some((line, index) => {
    const adjacent = `${line} ${claims[index + 1] ?? ""}`;
    const match = /青铜(?:器馆|馆|器).{0,60}?东馆|东馆.{0,60}?青铜(?:器馆|馆|器)/u.exec(adjacent);
    return match && !/人民广场|西馆|不在|并非|不能确认|尚未确认|无法确认|尚未确定/u.test(match[0])
      && !/尚未确定|尚未确认|无法确认|未能确认/u.test(line);
  });
  const tuesday = /(?:周二|星期二|礼拜二).{0,24}?(?:闭馆|休馆|不开放|不对外开放|无法参观|不能参观)|(?:闭馆日|休馆日).{0,12}?(?:周二|星期二)/u;
  const closed = claims.some(line => tuesday.test(line) && !/(?:周二|星期二).{0,10}(?:不闭馆|正常开放|照常开放)/u.test(line)
    && (!line.includes("人民广场馆") || line.includes("东馆")));
  const last = "(?:17\\s*[:时点]\\s*(?:00|整)?|下午\\s*(?:5|五)\\s*[时点](?:整)?)";
  const admission = "(?:停止(?:入场|入馆|检票)|最晚(?:入场|入馆)|最后(?:入场|入馆)|入场截止|入馆截止)";
  const lastAdmission = new RegExp(`${last}[^。;；\\n]{0,14}${admission}|${admission}[^。;；\\n]{0,18}${last}`, "u").test(prose);
  const weekdays = [...prose.matchAll(/(?:周|星期|礼拜)[一三四五]/gu)];
  const alternate = weekdays.some(day => {
    const nearby = prose.slice(Math.max(0, day.index - 22), day.index + 76);
    return /(?:1[2-6])\s*(?:[:时点](?:[0-5]\d|半|整)?)|下午\s*(?:[1-4一二两三四])\s*[点时](?:半|整)?/u.test(nearby);
  });
  const checks = { galleryAtEast: hasVenue, ordinaryTuesdayClosed: closed, lastAdmission17: lastAdmission,
    alternateWeekdayAfternoon: alternate, citedObservedOfficialPage: citedUrls.length > 0 && citedUrls.every(url => observed.has(url)) };
  return { passed: Object.values(checks).every(Boolean), checks, citedUrls };
}

/** The direct-guide task asks only for opening days, the entry cutoff and their source. */
export function checkEastVisitHours(text, { observedUrls = [] } = {}) {
  const note = checkVisitNote(text, { observedUrls });
  const checks = { ordinaryTuesdayClosed: note.checks.ordinaryTuesdayClosed, lastAdmission17: note.checks.lastAdmission17,
    citedObservedGuide: note.checks.citedObservedOfficialPage && note.citedUrls.includes(eastVisitGuide) };
  return { passed: Object.values(checks).every(Boolean), checks, citedUrls: note.citedUrls };
}

/** Independent official reference, obtained outside the model conversation. */
export async function fetchMuseumReference({ signal } = {}) {
  const sources = await Promise.all(["visit-east", "guide"].map(async name => {
    const url = `${origin}/mu/frontend/pg/service/${name}`;
    const timeout = AbortSignal.timeout(18_000);
    const response = await fetch(url, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw Error(`museum_reference_http_${response.status}`);
    const html = await response.text();
    const rendered = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ").replace(/<[^>]+>/gu, " ").replace(/&nbsp;|\s+/giu, " ");
    const confirmed = name === "guide"
      ? /(?:上博|上海博物馆)东馆.{0,18}青铜馆/u.test(rendered)
      : /17:00.{0,12}停止入场/u.test(rendered) && /周二闭馆/u.test(rendered);
    return { url, confirmed, sha256: createHash("sha256").update(html, "utf8").digest("hex") };
  }));
  return { confirmed: sources.every(source => source.confirmed), checkedAt: new Date().toISOString(), sources };
}
