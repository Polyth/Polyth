// Package-owned copy for the peak-pricing indicator. Kept in the package (not
// the shell catalog) because these strings only exist while this package is
// installed; the current locale comes from the host and unknown locales fall
// back to English.
import type { DurationUnits } from "../src/schedule.ts";

/** Settings → Peak pricing. */
export interface PeakPricingSettingsCopy {
  /** Settings nav label. */
  page: string;
  blurb: string;
  chipSection: string;
  show: string;
  showHint: string;
  display: string;
  displayHint: string;
  full: string;
  compact: string;
  dot: string;
  detailsSection: string;
  tooltip: string;
  tooltipHint: string;
  previewSection: string;
  /** Stand-in model name beside the preview chips. */
  previewModel: string;
  hidden: string;
  noSchedule: string;
  /** Settings search descriptions. */
  searchChip: string;
  searchDisplay: string;
  searchTooltip: string;
  /** Customize menu entry for the status-bar segment. */
  statusbarWidget: string;
  statusbarWidgetHint: string;
}

export interface PeakPricingCopy {
  /** Chip accessible name, e.g. "DeepSeek peak pricing: peak until 14:30". */
  chipLabel: string;
  peak: string;
  offPeak: string;
  /** "Peak until {time}" / "Off-peak until {time}". */
  until: string;
  /** "Peak ends in {remaining}". */
  remaining: string;
  /** "Peak pricing", "Off-peak pricing". */
  peakTitle: string;
  offPeakTitle: string;
  /** "Full price now" / "Half price now". */
  peakDetail: string;
  offPeakDetail: string;
  /** "Changes at {time}". */
  changesAt: string;
  /** "Today is off-peak for {holiday}." */
  holiday: string;
  /** "Weekend rates apply." */
  weekend: string;
  /** "The {year} holiday calendar is not published yet; weekday windows still apply." */
  calendarUnknown: string;
  /** "{source}" (under the "Holiday calendar" label). */
  calendarSource: string;
  /** "Off-peak is half the peak rate." */
  discount: string;
  /** "Your time · {zone}" */
  zone: string;
  /** "Peak hours (UTC)" */
  windows: string;
  /** The weekdays those windows apply on: "Mon–Fri". */
  weekdays: string;
  /** "Holiday calendar" */
  calendarLabel: string;
  /** "Served by {provider}: the clock is DeepSeek's own API price." */
  billedBy: string;
  /** "Open DeepSeek pricing" */
  sourceLink: string;
  /** Details surface heading. */
  detailsTitle: string;
  /** Countdown part names (`1h 21m`, `1 год 21 хв`). */
  duration: DurationUnits;
  settings: PeakPricingSettingsCopy;
}

const EN: PeakPricingCopy = {
  chipLabel: "DeepSeek pricing: {state} until {time}",
  peak: "Peak",
  offPeak: "Off-peak",
  until: "{state} until {time}",
  remaining: "{state} ends in {remaining}",
  peakTitle: "Peak pricing",
  offPeakTitle: "Off-peak pricing",
  peakDetail: "Full API rate right now",
  offPeakDetail: "Half the peak API rate right now",
  changesAt: "Changes at {time}",
  holiday: "Today is off-peak for {holiday}.",
  weekend: "Weekend rates apply.",
  calendarUnknown: "The {year} holiday calendar is not published yet, so only weekday windows are applied.",
  calendarSource: "{source}",
  discount: "Off-peak is half the peak rate.",
  zone: "Your time · {zone}",
  windows: "Peak hours (UTC)",
  weekdays: "Mon–Fri",
  calendarLabel: "Holiday calendar",
  billedBy: "Served by {provider}. This clock is DeepSeek's own API price; the route itself may bill differently.",
  sourceLink: "Open DeepSeek pricing",
  detailsTitle: "DeepSeek API pricing",
  duration: { day: "{n}d", hour: "{n}h", minute: "{n}m", second: "{n}s" },
  settings: {
    page: "Peak pricing",
    blurb: "Choose how the time-of-day price appears beside the model in the composer.",
    chipSection: "Chip",
    show: "Show the chip",
    showHint: "Show whether the selected model is at its peak or off-peak rate.",
    display: "Display",
    displayHint: "Full adds the time left, Compact keeps the word, Dot only keeps a coloured dot.",
    full: "Full",
    compact: "Compact",
    dot: "Dot only",
    detailsSection: "Details",
    tooltip: "Show a summary on hover",
    tooltipHint: "Pointing at the chip or focusing it shows the time left. A click always opens the full card.",
    previewSection: "Preview",
    previewModel: "DeepSeek V4 Flash",
    hidden: "The chip is hidden.",
    noSchedule: "Models without a published time-of-day price never show a chip.",
    searchChip: "Show or hide the peak and off-peak chip beside the model.",
    searchDisplay: "Full, compact or dot-only peak-pricing chip.",
    searchTooltip: "Hover summary with the time left until the price changes.",
    statusbarWidget: "Peak pricing",
    statusbarWidgetHint: "Peak or off-peak for the session's model, with the time left. Hidden for models without a time-of-day price.",
  },
};

