import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";

import { parseCalendarText } from "../src/features/calendar/parser.js";

const source = {
  id: "1",
  index: 1,
  name: "Main",
  color: "#2563eb",
};

test("parses single timed event into local day buckets", () => {
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:single-1
DTSTAMP:20260427T000000Z
DTSTART:20260427T030000Z
DTEND:20260427T040000Z
SUMMARY:测试
END:VEVENT
END:VCALENDAR`;

  const dayIndex = parseCalendarText({
    text,
    source,
    timezone: "Asia/Shanghai",
    now: DateTime.fromISO("2026-04-27T15:00:00+08:00"),
    windowStart: DateTime.fromISO("2026-04-01T00:00:00+08:00"),
    windowEnd: DateTime.fromISO("2026-05-31T23:59:59+08:00"),
    maxEventsPerDay: 20,
  });

  const events = dayIndex.get("2026-04-27");
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "测试");
  assert.equal(events[0].start_label, "11:00");
  assert.equal(events[0].end_label, "12:00");
});

test("parses all-day multi-day events across each overlapped day", () => {
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:allday-1
DTSTAMP:20260427T000000Z
DTSTART;VALUE=DATE:20260427
DTEND;VALUE=DATE:20260429
SUMMARY:出差
END:VEVENT
END:VCALENDAR`;

  const dayIndex = parseCalendarText({
    text,
    source,
    timezone: "Asia/Shanghai",
    now: DateTime.fromISO("2026-04-27T10:00:00+08:00"),
    windowStart: DateTime.fromISO("2026-04-01T00:00:00+08:00"),
    windowEnd: DateTime.fromISO("2026-05-31T23:59:59+08:00"),
    maxEventsPerDay: 20,
  });

  assert.equal(dayIndex.get("2026-04-27").length, 1);
  assert.equal(dayIndex.get("2026-04-28").length, 1);
  assert.equal(dayIndex.get("2026-04-27")[0].all_day, true);
});

test("handles recurrence, exdate, and recurrence override", () => {
  const text = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:recur-1
DTSTAMP:20260427T000000Z
DTSTART:20260427T030000Z
DTEND:20260427T040000Z
RRULE:FREQ=DAILY;COUNT=3
EXDATE:20260428T030000Z
SUMMARY:晨会
END:VEVENT
BEGIN:VEVENT
UID:recur-1
RECURRENCE-ID:20260429T030000Z
DTSTAMP:20260427T000000Z
DTSTART:20260429T050000Z
DTEND:20260429T060000Z
SUMMARY:改期晨会
END:VEVENT
END:VCALENDAR`;

  const dayIndex = parseCalendarText({
    text,
    source,
    timezone: "Asia/Shanghai",
    now: DateTime.fromISO("2026-04-27T10:00:00+08:00"),
    windowStart: DateTime.fromISO("2026-04-01T00:00:00+08:00"),
    windowEnd: DateTime.fromISO("2026-05-31T23:59:59+08:00"),
    maxEventsPerDay: 20,
  });

  assert.equal(dayIndex.get("2026-04-27").length, 1);
  assert.equal(dayIndex.get("2026-04-28"), undefined);
  assert.equal(dayIndex.get("2026-04-29").length, 1);
  assert.equal(dayIndex.get("2026-04-29")[0].title, "改期晨会");
  assert.equal(dayIndex.get("2026-04-29")[0].start_label, "13:00");
});
