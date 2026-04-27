import nodeIcal from "node-ical";
import { DateTime } from "luxon";

function toDateTime(value, timezone) {
  if (!value) return null;
  if (DateTime.isDateTime(value)) return value.setZone(timezone);
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: timezone });
  return null;
}

function isAllDayEvent(event) {
  return event.datetype === "date";
}

function eventDurationMs(event) {
  const start = event.start instanceof Date ? event.start.getTime() : null;
  const end = event.end instanceof Date ? event.end.getTime() : null;
  if (start !== null && end !== null && end > start) return end - start;
  return 15 * 60 * 1000;
}

function overlapDays(start, end) {
  const days = [];
  const lastMoment = end > start ? end.minus({ milliseconds: 1 }) : start;
  let cursor = start.startOf("day");
  const limit = lastMoment.startOf("day");
  while (cursor <= limit) {
    days.push(cursor.toISODate());
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

function recurrenceDateKey(date, timezone) {
  if (date instanceof Date) return DateTime.fromJSDate(date, { zone: timezone }).toISODate();
  return "";
}

function buildInstance({ event, source, start, end, timezone, now }) {
  const startDt = toDateTime(start, timezone);
  const endDt = toDateTime(end, timezone) ?? startDt;
  const allDay = isAllDayEvent(event);
  const effectiveEnd = endDt > startDt ? endDt : startDt.plus({ minutes: 15 });

  let status = "upcoming";
  if (allDay) status = "all-day";
  else if (startDt <= now && now < effectiveEnd) status = "now";
  else if (effectiveEnd <= now) status = "past";

  return {
    id: `${source.id}:${event.uid || "event"}:${startDt.toISO()}`,
    title: String(event.summary || "Untitled"),
    source_id: source.id,
    source: source.name,
    source_index: source.index,
    source_color: source.color,
    all_day: allDay,
    starts_at: startDt.toISO(),
    ends_at: endDt.toISO(),
    start_label: allDay ? "全天" : startDt.toFormat("HH:mm"),
    end_label: allDay || endDt <= startDt ? null : endDt.toFormat("HH:mm"),
    location: event.location?.trim() || null,
    description: event.description?.trim() || null,
    status,
  };
}

function expandRecurringEvent({ event, source, windowStart, windowEnd, timezone, now, overrides }) {
  const occurrences = [];
  if (!event.rrule || !(event.start instanceof Date)) return occurrences;

  const eventStart = toDateTime(event.start, timezone);
  const durationMs = eventDurationMs(event);
  const between = event.rrule.between(windowStart.toJSDate(), windowEnd.toJSDate(), true);
  const exdates = event.exdate ? new Set(Object.keys(event.exdate)) : new Set();

  for (const occurrence of between) {
    const key = recurrenceDateKey(occurrence, timezone);
    if (exdates.has(key)) continue;

    const override = overrides.get(`${source.id}:${event.uid}:${key}`);
    if (override) {
      const overrideEvent = buildSingleEvent({
        event: override,
        source,
        windowStart,
        windowEnd,
        timezone,
        now,
        allowRecurring: false,
      });
      if (overrideEvent) occurrences.push(overrideEvent);
      continue;
    }

    const occurrenceStart = eventStart.set({
      year: occurrence.getFullYear(),
      month: occurrence.getMonth() + 1,
      day: occurrence.getDate(),
    });
    const occurrenceEnd = occurrenceStart.plus({ milliseconds: durationMs });
    if (occurrenceEnd <= windowStart || occurrenceStart >= windowEnd) continue;
    occurrences.push(buildInstance({ event, source, start: occurrenceStart.toJSDate(), end: occurrenceEnd.toJSDate(), timezone, now }));
  }

  return occurrences;
}

function buildSingleEvent({ event, source, windowStart, windowEnd, timezone, now, allowRecurring = true, overrides = new Map() }) {
  if (!event.start) return null;

  if (allowRecurring && event.rrule && !event.recurrenceid) {
    return expandRecurringEvent({ event, source, windowStart, windowEnd, timezone, now, overrides });
  }

  const startDt = toDateTime(event.start, timezone);
  const endDt = toDateTime(event.end, timezone) ?? startDt;
  if (!startDt || endDt <= windowStart || startDt >= windowEnd) return null;
  return buildInstance({ event, source, start: event.start, end: event.end, timezone, now });
}

export function parseCalendarText({
  text,
  source,
  timezone,
  now,
  windowStart,
  windowEnd,
  maxEventsPerDay,
}) {
  const parsed = nodeIcal.sync.parseICS(text);
  const overrides = new Map();
  const dayIndex = new Map();

  for (const value of Object.values(parsed)) {
    if (value?.type === "VEVENT" && value.uid && value.recurrences) {
      for (const [key, override] of Object.entries(value.recurrences)) {
        overrides.set(`${source.id}:${value.uid}:${key}`, override);
      }
    }
  }

  for (const value of Object.values(parsed)) {
    if (value?.type !== "VEVENT" || value.recurrenceid) continue;
    const built = buildSingleEvent({
      event: value,
      source,
      windowStart,
      windowEnd,
      timezone,
      now,
      overrides,
    });
    const items = Array.isArray(built) ? built : built ? [built] : [];

    for (const event of items) {
      const start = DateTime.fromISO(event.starts_at, { zone: timezone });
      const end = DateTime.fromISO(event.ends_at, { zone: timezone });
      for (const dayKey of overlapDays(start, end)) {
        if (!dayIndex.has(dayKey)) dayIndex.set(dayKey, []);
        dayIndex.get(dayKey).push(event);
      }
    }
  }

  for (const [dayKey, events] of dayIndex.entries()) {
    events.sort((a, b) => {
      if (a.all_day && !b.all_day) return -1;
      if (!a.all_day && b.all_day) return 1;
      return a.starts_at.localeCompare(b.starts_at) || a.title.localeCompare(b.title);
    });
    dayIndex.set(dayKey, events.slice(0, maxEventsPerDay));
  }

  return dayIndex;
}
