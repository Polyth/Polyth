#!/usr/bin/env node
// Closed team dashboard for the community-metrics snapshots
// (docs/operations/community-metrics.md). One dependency-free file next to
// community-metrics.mjs; it serves a script-free HTML page (and its daily CSV)
// behind a password and nothing else. Closed by default: without a valid
// `password.scrypt` every request is answered 503, and a wrong password is
// never told apart from none.
//
//   node scripts/community-metrics-server.mjs serve              # METRICS_KEYS_DIR=/keys METRICS_DATA_DIR=/data
//   node scripts/community-metrics-server.mjs hash-password      # password from stdin -> the line password.scrypt holds
//
// Configuration: METRICS_HOST/METRICS_PORT (default 127.0.0.1:8789). A
// non-loopback host needs METRICS_TLS_TERMINATED=1 (a TLS proxy in front).
// METRICS_LANG (uk|en, default uk) and METRICS_TIMEZONE (default Europe/Kyiv)
// change only how the page reads.
// METRICS_TRUSTED_PROXY is not read: the lockout is service-wide, so no client
// address is ever needed, kept or logged.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEvents, parseGoals, parseLines, parseWeeklyNote, renderCsv, summarizeDashboard } from "./community-metrics.mjs";

const PREFIX = "scrypt";
const COST = { N: 16_384, r: 8, p: 1 };
const HASH_BYTES = 32;
const MAX_PASSWORD = 200;
const MAX_MEMORY = 64 * 1024 * 1024;
const LOCK_AFTER = 10;
const LOCK_WINDOW_MS = 15 * 60_000;

