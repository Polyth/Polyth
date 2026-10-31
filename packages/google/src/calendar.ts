// Google Calendar v3: normalized reads, validated writes, and free-time search.
// Time handling never guesses a zone: offset-less input without an IANA zone is
// rejected, and working-hours windows are computed in the caller's zone.

import { randomBytes } from "node:crypto";
import { googleError, GoogleError } from "./http.ts";
import type { GoogleClient } from "./http.ts";

const BASE = "https://www.googleapis.com/calendar/v3";
const MAX_CALENDARS = 1000;
const MAX_FREE_TIME_RANGE_MS = 62 * 24 * 60 * 60 * 1000;

export type EventTime = { date: string } | { dateTime: string; timeZone?: string };
export type SendUpdates = "all" | "externalOnly" | "none";

export interface EventInput {
  summary?: string;
  description?: string;
  location?: string;
  start: EventTime;
  /** All-day `date` ends are EXCLUSIVE: a one-day event on 2026-10-06 ends 2026-10-07. */
  end: EventTime;
  attendees?: Array<{ email: string; optional?: boolean }>;
  recurrence?: string[];
  visibility?: "default" | "public" | "private" | "confidential";
  transparency?: "opaque" | "transparent";
  reminders?: { useDefault: boolean; overrides?: Array<{ method: "email" | "popup"; minutes: number }> };
  colorId?: string;
}

export interface CalendarSummary {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
  timeZone?: string;
  description?: string;
  selected: boolean;
}

export interface CalendarAttendee {
  email: string;
  name?: string;
  responseStatus: string;
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  status: string;
  summary?: string;
  description?: string;
  location?: string;
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  recurrence?: string[];
  recurringEventId?: string;
  organizer?: { email?: string; name?: string; self?: boolean };
  attendees: CalendarAttendee[];
  selfResponse?: string;
  htmlLink?: string;
  meetLink?: string;
  created?: string;
  updated?: string;
  transparency?: string;
  visibility?: string;
  eventType?: string;
  etag?: string;
}

export interface BusyInterval { start: string; end: string }
export interface FreeBusyResult {
  timeMin: string;
  timeMax: string;
  calendars: Record<string, { busy: BusyInterval[]; errors?: string[] }>;
}

export interface ListEventsInput {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  query?: string;
  maxResults?: number;
  pageToken?: string;
  timeZone?: string;
  showDeleted?: boolean;
  signal?: AbortSignal;
}

export interface FindFreeTimeInput {
  timeMin: string;
  timeMax: string;
  durationMinutes: number;
  calendars?: string[];
  timeZone?: string;
  workingHours?: { start: string; end: string; days?: number[] };
  maxSlots?: number;
  signal?: AbortSignal;
}

export interface CalendarService {
  listCalendars(opts?: { signal?: AbortSignal }): Promise<CalendarSummary[]>;
  listEvents(input: ListEventsInput): Promise<{ events: CalendarEvent[]; nextPageToken?: string; timeZone?: string }>;
  getEvent(calendarId: string, eventId: string, opts?: { timeZone?: string; signal?: AbortSignal }): Promise<CalendarEvent>;
  createEvent(input: { calendarId?: string; event: EventInput; sendUpdates?: SendUpdates; addMeet?: boolean; signal?: AbortSignal }): Promise<CalendarEvent>;
  updateEvent(input: {
    calendarId?: string;
    eventId: string;
    patch: Partial<EventInput>;
    addAttendees?: Array<{ email: string; optional?: boolean }>;
    removeAttendees?: string[];
    sendUpdates?: SendUpdates;
    signal?: AbortSignal;
  }): Promise<CalendarEvent>;
  deleteEvent(input: { calendarId?: string; eventId: string; sendUpdates?: SendUpdates; signal?: AbortSignal }): Promise<{ deleted: true; alreadyGone: boolean }>;
  respond(input: {
    calendarId?: string;
    eventId: string;
    response: "accepted" | "declined" | "tentative";
    comment?: string;
    sendUpdates?: SendUpdates;
    signal?: AbortSignal;
  }): Promise<CalendarEvent>;
  freeBusy(input: { timeMin: string; timeMax: string; calendars?: string[]; timeZone?: string; signal?: AbortSignal }): Promise<FreeBusyResult>;
  findFreeTime(input: FindFreeTimeInput): Promise<{ timeZone?: string; slots: BusyInterval[]; calendarErrors?: Record<string, string[]>; complete?: false; warning?: string }>;
}