const UK: PeakPricingCopy = {
  chipLabel: "Ціни DeepSeek: {state} до {time}",
  peak: "Пік",
  offPeak: "Поза піком",
  until: "{state} до {time}",
  remaining: "{state} завершується через {remaining}",
  peakTitle: "Пікова ціна",
  offPeakTitle: "Позапікова ціна",
  peakDetail: "Зараз повний тариф API",
  offPeakDetail: "Зараз половина пікового тарифу API",
  changesAt: "Зміна о {time}",
  holiday: "Сьогодні поза піком через свято: {holiday}.",
  weekend: "Діє тариф вихідних.",
  calendarUnknown: "Календар свят на {year} рік ще не опубліковано, тому застосовуються лише буденні вікна.",
  calendarSource: "{source}",
  discount: "Поза піком ціна вдвічі нижча за пікову.",
  zone: "Ваш час · {zone}",
  windows: "Пікові години (UTC)",
  weekdays: "Пн–Пт",
  calendarLabel: "Календар свят",
  billedBy: "Маршрут через {provider}. Цей годинник показує власну ціну API DeepSeek; сам маршрут може тарифікуватися інакше.",
  sourceLink: "Відкрити ціни DeepSeek",
  detailsTitle: "Ціни API DeepSeek",
  duration: { day: "{n} дн.", hour: "{n} год", minute: "{n} хв", second: "{n} с" },
  settings: {
    page: "Пікові ціни",
    blurb: "Виберіть, як ціна залежно від часу доби показується біля моделі в полі повідомлення.",
    chipSection: "Позначка",
    show: "Показувати позначку",
    showHint: "Показує, чи діє для вибраної моделі піковий або позапіковий тариф.",
    display: "Вигляд",
    displayHint: "«Повний» додає залишок часу, «Стислий» лишає слово, «Крапка» — лише кольорову крапку.",
    full: "Повний",
    compact: "Стислий",
    dot: "Крапка",
    detailsSection: "Подробиці",
    tooltip: "Показувати підсумок при наведенні",
    tooltipHint: "Наведення або фокус на позначці показує залишок часу. Клік завжди відкриває повну картку.",
    previewSection: "Попередній перегляд",
    previewModel: "DeepSeek V4 Flash",
    hidden: "Позначку приховано.",
    noSchedule: "Моделі без опублікованої ціни за часом доби позначки не показують.",
    searchChip: "Показати або сховати позначку пікового й позапікового тарифу біля моделі.",
    searchDisplay: "Повна, стисла позначка пікових цін або лише крапка.",
    searchTooltip: "Підказка із залишком часу до зміни ціни.",
    statusbarWidget: "Пікові ціни",
    statusbarWidgetHint: "Пік чи поза піком для моделі сесії, із залишком часу. Не показується для моделей без ціни за часом доби.",
  },
};

const DE: PeakPricingCopy = {
  chipLabel: "DeepSeek-Preise: {state} bis {time}",
  peak: "Spitzenzeit",
  offPeak: "Nebenzeit",
  until: "{state} bis {time}",
  remaining: "{state} endet in {remaining}",
  peakTitle: "Spitzenzeit-Preise",
  offPeakTitle: "Nebenzeit-Preise",
  peakDetail: "Aktuell voller API-Tarif",
  offPeakDetail: "Aktuell halber API-Tarif der Spitzenzeit",
  changesAt: "Wechsel um {time}",
  holiday: "Heute gilt wegen {holiday} Nebenzeit.",
  weekend: "Es gelten Wochenendtarife.",
  calendarUnknown: "Der Feiertagskalender für {year} ist noch nicht veröffentlicht, daher gelten nur die Werktagsfenster.",
  calendarSource: "{source}",
  discount: "Die Nebenzeit kostet die Hälfte des Spitzentarifs.",
  zone: "Ihre Zeit · {zone}",
  windows: "Spitzenzeiten (UTC)",
  weekdays: "Mo–Fr",
  calendarLabel: "Feiertagskalender",
  billedBy: "Bereitgestellt von {provider}. Diese Uhr zeigt den eigenen API-Preis von DeepSeek; die Route selbst kann anders abrechnen.",
  sourceLink: "DeepSeek-Preise öffnen",
  detailsTitle: "DeepSeek-API-Preise",
  duration: { day: "{n} Tg.", hour: "{n} Std.", minute: "{n} Min.", second: "{n} s" },
  settings: {
    page: "Spitzenzeit-Preise",
    blurb: "Legen Sie fest, wie der tageszeitabhängige Preis neben dem Modell im Eingabefeld erscheint.",
    chipSection: "Chip",
    show: "Chip anzeigen",
    showHint: "Zeigt, ob das gewählte Modell gerade zum Spitzen- oder Nebentarif läuft.",
    display: "Darstellung",
    displayHint: "„Voll“ ergänzt die Restzeit, „Kompakt“ behält nur das Wort, „Nur Punkt“ nur einen farbigen Punkt.",
    full: "Voll",
    compact: "Kompakt",
    dot: "Nur Punkt",
    detailsSection: "Details",
    tooltip: "Zusammenfassung bei Hover anzeigen",
    tooltipHint: "Zeigen oder fokussieren Sie den Chip, um die Restzeit zu sehen. Ein Klick öffnet immer die vollständige Karte.",
    previewSection: "Vorschau",
    previewModel: "DeepSeek V4 Flash",
    hidden: "Der Chip ist ausgeblendet.",
    noSchedule: "Modelle ohne veröffentlichten tageszeitabhängigen Preis zeigen nie einen Chip.",
    searchChip: "Den Spitzen-/Nebenzeit-Chip neben dem Modell ein- oder ausblenden.",
    searchDisplay: "Chip für Spitzenzeit-Preise: voll, kompakt oder nur Punkt.",
    searchTooltip: "Hover-Zusammenfassung mit der Restzeit bis zur Preisänderung.",
    statusbarWidget: "Spitzenzeit-Preise",
    statusbarWidgetHint: "Spitzen- oder Nebenzeit für das Modell der Sitzung samt Restzeit. Ausgeblendet bei Modellen ohne tageszeitabhängigen Preis.",
  },
};