/** `scrypt$N$r$p$<salt>$<hash>`, the same line the report relay keeps. */
export function hashPassword(password) {
  if (!/^[\x21-\x7e]{1,200}$/.test(password)) throw new Error("password must be 1-200 printable ASCII characters without spaces");
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, HASH_BYTES, { ...COST, maxmem: MAX_MEMORY });
  return [PREFIX, COST.N, COST.r, COST.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export function parsePasswordLine(line) {
  const parts = String(line).trim().split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [N, r, p] = parts.slice(1, 4).map((part) => (/^\d{1,7}$/.test(part) ? Number(part) : Number.NaN));
  if (![N, r, p].every(Number.isInteger) || N < 1024 || N > 1_048_576 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  return salt.length >= 8 && salt.length <= 64 && hash.length === HASH_BYTES ? { N, r, p, salt, hash } : null;
}

export function verifyPassword(record, password) {
  if (!record || !password || password.length > MAX_PASSWORD) return false;
  try {
    const derived = scryptSync(password, record.salt, record.hash.length, { N: record.N, r: record.r, p: record.p, maxmem: MAX_MEMORY });
    return timingSafeEqual(derived, record.hash);
  } catch {
    return false;
  }
}

/** The password out of `Authorization: Basic …`; the user name is ignored. */
export function basicPassword(header) {
  const match = /^Basic ([A-Za-z0-9+/=]{1,400})$/.exec(header ?? "");
  if (!match) return "";
  const text = Buffer.from(match[1], "base64").toString("utf8");
  const colon = text.indexOf(":");
  return colon < 0 ? "" : text.slice(colon + 1);
}

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---- copy -------------------------------------------------------------------------------------------
// Two languages, Ukrainian by default (METRICS_LANG or ?lang=). `{name}` slots take already-escaped HTML.

const LOCALES = { uk: "uk-UA", en: "en-US" };
const TEXT = {
  uk: {
    title: "Polyth · Статистика",
    switchTo: ["en", "English"],
    updatedToday: "Оновлено сьогодні о {time}", updatedYesterday: "Оновлено вчора о {time}", updatedOn: "Оновлено {date} о {time}", stale: "Не оновлювалося з {date}",
    empty: "Ще немає даних. Щоденний запуск зробить перший знімок.",
    heroFirst: "Перший знімок зроблено {date}. Завантаження за день з'являться після наступного щоденного запуску.",
    heroPartial: "За {n} {days} обліку Polyth завантажили <strong>{x} {times}</strong>",
    heroWeek: "За останній тиждень Polyth завантажили <strong>{x} {times}</strong>",
    cmpUp: ", це більше, ніж тижнем раніше ({p}).", cmpDown: ", це менше, ніж тижнем раніше ({p}).", cmpFlat: ", приблизно стільки ж, як тижнем раніше ({p}).", cmpNone: ".",
    heroActive: " Щодня працює приблизно <strong>{a} {copies}</strong> застосунку на комп'ютерах.",
    heroTop: " Найпопулярніша платформа — <strong>{platform}</strong>.",
    status: { up: "Зростаємо", down: "Спад", flat: "Стабільно", wait: "Збираємо дані" },
    kpiDownloads: "Завантаження за 7 днів", kpiDownloadsVs: "до попереднього тижня", kpiDownloadsWait: "порівняння з'явиться за тиждень", kpiDownloadsPartial: "за {n} {days} обліку", kpiDownloadsNone: "з'являться після наступного знімка",
    kpiActive: "Активні застосунки", estimate: "оцінка", kpiActiveNote: "у середньому щодня, версії для комп'ютера",
    kpiTotal: "Усього завантажень", kpiTotalNote: "з {date}, коли почали облік", kpiTotalBefore: "з {date}, коли почали облік, і ще {n} до того",
    kpiGithub: "Інтерес на GitHub", kpiViews: "{visitors} сторінки за 14 днів · {s} {stars}", kpiStars: "{stars} на GitHub, зміна {period} · {f} {forks}", starsMonth: "за 30 днів", starsSince: "з {date}", kpiStarsOnly: "{stars} на GitHub · {f} {forks}",
    growth: "Як ростемо", metric: "Показник", period: "Період", mDownloads: "Завантаження", mActive: "Активні застосунки", p7: "7 днів", p30: "30 днів", p90: "90 днів",
    tipDownloads: "{n} {downloads}", tipDownloadsWeek: "{n} {downloads} за тиждень", tipActive: "≈ {n} {active}", tipActiveWeek: "≈ {n} {active} щодня (середнє)", tipSpread: "знімок пропущено, розподілено порівну",
    legDownloads: "Завантаження за день", legDownloadsWeek: "Завантаження за тиждень", legActive: "Активні застосунки за день", legActiveWeek: "Активні застосунки, середнє за тиждень",
    legAvg: "Середнє за 7 днів", legMark: "Реліз або подія", legSpread: "Пропущений знімок", legSince: "облік з {date}",
    where: "Де встановлюють", whereWindow: "Завантаження за платформами, останні {n} {days}", whereKept: "Завантаження за платформами у версіях, доступних зараз", whereNone: "Розподіл за платформами з'явиться після наступного щоденного знімка.",
    stable: "Стабільна версія", prerelease: "Бета і нічні збірки", npmWeek: "Через npm", npmWeekValue: "{n} за 7 днів",
    platform: { mac: "macOS", windows: "Windows", linux: "Linux", android: "Android", ios: "iOS", server: "Сервер (без інтерфейсу)", other: "Інше" },
    releases: "Останні релізи", releasesSub: "Завантаження за перші 7 днів після виходу", version: "Версія {v}", best: "Найкращий старт",
    inProgress: "триває: {n} з 7 днів", beforeCounting: "перший тиждень — до початку обліку · усього {n}", noReleases: "У знімках ще немає стабільних релізів.",
    noteTitle: "Підсумок тижня", noteBy: "Агент Polyth", noteStale: "Новий підсумок ще не надійшов",
    goalTitle: "Ціль на {month}", goalsTitle: "Цілі на {month}", goalOf: "з {target}",
    goalMetric: { downloads: "Завантаження", active: "Активні застосунки", stars: "Зірки на GitHub" },
    goalState: { done: "Досягнуто", on: "Йдемо за планом", close: "Трохи відстаємо", behind: "Відстаємо", missed: "Не досягнуто", wait: "Збираємо дані", level: "Ще {n}" },
    goalDaysLeft: "До кінця місяця {n} {days}.", goalFinal: "Місяць завершився, це підсумок.", goalSince: "Облік почався {date}, тож ціль рахує дні від цієї дати.",
    goalLeft: "Ще {n} за {d} {days}, це ≈ {p} на день.", goalProjected: "За поточним темпом буде ≈ {n}.", goalOver: "На {n} більше за ціль.",
    goalActiveNote: "У середньому за останні 7 днів.", goalStarsNote: "+{n} за цей місяць.", goalPace: "Риска на смужці показує, де варто бути сьогодні, щоб устигнути.",
    howTitle: "Як ми рахуємо", howHint: "чому це не «кількість користувачів»",
    how: [
      "Polyth не стежить за людьми: жоден застосунок нікуди не надсилає дані про себе. Тут лише публічні лічильники GitHub і npm.",
      "<strong>Підсумок тижня</strong> щопонеділка пише агент Polyth за тими самими числами, що на цій сторінці. <strong>Ціль на місяць</strong> задає команда, а прогноз продовжує поточний середній темп до кінця місяця.",
      "<strong>Завантаження</strong> — скільки разів завантажили файл встановлення. Одна людина може завантажити кілька разів; автооновлення на Windows і Linux теж завантажує цей файл.",
      "<strong>Активні застосунки</strong> — оцінка: версія для комп'ютера перевіряє оновлення під час запуску й кожні 6 годин, приблизно 4 рази на добу, тож кількість перевірок ділимо на 4. Android сюди не входить.",
      "Знімок робиться щодня зранку й зараховується до попереднього дня. Якщо знімок пропущено, приріст ділимо порівну між днями (позначено ≈).",
      "Поки числа невеликі, зміну від бази, меншої за 20, показуємо в штуках, а не у відсотках.",
    ],
    dataTitle: "Детальні дані", dataHint: "по днях, з вивантаженням у CSV", day: "День", downloads: "Завантаження", activeCol: "Активні застосунки ≈", csv: "Завантажити CSV",
    spreadNote: "≈ — знімок за цей день пропущено, значення розподілено порівну між днями.",
    footer: "Оновлюється щодня · доступ лише для команди",
    csvHeaders: { date: "Дата", downloads: "Завантаження", downloads_stable: "Стабільна версія", downloads_beta_nightly: "Бета і нічні", downloads_mac: "macOS", downloads_windows: "Windows", downloads_linux: "Linux", downloads_android: "Android", downloads_ios: "iOS", downloads_server: "Сервер", downloads_other: "Інше", update_checks: "Перевірки оновлень", active_apps_estimate: "Активні застосунки (оцінка)", npm_downloads: "npm", spread_over_missed_days: "Пропущений знімок (розподілено)" },
    forms: {
      times: ["раз", "рази", "разів", "раза"], days: ["день", "дні", "днів", "дня"], copies: ["копія", "копії", "копій", "копії"],
      downloads: ["завантаження", "завантаження", "завантажень", "завантаження"], active: ["активний застосунок", "активні застосунки", "активних застосунків", "активного застосунку"],
      stars: ["зірка", "зірки", "зірок", "зірки"], forks: ["форк", "форки", "форків", "форка"], visitors: ["відвідувач", "відвідувачі", "відвідувачів", "відвідувача"],
    },
  },
  en: {
    title: "Polyth · Statistics",
    switchTo: ["uk", "Українська"],
    updatedToday: "Updated today at {time}", updatedYesterday: "Updated yesterday at {time}", updatedOn: "Updated {date} at {time}", stale: "Not updated since {date}",
    empty: "No data yet. The daily run takes the first snapshot.",
    heroFirst: "The first snapshot was taken on {date}. Daily downloads appear after the next daily run.",
    heroPartial: "In {n} {days} of counting, Polyth was downloaded <strong>{x} {times}</strong>",
    heroWeek: "In the last week Polyth was downloaded <strong>{x} {times}</strong>",
    cmpUp: ", more than the week before ({p}).", cmpDown: ", fewer than the week before ({p}).", cmpFlat: ", about the same as the week before ({p}).", cmpNone: ".",
    heroActive: " About <strong>{a} desktop {copies}</strong> run each day.",
    heroTop: " The most popular platform is <strong>{platform}</strong>.",
    status: { up: "Growing", down: "Declining", flat: "Steady", wait: "Collecting data" },
    kpiDownloads: "Downloads, last 7 days", kpiDownloadsVs: "vs the week before", kpiDownloadsWait: "a comparison appears after a week", kpiDownloadsPartial: "in {n} {days} of counting", kpiDownloadsNone: "appear after the next snapshot",
    kpiActive: "Active apps", estimate: "estimate", kpiActiveNote: "daily average, desktop apps",
    kpiTotal: "Total downloads", kpiTotalNote: "since counting began on {date}", kpiTotalBefore: "since counting began on {date}, plus {n} before",
    kpiGithub: "Interest on GitHub", kpiViews: "page {visitors} in 14 days · {s} {stars}", kpiStars: "{stars} on GitHub, change {period} · {f} {forks}", starsMonth: "in 30 days", starsSince: "since {date}", kpiStarsOnly: "{stars} on GitHub · {f} {forks}",
    growth: "Growth", metric: "Metric", period: "Period", mDownloads: "Downloads", mActive: "Active apps", p7: "7 days", p30: "30 days", p90: "90 days",
    tipDownloads: "{n} {downloads}", tipDownloadsWeek: "{n} {downloads} that week", tipActive: "≈ {n} {active}", tipActiveWeek: "≈ {n} {active} a day (average)", tipSpread: "missed snapshot, spread evenly",
    legDownloads: "Downloads per day", legDownloadsWeek: "Downloads per week", legActive: "Active apps per day", legActiveWeek: "Active apps, weekly average",
    legAvg: "7-day average", legMark: "Release or event", legSpread: "Missed snapshot", legSince: "counting since {date}",
    where: "Where Polyth is installed", whereWindow: "Downloads by platform, last {n} {days}", whereKept: "Downloads by platform in the releases available now", whereNone: "The platform split appears after the next daily snapshot.",
    stable: "Stable", prerelease: "Beta and nightly", npmWeek: "Through npm", npmWeekValue: "{n} in 7 days",
    platform: { mac: "macOS", windows: "Windows", linux: "Linux", android: "Android", ios: "iOS", server: "Server (headless)", other: "Other" },
    releases: "Recent releases", releasesSub: "Downloads in the first 7 days after release", version: "Version {v}", best: "Best start",
    inProgress: "in progress: day {n} of 7", beforeCounting: "first week before counting began · {n} in total", noReleases: "No stable releases in the snapshots yet.",
    noteTitle: "This week in brief", noteBy: "Polyth agent", noteStale: "A newer summary has not arrived yet",
    goalTitle: "Goal for {month}", goalsTitle: "Goals for {month}", goalOf: "of {target}",
    goalMetric: { downloads: "Downloads", active: "Active apps", stars: "GitHub stars" },
    goalState: { done: "Reached", on: "On track", close: "Slightly behind", behind: "Behind", missed: "Missed", wait: "Collecting data", level: "{n} to go" },
    goalDaysLeft: "{n} {days} left in the month.", goalFinal: "The month is over; this is the result.", goalSince: "Counting began on {date}, so the goal counts from that day.",
    goalLeft: "{n} more in {d} {days}, about {p} a day.", goalProjected: "At the current pace: about {n}.", goalOver: "{n} above the goal.",
    goalActiveNote: "Daily average over the last 7 days.", goalStarsNote: "+{n} this month.", goalPace: "The tick on the bar shows where we should be today to make it.",
    howTitle: "How we count", howHint: "why this is not a user count",
    how: [
      "Polyth does not track people: no app sends anything about itself. These are only public counters from GitHub and npm.",
      "<strong>This week in brief</strong> is written every Monday by a Polyth agent from the same numbers as this page. The team sets the <strong>monthly goal</strong>; the forecast extends the current average pace to the end of the month.",
      "<strong>Downloads</strong> are how many times an installer file was fetched. One person may fetch it several times; the Windows and Linux auto-update fetches that file too.",
      "<strong>Active apps</strong> is an estimate: the desktop app checks for updates at launch and every 6 hours, about 4 times a day, so update checks are divided by 4. Android is not included.",
      "The snapshot runs every morning and counts toward the previous day. When a snapshot is missed, the growth is spread evenly over its days (marked ≈).",
      "While numbers are small, a change from a base under 20 is shown as a count, not a percentage.",
    ],
    dataTitle: "Daily data", dataHint: "per day, with a CSV download", day: "Day", downloads: "Downloads", activeCol: "Active apps ≈", csv: "Download CSV",
    spreadNote: "≈ — that day's snapshot was missed; the value is spread evenly over the days.",
    footer: "Updated daily · team access only",
    csvHeaders: { date: "Date", downloads: "Downloads", downloads_stable: "Stable", downloads_beta_nightly: "Beta and nightly", downloads_mac: "macOS", downloads_windows: "Windows", downloads_linux: "Linux", downloads_android: "Android", downloads_ios: "iOS", downloads_server: "Server", downloads_other: "Other", update_checks: "Update checks", active_apps_estimate: "Active apps (estimate)", npm_downloads: "npm", spread_over_missed_days: "Missed snapshot (spread)" },
    forms: {
      times: ["time", "times"], days: ["day", "days"], copies: ["app", "apps"], downloads: ["download", "downloads"], active: ["active app", "active apps"],
      stars: ["star", "stars"], forks: ["fork", "forks"], visitors: ["visitor", "visitors"],
    },
  },
};

export const LANGUAGES = Object.keys(TEXT);

function fill(template, slots) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in slots ? String(slots[key]) : match));
}