// ---------------------------------------------------------------- time helpers

const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function assertZone(timeZone: string, label = "timeZone"): void {
  if (typeof timeZone !== "string" || !timeZone) return googleError("invalid-request", `${label} must be an IANA time zone name such as "Europe/Kyiv".`);
  try {
    zoneFormatter(timeZone);
  } catch {
    return googleError("invalid-request", `${label} "${timeZone}" is not a valid IANA time zone name (for example "Europe/Kyiv").`);
  }
}

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

interface WallParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zonedParts(ms: number, timeZone: string): WallParts {
  const values: Record<string, number> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year!, month: values.month!, day: values.day!,
    hour: (values.hour ?? 0) % 24, minute: values.minute ?? 0, second: values.second ?? 0,
  };
}

function offsetMinutes(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Wall-clock time in an IANA zone → instant. Re-checks the offset at the
 * candidate instant so the result is right on either side of a DST change. */
function wallToInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMinutes(guess, timeZone) * 60000;
  return guess - offsetMinutes(first, timeZone) * 60000;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

function formatInstant(ms: number, timeZone: string | undefined): string {
  if (!timeZone) return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const offset = offsetMinutes(ms, timeZone);
  const p = zonedParts(ms, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function assertRfc3339(value: unknown, label: string): number {
  const text = typeof value === "string" ? value : "";
  const ms = RFC3339_WITH_OFFSET.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms)) {
    return googleError("invalid-request", `${label} must be an RFC 3339 timestamp with an explicit offset or Z, for example 2026-10-06T09:00:00+03:00 or 2026-10-06T06:00:00Z (got ${JSON.stringify(value)}). Polyth does not guess a time zone.`);
  }
  return ms;
}

function assertRange(timeMin: string, timeMax: string): { min: number; max: number } {
  const min = assertRfc3339(timeMin, "timeMin");
  const max = assertRfc3339(timeMax, "timeMax");
  if (max <= min) return googleError("invalid-request", "timeMax must be later than timeMin.");
  return { min, max };
}

function validDate(text: string): { year: number; month: number; day: number } | undefined {
  const match = DATE_ONLY.exec(text);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? { year, month, day } : undefined;
}

function validateTime(time: EventTime, label: string): void {
  const raw = time as { date?: unknown; dateTime?: unknown; timeZone?: unknown };
  if (raw.date !== undefined && raw.dateTime !== undefined) return googleError("invalid-request", `${label} must have either date (all-day) or dateTime, not both.`);
  if (raw.date !== undefined) {
    if (typeof raw.date !== "string" || !validDate(raw.date)) return googleError("invalid-request", `${label}.date must be a real calendar date in YYYY-MM-DD form.`);
    return;
  }
  if (typeof raw.dateTime !== "string") return googleError("invalid-request", `${label} needs date (YYYY-MM-DD, all-day) or dateTime.`);
  const match = LOCAL_DATE_TIME.exec(raw.dateTime);
  if (!match || !validDate(`${match[1]}-${match[2]}-${match[3]}`) || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) {
    return googleError("invalid-request", `${label}.dateTime must look like 2026-10-06T09:00:00+03:00 or 2026-10-06T09:00:00 with a timeZone.`);
  }
  if (raw.timeZone !== undefined) assertZone(raw.timeZone as string, `${label}.timeZone`);
  if (!match[7] && raw.timeZone === undefined) {
    return googleError("invalid-request", `${label}.dateTime has no UTC offset, so ${label}.timeZone (an IANA name such as "Europe/Kyiv") is required. Polyth does not assign a time zone for you.`);
  }
}

function instantOf(time: { dateTime: string; timeZone?: string }): number {
  const match = LOCAL_DATE_TIME.exec(time.dateTime)!;
  if (match[7]) return Date.parse(time.dateTime);
  return wallToInstant(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), time.timeZone!) + Number(match[6] ?? 0) * 1000;
}