const FR: PeakPricingCopy = {
  chipLabel: "Tarification DeepSeek : {state} jusqu’à {time}",
  peak: "Pointe",
  offPeak: "Hors pointe",
  until: "{state} jusqu’à {time}",
  remaining: "{state} se termine dans {remaining}",
  peakTitle: "Tarification de pointe",
  offPeakTitle: "Tarification hors pointe",
  peakDetail: "Tarif API plein en ce moment",
  offPeakDetail: "Moitié du tarif API de pointe en ce moment",
  changesAt: "Change à {time}",
  holiday: "Aujourd’hui est hors pointe pour {holiday}.",
  weekend: "Les tarifs du week-end s’appliquent.",
  calendarUnknown: "Le calendrier des jours fériés {year} n’est pas encore publié ; seules les plages de semaine sont appliquées.",
  calendarSource: "{source}",
  discount: "Le tarif hors pointe représente la moitié du tarif de pointe.",
  zone: "Votre heure · {zone}",
  windows: "Heures de pointe (UTC)",
  weekdays: "Lun–ven",
  calendarLabel: "Calendrier des jours fériés",
  billedBy: "Fourni par {provider}. Ce tarif est celui de l’API DeepSeek elle-même ; la route utilisée peut facturer différemment.",
  sourceLink: "Ouvrir la tarification DeepSeek",
  detailsTitle: "Tarification de l’API DeepSeek",
  duration: { day: "{n} j", hour: "{n} h", minute: "{n} min", second: "{n} s" },
  settings: {
    page: "Tarification de pointe",
    blurb: "Choisissez comment le tarif selon l’heure apparaît à côté du modèle dans la zone de saisie.",
    chipSection: "Puce",
    show: "Afficher la puce",
    showHint: "Indique si le modèle sélectionné est au tarif de pointe ou hors pointe.",
    display: "Affichage",
    displayHint: "Complet ajoute le temps restant, Compact conserve le libellé, Point n’affiche qu’un point coloré.",
    full: "Complet",
    compact: "Compact",
    dot: "Point seul",
    detailsSection: "Détails",
    tooltip: "Afficher un résumé au survol",
    tooltipHint: "Survoler la puce ou la cibler affiche le temps restant. Un clic ouvre toujours la carte complète.",
    previewSection: "Aperçu",
    previewModel: "DeepSeek V4 Flash",
    hidden: "La puce est masquée.",
    noSchedule: "Les modèles sans tarif horaire publié n’affichent jamais de puce.",
    searchChip: "Afficher ou masquer la puce de pointe à côté du modèle.",
    searchDisplay: "Puce de tarification de pointe complète, compacte ou point seul.",
    searchTooltip: "Résumé au survol avec le temps restant avant le changement de tarif.",
    statusbarWidget: "Tarification de pointe",
    statusbarWidgetHint: "Pointe ou hors pointe pour le modèle de la session, avec le temps restant. Masqué pour les modèles sans tarif horaire.",
  },
};

