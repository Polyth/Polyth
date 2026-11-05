// Package-owned copy, kept here because these strings exist only while the package
// is installed. Unknown locales fall back to English. Names in {braces} are filled
// by `fill`.
export interface LimitWindowsCopy {
  page: string;
  blurb: string;
  accounts: string;
  accountsHint: string;
  emptyTitle: string;
  emptyBody: string;
  unavailableTitle: string;
  unavailableBody: string;
  loadFailed: string;
  saveFailed: string;
  viewOnly: string;
  staleReading: string;
  private: string;
  off: string;
  summaryHour: string;
  summaryReset: string;
  summaryNext: string;
  when: string;
  whenHint: string;
  modeOff: string;
  modeHour: string;
  modeReset: string;
  hours: string;
  hoursHint: string;
  addHour: string;
  removeHour: string;
  hourLabel: string;
  days: string;
  daysHint: string;
  /** Sunday first. */
  dayNames: readonly string[];
  lead: string;
  leadHint: string;
  leadNone: string;
  rolling: string;
  rollingHint: string;
  activeHours: string;
  activeHoursHint: string;
  activeFrom: string;
  activeUntil: string;
  model: string;
  modelHint: string;
  modelAuto: string;
  modelReplaced: string;
  meters: string;
  metersHint: string;
  startNow: string;
  starting: string;
  startFailed: string;
  startRunning: string;
  startExhausted: string;
  startNoModel: string;
  history: string;
  noHistory: string;
  checking: string;
  nextLead: string;
  nextHour: string;
  nextRolling: string;
  nextReset: string;
  noNext: string;
  runningUntil: string;
  notStarted: string;
  holdExhausted: string;
  holdNoReading: string;
  holdUnknownReset: string;
  holdFailing: string;
  holdNoEffect: string;
  holdBudget: string;
  noRoute: string;
  noModel: string;
  outcomeSending: string;
  outcomeStarted: string;
  outcomeNoEffect: string;
  outcomeFailed: string;
  outcomeUnconfirmed: string;
  stripLabel: string;
  stripRunning: string;
  stripNow: string;
  stripPlanned: string;
  stripHour: string;
  searchPlan: string;
  searchModel: string;
  /** Model groups an account meters apart, by meter id. */
  meterNames: Readonly<Record<string, string>>;
}

const en: LimitWindowsCopy = {
  page: "Limit windows",
  blurb: "Open a new limit window when it suits you. One short request on the cheapest model starts it.",
  accounts: "Accounts",
  accountsHint: "Every start is a real request, so it uses a small part of that account's limits.",
  emptyTitle: "No account with time windows",
  emptyBody: "Accounts appear here when Usage reads a limit window from them.",
  unavailableTitle: "Not available here",
  unavailableBody: "Limit windows need a trusted local server with Usage turned on.",
  loadFailed: "Limit windows could not be loaded",
  saveFailed: "This change was not saved.",
  viewOnly: "Only a harness manager can change this account.",
  staleReading: "Usage can't read this account right now, so this may be out of date.",
  private: "Your private login",
  off: "Off",
  summaryHour: "At {times}",
  summaryReset: "After reset",
  summaryNext: "next {at}",
  when: "Start windows",
  whenHint: "A window only starts when it isn't already running.",
  modeOff: "Off",
  modeHour: "At an hour",
  modeReset: "After reset",
  hours: "New window at",
  hoursHint: "Time zone: {zone}.",
  addHour: "Add an hour",
  removeHour: "Remove {time}",
  hourLabel: "Hour",
  days: "Days",
  daysHint: "None selected means every day.",
  dayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  lead: "Prepare ahead",
  leadHint: "Also start this many windows before the hour, so a window ends right on it even if something runs overnight.",
  leadNone: "None",
  rolling: "Keep restarting",
  rollingHint: "After each reset, start the next window at once, as long as it ends by the next chosen hour.",
  activeHours: "Only during these hours",
  activeHoursHint: "Outside them, a window that resets stays closed until the range opens.",
  activeFrom: "From",
  activeUntil: "Until",
  model: "Model",
  modelHint: "The request runs on this account.",
  modelAuto: "Cheapest: {model}",
  modelReplaced: "The chosen model is no longer offered, so the cheapest one is used.",
  meters: "Which windows",
  metersHint: "This account meters these groups of models separately.",
  startNow: "Start a window now",
  starting: "Starting…",
  startFailed: "The window could not be started.",
  startRunning: "A window is already running.",
  startExhausted: "A limit of this account is used up.",
  startNoModel: "No model is available for this request.",
  history: "Recent starts",
  noHistory: "No window started yet.",
  checking: "Request sent. Checking that the window started.",
  nextLead: "Next request {at}. Its window ends at {target}, right when a new one should start.",
  nextHour: "The next window starts {at}.",
  nextRolling: "Next request {at}, right after the current window resets.",
  nextReset: "Next request {at}, right after the current window resets.",
  noNext: "Nothing is planned.",
  runningUntil: "Current window until {at}",
  notStarted: "No window is running",
  holdExhausted: "Waiting: a limit of this account is used up until {until}.",
  holdNoReading: "Waiting: Usage has no reading from this account.",
  holdUnknownReset: "Waiting: this account doesn't say when its window ends.",
  holdFailing: "The last request failed. It will try again {until}.",
  holdNoEffect: "Requests were answered but the window didn't start. It will try again {until}.",
  holdBudget: "Stopped for today: too many requests in 24 hours. It will continue {until}.",
  noRoute: "No harness on this server can reach this account.",
  noModel: "This account's harness lists no model for these windows.",
  outcomeSending: "sent, checking",
  outcomeStarted: "started, resets {at}",
  outcomeNoEffect: "answered, window didn't start",
  outcomeFailed: "failed",
  outcomeUnconfirmed: "sent, couldn't confirm",
  stripLabel: "The next 26 hours.",
  stripRunning: "Current window until {at}.",
  stripNow: "now",
  stripPlanned: "Planned starts: {list}.",
  stripHour: "Chosen hour {at}.",
  searchPlan: "Start each account's limit window at a chosen hour or after every reset.",
  searchModel: "Which model starts a limit window.",
  meterNames: { google: "Google models", "third-party": "Third-party models" },
};