function validatePair(start: EventTime, end: EventTime): void {
  validateTime(start, "start");
  validateTime(end, "end");
  const allDayStart = "date" in start;
  if (allDayStart !== "date" in end) return googleError("invalid-request", "start and end must both be all-day dates or both be dateTime values.");
  if (allDayStart) {
    if ((end as { date: string }).date <= (start as { date: string }).date) {
      return googleError("invalid-request", "For all-day events end.date is exclusive and must be after start.date (a one-day event on 2026-10-06 ends 2026-10-07).");
    }
    return;
  }
  if (instantOf(end as { dateTime: string; timeZone?: string }) <= instantOf(start as { dateTime: string; timeZone?: string })) {
    return googleError("invalid-request", "end must be later than start.");
  }
}

// ---------------------------------------------------------------- event input

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const RECURRENCE_PREFIX = /^(RRULE|EXRULE|RDATE|EXDATE)[:;]/;

function assertEmail(email: unknown): string {
  if (typeof email !== "string" || !EMAIL.test(email.trim())) return googleError("invalid-request", `"${String(email)}" is not a valid email address.`);
  return email.trim();
}

function validateEventFields(event: Partial<EventInput>): void {
  if (event.summary !== undefined && (typeof event.summary !== "string" || /[\r\n]/.test(event.summary))) {
    return googleError("invalid-request", "summary must be a single line of text without line breaks.");
  }
  for (const key of ["description", "location", "colorId"] as const) {
    if (event[key] !== undefined && typeof event[key] !== "string") return googleError("invalid-request", `${key} must be a string.`);
  }
  if (event.visibility !== undefined && !["default", "public", "private", "confidential"].includes(event.visibility)) {
    return googleError("invalid-request", "visibility must be default, public, private or confidential.");
  }
  if (event.transparency !== undefined && !["opaque", "transparent"].includes(event.transparency)) {
    return googleError("invalid-request", "transparency must be opaque or transparent.");
  }
  for (const attendee of event.attendees ?? []) assertEmail(attendee?.email);
  if (event.reminders) {
    const overrides = event.reminders.overrides ?? [];
    if (typeof event.reminders.useDefault !== "boolean" || overrides.length > 5) return googleError("invalid-request", "reminders needs useDefault and at most 5 overrides.");
    for (const item of overrides) {
      if (!["email", "popup"].includes(item.method) || !Number.isInteger(item.minutes) || item.minutes < 0 || item.minutes > 40320) {
        return googleError("invalid-request", "Each reminder override needs method email|popup and whole minutes between 0 and 40320.");
      }
    }
  }
  if (event.recurrence !== undefined) {
    if (!Array.isArray(event.recurrence) || !event.recurrence.length || event.recurrence.some((line) => typeof line !== "string" || !RECURRENCE_PREFIX.test(line))) {
      return googleError("invalid-request", "recurrence lines must start with RRULE:, EXRULE:, RDATE: or EXDATE: (no DTSTART/DTEND).");
    }
    const start = event.start as { dateTime?: string; timeZone?: string } | undefined;
    if (start && start.dateTime !== undefined && !start.timeZone) {
      return googleError("invalid-request", "A recurring timed event needs start.timeZone (IANA name); Google expands the recurrence in that zone.");
    }
  }
}

function eventBody(event: Partial<EventInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ["summary", "description", "location", "start", "end", "recurrence", "visibility", "transparency", "reminders", "colorId"] as const) {
    if (event[key] !== undefined) body[key] = event[key];
  }
  if (event.attendees !== undefined) body.attendees = event.attendees.map(wireAttendee);
  return body;
}

const wireAttendee = (a: { email: string; optional?: boolean }): Record<string, unknown> =>
  ({ email: assertEmail(a.email), ...(a.optional !== undefined ? { optional: a.optional } : {}) });

// ---------------------------------------------------------------- normalization

interface RawEvent {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<Record<string, unknown> & { email?: string; displayName?: string; responseStatus?: string; optional?: boolean; organizer?: boolean; self?: boolean; resource?: boolean }>;
  attendeesOmitted?: boolean;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }>; createRequest?: { status?: { statusCode?: string } } };
  created?: string;
  updated?: string;
  transparency?: string;
  visibility?: string;
  eventType?: string;
}

function normalizeTime(time: RawEvent["start"]): EventTime {
  if (time?.date !== undefined) return { date: time.date };
  return { dateTime: time?.dateTime ?? "", ...(time?.timeZone ? { timeZone: time.timeZone } : {}) };
}