const PL: PeakPricingCopy = {
  chipLabel: "Ceny DeepSeek: {state} do {time}",
  peak: "Szczyt",
  offPeak: "Poza szczytem",
  until: "{state} do {time}",
  remaining: "{state} kończy się za {remaining}",
  peakTitle: "Ceny w godzinach szczytu",
  offPeakTitle: "Ceny poza godzinami szczytu",
  peakDetail: "Teraz pełna stawka API",
  offPeakDetail: "Teraz połowa stawki API w szczycie",
  changesAt: "Zmienia się o {time}",
  holiday: "Dziś obowiązuje stawka poza szczytem z powodu: {holiday}.",
  weekend: "Obowiązują stawki weekendowe.",
  calendarUnknown: "Kalendarz świąt na {year} nie został jeszcze opublikowany, więc stosowane są tylko okna dni roboczych.",
  calendarSource: "{source}",
  discount: "Poza szczytem stawka jest o połowę niższa.",
  zone: "Twój czas · {zone}",
  windows: "Godziny szczytu (UTC)",
  weekdays: "pon.–pt.",
  calendarLabel: "Kalendarz świąt",
  billedBy: "Obsługiwane przez {provider}. Ten zegar pokazuje cenę API DeepSeek; sama trasa może rozliczać inaczej.",
  sourceLink: "Otwórz cennik DeepSeek",
  detailsTitle: "Cennik API DeepSeek",
  duration: { day: "{n} d", hour: "{n} godz.", minute: "{n} min", second: "{n} s" },
  settings: {
    page: "Ceny w godzinach szczytu",
    blurb: "Wybierz, jak cena zależna od pory dnia ma się pojawiać obok modelu w polu wiadomości.",
    chipSection: "Żeton",
    show: "Pokaż żeton",
    showHint: "Pokazuj, czy wybrany model ma stawkę szczytową, czy pozaszczytową.",
    display: "Wyświetlanie",
    displayHint: "Pełny dodaje pozostały czas, Kompaktowy zachowuje słowo, Kropka pozostawia tylko kolorową kropkę.",
    full: "Pełny",
    compact: "Kompaktowy",
    dot: "Tylko kropka",
    detailsSection: "Szczegóły",
    tooltip: "Pokaż podsumowanie po najechaniu",
    tooltipHint: "Najechanie na żeton lub ustawienie na nim fokusu pokazuje pozostały czas. Kliknięcie zawsze otwiera pełną kartę.",
    previewSection: "Podgląd",
    previewModel: "DeepSeek V4 Flash",
    hidden: "Żeton jest ukryty.",
    noSchedule: "Modele bez opublikowanej ceny zależnej od pory dnia nigdy nie pokazują żetonu.",
    searchChip: "Pokaż lub ukryj żeton szczytu i poza szczytem obok modelu.",
    searchDisplay: "Pełny, kompaktowy lub kropkowy żeton cen szczytowych.",
    searchTooltip: "Podsumowanie po najechaniu z czasem do zmiany ceny.",
    statusbarWidget: "Ceny w godzinach szczytu",
    statusbarWidgetHint: "Szczyt lub poza szczytem dla modelu sesji wraz z pozostałym czasem. Ukryte dla modeli bez ceny zależnej od pory dnia.",
  },
};

const PT_BR: PeakPricingCopy = {
  chipLabel: "Preço do DeepSeek: {state} até {time}",
  peak: "Pico",
  offPeak: "Fora de pico",
  until: "{state} até {time}",
  remaining: "{state} termina em {remaining}",
  peakTitle: "Preço de pico",
  offPeakTitle: "Preço fora de pico",
  peakDetail: "Tarifa cheia da API no momento",
  offPeakDetail: "Metade da tarifa de pico da API no momento",
  changesAt: "Muda às {time}",
  holiday: "Hoje é considerado fora de pico por ser {holiday}.",
  weekend: "Tarifas de fim de semana em vigor.",
  calendarUnknown: "O calendário de feriados de {year} ainda não foi publicado, portanto aplicam-se apenas os horários de dias úteis.",
  calendarSource: "{source}",
  discount: "O horário fora de pico tem metade do valor da tarifa cheia.",
  zone: "Seu horário local · {zone}",
  windows: "Horários de pico (UTC)",
  weekdays: "Seg–Sex",
  calendarLabel: "Calendário de feriados",
  billedBy: "Fornecido por {provider}. Este relógio reflete o preço da API oficial do DeepSeek; a rota contratada pode faturar de forma diferente.",
  sourceLink: "Abrir preços do DeepSeek",
  detailsTitle: "Preços da API DeepSeek",
  duration: { day: "{n}d", hour: "{n}h", minute: "{n}m", second: "{n}s" },
  settings: {
    page: "Preço de pico",
    blurb: "Escolha como o preço por horário do dia é exibido ao lado do modelo no composer.",
    chipSection: "Chip",
    show: "Exibir o chip",
    showHint: "Mostrar se o modelo selecionado está na tarifa de pico ou fora de pico.",
    display: "Exibição",
    displayHint: "Completo inclui o tempo restante, Compacto exibe apenas a palavra, Somente ponto mantém um ponto colorido.",
    full: "Completo",
    compact: "Compacto",
    dot: "Somente ponto",
    detailsSection: "Detalhes",
    tooltip: "Exibir resumo ao passar o mouse",
    tooltipHint: "Passar o cursor sobre o chip ou focalizá-lo mostra o tempo restante. Um clique sempre abre o cartão completo.",
    previewSection: "Prévia",
    previewModel: "DeepSeek V4 Flash",
    hidden: "O chip está oculto.",
    noSchedule: "Modelos sem precificação diferenciada por horário nunca exibem chip.",
    searchChip: "Mostrar ou ocultar o chip de horário de pico e fora de pico ao lado do modelo.",
    searchDisplay: "Chip de preço de pico completo, compacto ou apenas ponto.",
    searchTooltip: "Resumo ao passar o mouse com o tempo restante até a alteração de preço.",
    statusbarWidget: "Preço de pico",
    statusbarWidgetHint: "Horário de pico ou fora de pico para o modelo da sessão, com o tempo restante. Oculto para modelos sem precificação por horário.",
  },
};

