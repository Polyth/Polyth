// The page's own strings. English is canonical and the fallback for any locale
// without its own catalog; `satisfies` makes a missing or extra key a type
// error, so a half-translated locale fails the build instead of showing a key.
import type { IntegrationCategory } from "./manifest.ts";

const en = {
  title: "Integrations",
  back: "All integrations",
  connectCommand: "Connect a service…",
  subtitle: "Connect the services your agent can use.",
  search: "Search integrations",
  searchEmpty: "Nothing matches “{query}”.",
  searchClear: "Clear search",
  featured: "Featured",
  all: "All",
  local: "Local",
  beta: "Beta",
  loading: "Reading the catalog…",
  loadFailed: "The catalog could not be loaded.",
  retry: "Try again",
  installed: "Connected",
  installedManual: "Connected manually",
  manageInSettings: "Manage in MCP settings",
  install: "Connect",
  uninstall: "Disconnect",
  installing: "Connecting…",
  uninstalling: "Disconnecting…",
  sections: "Categories",
  empty: "The catalog is empty.",
  detailAbout: "About",
  detailConnection: "Connection",
  detailComponents: "What it installs",
  detailType: "Type",
  detailEndpoint: "Endpoint",
  detailCommand: "Command",
  detailScope: "Where it connects",
  detailScopeProject: "This project",
  detailScopeSpace: "The whole Space",
  detailScopePerson: "Only your private chats",
  detailSignIn: "Sign-in",
  detailToken: "Where the token is created",
  detailTokenLabel: "API token",
  detailTokenPlaceholder: "Paste your key",
  detailTokenShow: "Show",
  detailTokenHide: "Hide",
  detailTokenVault: "The key is stored write-only in your Credential Vault and is never shown again.",
  detailTokenScope: "A token server is always personal: only your private chats can see it.",
  detailTokenMissing: "This entry does not say how its key travels, so it cannot connect yet.",
  detailLocalPin: "Installs only with a pinned version — run:",
  detailHomepage: "Website",
  detailChecked: "Checked",
  detailEvidence: "What was observed",
  detailSource: "Source",
  detailProbe: "Probe",
  detailProbeMore: "How it was checked",
  detailSkills: "Skills",
  detailVerified: "Published by the service itself",
  detailThirdParty: "Community or third-party server",
  detailStable: "Stable",
  componentsRemote: "Remote MCP server",
  componentsLocal: "Local MCP server",
  requiresLabel: "Requirements",
  authOauth: "Sign in with the service (OAuth)",
  authOauthNote: "The first tool call opens the service's sign-in page.",
  authToken: "Needs an API token",
  authTokenOptional: "Works without a token; a key raises limits",
  authNone: "No sign-in",
  authLocal: "Runs locally, no sign-in",
  problems: "Some entries did not load",
  errorGeneric: "Something went wrong. Try again.",
  stats: "{total} integrations · {oauth} with OAuth · {token} with a token · {local} local",
  category: {
    product: "Product",
    code: "Code",
    design: "Design",
    cloud: "Cloud",
    data: "Data",
    quality: "Quality",
    ai: "AI",
    other: "Other",
  } satisfies Record<IntegrationCategory, string>,
};

export type CatalogStrings = typeof en;
type CatalogKey = keyof CatalogStrings;

/** A locale may translate any string, and any category label, and nothing else. */
type CatalogOverrides = {
  [K in CatalogKey]?: K extends "category" ? Partial<CatalogStrings["category"]> : CatalogStrings[K];
};

const uk: CatalogOverrides = {
  title: "Інтеграції",
  back: "Усі інтеграції",
  connectCommand: "Підключити сервіс…",
  subtitle: "Підключіть сервіси, якими може користуватися агент.",
  search: "Пошук інтеграцій",
  searchEmpty: "Нічого не знайдено за «{query}».",
  searchClear: "Очистити пошук",
  featured: "Рекомендовані",
  all: "Усі",
  local: "Локально",
  beta: "Бета",
  loading: "Читаю каталог…",
  loadFailed: "Не вдалося завантажити каталог.",
  retry: "Спробувати ще раз",
  installed: "Підключено",
  installedManual: "Підключено вручну",
  manageInSettings: "Керувати в налаштуваннях MCP",
  install: "Підключити",
  uninstall: "Від'єднати",
  installing: "Підключаю…",
  uninstalling: "Від'єдную…",
  sections: "Категорії",
  empty: "Каталог порожній.",
  detailAbout: "Про сервіс",
  detailConnection: "Підключення",
  detailComponents: "Що встановлюється",
  detailType: "Тип",
  detailEndpoint: "Адреса",
  detailCommand: "Команда",
  detailScope: "Куди підключається",
  detailScopeProject: "Цей проєкт",
  detailScopeSpace: "Увесь простір",
  detailScopePerson: "Лише твої приватні чати",
  detailSignIn: "Вхід",
  detailToken: "Де створити токен",
  detailTokenLabel: "API-токен",
  detailTokenPlaceholder: "Встав ключ",
  detailTokenShow: "Показати",
  detailTokenHide: "Сховати",
  detailTokenVault: "Ключ зберігається лише на запис у Credential Vault і більше не показується.",
  detailTokenScope: "Сервер із токеном завжди персональний: його бачать лише твої приватні чати.",
  detailTokenMissing: "Цей запис ще не каже, як передається ключ, тому підключити його поки не можна.",
  detailLocalPin: "Встановлюється лише з піном версії — команда:",
  detailHomepage: "Сайт",
  detailChecked: "Перевірено",
  detailEvidence: "Що саме спостерігали",
  detailSource: "Джерело",
  detailProbe: "Проба",
  detailProbeMore: "Як це перевіряли",
  detailSkills: "Скіли",
  detailVerified: "Публікує сам сервіс",
  detailThirdParty: "Спільнотний або сторонній сервер",
  detailStable: "Стабільний",
  componentsRemote: "Віддалений MCP-сервер",
  componentsLocal: "Локальний MCP-сервер",
  requiresLabel: "Вимоги",
  authOauth: "Вхід через сервіс (OAuth)",
  authOauthNote: "Перший виклик тула відкриває сторінку входу сервісу.",
  authToken: "Потрібен API-токен",
  authTokenOptional: "Працює без токена; ключ піднімає ліміти",
  authNone: "Без входу",
  authLocal: "Працює локально, без входу",
  problems: "Частина записів не завантажилась",
  errorGeneric: "Щось пішло не так. Спробуй ще раз.",
  stats: "{total} інтеграцій · {oauth} з OAuth · {token} з токеном · {local} локальних",
  category: {
    product: "Продукт",
    code: "Код",
    design: "Дизайн",
    cloud: "Хмара",
    data: "Дані",
    quality: "Якість",
    ai: "AI",
    other: "Інше",
  },
};

/** Strings for a locale: English plus whatever that locale overrides. */
export function catalogStrings(locale?: string): CatalogStrings {
  const language = (locale ?? "en").toLowerCase().split(/[-_]/)[0];
  if (language === "uk") {
    const { category, ...rest } = uk;
    return {
      ...en,
      ...rest,
      category: { ...en.category, ...category },
    } as CatalogStrings;
  }
  return en;
}

/** Fill `{name}` placeholders in a string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole);
}