function normalizeEvent(raw: RawEvent, calendarId: string): CalendarEvent {
  const attendees: CalendarAttendee[] = (raw.attendees ?? []).map((a) => ({
    email: a.email ?? "",
    ...(a.displayName ? { name: a.displayName } : {}),
    responseStatus: a.responseStatus ?? "needsAction",
    ...(a.optional ? { optional: true } : {}),
    ...(a.organizer ? { organizer: true } : {}),
    ...(a.self ? { self: true } : {}),
    ...(a.resource ? { resource: true } : {}),
  }));
  const self = attendees.find((a) => a.self);
  const meetLink = raw.hangoutLink ?? raw.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  const start = normalizeTime(raw.start);
  return {
    id: raw.id ?? "",
    calendarId,
    status: raw.status ?? "confirmed",
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.location !== undefined ? { location: raw.location } : {}),
    start,
    end: normalizeTime(raw.end),
    allDay: "date" in start,
    ...(raw.recurrence ? { recurrence: raw.recurrence } : {}),
    ...(raw.recurringEventId ? { recurringEventId: raw.recurringEventId } : {}),
    ...(raw.organizer ? {
      organizer: {
        ...(raw.organizer.email ? { email: raw.organizer.email } : {}),
        ...(raw.organizer.displayName ? { name: raw.organizer.displayName } : {}),
        ...(raw.organizer.self ? { self: true } : {}),
      },
    } : {}),
    attendees,
    ...(self ? { selfResponse: self.responseStatus } : {}),
    ...(raw.htmlLink ? { htmlLink: raw.htmlLink } : {}),
    ...(meetLink ? { meetLink } : {}),
    ...(raw.created ? { created: raw.created } : {}),
    ...(raw.updated ? { updated: raw.updated } : {}),
    ...(raw.transparency ? { transparency: raw.transparency } : {}),
    ...(raw.visibility ? { visibility: raw.visibility } : {}),
    ...(raw.eventType ? { eventType: raw.eventType } : {}),
    ...(raw.etag ? { etag: raw.etag } : {}),
  };
}

// ---------------------------------------------------------------- free-time math

type Interval = [number, number];

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function parseClock(text: unknown, label: string, allow24: boolean): number {
  const match = typeof text === "string" ? /^(\d{2}):(\d{2})$/.exec(text) : null;
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
  if (!match || Number(match[2]) > 59 || !(minutes < 1440 || (allow24 && minutes === 1440))) {
    return googleError("invalid-request", `${label} must be a 24-hour HH:MM time${allow24 ? " (24:00 allowed)" : ""}.`);
  }
  return minutes;
}

function workingWindows(min: number, max: number, timeZone: string, hours: NonNullable<FindFreeTimeInput["workingHours"]>): Interval[] {
  const startMin = parseClock(hours.start, "workingHours.start", false);
  const endMin = parseClock(hours.end, "workingHours.end", true);
  if (endMin <= startMin) return googleError("invalid-request", "workingHours.end must be later than workingHours.start.");
  const days = hours.days ?? [1, 2, 3, 4, 5];
  if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return googleError("invalid-request", "workingHours.days must be weekday numbers 0 (Sunday) to 6 (Saturday).");
  }
  const first = zonedParts(min, timeZone);
  const last = zonedParts(max, timeZone);
  const lastDay = Date.UTC(last.year, last.month - 1, last.day);
  const windows: Interval[] = [];
  for (let day = Date.UTC(first.year, first.month - 1, first.day); day <= lastDay; day += 86_400_000) {
    const date = new Date(day);
    if (!days.includes(date.getUTCDay())) continue;
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const from = Math.max(min, wallToInstant(y, m, d, Math.floor(startMin / 60), startMin % 60, timeZone));
    const to = Math.min(max, wallToInstant(y, m, d, Math.floor(endMin / 60), endMin % 60, timeZone));
    if (to > from) windows.push([from, to]);
  }
  return windows;
}

// ---------------------------------------------------------------- service

const sig = (signal: AbortSignal | undefined): { signal?: AbortSignal } => signal ? { signal } : {};
const enc = encodeURIComponent;

