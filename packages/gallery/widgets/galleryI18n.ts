// Package-owned copy. The gallery does not register into the shell catalog
// because its keys are feature-local and would otherwise have to be merged in
// every locale chunk; the current locale is read from the host and unknown
// locales fall back to English.
export type GalleryLocale = "en" | "uk";

const EN: Record<string, string> = {
  "gallery.title": "Gallery",
  "gallery.subtitle": "Browse generated images, annotate them, and send them to a model.",
  "gallery.chooseProject": "Select a project to browse its images.",
  "gallery.folder": "Folder",
  "gallery.projectRoot": "Project root",
  "gallery.refresh": "Refresh",
  "gallery.recursive": "Include subfolders",
  "gallery.back": "Parent folder",
  "gallery.loading": "Loading images…",
  "gallery.empty": "No images here",
  "gallery.emptyHint": "This folder has no supported image files. Pick another folder.",
  "gallery.error": "Could not read this folder",
  "gallery.truncated": "Showing the first {count} images.",
  "gallery.count": "{count} images",
  "gallery.openFolder": "Open folder",
  "gallery.close": "Close",
  "gallery.folderPicker": "Choose a folder",
  "gallery.select": "Select",
  "gallery.selected": "{count} selected",
  "gallery.annotate": "Annotate",
  "gallery.toolOff": "Pan",
  "gallery.toolPoint": "Point",
  "gallery.toolZone": "Zone",
  "gallery.annotateHint": "Click to drop a point, or drag to mark a zone.",
  "gallery.annotations": "Notes",
  "gallery.noAnnotations": "No notes on this image yet.",
  "gallery.commentPlaceholder": "Describe what you see or what should change…",
  "gallery.deleteNote": "Delete note",
  "gallery.clearNotes": "Clear notes",
  "gallery.previous": "Previous image",
  "gallery.next": "Next image",
  "gallery.zoomIn": "Zoom in",
  "gallery.zoomOut": "Zoom out",
  "gallery.zoomReset": "Reset zoom",
  "gallery.instruction": "Message",
  "gallery.instructionPlaceholder": "What should the model do with these images?",
  "gallery.model": "Model",
  "gallery.modelPlaceholder": "Choose a model",
  "gallery.modelUnknown": "No image-capable models are available right now.",
  "gallery.modelOtherHarness": "Models from other engines are hidden for this session.",
  "gallery.attachCount": "Sending {count} image(s)",
  "gallery.attachOverflow": "Only the first {count} images can be attached.",
  "gallery.send": "Send to chat",
  "gallery.sending": "Sending…",
  "gallery.sent": "Sent to the session.",
  "gallery.noSession": "Open a conversation to send these images.",
  "gallery.seedDraft": "No active conversation — the review was placed in a new chat draft.",
  "gallery.comments": "{count} notes",
  "gallery.imageAlt": "Gallery image {name}",
  "gallery.includeInSend": "Include in send",
  "gallery.selectToSend": "Select at least one image to send.",
};

const UK: Record<string, string> = {
  "gallery.title": "Галерея",
  "gallery.subtitle": "Переглядайте згенеровані зображення, позначайте їх і надсилайте моделі.",
  "gallery.chooseProject": "Виберіть проєкт, щоб переглянути його зображення.",
  "gallery.folder": "Тека",
  "gallery.projectRoot": "Корінь проєкту",
  "gallery.refresh": "Оновити",
  "gallery.recursive": "Включати підтеки",
  "gallery.back": "Батьківська тека",
  "gallery.loading": "Завантаження зображень…",
  "gallery.empty": "Тут немає зображень",
  "gallery.emptyHint": "У цій теці немає підтримуваних зображень. Виберіть іншу теку.",
  "gallery.error": "Не вдалося прочитати цю теку",
  "gallery.truncated": "Показано перші {count} зображень.",
  "gallery.count": "{count} зображень",
  "gallery.openFolder": "Відкрити теку",
  "gallery.close": "Закрити",
  "gallery.folderPicker": "Виберіть теку",
  "gallery.select": "Вибрати",
  "gallery.selected": "Вибрано: {count}",
  "gallery.annotate": "Позначити",
  "gallery.toolOff": "Панорама",
  "gallery.toolPoint": "Точка",
  "gallery.toolZone": "Зона",
  "gallery.annotateHint": "Натисніть, щоб поставити точку, або протягніть, щоб позначити зону.",
  "gallery.annotations": "Нотатки",
  "gallery.noAnnotations": "Для цього зображення ще немає нотаток.",
  "gallery.commentPlaceholder": "Опишіть, що ви бачите або що слід змінити…",
  "gallery.deleteNote": "Видалити нотатку",
  "gallery.clearNotes": "Очистити нотатки",
  "gallery.previous": "Попереднє зображення",
  "gallery.next": "Наступне зображення",
  "gallery.zoomIn": "Збільшити",
  "gallery.zoomOut": "Зменшити",
  "gallery.zoomReset": "Скинути масштаб",
  "gallery.instruction": "Повідомлення",
  "gallery.instructionPlaceholder": "Що модель має зробити з цими зображеннями?",
  "gallery.model": "Модель",
  "gallery.modelPlaceholder": "Виберіть модель",
  "gallery.modelUnknown": "Зараз немає моделей, що підтримують зображення.",
  "gallery.modelOtherHarness": "Моделі з інших рушіїв приховані для цієї сесії.",
  "gallery.attachCount": "Надсилається {count} зображень",
  "gallery.attachOverflow": "Можна прикріпити лише перші {count} зображень.",
  "gallery.send": "Надіслати в чат",
  "gallery.sending": "Надсилання…",
  "gallery.sent": "Надіслано в сесію.",
  "gallery.noSession": "Відкрийте розмову, щоб надіслати ці зображення.",
  "gallery.seedDraft": "Немає активної розмови — огляд додано в чернетку нової розмови.",
  "gallery.comments": "{count} нотаток",
  "gallery.imageAlt": "Зображення галереї {name}",
  "gallery.includeInSend": "Додати до надсилання",
  "gallery.selectToSend": "Виберіть принаймні одне зображення для надсилання.",
};

const BUNDLES: Record<GalleryLocale, Record<string, string>> = { en: EN, uk: UK };

export type GalleryTranslate = (key: string, values?: Record<string, string | number>) => string;

export function isGalleryLocale(value: string): value is GalleryLocale {
  return value === "en" || value === "uk";
}

export function createGalleryTranslate(locale: string): GalleryTranslate {
  const bundle = (isGalleryLocale(locale) ? BUNDLES[locale] : EN) ?? EN;
  return (key, values = {}) => {
    const template = bundle[key] ?? EN[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = values[name];
      return value === undefined || value === null ? match : String(value);
    });
  };
}