const IT: PeakPricingCopy = {
  chipLabel: "Prezzi DeepSeek: {state} fino alle {time}",
  peak: "Picco",
  offPeak: "Fuori picco",
  until: "{state} fino alle {time}",
  remaining: "{state} termina tra {remaining}",
  peakTitle: "Prezzi di picco",
  offPeakTitle: "Prezzi fuori picco",
  peakDetail: "Tariffa API piena in questo momento",
  offPeakDetail: "Metà della tariffa API di picco in questo momento",
  changesAt: "Cambia alle {time}",
  holiday: "Oggi è fuori picco per {holiday}.",
  weekend: "Si applicano le tariffe del fine settimana.",
  calendarUnknown: "Il calendario dei festivi {year} non è ancora pubblicato, quindi si applicano solo le fasce feriali.",
  calendarSource: "{source}",
  discount: "Fuori picco la tariffa è metà di quella di picco.",
  zone: "Il tuo orario · {zone}",
  windows: "Ore di picco (UTC)",
  weekdays: "Lun–Ven",
  calendarLabel: "Calendario dei festivi",
  billedBy: "Fornito da {provider}. Questo orologio si basa sul prezzo API di DeepSeek; la route potrebbe addebitare diversamente.",
  sourceLink: "Apri i prezzi DeepSeek",
  detailsTitle: "Prezzi API DeepSeek",
  duration: { day: "{n}g", hour: "{n}h", minute: "{n}m", second: "{n}s" },
  settings: {
    page: "Prezzi di picco",
    blurb: "Scegli come mostrare il prezzo in base all’orario accanto al modello nel compositore.",
    chipSection: "Chip",
    show: "Mostra il chip",
    showHint: "Mostra se il modello selezionato è a tariffa di picco o fuori picco.",
    display: "Visualizzazione",
    displayHint: "Completa aggiunge il tempo rimanente, Compatta mantiene la parola, Solo punto mantiene solo un punto colorato.",
    full: "Completa",
    compact: "Compatta",
    dot: "Solo punto",
    detailsSection: "Dettagli",
    tooltip: "Mostra un riepilogo al passaggio del mouse",
    tooltipHint: "Passando il mouse sul chip o portandovi il focus si vede il tempo rimanente. Un clic apre sempre la scheda completa.",
    previewSection: "Anteprima",
    previewModel: "DeepSeek V4 Flash",
    hidden: "Il chip è nascosto.",
    noSchedule: "I modelli senza un prezzo orario pubblicato non mostrano mai il chip.",
    searchChip: "Mostra o nascondi il chip di picco e fuori picco accanto al modello.",
    searchDisplay: "Chip dei prezzi di picco completa, compatta o solo punto.",
    searchTooltip: "Riepilogo al passaggio del mouse con il tempo rimanente prima del cambio di prezzo.",
    statusbarWidget: "Prezzi di picco",
    statusbarWidgetHint: "Picco o fuori picco per il modello della sessione, con il tempo rimanente. Nascosto per i modelli senza prezzo orario.",
  },
};

