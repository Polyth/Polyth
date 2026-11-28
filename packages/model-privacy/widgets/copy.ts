// Package-owned copy: these strings exist only while this package is
// installed. Unknown locales fall back to English.
import type { PrivacyPolicy } from "../src/policies.ts";

export interface PolicyCopy {
  /** The mark's accessible name and first line. */
  label: string;
  /** One sentence under it. */
  detail: string;
  /** Composer chip text. */
  chip: string;
}

export interface ModelPrivacyCopy {
  heading: string;
  checked: string;
  stale: string;
  retainedDays: string;
  trialOnly: string;
  sourceLink: string;
  policy: Record<PrivacyPolicy, PolicyCopy>;
  settings: {
    page: string;
    blurb: string;
    marksSection: string;
    all: string;
    allHint: string;
    chip: string;
    chipHint: string;
    sourceSection: string;
    sourceHint: string;
    searchAll: string;
    searchChip: string;
  };
}

const EN: ModelPrivacyCopy = {
  heading: "Data handling",
  checked: "Checked {date}",
  stale: "Last checked {date}; it may have changed.",
  retainedDays: "Data is kept for {days} days.",
  trialOnly: "Trial use only: do not send personal or confidential data.",
  sourceLink: "Provider's policy",
  policy: {
    "zero-retention": {
      label: "Zero retention",
      detail: "The provider does not keep your prompts or train on them.",
      chip: "Zero retention",
    },
    "retained-no-training": {
      label: "Kept, not used for training",
      detail: "The provider keeps requests for a while for safety but does not train on them.",
      chip: "Data kept",
    },
    "may-improve": {
      label: "May be used to improve the model",
      detail: "While the model is free, collected data may be used to improve it.",
      chip: "Data may train the model",
    },
    "retained-training": {
      label: "Kept and used for training",
      detail: "While the model is free, collected data is retained and used to improve it.",
      chip: "Data is used for training",
    },
    unclear: {
      label: "Data policy unclear",
      detail: "The provider's page does not say clearly how data sent to this model is used.",
      chip: "Data policy unclear",
    },
    unverified: {
      label: "Data policy not verified",
      detail: "This model is not in the checked list yet. Do not assume it keeps nothing.",
      chip: "Data policy not verified",
    },
    "upstream-terms": {
      label: "Upstream vendor's retention",
      detail: "Paid routes follow the model vendor's terms; OpenAI, Anthropic, Google and xAI keep requests for 30 to 55 days.",
      chip: "Vendor retention",
    },
  },
  settings: {
    page: "Model privacy",
    blurb: "Marks beside model names that say how each free model's provider handles what you send.",
    marksSection: "Marks",
    all: "Show reassuring marks too",
    allHint: "Also mark zero-retention models. Off: only models that keep or may train on your data are marked.",
    chip: "Chip beside the model",
    chipHint: "A chip in the composer when the selected model may keep or train on your data.",
    sourceSection: "Source",
    sourceHint: "Checked {date}. The list is a dated snapshot of the provider's own page, not a live feed.",
    searchAll: "Mark zero-retention models too",
    searchChip: "Composer privacy chip",
  },
};

const UK: ModelPrivacyCopy = {
  heading: "Обробка даних",
  checked: "Перевірено {date}",
  stale: "Востаннє перевірено {date}, могло змінитися.",
  retainedDays: "Дані зберігаються {days} днів.",
  trialOnly: "Лише для пробного використання: не надсилайте особисті чи конфіденційні дані.",
  sourceLink: "Політика провайдера",
  policy: {
    "zero-retention": {
      label: "Нічого не зберігається",
      detail: "Провайдер не зберігає ваші запити й не навчає на них моделі.",
      chip: "Нічого не зберігається",
    },
    "retained-no-training": {
      label: "Зберігається, але не для навчання",
      detail: "Провайдер якийсь час зберігає запити з міркувань безпеки, але не навчає на них.",
      chip: "Дані зберігаються",
    },
    "may-improve": {
      label: "Може використовуватись для покращення моделі",
      detail: "Поки модель безкоштовна, зібрані дані можуть використовуватись для її покращення.",
      chip: "Дані можуть іти на навчання",
    },
    "retained-training": {
      label: "Зберігається й іде на навчання",
      detail: "Поки модель безкоштовна, зібрані дані зберігаються й використовуються для її покращення.",
      chip: "Дані йдуть на навчання",
    },
    unclear: {
      label: "Політика щодо даних неясна",
      detail: "Сторінка провайдера прямо не каже, як використовуються дані, надіслані цій моделі.",
      chip: "Політика неясна",
    },
    unverified: {
      label: "Політику не перевірено",
      detail: "Цієї моделі ще немає в перевіреному списку. Не вважайте, що вона нічого не зберігає.",
      chip: "Політику не перевірено",
    },
    "upstream-terms": {
      label: "Зберігання за умовами вендора",
      detail: "Платні маршрути підкоряються умовам вендора моделі; OpenAI, Anthropic, Google і xAI зберігають запити від 30 до 55 днів.",
      chip: "Умови вендора",
    },
  },
  settings: {
    page: "Приватність моделей",
    blurb: "Позначки біля назв моделей: як провайдер кожної безкоштовної моделі поводиться з тим, що ви надсилаєте.",
    marksSection: "Позначки",
    all: "Показувати й заспокійливі позначки",
    allHint: "Позначати також моделі без зберігання даних. Вимкнено: позначаються лише моделі, які зберігають дані або можуть на них навчатися.",
    chip: "Чип біля моделі",
    chipHint: "Чип у композері, коли обрана модель може зберігати ваші дані чи навчатися на них.",
    sourceSection: "Джерело",
    sourceHint: "Перевірено {date}. Список — датований знімок сторінки самого провайдера, а не живі дані.",
    searchAll: "Позначати й моделі без зберігання",
    searchChip: "Чип приватності в композері",
  },
};

const CATALOGS: Readonly<Record<string, ModelPrivacyCopy>> = { en: EN, uk: UK };

export function createModelPrivacyCopy(locale: string): ModelPrivacyCopy {
  const language = (locale.split("-")[0] ?? "en").toLowerCase();
  return CATALOGS[locale] ?? CATALOGS[language] ?? EN;
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function formatCheckedDate(iso: string, locale: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date);
  } catch {
    return iso;
  }
}