/** Formatting bound to one language: numbers, plural words and UTC calendar days. */
function formatter(lang) {
  const t = TEXT[lang] ?? TEXT.uk;
  const locale = LOCALES[lang] ?? LOCALES.uk;
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const plurals = new Intl.PluralRules(locale);
  const order = lang === "uk" ? ["one", "few", "many", "other"] : ["one", "other"];
  const long = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" });
  const short = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const monthName = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  const date = (day) => new Date(`${day}T00:00:00Z`);
  return {
    t,
    lang: TEXT[lang] ? lang : "uk",
    locale,
    month: (month) => monthName.format(date(`${month}-01`)),
    range: (from, to) => (from === to ? long.format(date(from)) : long.formatRange(date(from), date(to))),
    num: (n) => numbers.format(Math.round(n)),
    word: (n, key) => {
      const forms = t.forms[key];
      const index = order.indexOf(plurals.select(Math.round(n)));
      return forms[index < 0 ? forms.length - 1 : index] ?? forms.at(-1);
    },
    dayLong: (day) => long.format(new Date(`${day}T00:00:00Z`)),
    dayShort: (day) => short.format(new Date(`${day}T00:00:00Z`)),
  };
}

// ---- small pieces -----------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** ▲/▼/≈ chip. Small bases make percentages lie, so below 20 the absolute change is shown. */
function change(now, before, f) {
  if (before === null || before === undefined || now === null) return { tone: "wait", html: "" };
  const diff = Math.round(now) - Math.round(before);
  const tone = Math.abs(diff) < Math.max(1, before * 0.03) ? "flat" : diff > 0 ? "up" : "down";
  const arrow = { up: "▲", down: "▼", flat: "≈" }[tone];
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "";
  const text = before < 20 ? `${sign}${f.num(Math.abs(diff))}` : `${sign}${Math.abs(Math.round((diff / before) * 100))}%`;
  return { tone, html: `<span class="chip ${tone}"><span aria-hidden="true">${arrow}</span> ${esc(text)}</span>` };
}

function sparkline(values, tone) {
  const data = values.filter(Number.isFinite);
  if (data.length < 2) return "";
  const low = Math.min(...data);
  const high = Math.max(...data);
  const floor = tone === "total" ? low - (high - low) * 0.15 : 0;
  const range = Math.max(high - floor, 1) * 1.08;
  const line = data.map((v, i) => `${((i / (data.length - 1)) * 100).toFixed(2)},${(30 - ((v - floor) / range) * 28).toFixed(2)}`).join(" ");
  return `<svg class="spark ${tone === "total" ? "acc" : tone}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polygon class="area" points="0,30 ${line} 100,30"/><polyline class="ln" points="${line}"/></svg>`;
}

const ICONS = {
  mac: `<path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.9-.9-3.1-.8-1.6 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.4-1-2.4-3.8zM14.1 5.8c.6-.8 1.1-1.8 1-2.8-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.7-1 2.7 1 .1 2-.5 2.7-1.3z"/>`,
  android: `<path d="M5.5 10h13v7.5a1.5 1.5 0 0 1-1.5 1.5h-1v2.5a1.25 1.25 0 0 1-2.5 0V19h-3v2.5a1.25 1.25 0 0 1-2.5 0V19H7a1.5 1.5 0 0 1-1.5-1.5zM5.6 9a6.4 6.4 0 0 1 12.8 0zM2.5 11.2a1.25 1.25 0 0 1 2.5 0v4.6a1.25 1.25 0 0 1-2.5 0zM19 11.2a1.25 1.25 0 0 1 2.5 0v4.6a1.25 1.25 0 0 1-2.5 0z"/><path d="M8 3.2l1.4 2.4M16 3.2l-1.4 2.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="9.3" cy="6.9" r=".8" class="hole"/><circle cx="14.7" cy="6.9" r=".8" class="hole"/>`,
  windows: `<path d="M3 5.4l7.4-1v7.1H3zM11.4 4.2L21 3v8.5h-9.6zM3 12.5h7.4v7.1l-7.4-1zM11.4 12.5H21V21l-9.6-1.3z"/>`,
  linux: `<ellipse cx="12" cy="14.5" rx="6.2" ry="7"/><ellipse cx="12" cy="15.4" rx="3.8" ry="5" class="hole"/><circle cx="12" cy="6.6" r="4.2"/><circle cx="10.5" cy="6" r=".9" class="hole"/><circle cx="13.5" cy="6" r=".9" class="hole"/><path d="M10.6 8.1h2.8L12 9.6z" class="beak"/>`,
  server: `<rect x="3.5" y="4" width="17" height="6.5" rx="1.6"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.6"/><circle cx="7" cy="7.25" r="1" class="hole"/><circle cx="7" cy="16.75" r="1" class="hole"/>`,
  other: `<path d="M12 2.8l8.2 4.6v9.2L12 21.2l-8.2-4.6V7.4zM12 5.1L6.3 8.3 12 11.5l5.7-3.2zM5.8 10v5.4l5.2 2.9v-5.4zM13 12.9v5.4l5.2-2.9V10z"/>`,
};
ICONS.ios = ICONS.mac;

// ---- growth chart -----------------------------------------------------------------------------------

/**
 * Points for one period: the last 7 or 30 days, or 13 complete weeks for "90 days" once more than
 * 30 days exist (fewer days show as days). Fewer days than the period shows only the days there are.
 */
function periodPoints(days, period, f) {
  if (period !== "p90" || days.length <= 30) {
    return days.slice(-(period === "p7" ? 7 : period === "p30" ? 30 : 90)).map((d) => ({ start: d.day, end: d.day, label: f.dayShort(d.day), long: f.dayLong(d.day), downloads: d.downloads, active: d.active, spread: d.spread, week: false }));
  }
  const weeks = [];
  for (let end = days.length; end - 7 >= 0 && weeks.length < 13; end -= 7) {
    const chunk = days.slice(end - 7, end);
    weeks.unshift({
      start: chunk[0].day, end: chunk[6].day, label: f.dayShort(chunk[0].day), long: `${f.dayShort(chunk[0].day)} – ${f.dayShort(chunk[6].day)}`,
      downloads: chunk.reduce((s, d) => s + d.downloads, 0), active: chunk.reduce((s, d) => s + d.active, 0) / 7, spread: chunk.some((d) => d.spread), week: true,
    });
  }
  return weeks;
}

function niceMax(top) {
  if (top <= 0) return 4;
  const mag = 10 ** Math.floor(Math.log10(top));
  return [1, 2, 2.5, 4, 5, 10].map((m) => m * mag).find((m) => m >= top);
}