const ES: PeakPricingCopy = {
  chipLabel: "Precios de DeepSeek: {state} hasta {time}",
  peak: "Punta",
  offPeak: "Valle",
  until: "{state} hasta {time}",
  remaining: "{state} termina en {remaining}",
  peakTitle: "Precios punta",
  offPeakTitle: "Precios valle",
  peakDetail: "Tarifa completa de la API en este momento",
  offPeakDetail: "Mitad de la tarifa punta de la API en este momento",
  changesAt: "Cambia a las {time}",
  holiday: "Hoy es horario valle por {holiday}.",
  weekend: "Se aplican tarifas de fin de semana.",
  calendarUnknown: "El calendario de festivos de {year} aún no se ha publicado, por lo que solo se aplican los intervalos entre semana.",
  calendarSource: "{source}",
  discount: "El horario valle es la mitad de la tarifa punta.",
  zone: "Tu hora · {zone}",
  windows: "Horas punta (UTC)",
  weekdays: "Lun–Vie",
  calendarLabel: "Calendario de festivos",
  billedBy: "Servido por {provider}. Este reloj muestra el precio de la API directa de DeepSeek; la ruta puede facturar de forma diferente.",
  sourceLink: "Abrir precios de DeepSeek",
  detailsTitle: "Precios de la API de DeepSeek",
  duration: { day: "{n}d", hour: "{n}h", minute: "{n}m", second: "{n}s" },
  settings: {
    page: "Precios punta",
    blurb: "Elige cómo aparece el precio por franja horaria junto al modelo en el cuadro de redacción.",
    chipSection: "Chip",
    show: "Mostrar el chip",
    showHint: "Muestra si el modelo seleccionado está en su tarifa punta o valle.",
    display: "Visualización",
    displayHint: "Completo añade el tiempo restante, Compacto conserva el texto y Solo punto mantiene un punto de color.",
    full: "Completo",
    compact: "Compacto",
    dot: "Solo punto",
    detailsSection: "Detalles",
    tooltip: "Mostrar un resumen al pasar el cursor",
    tooltipHint: "Al pasar el cursor sobre el chip o enfocarlo se muestra el tiempo restante. Al hacer clic siempre se abre la tarjeta completa.",
    previewSection: "Vista previa",
    previewModel: "DeepSeek V4 Flash",
    hidden: "El chip está oculto.",
    noSchedule: "Los modelos sin precio publicado por franja horaria nunca muestran un chip.",
    searchChip: "Muestra u oculta el chip de tarifas punta y valle junto al modelo.",
    searchDisplay: "Chip de precios punta completo, compacto o solo con punto.",
    searchTooltip: "Resumen al pasar el cursor con el tiempo restante hasta que cambie el precio.",
    statusbarWidget: "Precios punta",
    statusbarWidgetHint: "Tarifa punta o valle para el modelo de la sesión, con el tiempo restante. Oculto para modelos sin precio por franja horaria.",
  },
};

const ZH_CN: PeakPricingCopy = {
  chipLabel: "DeepSeek 定价：{state}，至 {time}",
  peak: "高峰",
  offPeak: "非高峰",
  until: "{state}，至 {time}",
  remaining: "{state} 将在 {remaining} 后结束",
  peakTitle: "高峰定价",
  offPeakTitle: "非高峰定价",
  peakDetail: "当前为完整 API 费率",
  offPeakDetail: "当前为高峰 API 费率的一半",
  changesAt: "{time} 变更",
  holiday: "今天是 {holiday}，按非高峰计费。",
  weekend: "适用周末费率。",
  calendarUnknown: "{year} 年的节假日日历尚未发布，因此仅应用工作日时段。",
  calendarSource: "{source}",
  discount: "非高峰为高峰费率的一半。",
  zone: "你的时间 · {zone}",
  windows: "高峰时段（UTC）",
  weekdays: "周一至周五",
  calendarLabel: "节假日日历",
  billedBy: "由 {provider} 提供。此时钟为 DeepSeek 自身 API 价格；实际路由的计费可能不同。",
  sourceLink: "打开 DeepSeek 定价",
  detailsTitle: "DeepSeek API 定价",
  duration: { day: "{n} 天", hour: "{n} 小时", minute: "{n} 分钟", second: "{n} 秒" },
  settings: {
    page: "高峰定价",
    blurb: "选择输入框中模型旁如何显示时段价格。",
    chipSection: "标签",
    show: "显示标签",
    showHint: "显示所选模型当前处于高峰还是非高峰费率。",
    display: "显示方式",
    displayHint: "“完整”会加上剩余时间，“紧凑”只保留文字，“仅圆点”只保留彩色圆点。",
    full: "完整",
    compact: "紧凑",
    dot: "仅圆点",
    detailsSection: "详情",
    tooltip: "悬停时显示摘要",
    tooltipHint: "指向或聚焦标签时显示剩余时间。点击始终打开完整卡片。",
    previewSection: "预览",
    previewModel: "DeepSeek V4 Flash",
    hidden: "标签已隐藏。",
    noSchedule: "没有公开时段价格的模型永远不会显示标签。",
    searchChip: "在模型旁显示或隐藏高峰/非高峰标签。",
    searchDisplay: "完整、紧凑或仅圆点的高峰定价标签。",
    searchTooltip: "悬停摘要，显示距离价格变更的剩余时间。",
    statusbarWidget: "高峰定价",
    statusbarWidgetHint: "会话模型的高峰或非高峰状态及剩余时间。没有时段价格的模型不显示。",
  },
};

