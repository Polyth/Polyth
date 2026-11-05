// How times read on the page: the clock alone for today, with the weekday for
// any other date, always in the plan's own time zone.
import { localParts } from "../src/schedule.ts";

const clock = (locale: string, timeZone: string) =>
  new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });

const weekday = (locale: string, timeZone: string) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", timeZone });

const sameDay = (a: number, b: number, timeZone: string): boolean => {
  const left = localParts(a, timeZone);
  const right = localParts(b, timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
};

export const formatClock = (at: number, locale: string, timeZone: string): string =>
  clock(locale, timeZone).format(at);

export const formatMoment = (at: number, now: number, locale: string, timeZone: string): string =>
  sameDay(at, now, timeZone)
    ? formatClock(at, locale, timeZone)
    : `${weekday(locale, timeZone).format(at)} ${formatClock(at, locale, timeZone)}`;