const uk: LimitWindowsCopy = {
  page: "Вікна лімітів",
  blurb: "Відкривайте нове вікно ліміту тоді, коли вам зручно. Його запускає один короткий запит до найдешевшої моделі.",
  accounts: "Акаунти",
  accountsHint: "Кожен старт — це справжній запит, тож він витрачає невелику частину лімітів цього акаунта.",
  emptyTitle: "Немає акаунтів із часовими вікнами",
  emptyBody: "Акаунти з’являться тут, коли Usage прочитає в них вікно ліміту.",
  unavailableTitle: "Тут недоступно",
  unavailableBody: "Вікнам лімітів потрібен довірений локальний сервер з увімкненим Usage.",
  loadFailed: "Не вдалося завантажити вікна лімітів",
  saveFailed: "Цю зміну не збережено.",
  viewOnly: "Змінювати цей акаунт може лише керівник харнесів.",
  staleReading: "Usage зараз не може прочитати цей акаунт, тому дані можуть бути застарілі.",
  private: "Ваш приватний логін",
  off: "Вимкнено",
  summaryHour: "О {times}",
  summaryReset: "Після скидання",
  summaryNext: "далі {at}",
  when: "Запускати вікна",
  whenHint: "Вікно запускається, лише якщо воно ще не йде.",
  modeOff: "Вимкнено",
  modeHour: "У певну годину",
  modeReset: "Після скидання",
  hours: "Нове вікно о",
  hoursHint: "Часовий пояс: {zone}.",
  addHour: "Додати годину",
  removeHour: "Прибрати {time}",
  hourLabel: "Година",
  days: "Дні",
  daysHint: "Якщо нічого не вибрано — щодня.",
  dayNames: ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"],
  lead: "Готувати наперед",
  leadHint: "Запускати стільки вікон перед цією годиною, щоб вікно закінчувалося саме на ній, навіть якщо вночі щось працює.",
  leadNone: "Ні",
  rolling: "Перезапускати далі",
  rollingHint: "Після кожного скидання одразу запускати наступне вікно, якщо воно закінчиться до наступної вибраної години.",
  activeHours: "Лише в ці години",
  activeHoursHint: "Поза ними вікно після скидання чекає початку проміжку.",
  activeFrom: "Від",
  activeUntil: "До",
  model: "Модель",
  modelHint: "Запит виконується на цьому акаунті.",
  modelAuto: "Найдешевша: {model}",
  modelReplaced: "Вибрану модель більше не пропонують, тому працює найдешевша.",
  meters: "Які вікна",
  metersHint: "Цей акаунт рахує ці групи моделей окремо.",
  startNow: "Запустити вікно зараз",
  starting: "Запуск…",
  startFailed: "Не вдалося запустити вікно.",
  startRunning: "Вікно вже йде.",
  startExhausted: "Ліміт цього акаунта вичерпано.",
  startNoModel: "Для цього запиту немає доступної моделі.",
  history: "Останні запуски",
  noHistory: "Ще жодного запуску.",
  checking: "Запит надіслано. Перевіряємо, чи почалося вікно.",
  nextLead: "Наступний запит: {at}. Його вікно закінчиться о {target}, саме коли має початися нове.",
  nextHour: "Наступне вікно почнеться: {at}.",
  nextRolling: "Наступний запит: {at}, одразу після скидання поточного вікна.",
  nextReset: "Наступний запит: {at}, одразу після скидання поточного вікна.",
  noNext: "Нічого не заплановано.",
  runningUntil: "Поточне вікно до {at}",
  notStarted: "Вікно зараз не йде",
  holdExhausted: "Очікування: ліміт цього акаунта вичерпано до {until}.",
  holdNoReading: "Очікування: Usage не має даних цього акаунта.",
  holdUnknownReset: "Очікування: акаунт не повідомляє, коли закінчиться вікно.",
  holdFailing: "Останній запит не вдався. Наступна спроба {until}.",
  holdNoEffect: "Запити отримали відповідь, але вікно не почалося. Наступна спроба {until}.",
  holdBudget: "Зупинено на сьогодні: забагато запитів за 24 години. Продовжиться {until}.",
  noRoute: "Жоден харнес на цьому сервері не має доступу до цього акаунта.",
  noModel: "Харнес цього акаунта не пропонує моделі для цих вікон.",
  outcomeSending: "надіслано, перевірка",
  outcomeStarted: "почалося, скидання {at}",
  outcomeNoEffect: "є відповідь, але вікно не почалося",
  outcomeFailed: "не вдалося",
  outcomeUnconfirmed: "надіслано, не підтверджено",
  stripLabel: "Наступні 26 годин.",
  stripRunning: "Поточне вікно до {at}.",
  stripNow: "зараз",
  stripPlanned: "Заплановані старти: {list}.",
  stripHour: "Вибрана година {at}.",
  searchPlan: "Запускати вікно ліміту кожного акаунта у вибрану годину або після кожного скидання.",
  searchModel: "Яка модель запускає вікно ліміту.",
  meterNames: { google: "Моделі Google", "third-party": "Сторонні моделі" },
};

export function createCopy(locale: string): LimitWindowsCopy {
  return locale.toLowerCase().startsWith("uk") ? uk : en;
}

export const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