const BG: PeakPricingCopy = {
  chipLabel: "Цени на DeepSeek: {state} до {time}",
  peak: "Пик",
  offPeak: "Извън пик",
  until: "{state} до {time}",
  remaining: "{state} приключва след {remaining}",
  peakTitle: "Ценообразуване в пик",
  offPeakTitle: "Ценообразуване извън пик",
  peakDetail: "Пълна тарифа за API в момента",
  offPeakDetail: "Половината от тарифата за API в пик в момента",
  changesAt: "Промяна в {time}",
  holiday: "Днес е извън пик заради {holiday}.",
  weekend: "Важат тарифите за уикенд.",
  calendarUnknown: "Празничният календар за {year} още не е публикуван, затова се прилагат само делничните часови прозорци.",
  calendarSource: "{source}",
  discount: "Извън пик е половината от тарифата в пик.",
  zone: "Вашето време · {zone}",
  windows: "Часове в пик (UTC)",
  weekdays: "пн–пт",
  calendarLabel: "Празничен календар",
  billedBy: "Обслужва се от {provider}. Този часовник показва собствената цена на API на DeepSeek; самият маршрут може да таксува различно.",
  sourceLink: "Отваряне на цените на DeepSeek",
  detailsTitle: "Цени на API на DeepSeek",
  duration: { day: "{n} д", hour: "{n} ч", minute: "{n} мин", second: "{n} с" },
  settings: {
    page: "Ценообразуване в пик",
    blurb: "Изберете как цената според часа да се показва до модела в полето за съобщение.",
    chipSection: "Отметка",
    show: "Показване на отметката",
    showHint: "Показва дали избраният модел е в пикова или извънпикова тарифа.",
    display: "Показване",
    displayHint: "„Пълно“ добавя оставащото време, „Компактно“ запазва думата, „Само точка“ оставя само цветна точка.",
    full: "Пълно",
    compact: "Компактно",
    dot: "Само точка",
    detailsSection: "Подробности",
    tooltip: "Показване на обобщение при посочване",
    tooltipHint: "Посочването на отметката или фокусирането ѝ показва оставащото време. Щракването винаги отваря пълната карта.",
    previewSection: "Преглед",
    previewModel: "DeepSeek V4 Flash",
    hidden: "Отметката е скрита.",
    noSchedule: "Модели без публикувана цена според часа никога не показват отметка.",
    searchChip: "Показване или скриване на отметката за пик и извън пик до модела.",
    searchDisplay: "Отметка за ценообразуване в пик: пълна, компактна или само точка.",
    searchTooltip: "Обобщение при посочване с оставащото време до промяната на цената.",
    statusbarWidget: "Ценообразуване в пик",
    statusbarWidgetHint: "Пик или извън пик за модела на сесията, с оставащото време. Скрито за модели без цена според часа.",
  },
};

const AR: PeakPricingCopy = {
  chipLabel: "تسعير DeepSeek: {state} حتى {time}",
  peak: "ذروة",
  offPeak: "خارج الذروة",
  until: "{state} حتى {time}",
  remaining: "ينتهي {state} خلال {remaining}",
  peakTitle: "تسعير الذروة",
  offPeakTitle: "تسعير خارج الذروة",
  peakDetail: "سعر API الكامل الآن",
  offPeakDetail: "نصف سعر API في الذروة الآن",
  changesAt: "يتغيّر في {time}",
  holiday: "اليوم خارج الذروة بسبب {holiday}.",
  weekend: "تُطبَّق أسعار عطلة نهاية الأسبوع.",
  calendarUnknown: "لم يُنشر تقويم عطلات {year} بعد، لذا تُطبَّق نوافذ أيام الأسبوع فقط.",
  calendarSource: "{source}",
  discount: "السعر خارج الذروة نصف سعر الذروة.",
  zone: "وقتك · {zone}",
  windows: "ساعات الذروة (UTC)",
  weekdays: "الاثنين–الجمعة",
  calendarLabel: "تقويم العطلات",
  billedBy: "يُقدَّم عبر {provider}. هذا السعر هو سعر API الخاص بـ DeepSeek؛ قد تختلف فوترة المسار نفسه.",
  sourceLink: "فتح تسعير DeepSeek",
  detailsTitle: "تسعير DeepSeek API",
  duration: { day: "{n} يوم", hour: "{n} ساعة", minute: "{n} دقيقة", second: "{n} ثانية" },
  settings: {
    page: "تسعير الذروة",
    blurb: "اختر كيف يظهر سعر الوقت من اليوم بجانب النموذج في محرر الرسائل.",
    chipSection: "الشريحة",
    show: "إظهار الشريحة",
    showHint: "إظهار ما إذا كان النموذج المحدد بسعر الذروة أو خارجها.",
    display: "العرض",
    displayHint: "كامل يضيف الوقت المتبقي، ومختصر يحتفظ بالكلمة، ونقطة تحتفظ بنقطة ملوّنة فقط.",
    full: "كامل",
    compact: "مختصر",
    dot: "نقطة فقط",
    detailsSection: "التفاصيل",
    tooltip: "إظهار ملخص عند التمرير",
    tooltipHint: "التمرير فوق الشريحة أو تركيزها يعرض الوقت المتبقي. والنقر يفتح البطاقة الكاملة دائمًا.",
    previewSection: "معاينة",
    previewModel: "DeepSeek V4 Flash",
    hidden: "الشريحة مخفية.",
    noSchedule: "النماذج التي ليس لها سعر منشور بحسب الوقت من اليوم لا تعرض شريحة أبدًا.",
    searchChip: "إظهار أو إخفاء شريحة الذروة وخارج الذروة بجانب النموذج.",
    searchDisplay: "شريحة تسعير الذروة: كاملة أو مختصرة أو نقطة فقط.",
    searchTooltip: "ملخص عند التمرير مع الوقت المتبقي حتى تغيّر السعر.",
    statusbarWidget: "تسعير الذروة",
    statusbarWidgetHint: "الذروة أو خارج الذروة لنموذج الجلسة، مع الوقت المتبقي. مخفي للنماذج التي ليس لها سعر بحسب الوقت من اليوم.",
  },
};

