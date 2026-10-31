import assert from "node:assert/strict";
import { test } from "node:test";
import { createCalendarService } from "../src/calendar.ts";
import { createGoogleClient, GoogleError } from "../src/http.ts";

interface Call { method: string; url: URL; body: any; headers: Record<string, string> }
type Handler = (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> };

function setup(handlers: Handler[] | Handler) {
  const calls: Call[] = [];
  const queue = Array.isArray(handlers) ? [...handlers] : undefined;
  const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(url),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: init.headers as Record<string, string>,
    };
    calls.push(call);
    const handler = queue ? queue.shift() : (handlers as Handler);
    assert.ok(handler, `unexpected request ${call.method} ${call.url}`);
    const out = handler(call);
    const status = out.status ?? 200;
    return new Response(out.body === undefined || status === 204 ? null : JSON.stringify(out.body), { status, headers: out.headers });
  };
  const client = createGoogleClient({ tokens: { accessToken: async () => "test-token" }, fetch: fakeFetch, sleep: async () => {} });
  return { service: createCalendarService(client), calls };
}

const rejects = async (promise: Promise<unknown>, code: string, match?: RegExp) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GoogleError, String(error));
    assert.equal(error.code, code);
    if (match) assert.match(error.message, match);
    return true;
  });
};

const timedEvent = { id: "e1", status: "confirmed", summary: "Sync", start: { dateTime: "2026-10-06T09:00:00+03:00", timeZone: "Europe/Kyiv" }, end: { dateTime: "2026-10-06T10:00:00+03:00" } };

