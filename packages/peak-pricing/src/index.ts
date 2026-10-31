// Time-of-day API pricing for providers that publish peak and off-peak rates.
// Browser-safe and pure: the clock is evaluated from the provider's own UTC
// windows, so the answer never depends on the device's zone or a server call.
export {
  CHINA_HOLIDAY_CALENDARS,
  CHINA_HOLIDAYS_2026,
  type HolidayCalendar,
  type HolidayRange,
} from "./holidays.ts";
export {
  DEEPSEEK_PEAK_WEEKDAYS,
  DEEPSEEK_PEAK_WINDOWS,
  DEEPSEEK_PRICING,
  EN_DURATION_UNITS,
  PRICING_SCHEDULES,
  formatLocalTime,
  formatRemaining,
  priceStateAt,
  pricingRouteFor,
  scheduleForProvider,
  type DurationUnits,
  type PeakWindow,
  type PricePhase,
  type PriceState,
  type PricingRoute,
  type PricingSchedule,
} from "./schedule.ts";