function chart(summary, period, key, f) {
  const { t } = f;
  const data = periodPoints(summary.days, period, f);
  const max = niceMax(Math.max(...data.map((d) => d[key])) * 1.08);
  const week = data[0]?.week ?? false;
  const tip = (d) => {
    const n = f.num(d[key]);
    const template = key === "downloads" ? (week ? t.tipDownloadsWeek : t.tipDownloads) : week ? t.tipActiveWeek : t.tipActive;
    return fill(esc(template), { n: `<strong>${n}</strong>`, downloads: esc(f.word(d[key], "downloads")), active: esc(f.word(d[key], "active")) });
  };
  const plain = (d) => tip(d).replace(/<[^>]+>/g, "");
  const labelEvery = data.length > 20 ? 7 : data.length > 10 ? 3 : 1;
  const cols = data.map((d, i) => {
    const h = ((d[key] / max) * 100).toFixed(1);
    const edge = i < data.length * 0.15 ? " l" : i > data.length * 0.85 ? " r" : "";
    const label = (data.length - 1 - i) % labelEvery === 0 ? `<i>${esc(d.label)}</i>` : "";
    const note = d.spread ? `<br><em>≈ ${esc(t.tipSpread)}</em>` : "";
    return `<div class="col${edge}${d.spread ? " sp" : ""}" style="--h:${h}%" tabindex="0" aria-label="${esc(d.long)}: ${plain(d)}"><b style="height:${h}%"></b><span class="tip">${tip(d)}<br><em>${esc(d.long)}</em>${note}</span>${label}</div>`;
  }).join("");
  const showAvg = period === "p30" && !week && data.length >= 8;
  const avg = data.map((_, i) => {
    const w = data.slice(Math.max(0, i - 6), i + 1);
    return w.reduce((s, d) => s + d[key], 0) / w.length;
  });
  const avgLine = showAvg ? `<svg class="avg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${avg.map((v, i) => `${(((i + 0.5) / data.length) * 100).toFixed(2)},${(100 - (v / max) * 100).toFixed(2)}`).join(" ")}"/></svg>` : "";
  const first = data[0]?.start;
  const span = first ? daysBetween(first, data.at(-1).end) + 1 : 1;
  const inWindow = first ? summary.markers.filter((m) => m.day >= first && m.day <= data.at(-1).end) : [];
  // Labels never overlap: events keep theirs, a release label too close to a shown one is dropped (its mark stays).
  const placed = inWindow.map((m) => ({ ...m, x: ((daysBetween(first, m.day) + 0.5) / span) * 100 }));
  const shown = placed.filter((m) => m.kind === "event");
  for (const m of placed.filter((p) => p.kind === "release")) if (shown.every((s) => Math.abs(s.x - m.x) >= 11)) shown.push(m);
  const marks = placed.map((m) => `<span class="mark${m.kind === "event" ? " event" : ""}${m.x > 80 ? " end" : ""}" style="left:${m.x.toFixed(2)}%" title="${esc(f.dayLong(m.day))}: ${esc(m.label)}">${shown.includes(m) ? `<span>${esc(m.label)}</span>` : ""}</span>`).join("");
  const legendBar = key === "downloads" ? (week ? t.legDownloadsWeek : t.legDownloads) : week ? t.legActiveWeek : t.legActive;
  const clipped = summary.days.length < (period === "p7" ? 7 : period === "p30" ? 30 : 91);
  return `<div class="ch ${period} ${key === "downloads" ? "mdl" : "mact"}">
<div class="plot ${key}"><div class="grid">${[max, max / 2, 0].map((v) => `<span><i>${f.num(v)}</i></span>`).join("")}</div><div class="marks">${marks}</div><div class="cols">${cols}</div>${avgLine}</div>
<p class="legend"><span class="sw bar"></span>${esc(legendBar)}${showAvg ? `<span class="sw line"></span>${esc(t.legAvg)}` : ""}${placed.length ? `<span class="sw diamond"></span>${esc(t.legMark)}` : ""}${data.some((d) => d.spread) ? `<span class="sw spread"></span>${esc(t.legSpread)}` : ""}${clipped ? `<span class="since">${esc(fill(t.legSince, { date: f.dayLong(summary.days[0].day) }))}</span>` : ""}</p>
</div>`;
}

// ---- page -------------------------------------------------------------------------------------------

function freshness(takenAt, lastDay, now, timeZone, f) {
  const { t } = f;
  const taken = Date.parse(takenAt ?? `${lastDay}T00:00:00Z`);
  const zone = (() => { try { new Intl.DateTimeFormat("en", { timeZone }); return timeZone; } catch { return "UTC"; } })();
  const dayIn = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const time = new Intl.DateTimeFormat(f.locale, { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(new Date(taken));
  const takenDay = dayIn(taken);
  const stale = now - taken > 36 * 3_600_000;
  const text = stale
    ? fill(t.stale, { date: f.dayLong(takenDay) })
    : takenDay === dayIn(now) ? fill(t.updatedToday, { time }) : takenDay === dayIn(now - DAY_MS) ? fill(t.updatedYesterday, { time }) : fill(t.updatedOn, { date: f.dayLong(takenDay), time });
  return `<span class="fresh"><span class="dot${stale ? " stale" : ""}"></span>${esc(text)}</span>`;
}

function hero(summary, f) {
  const { t } = f;
  if (summary.days.length === 0) return { tone: "wait", html: esc(fill(t.heroFirst, { date: f.dayLong(summary.firstDay) })) };
  const w = summary.week;
  const x = { x: f.num(w.downloads), times: esc(f.word(w.downloads, "times")) };
  let html;
  let tone = "wait";
  if (w.days < 7) {
    html = fill(t.heroPartial, { n: w.days, days: esc(f.word(w.days, "days")), ...x }) + t.cmpNone;
  } else {
    const c = change(w.downloads, w.previousDownloads, f);
    tone = c.tone;
    const tail = { up: t.cmpUp, down: t.cmpDown, flat: t.cmpFlat, wait: t.cmpNone }[c.tone];
    html = fill(t.heroWeek, x) + fill(tail, { p: f.num(w.previousDownloads ?? 0) });
  }
  if (w.active !== null && w.active >= 0.5) html += fill(t.heroActive, { a: f.num(w.active), copies: esc(f.word(w.active, "copies")) });
  const top = summary.split.platforms ? Object.entries(summary.split.platforms).filter(([key]) => key !== "other").sort((a, b) => b[1] - a[1])[0] : null;
  if (top && top[1] > 0) html += fill(t.heroTop, { platform: esc(t.platform[top[0]]) });
  return { tone, html };
}

function platformCard(summary, f) {
  const { t } = f;
  const { split } = summary;
  const sub = !split.platforms ? t.whereNone : split.scope.kind === "window" ? fill(t.whereWindow, { n: split.scope.days, days: f.word(split.scope.days, "days") }) : t.whereKept;
  let list = "";
  if (split.platforms) {
    const entries = Object.entries(split.platforms).filter(([, n]) => n >= 0.5).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, n]) => s + n, 0) || 1;
    list = `<ul class="plist">${entries.map(([key, n]) => {
      const share = (n / total) * 100;
      return `<li><span class="ico ${key}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[key] ?? ICONS.other}</svg></span><span class="pname">${esc(t.platform[key] ?? key)}</span><span class="pbar"><b style="width:${share.toFixed(1)}%"></b></span><span class="pval"><strong>${Math.round(share)}%</strong> ${f.num(n)}</span></li>`;
    }).join("")}</ul>`;
  }
  const channels = split.stable + split.prerelease;
  const parts = [];
  if (channels > 0) {
    const stableShare = Math.round((split.stable / channels) * 100);
    parts.push(`<span>${esc(t.stable)} <strong>${stableShare}%</strong></span>`, `<span>${esc(t.prerelease)} <strong>${100 - stableShare}%</strong></span>`);
  }
  if (summary.week.npm !== null) parts.push(`<span>${esc(t.npmWeek)} <strong>${esc(fill(t.npmWeekValue, { n: f.num(summary.week.npm) }))}</strong></span>`);
  return `<div class="card"><h2>${esc(t.where)}</h2><p class="sub">${esc(sub)}</p>${list}${parts.length ? `<div class="split">${parts.join("")}</div>` : ""}</div>`;
}

function releaseCard(summary, f) {
  const { t } = f;
  const complete = summary.releases.filter((r) => r.firstWeek !== null && !r.inProgress);
  const best = complete.length >= 2 ? complete.reduce((a, b) => (b.firstWeek > a.firstWeek ? b : a)) : null;
  const top = Math.max(1, ...summary.releases.map((r) => r.firstWeek ?? 0));
  const items = summary.releases.map((r) => {
    const notes = [esc(f.dayLong(r.published))];
    if (r.firstWeek === null) notes.push(esc(fill(t.beforeCounting, { n: f.num(r.total) })));
    else if (r.inProgress) notes.push(`<span class="live">${esc(fill(t.inProgress, { n: r.daysMeasured }))}</span>`);
    const bar = r.firstWeek === null ? `<span class="rbar"></span>` : `<span class="rbar${r.inProgress ? " partial" : ""}"><b style="width:${((r.firstWeek / top) * 100).toFixed(0)}%"></b></span>`;
    return `<li><div><strong>${esc(fill(t.version, { v: r.tag.replace(/^v/, "") }))}</strong>${r === best ? `<span class="badge">${esc(t.best)}</span>` : ""}<small>${notes.join(" · ")}</small></div>${bar}<span class="rval">${r.firstWeek === null ? "—" : f.num(r.firstWeek)}</span></li>`;
  }).join("");
  return `<div class="card"><h2>${esc(t.releases)}</h2><p class="sub">${esc(t.releasesSub)}</p>${items ? `<ul class="rlist">${items}</ul>` : `<p class="sub">${esc(t.noReleases)}</p>`}</div>`;
}

function kpis(summary, f) {
  const { t } = f;
  const w = summary.week;
  const last30 = summary.days.slice(-30);
  const dl = change(w.downloads, w.previousDownloads, f);
  const act = change(w.active, w.previousActive, f);
  const dlNote = w.days === 0 ? t.kpiDownloadsNone : w.days < 7 ? fill(t.kpiDownloadsPartial, { n: w.days, days: f.word(w.days, "days") }) : w.previousDownloads === null ? t.kpiDownloadsWait : t.kpiDownloadsVs;
  const total = summary.total;
  const totalNote = total.before > 0 ? fill(t.kpiTotalBefore, { date: f.dayLong(total.since), n: f.num(total.before) }) : fill(t.kpiTotalNote, { date: f.dayLong(total.since) });
  const r = summary.repo;
  let github;
  if (r.viewsUnique !== null) {
    github = { value: f.num(r.viewsUnique), chip: "", note: fill(t.kpiViews, { visitors: f.word(r.viewsUnique, "visitors"), s: f.num(r.stars ?? 0), stars: f.word(r.stars ?? 0, "stars") }) };
  } else {
    const stars = r.stars ?? 0;
    // Stars are few and only grow slowly: the chip is always the absolute change, never a percentage.
    const tone = r.starsChange > 0 ? "up" : r.starsChange < 0 ? "down" : "flat";
    const chip = r.starsChange === null ? "" : `<span class="chip ${tone}"><span aria-hidden="true">${{ up: "▲", down: "▼", flat: "≈" }[tone]}</span> ${r.starsChange > 0 ? "+" : r.starsChange < 0 ? "−" : ""}${f.num(Math.abs(r.starsChange))}</span>`;
    const period = r.starsSince && daysBetween(r.starsSince, summary.lastDay) < 30 ? fill(t.starsSince, { date: f.dayLong(r.starsSince) }) : t.starsMonth;
    github = { value: r.stars === null ? "—" : f.num(stars), chip, note: fill(r.starsChange === null ? t.kpiStarsOnly : t.kpiStars, { stars: f.word(stars, "stars"), period, f: f.num(r.forks ?? 0), forks: f.word(r.forks ?? 0, "forks") }) };
  }
  const card = (title, value, chip, note, spark, extra = "") => `<article class="card kpi${spark ? "" : " plain"}"><h2>${title}${extra}</h2><div class="v"><strong>${value}</strong>${chip}</div><small>${esc(note)}</small>${spark}</article>`;
  return `<section class="kpis">