test("normalizes all-day and timed events", async () => {
  const { service } = setup(() => ({
    body: {
      timeZone: "Europe/Kyiv",
      nextPageToken: "next",
      items: [
        timedEvent,
        { id: "e2", summary: "Holiday", start: { date: "2026-10-14" }, end: { date: "2026-10-15" }, hangoutLink: "https://meet.google.com/abc" },
        { id: "e3", start: { dateTime: "2026-10-07T09:00:00Z" }, end: { dateTime: "2026-10-07T10:00:00Z" }, organizer: { email: "o@x.com", displayName: "Org", self: true },
          attendees: [{ email: "a@x.com", displayName: "A", responseStatus: "accepted", organizer: true }, { email: "me@x.com", responseStatus: "tentative", self: true, optional: true }],
          conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:1" }, { entryPointType: "video", uri: "https://meet.google.com/xyz" }] } },
      ],
    },
  }));
  const result = await service.listEvents({});
  const [timed, allDay, rich] = result.events;
  assert.equal(timed!.allDay, false);
  assert.deepEqual(timed!.start, { dateTime: "2026-10-06T09:00:00+03:00", timeZone: "Europe/Kyiv" });
  assert.deepEqual(timed!.attendees, []);
  assert.equal(allDay!.allDay, true);
  assert.deepEqual(allDay!.start, { date: "2026-10-14" });
  assert.equal(allDay!.meetLink, "https://meet.google.com/abc");
  assert.equal(allDay!.calendarId, "primary");
  assert.equal(rich!.meetLink, "https://meet.google.com/xyz");
  assert.equal(rich!.selfResponse, "tentative");
  assert.deepEqual(rich!.organizer, { email: "o@x.com", name: "Org", self: true });
  assert.equal(rich!.attendees[0]!.organizer, true);
  assert.equal(result.nextPageToken, "next");
  assert.equal(result.timeZone, "Europe/Kyiv");
  assert.ok(!("description" in timed!));
});

test("listEvents sends singleEvents/orderBy/timeMin, clamps maxResults, passes the page token", async () => {
  const { service, calls } = setup(() => ({ body: { items: [] } }));
  await service.listEvents({ calendarId: "team@group.calendar.google.com", timeMin: "2026-10-06T00:00:00Z", timeMax: "2026-10-07T00:00:00+03:00", query: "lunch", maxResults: 9999, pageToken: "tok", timeZone: "Europe/Kyiv" });
  const call = calls[0]!;
  assert.equal(call.url.pathname, "/calendar/v3/calendars/team%40group.calendar.google.com/events");
  const q = call.url.searchParams;
  assert.equal(q.get("singleEvents"), "true");
  assert.equal(q.get("orderBy"), "startTime");
  assert.equal(q.get("timeMin"), "2026-10-06T00:00:00Z");
  assert.equal(q.get("maxResults"), "250");
  assert.equal(q.get("pageToken"), "tok");
  assert.equal(q.get("q"), "lunch");
  assert.equal(q.get("timeZone"), "Europe/Kyiv");
  await service.listEvents({});
  assert.equal(calls[1]!.url.searchParams.get("maxResults"), "50");
  assert.equal(calls[1]!.url.pathname, "/calendar/v3/calendars/primary/events");
});

test("listEvents rejects offset-less and inverted ranges", async () => {
  const { service, calls } = setup(() => ({ body: { items: [] } }));
  await rejects(service.listEvents({ timeMin: "2026-10-06T00:00:00" }), "invalid-request", /explicit offset or Z/);
  await rejects(service.listEvents({ timeMin: "2026-10-06" }), "invalid-request");
  await rejects(service.listEvents({ timeMin: "2026-10-06T10:00:00Z", timeMax: "2026-10-06T10:00:00Z" }), "invalid-request", /later than/);
  assert.equal(calls.length, 0);
});

test("listCalendars pages and normalizes", async () => {
  const { service, calls } = setup([
    () => ({ body: { nextPageToken: "p2", items: [{ id: "me@x.com", summary: "Me", primary: true, accessRole: "owner", timeZone: "Europe/Kyiv", selected: true }] } }),
    () => ({ body: { items: [{ id: "c2", summary: "Team", summaryOverride: "My team", accessRole: "reader", description: "d" }] } }),
  ]);
  const list = await service.listCalendars();
  assert.equal(calls[1]!.url.searchParams.get("pageToken"), "p2");
  assert.deepEqual(list, [
    { id: "me@x.com", summary: "Me", primary: true, accessRole: "owner", timeZone: "Europe/Kyiv", selected: true },
    { id: "c2", summary: "My team", primary: false, accessRole: "reader", description: "d", selected: false },
  ]);
});

test("createEvent rejects offset-less dateTime without timeZone and recurrence without timeZone", async () => {
  const { service, calls } = setup(() => ({ body: timedEvent }));
  await rejects(service.createEvent({ event: { summary: "x", start: { dateTime: "2026-10-06T09:00:00" }, end: { dateTime: "2026-10-06T10:00:00" } } }), "invalid-request", /timeZone/);
  await rejects(service.createEvent({
    event: { start: { dateTime: "2026-10-06T09:00:00+03:00" }, end: { dateTime: "2026-10-06T10:00:00+03:00" }, recurrence: ["RRULE:FREQ=WEEKLY"] },
  }), "invalid-request", /start\.timeZone/);
  await rejects(service.createEvent({ event: { start: { date: "2026-10-06" }, end: { date: "2026-10-06" } } }), "invalid-request", /exclusive/);
  await rejects(service.createEvent({ event: { start: { date: "2026-10-06" }, end: { dateTime: "2026-10-07T00:00:00Z" } } }), "invalid-request", /both/);
  await rejects(service.createEvent({ event: { summary: "a\nb", start: { date: "2026-10-06" }, end: { date: "2026-10-07" } } }), "invalid-request", /line/);
  await rejects(service.createEvent({ event: { start: { dateTime: "2026-10-06T09:00:00", timeZone: "Mars/Base" }, end: { dateTime: "2026-10-06T10:00:00", timeZone: "Mars/Base" } } }), "invalid-request", /IANA/);
  await rejects(service.createEvent({ event: { start: { date: "2026-10-06" }, end: { date: "2026-10-07" }, recurrence: ["DTSTART:20261006"] } }), "invalid-request", /RRULE/);
  await rejects(service.createEvent({ event: { start: { date: "2026-10-06" }, end: { date: "2026-10-07" }, attendees: [{ email: "nope" }] } }), "invalid-request", /email/);
  assert.equal(calls.length, 0);
});

test("createEvent defaults sendUpdates=none and requests Meet when asked", async () => {
  const { service, calls } = setup([
    () => ({ body: timedEvent }),
    () => ({ body: { ...timedEvent, hangoutLink: "https://meet.google.com/new" } }),
  ]);
  const event = {
    summary: "Sync",
    start: { dateTime: "2026-10-06T09:00:00", timeZone: "Europe/Kyiv" },
    end: { dateTime: "2026-10-06T10:00:00", timeZone: "Europe/Kyiv" },
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    attendees: [{ email: "a@x.com" }],
  };
  await service.createEvent({ event });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url.searchParams.get("sendUpdates"), "none");
  assert.equal(calls[0]!.url.searchParams.get("conferenceDataVersion"), null);
  assert.equal(calls[0]!.body.conferenceData, undefined);
  assert.deepEqual(calls[0]!.body.attendees, [{ email: "a@x.com" }]);

  const created = await service.createEvent({ event, addMeet: true, sendUpdates: "all" });
  assert.equal(calls[1]!.url.searchParams.get("sendUpdates"), "all");
  assert.equal(calls[1]!.url.searchParams.get("conferenceDataVersion"), "1");
  const request = calls[1]!.body.conferenceData.createRequest;
  assert.equal(request.conferenceSolutionKey.type, "hangoutsMeet");
  assert.match(request.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(created.meetLink, "https://meet.google.com/new");
});

test("updateEvent PATCHes the full merged attendee list", async () => {
  const { service, calls } = setup([
    () => ({ body: { ...timedEvent, attendees: [
      { email: "Keep@x.com", responseStatus: "accepted" },
      { email: "drop@x.com", responseStatus: "needsAction" },
      { email: "me@x.com", responseStatus: "accepted", self: true },
    ] } }),
    () => ({ body: timedEvent }),
  ]);
  await service.updateEvent({
    eventId: "e1",
    patch: { summary: "Renamed" },
    addAttendees: [{ email: "new@x.com", optional: true }, { email: "KEEP@x.com", optional: true }],
    removeAttendees: ["DROP@x.com"],
  });
  assert.equal(calls[0]!.method, "GET");
  const patch = calls[1]!;
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url.pathname, "/calendar/v3/calendars/primary/events/e1");
  assert.equal(patch.url.searchParams.get("sendUpdates"), "none");
  assert.equal(patch.body.summary, "Renamed");
  assert.deepEqual(patch.body.attendees, [
    { email: "Keep@x.com", responseStatus: "accepted", optional: true },
    { email: "me@x.com", responseStatus: "accepted", self: true },
    { email: "new@x.com", optional: true },
  ]);
});