const PT: PeakPricingCopy = {
  chipLabel: "Preços DeepSeek: {state} até {time}",
  peak: "Pico",
  offPeak: "Fora de pico",
  until: "{state} até {time}",
  remaining: "{state} termina dentro de {remaining}",
  peakTitle: "Preços de pico",
  offPeakTitle: "Preços fora de pico",
  peakDetail: "Taxa de API total neste momento",
  offPeakDetail: "Metade da taxa de pico da API neste momento",
  changesAt: "Muda às {time}",
  holiday: "Hoje é fora de pico por causa de {holiday}.",
  weekend: "Aplicam-se as tarifas de fim de semana.",
  calendarUnknown: "O calendário de feriados de {year} ainda não foi publicado, por isso só se aplicam as janelas de dias úteis.",
  calendarSource: "{source}",
  discount: "Fora de pico é metade da taxa de pico.",
  zone: "A sua hora · {zone}",
  windows: "Horas de pico (UTC)",
  weekdays: "Seg–Sex",
  calendarLabel: "Calendário de feriados",
  billedBy: "Servido por {provider}. Este relógio usa o preço da própria API DeepSeek; a rota em si pode faturar de forma diferente.",
  sourceLink: "Abrir preços da DeepSeek",
  detailsTitle: "Preços da API DeepSeek",
  duration: { day: "{n}d", hour: "{n}h", minute: "{n}m", second: "{n}s" },
  settings: {
    page: "Preços de pico",
    blurb: "Escolha como o preço consoante a hora aparece junto ao modelo no compositor.",
    chipSection: "Pastilha",
    show: "Mostrar a pastilha",
    showHint: "Mostrar se o modelo selecionado está em taxa de pico ou fora de pico.",
    display: "Apresentação",
    displayHint: "«Completa» acrescenta o tempo restante, «Compacta» mantém a palavra e «Só ponto» mantém apenas um ponto colorido.",
    full: "Completa",
    compact: "Compacta",
    dot: "Só ponto",
    detailsSection: "Detalhes",
    tooltip: "Mostrar um resumo ao passar o cursor",
    tooltipHint: "Passar o cursor sobre a pastilha ou focá-la mostra o tempo restante. Um clique abre sempre o cartão completo.",
    previewSection: "Pré-visualização",
    previewModel: "DeepSeek V4 Flash",
    hidden: "A pastilha está oculta.",
    noSchedule: "Modelos sem preço publicado por hora nunca mostram pastilha.",
    searchChip: "Mostrar ou ocultar a pastilha de pico e fora de pico junto ao modelo.",
    searchDisplay: "Pastilha de preços de pico completa, compacta ou só ponto.",
    searchTooltip: "Resumo ao passar o cursor com o tempo até o preço mudar.",
    statusbarWidget: "Preços de pico",
    statusbarWidgetHint: "Pico ou fora de pico para o modelo da sessão, com o tempo restante. Oculto nos modelos sem preço por hora.",
  },
};

const CATALOGS: Readonly<Record<string, PeakPricingCopy>> = { en: EN, uk: UK, de: DE, fr: FR, pl: PL, "pt-BR": PT_BR, pt: PT, it: IT, es: ES, "zh-CN": ZH_CN, bg: BG, ar: AR };

export function createPeakPricingCopy(locale: string): PeakPricingCopy {
  const language = locale.split("-")[0]!.toLowerCase();
  return CATALOGS[locale] ?? CATALOGS[language] ?? (language === "zh" ? CATALOGS["zh-CN"]! : EN);
}

/** Fill `{name}` placeholders; unknown names stay visible so a copy bug is
 *  obvious instead of silently blank. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
