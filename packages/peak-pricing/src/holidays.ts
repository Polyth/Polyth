// China's public-holiday calendar, which DeepSeek excludes from peak pricing
// ("All other hours are off-peak, including weekends and Chinese public
// holidays in full"). Dates are the State Council's published holiday spans
// (放假调休) in Asia/Shanghai. Makeup workdays (调休上班) are deliberately not
// listed: they are weekends, and weekends are already off-peak.
//
// Only a published notice is encoded. The 2026 notice is
// 国办发明电〔2025〕7号 (gov.cn, 2025-11-04). When `to` has passed, the clock
// still runs on weekday windows and the UI says the holiday calendar has not
// been published for that year yet — never a guessed date.

export interface HolidayRange {
  /** Holiday name, English; the details surface shows it as-is. */
  name: string;
  /** Inclusive first and last day, `YYYY-MM-DD` in Asia/Shanghai. */
  from: string;
  to: string;
}

export interface HolidayCalendar {
  /** Inclusive coverage in Asia/Shanghai dates. */
  from: string;
  to: string;
  /** Human-readable provenance shown in the details surface. */
  source: string;
  ranges: readonly HolidayRange[];
}

export const CHINA_HOLIDAYS_2026: HolidayCalendar = {
  from: "2026-01-01",
  to: "2026-12-31",
  source: "State Council notice 国办发明电〔2025〕7号 (2025-11-04)",
  ranges: [
    { name: "New Year's Day", from: "2026-01-01", to: "2026-01-03" },
    { name: "Spring Festival", from: "2026-02-15", to: "2026-02-23" },
    { name: "Qingming Festival", from: "2026-04-04", to: "2026-04-06" },
    { name: "Labour Day", from: "2026-05-01", to: "2026-05-05" },
    { name: "Dragon Boat Festival", from: "2026-06-19", to: "2026-06-21" },
    { name: "Mid-Autumn Festival", from: "2026-09-25", to: "2026-09-27" },
    { name: "National Day", from: "2026-10-01", to: "2026-10-07" },
  ],
};

/** The published calendars, newest last. */
export const CHINA_HOLIDAY_CALENDARS: readonly HolidayCalendar[] = [CHINA_HOLIDAYS_2026];