${card(esc(t.kpiDownloads), w.days === 0 ? "—" : f.num(w.downloads), dl.html, dlNote, sparkline(last30.map((d) => d.downloads), "acc"))}
${card(esc(t.kpiActive), w.active === null ? "—" : `≈ ${f.num(w.active)}`, act.html, t.kpiActiveNote, sparkline(last30.map((d) => d.active), "vio"), ` <span class="est">${esc(t.estimate)}</span>`)}
${card(esc(t.kpiTotal), f.num(total.downloads), "", totalNote, sparkline(summary.cumulative.slice(-30).map((d) => d.total), "total"))}
${card(esc(t.kpiGithub), github.value, github.chip, github.note, sparkline(r.starsSeries, "grn"))}
</section>`;
}

const SPARKLE = '<path d="M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z"/><path d="M19 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/>';
const NOTE_STALE_MS = 9 * DAY_MS;

/** The agent's three lines; the page's language when the note has it, else the other one (marked with lang). */
function noteCard(note, f, now) {
  const { t } = f;
  const lineLang = note[f.lang] ? f.lang : LANGUAGES.find((l) => note[l]);
  const rich = (text) => esc(text).replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  const stale = now - Date.parse(note.writtenAt) > NOTE_STALE_MS;
  return `<article class="card note"><div class="nhead"><span class="agent" aria-hidden="true"><svg viewBox="0 0 24 24">${SPARKLE}</svg></span><div><h2>${esc(t.noteTitle)}</h2><p class="sub">${esc(t.noteBy)} · ${esc(f.range(note.from, note.to))}</p></div>${stale ? `<span class="badge warn">${esc(t.noteStale)}</span>` : ""}</div><ol class="nlist"${lineLang === f.lang ? "" : ` lang="${lineLang}"`}>${note[lineLang].map((line) => `<li>${rich(line)}</li>`).join("")}</ol></article>`;
}

const CHIP_TONE = { done: "up", on: "acc", close: "warn", behind: "down", missed: "down", wait: "flat", level: "flat" };
const BAR_TONE = { done: "up", close: "warn", behind: "down", missed: "down" };

/** This month's goals: value against target, a bar with a "where we should be today" tick for downloads, plain-language pace. */
function goalCard(goals, f) {
  const { t } = f;
  let pace = false;
  const rows = goals.items.map((g) => {
    const share = g.current === null ? 0 : Math.min(100, (g.current / g.target) * 100);
    const value = g.current === null ? "—" : g.metric === "active" ? `≈ ${f.num(g.current)}` : f.num(g.current);
    const label = fill(t.goalState[g.status], { n: f.num(Math.max(0, g.target - (g.current ?? 0))) });
    const notes = [];
    let tick = "";
    if (g.metric === "downloads") {
      if (g.status !== "done" && goals.remaining > 0 && g.expected > 0) {
        tick = `<i style="left:${Math.min(100, (g.expected / g.target) * 100).toFixed(1)}%"></i>`;
        pace = true;
      }
      if (g.perDay !== null) notes.push(fill(t.goalLeft, { n: f.num(g.target - g.current), d: goals.remaining, days: f.word(goals.remaining, "days"), p: f.num(Math.ceil(g.perDay)) }));
      if (g.projected !== null && g.status !== "done" && goals.remaining > 0) notes.push(fill(t.goalProjected, { n: f.num(g.projected) }));
    } else if (g.metric === "active") {
      notes.push(t.goalActiveNote);
    } else if (g.gained > 0) {
      notes.push(fill(t.goalStarsNote, { n: f.num(g.gained) }));
    }
    if (g.status === "done" && Math.round(g.current) > g.target) notes.push(fill(t.goalOver, { n: f.num(g.current - g.target) }));
    return `<li><div class="gtop"><span class="gname">${esc(t.goalMetric[g.metric])}</span><span class="chip ${CHIP_TONE[g.status]}">${esc(label)}</span></div><div class="gval"><strong>${value}</strong> ${esc(fill(t.goalOf, { target: f.num(g.target) }))}</div><div class="gbar ${BAR_TONE[g.status] ?? "acc"}" role="img" aria-label="${Math.round(share)}%"><b style="width:${share.toFixed(1)}%"></b>${tick}</div>${notes.length ? `<small>${esc(notes.join(" "))}</small>` : ""}</li>`;
  }).join("");
  const sub = [goals.remaining === 0 ? t.goalFinal : fill(t.goalDaysLeft, { n: goals.remaining, days: f.word(goals.remaining, "days") })];
  if (goals.since) sub.push(fill(t.goalSince, { date: f.dayLong(goals.since) }));
  const title = fill(goals.items.length > 1 ? t.goalsTitle : t.goalTitle, { month: f.month(goals.month) });
  return `<article class="card goal"><h2>${esc(title)}</h2><p class="sub">${esc(sub.join(" "))}</p><ul class="glist">${rows}</ul>${pace ? `<p class="fine">${esc(t.goalPace)}</p>` : ""}</article>`;
}

function dailyTable(summary, f, csvHref) {
  const { t } = f;
  const recent = summary.days.slice(-14).reverse();
  const cell = (d, n) => `${d.spread ? "≈ " : ""}${f.num(n)}`;
  const rows = recent.map((d) => `<tr><td>${esc(f.dayLong(d.day))}</td><td>${cell(d, d.downloads)}</td><td>${cell(d, d.active)}</td><td>${typeof d.npm === "number" ? f.num(d.npm) : "—"}</td></tr>`).join("");
  return `<details><summary>${esc(t.dataTitle)}<span>${esc(t.dataHint)}</span></summary><div class="dbody"><table><thead><tr><th>${esc(t.day)}</th><th>${esc(t.downloads)}</th><th>${esc(t.activeCol)}</th><th>npm</th></tr></thead><tbody>${rows}</tbody></table>${recent.some((d) => d.spread) ? `<p class="fine">${esc(t.spreadNote)}</p>` : ""}<a class="csv" href="${esc(csvHref)}" download>${esc(t.csv)} <span aria-hidden="true">↓</span></a></div></details>`;
}

const STYLE = `:root{color-scheme:light dark;--bg:#f4f5f8;--card:#fff;--text:#0f1222;--dim:#3b4152;--muted:#5f6577;--line:#e5e7ee;--wash:#f0f2f6;
--acc:#3d6cf0;--acc-wash:rgba(61,108,240,.10);--vio:#7c5cff;--vio-wash:rgba(124,92,255,.10);--up:#0f8a4b;--up-wash:rgba(16,163,90,.12);--down:#c2362b;--down-wash:rgba(220,60,45,.12);--warn:#b26a00;--warn-wash:rgba(230,150,20,.16);
--shadow:0 1px 2px rgba(15,18,34,.04),0 8px 24px -12px rgba(15,18,34,.10)}
@media(prefers-color-scheme:dark){:root{--bg:#0c0e13;--card:#151821;--text:#eef0f6;--dim:#c9cdd8;--muted:#9aa1b2;--line:#252a3a;--wash:#1b1f2a;
--acc:#7aa2f7;--acc-wash:rgba(122,162,247,.13);--vio:#a78bfa;--vio-wash:rgba(167,139,250,.13);--up:#4ade80;--up-wash:rgba(74,222,128,.12);--down:#f87171;--down-wash:rgba(248,113,113,.12);--warn:#fbbf24;--warn-wash:rgba(251,191,36,.14);--shadow:none}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums}
.sr{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
.app{max-width:1080px;margin:0 auto;padding:28px 24px 48px}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:22px}
.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--acc),var(--vio));box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
header h1{font-size:19px;margin:0;font-weight:650;letter-spacing:-.01em}
.fresh{margin-left:auto;font-size:13px;color:var(--muted);display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--up);box-shadow:0 0 0 3px var(--up-wash)}.dot.stale{background:var(--warn);box-shadow:0 0 0 3px var(--warn-wash)}
.lang{font-size:13px;font-weight:550;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:8px;padding:3px 9px}.lang:hover{color:var(--text)}
a:focus-visible,summary:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}
.hero{padding:24px 26px;margin-bottom:16px;background:linear-gradient(120deg,var(--acc-wash),transparent 60%),var(--card);display:flex;gap:20px;align-items:flex-start}
.hero p{margin:0;font-size:20px;line-height:1.45;letter-spacing:-.01em;color:var(--dim);max-width:68ch}
.hero strong{color:var(--text);font-weight:650}
.status{flex:none;font-size:13px;font-weight:600;padding:6px 12px;border-radius:999px;margin-left:auto}
.status.up{background:var(--up-wash);color:var(--up)}.status.down{background:var(--down-wash);color:var(--down)}.status.flat,.status.wait{background:var(--wash);color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
.kpi{padding:18px 18px 0;display:flex;flex-direction:column;overflow:hidden}.kpi.plain{padding-bottom:18px}
.kpi h2{margin:0;font-size:13px;font-weight:550;color:var(--muted);display:flex;gap:6px;align-items:center}
.est{font-size:11px;font-weight:600;color:var(--vio);background:var(--vio-wash);border-radius:6px;padding:1px 6px}
.kpi .v{display:flex;align-items:baseline;gap:10px;margin:8px 0 2px;flex-wrap:wrap}
.kpi .v strong{font-size:34px;line-height:1.1;font-weight:680;letter-spacing:-.02em}
.kpi small{color:var(--muted);font-size:12.5px;min-height:2.6em;margin-top:auto}
.chip{font-size:12.5px;font-weight:600;border-radius:999px;padding:2px 8px;white-space:nowrap}
.chip.up{color:var(--up);background:var(--up-wash)}.chip.down{color:var(--down);background:var(--down-wash)}.chip.flat{color:var(--muted);background:var(--wash)}.chip.acc{color:var(--acc);background:var(--acc-wash)}.chip.warn{color:var(--warn);background:var(--warn-wash)}
.brief{display:grid;grid-template-columns:1.35fr 1fr;gap:16px;margin-bottom:16px}.brief.one{grid-template-columns:1fr}
.brief .card{padding:20px 22px}.brief h2{margin:0 0 4px;font-size:17px;font-weight:650}
.nhead{display:flex;align-items:center;gap:12px;margin-bottom:16px}.nhead h2{margin:0}.nhead .sub{margin:2px 0 0}.nhead .badge{margin-left:auto;white-space:normal;text-align:center}
.agent{flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,var(--acc),var(--vio));box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
.agent svg{width:21px;height:21px;fill:currentColor}
.nlist{list-style:none;margin:0;padding:0;display:grid;gap:14px;counter-reset:n}
.nlist li{position:relative;padding-left:36px;font-size:15.5px;line-height:1.5;color:var(--dim);counter-increment:n}
.nlist li::before{content:counter(n);position:absolute;left:0;top:0;width:24px;height:24px;border-radius:8px;background:var(--acc-wash);color:var(--acc);font-size:12.5px;font-weight:700;display:grid;place-items:center}
.nlist strong{color:var(--text);font-weight:650}.brief.one .nlist li{max-width:80ch}
.glist{list-style:none;margin:0;padding:0;display:grid;gap:20px}.brief.one .glist{grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px 28px}
.gtop{display:flex;align-items:center;justify-content:space-between;gap:10px}
.gname{font-size:13px;font-weight:550;color:var(--muted)}
.gval{margin:2px 0 10px;font-size:14px;color:var(--muted)}.gval strong{font-size:30px;line-height:1.15;font-weight:680;letter-spacing:-.02em;color:var(--text);margin-right:2px}
.gbar{position:relative;height:10px;border-radius:99px;background:var(--wash)}
.gbar b{display:block;height:100%;border-radius:99px;background:var(--acc)}
.gbar.up b{background:var(--up)}.gbar.warn b{background:var(--warn)}.gbar.down b{background:var(--down)}
.gbar i{position:absolute;top:-4px;bottom:-4px;width:3px;margin-left:-1.5px;border-radius:2px;background:var(--text);opacity:.65}
.glist small{display:block;margin-top:9px;font-size:12.5px;line-height:1.45;color:var(--muted)}
.goal .fine{margin-top:16px}
.badge.warn{color:var(--warn);background:var(--warn-wash)}
.spark{display:block;width:calc(100% + 36px);margin:10px -18px 0;height:44px}
.spark .ln{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round}
.spark.acc .ln{stroke:var(--acc)}.spark.acc .area{fill:var(--acc-wash)}.spark.vio .ln{stroke:var(--vio)}.spark.vio .area{fill:var(--vio-wash)}.spark.grn .ln{stroke:var(--up)}.spark.grn .area{fill:var(--up-wash)}
.main{padding:20px 22px 18px;margin-bottom:16px}
.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.head h2{margin:0;font-size:17px;font-weight:650;margin-right:auto}
.seg{display:inline-flex;background:var(--wash);border-radius:10px;padding:3px;gap:2px}
.seg label{font-size:13px;font-weight:550;color:var(--muted);padding:6px 12px;border-radius:8px;cursor:pointer;user-select:none;white-space:nowrap}
.seg label:hover{color:var(--text)}
#p7:checked~.app label[for=p7],#p30:checked~.app label[for=p30],#p90:checked~.app label[for=p90],#mdl:checked~.app label[for=mdl],#mact:checked~.app label[for=mact]{background:var(--card);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.12)}
#p7:focus-visible~.app label[for=p7],#p30:focus-visible~.app label[for=p30],#p90:focus-visible~.app label[for=p90],#mdl:focus-visible~.app label[for=mdl],#mact:focus-visible~.app label[for=mact]{outline:2px solid var(--acc);outline-offset:1px}
.ch{display:none}
#p7:checked~#mdl:checked~.app .ch.p7.mdl,#p30:checked~#mdl:checked~.app .ch.p30.mdl,#p90:checked~#mdl:checked~.app .ch.p90.mdl,
#p7:checked~#mact:checked~.app .ch.p7.mact,#p30:checked~#mact:checked~.app .ch.p30.mact,#p90:checked~#mact:checked~.app .ch.p90.mact{display:block}
.plot{position:relative;height:260px;margin:26px 0 30px 38px}
.grid{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between}
.grid span{border-top:1px dashed var(--line);position:relative;height:0}.grid span:last-child{border-top-style:solid}
.grid i{position:absolute;right:calc(100% + 8px);top:-9px;font-style:normal;font-size:11.5px;color:var(--muted)}
.cols{position:absolute;inset:0;display:flex;align-items:flex-end;gap:3px}
.col{flex:1;height:100%;position:relative;display:flex;align-items:flex-end;outline:none;cursor:default}
.col b{display:block;width:100%;min-height:1px;border-radius:5px 5px 2px 2px;background:var(--acc);opacity:.82;transition:opacity .12s}
.plot.active .col b{background:var(--vio)}
.col.sp b{background:repeating-linear-gradient(-45deg,var(--acc) 0 5px,color-mix(in srgb,var(--acc) 45%,transparent) 5px 9px)}
.plot.active .col.sp b{background:repeating-linear-gradient(-45deg,var(--vio) 0 5px,color-mix(in srgb,var(--vio) 45%,transparent) 5px 9px)}
.cols:hover .col b{opacity:.45}.cols .col:hover b,.col:focus-visible b{opacity:1}
.col i{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);font-style:normal;font-size:11.5px;color:var(--muted);white-space:nowrap}
.tip{position:absolute;bottom:calc(var(--h) + 10px);left:50%;transform:translate(-50%,4px);background:var(--text);color:var(--card);font-size:12.5px;line-height:1.35;padding:8px 10px;border-radius:10px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s,transform .12s;z-index:3}
.tip strong{font-size:15px}.tip em{font-style:normal;opacity:.7}
.col.l .tip{left:0;transform:translate(0,4px)}.col.r .tip{left:auto;right:0;transform:translate(0,4px)}
.col:hover .tip,.col:focus-visible .tip{opacity:1;transform:translate(-50%,0)}
.col.l:hover .tip,.col.l:focus-visible .tip,.col.r:hover .tip,.col.r:focus-visible .tip{transform:translate(0,0)}
.col:focus-visible{box-shadow:inset 0 -3px 0 var(--text)}
.avg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.avg polyline{fill:none;stroke:var(--text);stroke-width:2;stroke-opacity:.55;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-dasharray:5 4}
.marks{position:absolute;inset:0;pointer-events:none}
.mark{position:absolute;top:-22px;bottom:0;border-left:1px dashed var(--line)}
.mark::after{content:"";position:absolute;bottom:-5px;left:-5px;width:8px;height:8px;background:var(--card);border:2px solid var(--muted);transform:rotate(45deg)}
.mark.event::after{border-color:var(--up)}
.mark span{position:absolute;top:0;left:4px;font-size:11px;color:var(--muted);white-space:nowrap;background:var(--card);padding:0 3px;border-radius:4px}
.mark.end span{left:auto;right:4px}
.mark.event span{color:var(--up);font-weight:600}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin:0;font-size:12.5px;color:var(--muted)}
.sw{display:inline-block;margin-right:-8px}
.sw.bar{width:10px;height:10px;border-radius:3px;background:var(--acc)}.mact .sw.bar{background:var(--vio)}
.sw.line{width:16px;border-top:2px dashed var(--text);opacity:.55}
.sw.diamond{width:8px;height:8px;border:2px solid var(--muted);transform:rotate(45deg)}
.sw.spread{width:10px;height:10px;border-radius:3px;background:repeating-linear-gradient(-45deg,var(--muted) 0 2px,transparent 2px 4px)}
.since{margin-left:auto}
.pair{display:grid;grid-template-columns:1.1fr 1fr;gap:16px;margin-bottom:16px}
.pair .card{padding:20px 22px}
.pair h2{margin:0 0 4px;font-size:17px;font-weight:650}
.sub{margin:0 0 16px;font-size:13px;color:var(--muted)}
.plist,.rlist{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.plist li{display:grid;grid-template-columns:32px minmax(0,11.5em) 1fr 84px;align-items:center;gap:12px}
.ico{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--wash)}
.ico svg{width:19px;height:19px;fill:currentColor}
.ico .hole{fill:var(--wash)}.ico .beak{fill:#f2a93b}
.ico.mac,.ico.ios,.ico.linux{color:var(--text)}.ico.android{color:#2fa660}.ico.windows{color:#1f7ae0}.ico.server,.ico.other{color:var(--muted)}
.pname{font-size:14px;font-weight:550}
.pbar,.rbar{height:8px;border-radius:99px;background:var(--wash);overflow:hidden}
.pbar b,.rbar b{display:block;height:100%;border-radius:99px;background:var(--acc)}
.pval{text-align:right;font-size:13px;color:var(--muted)}.pval strong{color:var(--text);font-size:14px;margin-right:4px}
.rlist li{display:grid;grid-template-columns:minmax(0,2.3fr) minmax(56px,1fr) 44px;gap:14px;align-items:center}
.rlist strong{font-size:14px;font-weight:600;white-space:nowrap}.rlist small{display:block;font-size:12.5px;color:var(--muted)}
.rval{text-align:right;font-weight:600}.live{color:var(--vio)}
.rbar.partial b{background:repeating-linear-gradient(-45deg,var(--acc) 0 6px,color-mix(in srgb,var(--acc) 55%,transparent) 6px 10px)}
.badge{display:inline-block;white-space:nowrap;font-size:11px;font-weight:600;color:var(--up);background:var(--up-wash);border-radius:6px;padding:1px 6px;margin-left:8px;vertical-align:1px}
.split{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.split strong{color:var(--text)}
details{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:10px}
summary{cursor:pointer;padding:14px 18px;font-weight:600;font-size:14.5px;list-style:none;display:flex;align-items:center;gap:10px;border-radius:14px}
summary::-webkit-details-marker{display:none}
summary::before{content:"";width:7px;height:7px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .15s;margin-right:4px}
details[open] summary::before{transform:rotate(45deg)}
summary span{margin-left:auto;font-weight:500;font-size:13px;color:var(--muted)}
.dbody{padding:0 18px 16px;color:var(--dim);font-size:14px}
.dbody ul{margin:0;padding-left:18px;display:grid;gap:6px}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{padding:8px 4px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:550}
.fine{font-size:12.5px;color:var(--muted);margin:10px 0 0}
.csv{display:inline-block;margin-top:12px;font-size:13px;font-weight:600;color:var(--acc);text-decoration:none}
.empty{padding:48px 24px;text-align:center;color:var(--muted);font-size:16px}
footer{margin-top:22px;font-size:12.5px;color:var(--muted);text-align:center}
@media(max-width:880px){.kpis{grid-template-columns:repeat(2,1fr)}.pair,.brief{grid-template-columns:1fr}}
@media(max-width:520px){.app{padding:18px 14px 36px}.hero{flex-direction:column-reverse;padding:18px;gap:12px}.hero p{font-size:17px}.status{margin-left:0}.kpis{gap:10px}.kpi{padding:14px 14px 0}.kpi.plain{padding-bottom:14px}.kpi .v strong{font-size:27px}.spark{width:calc(100% + 28px);margin:8px -14px 0}
.brief .card{padding:18px}.nlist li{font-size:15px}.nhead{flex-wrap:wrap}.nhead .badge{margin-left:50px}.main{padding:16px 14px}.plot{height:200px;margin-left:30px}.cols{gap:2px}.head .seg label{padding:6px 9px}.plist li{grid-template-columns:30px 1fr 70px}.plist .pbar{grid-column:2/4;grid-row:2;margin-top:-6px}.rlist li{grid-template-columns:1fr 40px;row-gap:8px}.rlist .rbar{grid-column:1/3;grid-row:2}.rlist .rval{grid-column:2;grid-row:1}.mark:not(.event) span{display:none}summary span{display:none}.fresh{margin-left:0;order:3;width:100%}.lang{margin-left:auto}.since{margin-left:0}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;

/**
 * The script-free dashboard: a one-paragraph summary, four headline numbers, a growth chart with
 * CSS-only period and metric switches, platforms, recent releases, and the daily table with a CSV link.
 */
export function renderDashboardHtml(lines, { now = Date.now(), lang = "uk", events = [], goals = [], note = null, timeZone = "Europe/Kyiv" } = {}) {
  const language = TEXT[lang] ? lang : "uk";
  const f = formatter(language);
  const { t } = f;
  const summary = summarizeDashboard(lines, { events, goals });
  const [otherLang, otherName] = t.switchTo;
  const query = (extra) => `?${new URLSearchParams({ lang: language, ...extra })}`;
  const switcher = `<a class="lang" href="${esc(`?lang=${otherLang}`)}" hreflang="${otherLang}" lang="${otherLang}">${esc(otherName)}</a>`;
  let body;
  if (!summary) {
    body = `<header><span class="logo" aria-hidden="true"></span><h1>${esc(t.title)}</h1>${switcher}</header><section class="card empty">${esc(t.empty)}</section>`;
  } else {
    const intro = hero(summary, f);
    const charts = summary.days.length
      ? `<section class="card main"><div class="head"><h2>${esc(t.growth)}</h2>
<div class="seg" role="group" aria-label="${esc(t.metric)}"><label for="mdl">${esc(t.mDownloads)}</label><label for="mact">${esc(t.mActive)}</label></div>
<div class="seg" role="group" aria-label="${esc(t.period)}"><label for="p7">${esc(t.p7)}</label><label for="p30">${esc(t.p30)}</label><label for="p90">${esc(t.p90)}</label></div></div>
${["p7", "p30", "p90"].flatMap((p) => [chart(summary, p, "downloads", f), chart(summary, p, "active", f)]).join("\n")}
</section>`
      : "";
    const briefCards = [note ? noteCard(note, f, now) : "", summary.goals ? goalCard(summary.goals, f) : ""].filter(Boolean);
    // Side by side while the goal card is about as tall as the note; with several goals both span the row.
    const stacked = briefCards.length === 1 || (summary.goals?.items.length ?? 0) > 1;
    const briefRow = briefCards.length ? `<section class="brief${stacked ? " one" : ""}">${briefCards.join("")}</section>` : "";
    body = `<header><span class="logo" aria-hidden="true"></span><h1>${esc(t.title)}</h1>${freshness(summary.takenAt, summary.lastDay, now, timeZone, f)}${switcher}</header>
<section class="card hero"><p>${intro.html}</p><span class="status ${intro.tone}">${{ up: "↗ ", down: "↘ ", flat: "→ ", wait: "" }[intro.tone]}${esc(t.status[intro.tone])}</span></section>
${briefRow}
${kpis(summary, f)}
${charts}
<section class="pair">${platformCard(summary, f)}${releaseCard(summary, f)}</section>
<details><summary>${esc(t.howTitle)}<span>${esc(t.howHint)}</span></summary><div class="dbody"><ul>${t.how.map((item) => `<li>${item}</li>`).join("")}</ul></div></details>
${summary.days.length ? dailyTable(summary, f, query({ export: "csv" })) : ""}
<footer>${esc(t.footer)}</footer>`;
  }
  const radios = summary?.days.length
    ? `<input class="sr" type="radio" name="p" id="p7" aria-label="${esc(t.p7)}"><input class="sr" type="radio" name="p" id="p30" checked aria-label="${esc(t.p30)}"><input class="sr" type="radio" name="p" id="p90" aria-label="${esc(t.p90)}">
<input class="sr" type="radio" name="m" id="mdl" checked aria-label="${esc(t.mDownloads)}"><input class="sr" type="radio" name="m" id="mact" aria-label="${esc(t.mActive)}">`
    : "";
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(t.title)}</title>
<style>${STYLE}</style></head><body>
${radios}
<div class="app">
${body}
</div></body></html>
`;
}

/** The daily series as a spreadsheet file, headers in the page's language; a BOM lets Excel read UTF-8. */
export function renderDashboardCsv(lines, { lang = "uk" } = {}) {
  return `\uFEFF${renderCsv(lines, { headers: (TEXT[lang] ?? TEXT.uk).csvHeaders })}`;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function readOnce(file, cache) {
  let stamp;
  try { stamp = `${statSync(file).mtimeMs}`; } catch { stamp = ""; }
  if (cache.stamp === stamp) return cache.value;
  cache.stamp = stamp;
  cache.value = null;
  if (stamp) {
    try { cache.value = readFileSync(file, "utf8"); } catch { cache.value = null; }
  }
  return cache.value;
}

/** What a cancelled password prompt leaves on screen: a short note in the page's language, no data. */
function signInPage(lang) {
  const text = lang === "en"
    ? ["Team password needed", "Reload the page to enter the team password again."]
    : ["Потрібен пароль команди", "Оновіть сторінку, щоб ввести пароль команди ще раз."];
  return `<!doctype html><html lang="${lang === "en" ? "en" : "uk"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polyth</title><style>${STYLE}</style></head><body><div class="app"><section class="card empty"><h1>${esc(text[0])}</h1><p>${esc(text[1])}</p></section></div></body></html>`;
}

/**
 * Request handler; `keysDir/password.scrypt`, `dataDir/snapshots.jsonl` and the optional `dataDir/events.json`,
 * `goals.json` and `weekly.json` are re-read when their mtime changes. `/` takes `?lang=uk|en` and `?export=csv` (the daily CSV), so the TLS
 * proxy that forwards `/` needs no new route.
 */
export function createHandler({ keysDir, dataDir, now = () => Date.now(), lang: defaultLang = "uk", timeZone = "Europe/Kyiv" }) {
  const passwordCache = {};
  const snapshotCache = {};
  const eventsCache = {};
  const goalsCache = {};
  const noteCache = {};
  const failures = [];
  const send = (res, status, body = "", extra = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", ...extra });
    res.end(body);
  };
  return (req, res) => {
    const [path, search = ""] = (req.url ?? "").split("?");
    const params = new URLSearchParams(search.slice(0, 200));
    const lang = LANGUAGES.includes(params.get("lang")) ? params.get("lang") : LANGUAGES.includes(defaultLang) ? defaultLang : "uk";
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "", { allow: "GET, HEAD" });
    if (path === "/robots.txt") return send(res, 200, "User-agent: *\nDisallow: /\n", { "content-type": "text/plain; charset=utf-8" });
    if (path !== "/" && path !== "/healthz") return send(res, 404);
    const record = parsePasswordLine(readOnce(join(keysDir, "password.scrypt"), passwordCache) ?? "");
    if (!record) return send(res, 503, "Unavailable.");
    const t = now();
    while (failures.length && t - failures[0] > LOCK_WINDOW_MS) failures.shift();
    if (failures.length >= LOCK_AFTER) return send(res, 429, "Try again later.", { "retry-after": String(Math.ceil((failures[0] + LOCK_WINDOW_MS - t) / 1000)) });
    if (!verifyPassword(record, basicPassword(req.headers.authorization))) {
      if (req.headers.authorization) failures.push(t);
      return send(res, 401, req.method === "HEAD" ? "" : signInPage(lang), { "www-authenticate": 'Basic realm="Polyth community signals", charset="UTF-8"' });
    }
    if (path === "/healthz") return send(res, 200, "ok", { "content-type": "text/plain; charset=utf-8" });
    const lines = parseLines(readOnce(join(dataDir, "snapshots.jsonl"), snapshotCache) ?? "");
    if (params.get("export") === "csv") {
      const day = lines.at(-1)?.day ?? "empty";
      return send(res, 200, req.method === "HEAD" ? "" : renderDashboardCsv(lines, { lang }), {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="polyth-statistics-${day}.csv"`,
      });
    }
    const events = parseEvents(readOnce(join(dataDir, "events.json"), eventsCache) ?? "[]");
    const goals = parseGoals(readOnce(join(dataDir, "goals.json"), goalsCache) ?? "[]");
    const note = parseWeeklyNote(readOnce(join(dataDir, "weekly.json"), noteCache) ?? "");
    return send(res, 200, req.method === "HEAD" ? "" : renderDashboardHtml(lines, { now: t, lang, events, goals, note, timeZone }));
  };
}

function readStdin() {
  return readFileSync(0, "utf8").replace(/\r?\n$/, "");
}

export function main(argv, env = process.env) {
  if (argv[0] === "hash-password") {
    console.log(hashPassword(readStdin()));
    return null;
  }
  if (argv[0] !== "serve") {
    console.error("usage: community-metrics-server.mjs serve | hash-password");
    process.exitCode = 2;
    return null;
  }
  const host = env.METRICS_HOST || "127.0.0.1";
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && env.METRICS_TLS_TERMINATED !== "1") throw new Error("a non-loopback METRICS_HOST needs METRICS_TLS_TERMINATED=1");
  const server = createServer(createHandler({
    keysDir: resolve(env.METRICS_KEYS_DIR || "/keys"),
    dataDir: resolve(env.METRICS_DATA_DIR || "/data"),
    lang: env.METRICS_LANG || "uk",
    timeZone: env.METRICS_TIMEZONE || "Europe/Kyiv",
  }));
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.maxHeadersCount = 32;
  const port = Number(env.METRICS_PORT || 8789);
  server.listen(port, host, () => console.log(`community metrics dashboard on ${host}:${port}`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
}