export function createCalendarService(client: GoogleClient): CalendarService {
  // "." and ".." survive encodeURIComponent and URL normalization would turn
  // them into a different API path.
  const segment = (id: string, label: string): string => {
    if (typeof id !== "string" || !id || id === "." || id === "..") return googleError("invalid-request", `${label} is required.`);
    return enc(id);
  };

  const eventUrl = (calendarId: string | undefined, eventId?: string): string =>
    `${BASE}/calendars/${segment(calendarId ?? "primary", "calendarId")}/events${eventId !== undefined ? `/${segment(eventId, "eventId")}` : ""}`;

  const fetchRaw = (calendarId: string, eventId: string, extra: { timeZone?: string; signal?: AbortSignal } = {}): Promise<RawEvent> =>
    client.json<RawEvent>({
      url: eventUrl(calendarId, eventId),
      query: { ...(extra.timeZone ? { timeZone: extra.timeZone } : {}) },
      ...sig(extra.signal),
    });

  const patchRaw = (calendarId: string, eventId: string, body: Record<string, unknown>, sendUpdates: SendUpdates, signal?: AbortSignal): Promise<RawEvent> =>
    client.json<RawEvent>({ method: "PATCH", url: eventUrl(calendarId, eventId), query: { sendUpdates }, json: body, ...sig(signal) });

  const service: CalendarService = {
    async listCalendars(opts = {}) {
      const out: CalendarSummary[] = [];
      let pageToken: string | undefined;
      do {
        const page = await client.json<{ nextPageToken?: string; items?: Array<Record<string, unknown>> }>({
          url: `${BASE}/users/me/calendarList`,
          query: {
            maxResults: 250,
            ...(pageToken ? { pageToken } : {}),
            fields: "nextPageToken,items(id,summary,summaryOverride,description,primary,accessRole,timeZone,selected)",
          },
          ...sig(opts.signal),
        });
        for (const item of page.items ?? []) {
          out.push({
            id: String(item.id ?? ""),
            summary: String(item.summaryOverride ?? item.summary ?? item.id ?? ""),
            primary: item.primary === true,
            accessRole: String(item.accessRole ?? ""),
            ...(typeof item.timeZone === "string" ? { timeZone: item.timeZone } : {}),
            ...(typeof item.description === "string" ? { description: item.description } : {}),
            selected: item.selected === true,
          });
          if (out.length >= MAX_CALENDARS) return out;
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },

    async listEvents(input) {
      const calendarId = input.calendarId ?? "primary";
      let min: number | undefined;
      let max: number | undefined;
      if (input.timeMin !== undefined) min = assertRfc3339(input.timeMin, "timeMin");
      if (input.timeMax !== undefined) max = assertRfc3339(input.timeMax, "timeMax");
      if (min !== undefined && max !== undefined && max <= min) return googleError("invalid-request", "timeMax must be later than timeMin.");
      if (input.timeZone) assertZone(input.timeZone);
      const requested = Number.isFinite(input.maxResults) ? Math.trunc(input.maxResults!) : 50;
      const page = await client.json<{ items?: RawEvent[]; nextPageToken?: string; timeZone?: string }>({
        url: eventUrl(calendarId),
        query: {
          singleEvents: true,
          orderBy: "startTime",
          maxResults: Math.min(250, Math.max(1, requested)),
          ...(input.timeMin ? { timeMin: input.timeMin } : {}),
          ...(input.timeMax ? { timeMax: input.timeMax } : {}),
          ...(input.query ? { q: input.query } : {}),
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
          ...(input.timeZone ? { timeZone: input.timeZone } : {}),
          ...(input.showDeleted ? { showDeleted: true } : {}),
        },
        ...sig(input.signal),
      });
      return {
        events: (page.items ?? []).map((item) => normalizeEvent(item, calendarId)),
        ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
        ...(page.timeZone ? { timeZone: page.timeZone } : {}),
      };
    },

    async getEvent(calendarId, eventId, opts = {}) {
      if (opts.timeZone) assertZone(opts.timeZone);
      return normalizeEvent(await fetchRaw(calendarId || "primary", eventId, opts), calendarId || "primary");
    },

    async createEvent(input) {
      const calendarId = input.calendarId ?? "primary";
      validatePair(input.event.start, input.event.end);
      validateEventFields(input.event);
      const body = eventBody(input.event);
      // A client-chosen id makes an uncertain insert checkable: a retry with the
      // same id fails with a conflict instead of creating a duplicate.
      const eventId = randomBytes(16).toString("hex");
      body.id = eventId;
      if (input.addMeet) {
        body.conferenceData = {
          createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
        };
      }
      let created: RawEvent;
      try {
        created = await client.json<RawEvent>({
          method: "POST",
          url: eventUrl(calendarId),
          query: { sendUpdates: input.sendUpdates ?? "none", ...(input.addMeet ? { conferenceDataVersion: 1 } : {}) },
          json: body,
          ...sig(input.signal),
        });
      } catch (error) {
        if (error instanceof GoogleError && error.code === "mutation-outcome-unknown") {
          return googleError("mutation-outcome-unknown", `${error.message} The event id is ${eventId}; get it before creating it again.`, { ...(error.status !== undefined ? { status: error.status } : {}) });
        }
        throw error;
      }
      // Meet creation can still be pending in the insert response.
      if (input.addMeet && created.id && !created.hangoutLink && created.conferenceData?.createRequest?.status?.statusCode === "pending") {
        try {
          created = await fetchRaw(calendarId, created.id, sig(input.signal));
        } catch (error) {
          if (!(error instanceof GoogleError)) throw error;
        }
      }
      return normalizeEvent(created, calendarId);
    },

    async updateEvent(input) {
      const calendarId = input.calendarId ?? "primary";
      const { patch } = input;
      if (patch.start && patch.end) validatePair(patch.start, patch.end);
      else if (patch.start) validateTime(patch.start, "start");
      else if (patch.end) validateTime(patch.end, "end");
      validateEventFields(patch);
      const body = eventBody(patch);
      const adding = input.addAttendees ?? [];
      const removing = (input.removeAttendees ?? []).map((email) => assertEmail(email).toLowerCase());
      if (!adding.length && !removing.length && !Object.keys(body).length) {
        return googleError("invalid-request", "Nothing to update: give at least one field to change or attendees to add or remove.");
      }
      if (adding.length || removing.length) {
        // Arrays replace wholesale on PATCH, so send the full merged list.
        const base: Array<Record<string, unknown> & { email?: string }> = patch.attendees !== undefined
          ? (body.attendees as Array<Record<string, unknown> & { email?: string }>)
          : [...((await fetchRaw(calendarId, input.eventId, sig(input.signal))).attendees ?? [])];
        const merged = base.filter((a) => !removing.includes((a.email ?? "").toLowerCase()));
        for (const add of adding) {
          const wire = wireAttendee(add);
          const index = merged.findIndex((a) => (a.email ?? "").toLowerCase() === (wire.email as string).toLowerCase());
          if (index < 0) merged.push(wire);
          else if (add.optional !== undefined) merged[index] = { ...merged[index]!, optional: add.optional };
        }
        body.attendees = merged;
      }
      return normalizeEvent(await patchRaw(calendarId, input.eventId, body, input.sendUpdates ?? "none", input.signal), calendarId);
    },

    async deleteEvent(input) {
      const calendarId = input.calendarId ?? "primary";
      try {
        await client.json<unknown>({ method: "DELETE", url: eventUrl(calendarId, input.eventId), query: { sendUpdates: input.sendUpdates ?? "none" }, ...sig(input.signal) });
      } catch (error) {
        // 410 means the event was already deleted; a 404 is a wrong id or calendar and must surface.
        if (error instanceof GoogleError && error.code === "not-found" && error.status === 410) return { deleted: true, alreadyGone: true };
        throw error;
      }
      return { deleted: true, alreadyGone: false };
    },

    async respond(input) {
      const calendarId = input.calendarId ?? "primary";
      if (!["accepted", "declined", "tentative"].includes(input.response)) {
        return googleError("invalid-request", "response must be accepted, declined or tentative.");
      }
      const raw = await fetchRaw(calendarId, input.eventId, sig(input.signal));
      // PATCH replaces the whole list; a partial view would drop hidden guests.
      if (raw.attendeesOmitted) {
        return googleError("invalid-request", "Google returned only part of this event's guest list, so the response cannot be changed safely here. Respond in Google Calendar.");
      }
      const attendees = raw.attendees ?? [];
      if (!attendees.some((a) => a.self)) {
        return googleError("invalid-request", "You are not an attendee of this event, so there is no response to change.");
      }
      const next = attendees.map((a) => a.self
        ? { ...a, responseStatus: input.response, ...(input.comment !== undefined ? { comment: input.comment } : {}) }
        : a);
      return normalizeEvent(await patchRaw(calendarId, input.eventId, { attendees: next }, input.sendUpdates ?? "all", input.signal), calendarId);
    },

    async freeBusy(input) {
      assertRange(input.timeMin, input.timeMax);
      if (input.timeZone) assertZone(input.timeZone);
      const ids = [...new Set(input.calendars?.length ? input.calendars : ["primary"])];
      if (ids.length > 50) return googleError("invalid-request", "freeBusy accepts at most 50 calendars per query.");
      const response = await client.json<{
        timeMin?: string;
        timeMax?: string;
        calendars?: Record<string, { busy?: BusyInterval[]; errors?: Array<{ domain?: string; reason?: string }> }>;
      }>({
        method: "POST",
        url: `${BASE}/freeBusy`,
        json: { timeMin: input.timeMin, timeMax: input.timeMax, ...(input.timeZone ? { timeZone: input.timeZone } : {}), items: ids.map((id) => ({ id })) },
        idempotent: true,
        ...sig(input.signal),
      });
      const calendars: FreeBusyResult["calendars"] = {};
      for (const id of ids) {
        const entry = response?.calendars?.[id];
        const errors = (entry?.errors ?? []).map((e) => e.reason ?? e.domain ?? "unknown");
        calendars[id] = {
          busy: (entry?.busy ?? []).map((b) => ({ start: b.start, end: b.end })),
          ...(errors.length ? { errors } : {}),
        };
      }
      return { timeMin: response?.timeMin ?? input.timeMin, timeMax: response?.timeMax ?? input.timeMax, calendars };
    },

    async findFreeTime(input) {
      const { min, max } = assertRange(input.timeMin, input.timeMax);
      if (max - min > MAX_FREE_TIME_RANGE_MS) return googleError("invalid-request", "findFreeTime ranges are limited to 62 days; narrow timeMin/timeMax.");
      if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 1440) {
        return googleError("invalid-request", "durationMinutes must be a whole number between 5 and 1440.");
      }
      const maxSlots = input.maxSlots === undefined ? 10 : Math.trunc(input.maxSlots);
      if (!(maxSlots >= 1 && maxSlots <= 50)) return googleError("invalid-request", "maxSlots must be between 1 and 50.");
      if (input.timeZone) assertZone(input.timeZone);
      if (input.workingHours && !input.timeZone) {
        return googleError("invalid-request", "workingHours needs timeZone (an IANA name such as \"Europe/Kyiv\") to know which wall-clock hours you mean.");
      }
      const windows: Interval[] = input.workingHours
        ? workingWindows(min, max, input.timeZone!, input.workingHours)
        : [[min, max]];

      const busyData = await service.freeBusy({
        timeMin: input.timeMin, timeMax: input.timeMax,
        ...(input.calendars ? { calendars: input.calendars } : {}),
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        ...sig(input.signal),
      });
      const busy: Interval[] = [];
      const calendarErrors: Record<string, string[]> = {};
      for (const [id, entry] of Object.entries(busyData.calendars)) {
        if (entry.errors?.length) calendarErrors[id] = entry.errors;
        for (const b of entry.busy) busy.push([Date.parse(b.start), Date.parse(b.end)]);
      }
      const blocked = mergeIntervals(busy.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e)));

      const step = input.durationMinutes * 60000;
      const slots: BusyInterval[] = [];
      outer: for (const [from, to] of windows) {
        let cursor = from;
        for (const [bs, be] of blocked) {
          if (be <= cursor) continue;
          if (bs >= to) break;
          for (; cursor + step <= bs; cursor += step) {
            slots.push({ start: formatInstant(cursor, input.timeZone), end: formatInstant(cursor + step, input.timeZone) });
            if (slots.length >= maxSlots) break outer;
          }
          cursor = Math.max(cursor, be);
        }
        for (; cursor + step <= to; cursor += step) {
          slots.push({ start: formatInstant(cursor, input.timeZone), end: formatInstant(cursor + step, input.timeZone) });
          if (slots.length >= maxSlots) break outer;
        }
      }
      const failed = Object.keys(calendarErrors);
      return {
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        slots,
        ...(failed.length ? {
          calendarErrors,
          complete: false as const,
          warning: `Free/busy is unavailable for ${failed.join(", ")}; these slots ignore those calendars.`,
        } : {}),
      };
    },
  };
  return service;
}