test("updateEvent validates start/end together or individually and refuses empty patches", async () => {
  const { service, calls } = setup(() => ({ body: timedEvent }));
  await rejects(service.updateEvent({ eventId: "e1", patch: {
    start: { dateTime: "2026-10-06T10:00:00+03:00" }, end: { dateTime: "2026-10-06T09:00:00+03:00" },
  } }), "invalid-request", /later than start/);
  await rejects(service.updateEvent({ eventId: "e1", patch: { start: { dateTime: "2026-10-06T10:00:00" } } }), "invalid-request", /timeZone/);
  await rejects(service.updateEvent({ eventId: "e1", patch: {} }), "invalid-request", /Nothing to update/);
  assert.equal(calls.length, 0);
  await service.updateEvent({ eventId: "e1", patch: { end: { dateTime: "2026-10-06T11:00:00+03:00" } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.attendees, undefined);
});

test("deleteEvent: 410 is alreadyGone, 404 propagates as not-found", async () => {
  const { service, calls } = setup([
    () => ({ status: 204 }),
    () => ({ status: 410, body: { error: { code: 410, message: "Resource has been deleted", errors: [{ reason: "deleted" }] } } }),
    () => ({ status: 404, body: { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } } }),
  ]);
  assert.deepEqual(await service.deleteEvent({ eventId: "e1" }), { deleted: true, alreadyGone: false });
  assert.equal(calls[0]!.method, "DELETE");
  assert.equal(calls[0]!.url.searchParams.get("sendUpdates"), "none");
  assert.deepEqual(await service.deleteEvent({ eventId: "e1" }), { deleted: true, alreadyGone: true });
  await rejects(service.deleteEvent({ eventId: "e1" }), "not-found");
});

test("respond changes only the self attendee and keeps the rest", async () => {
  const attendees = [
    { email: "org@x.com", responseStatus: "accepted", organizer: true },
    { email: "me@x.com", responseStatus: "needsAction", self: true },
    { email: "b@x.com", responseStatus: "declined" },
  ];
  const { service, calls } = setup([
    () => ({ body: { ...timedEvent, attendees } }),
    () => ({ body: { ...timedEvent, attendees: [attendees[0], { ...attendees[1], responseStatus: "declined" }, attendees[2]] } }),
    () => ({ body: { ...timedEvent, attendees: [{ email: "org@x.com", responseStatus: "accepted" }] } }),
  ]);
  const result = await service.respond({ eventId: "e1", response: "declined", comment: "Out of office" });
  assert.equal(calls[1]!.method, "PATCH");
  assert.equal(calls[1]!.url.searchParams.get("sendUpdates"), "all");
  assert.deepEqual(Object.keys(calls[1]!.body), ["attendees"]);
  assert.deepEqual(calls[1]!.body.attendees, [
    attendees[0],
    { email: "me@x.com", responseStatus: "declined", self: true, comment: "Out of office" },
    attendees[2],
  ]);
  assert.equal(result.selfResponse, "declined");
  await rejects(service.respond({ eventId: "e1", response: "accepted" }), "invalid-request", /not an attendee/);
  assert.equal(calls.length, 3);
});

test("freeBusy is a POST that retries a 503", async () => {
  const { service, calls } = setup([
    () => ({ status: 503, body: { error: { code: 503, message: "Backend Error", errors: [{ reason: "backendError" }] } } }),
    () => ({ body: { timeMin: "2026-10-06T00:00:00Z", timeMax: "2026-10-07T00:00:00Z", calendars: {
      primary: { busy: [{ start: "2026-10-06T09:00:00Z", end: "2026-10-06T10:00:00Z" }] },
      "x@y.com": { busy: [], errors: [{ domain: "global", reason: "notFound" }] },
    } } }),
  ]);
  const result = await service.freeBusy({ timeMin: "2026-10-06T00:00:00Z", timeMax: "2026-10-07T00:00:00Z", calendars: ["primary", "x@y.com", "primary"] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.method, "POST");
  assert.equal(calls[1]!.url.pathname, "/calendar/v3/freeBusy");
  assert.deepEqual(calls[1]!.body.items, [{ id: "primary" }, { id: "x@y.com" }]);
  assert.deepEqual(result.calendars.primary, { busy: [{ start: "2026-10-06T09:00:00Z", end: "2026-10-06T10:00:00Z" }] });
  assert.deepEqual(result.calendars["x@y.com"], { busy: [], errors: ["notFound"] });
  await rejects(service.freeBusy({ timeMin: "2026-10-06T00:00:00Z", timeMax: "2026-10-07T00:00:00Z", calendars: Array.from({ length: 51 }, (_, i) => `c${i}`) }), "invalid-request", /50/);
});

test("findFreeTime merges busy blocks across calendars and honours Kyiv working hours over the DST change", async () => {
  // 2026-10-25 04:00 EEST → 03:00 EET: Fri 23 is +03:00, Sun 25 is +02:00.
  const { service, calls } = setup(() => ({ body: { calendars: {
    primary: { busy: [{ start: "2026-10-23T06:00:00Z", end: "2026-10-23T07:00:00Z" }] }, // 09:00–10:00 +03:00
    "team@x.com": { busy: [{ start: "2026-10-23T07:00:00Z", end: "2026-10-23T08:00:00Z" }] }, // 10:00–11:00 +03:00
  } } }));
  const result = await service.findFreeTime({
    timeMin: "2026-10-22T21:00:00Z",
    timeMax: "2026-10-26T21:00:00Z",
    durationMinutes: 60,
    calendars: ["primary", "team@x.com"],
    timeZone: "Europe/Kyiv",
    workingHours: { start: "09:00", end: "17:00", days: [5, 0] },
    maxSlots: 50,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.pathname, "/calendar/v3/freeBusy");
  const starts = result.slots.map((s) => s.start);
  assert.equal(starts.length, 6 + 8);
  assert.equal(starts[0], "2026-10-23T11:00:00+03:00");
  assert.equal(starts[5], "2026-10-23T16:00:00+03:00");
  assert.equal(result.slots[5]!.end, "2026-10-23T17:00:00+03:00");
  assert.equal(starts[6], "2026-10-25T09:00:00+02:00");
  assert.equal(result.slots[13]!.end, "2026-10-25T17:00:00+02:00");
  assert.equal(result.timeZone, "Europe/Kyiv");
  const limited = await service.findFreeTime({
    timeMin: "2026-10-22T21:00:00Z", timeMax: "2026-10-26T21:00:00Z", durationMinutes: 120, calendars: ["primary", "team@x.com"],
    timeZone: "Europe/Kyiv", workingHours: { start: "09:00", end: "17:00", days: [5] }, maxSlots: 2,
  });
  assert.deepEqual(limited.slots.map((s) => s.start), ["2026-10-23T11:00:00+03:00", "2026-10-23T13:00:00+03:00"]);
});

test("findFreeTime without a zone returns UTC slots, reports calendar errors, validates inputs", async () => {
  const { service } = setup(() => ({ body: { calendars: { primary: { busy: [{ start: "2026-10-06T10:00:00Z", end: "2026-10-06T10:30:00Z" }], errors: [{ reason: "notFound" }] } } } }));
  const result = await service.findFreeTime({ timeMin: "2026-10-06T09:00:00Z", timeMax: "2026-10-06T11:00:00Z", durationMinutes: 30 });
  assert.deepEqual(result.slots, [
    { start: "2026-10-06T09:00:00Z", end: "2026-10-06T09:30:00Z" },
    { start: "2026-10-06T09:30:00Z", end: "2026-10-06T10:00:00Z" },
    { start: "2026-10-06T10:30:00Z", end: "2026-10-06T11:00:00Z" },
  ]);
  assert.deepEqual(result.calendarErrors, { primary: ["notFound"] });
  const base = { timeMin: "2026-10-06T09:00:00Z", timeMax: "2026-10-06T11:00:00Z", durationMinutes: 30 };
  await rejects(service.findFreeTime({ ...base, timeZone: "Not/AZone" }), "invalid-request", /IANA/);
  await rejects(service.findFreeTime({ ...base, workingHours: { start: "09:00", end: "17:00" } }), "invalid-request", /timeZone/);
  await rejects(service.findFreeTime({ ...base, durationMinutes: 1 }), "invalid-request", /durationMinutes/);
  await rejects(service.findFreeTime({ ...base, timeMax: "2026-12-30T00:00:00Z" }), "invalid-request", /62 days/);
  await rejects(service.findFreeTime({ ...base, timeZone: "Europe/Kyiv", workingHours: { start: "9am", end: "17:00" } }), "invalid-request", /HH:MM/);
});

test("insufficient scope surfaces as insufficient-scope", async () => {
  const { service } = setup(() => ({ status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } } }));
  await rejects(service.listCalendars(), "insufficient-scope");
});
