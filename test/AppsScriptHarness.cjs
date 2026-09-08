const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const TEST_NOW = Date.parse('2026-09-08T12:00:00.000Z');
const TEST_SYNC_ID = 'a'.repeat(64);
const TEST_SECRET = 's'.repeat(64);
const TEST_KEYWORDS = ['orchid', 'tulip'];

/** Calendar can omit fields whose values equal API defaults. */
function normalizeCalendarResponse(resource) {
  const event = structuredClone(resource);
  if (event.transparency === 'opaque') delete event.transparency;
  if (event.visibility === 'default') delete event.visibility;
  return event;
}

/** Load Apps Script files with in-memory services; no Google account or network is used. */
function createAppsScriptHarness() {
  const saved = {
    SHARED_SECRET: TEST_SECRET,
    SOURCE_ID_SECRET: 'i'.repeat(64),
    SOURCE_KEYWORDS: JSON.stringify(TEST_KEYWORDS),
    DESTINATION_WEB_APP_URL: 'https://script.google.com/macros/s/test-deployment/exec',
  };
  const events = new Map();
  const calls = [];
  const logs = [];
  let now = TEST_NOW;
  let uuid = 0;
  const properties = {
    getProperty: (key) => saved[key] ?? null,
    getProperties: () => ({...saved}),
    setProperty: (key, value) => { saved[key] = value; return properties; },
    deleteProperty: (key) => { delete saved[key]; return properties; },
  };
  const calendar = {
    Calendars: {get: () => ({id: 'source@example.com', timeZone: 'America/New_York'})},
    Events: {
      list(calendarId, options) {
        calls.push({operation: 'list', calendarId, options});
        if (calendarId !== 'primary') return {items: []};
        return {items: Array.from(events.values()).filter((event) =>
          event.status !== 'cancelled' &&
          event.extendedProperties?.private?.syncOwner === 'calendar-ooo-sync-v1' &&
          Date.parse(event.end.dateTime) > Date.parse(options.timeMin)
        ).map((event) => structuredClone(event))};
      },
      get(calendarId, eventId) {
        calls.push({operation: 'get', calendarId, eventId});
        if (!events.has(eventId)) throw Object.assign(new Error('Not Found'), {code: 404});
        return structuredClone(events.get(eventId));
      },
      insert(event, calendarId) {
        calls.push({operation: 'insert', calendarId, event: structuredClone(event)});
        if (events.has(event.id)) throw Object.assign(new Error('Conflict'), {code: 409});
        events.set(event.id, normalizeCalendarResponse({...event, status: 'confirmed'}));
        return structuredClone(events.get(event.id));
      },
      patch(event, calendarId, eventId) {
        calls.push({operation: 'patch', calendarId, eventId, event: structuredClone(event)});
        if (!events.has(eventId)) throw Object.assign(new Error('Not Found'), {code: 404});
        if ('eventType' in event) throw new Error('eventType cannot be patched');
        events.set(eventId, normalizeCalendarResponse({...events.get(eventId), ...event}));
        return structuredClone(events.get(eventId));
      },
      remove(calendarId, eventId) {
        calls.push({operation: 'remove', calendarId, eventId});
        if (!events.has(eventId)) throw Object.assign(new Error('Not Found'), {code: 404});
        events.set(eventId, {...events.get(eventId), status: 'cancelled'});
      },
    },
  };
  const lock = {
    available: true,
    held: false,
    tryLock() { if (!this.available || this.held) return false; this.held = true; return true; },
    releaseLock() { this.held = false; },
  };
  const utilities = {
    Charset: {UTF_8: 'UTF-8'},
    computeHmacSha256Signature: (text, secret) =>
      Array.from(crypto.createHmac('sha256', secret).update(text).digest()),
    getUuid: () => (++uuid).toString(16).padStart(32, '0'),
    formatDate(date, timeZone, format) {
      if (format !== 'yyyy-MM-dd') throw new Error('Unsupported test date format');
      const parts = new Intl.DateTimeFormat('en', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(date);
      const part = (type) => parts.find((p) => p.type === type).value;
      return `${part('year')}-${part('month')}-${part('day')}`;
    },
  };
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    console: {log: (text) => logs.push(text), error: (text) => logs.push(text)},
    Calendar: calendar,
    Utilities: utilities,
    PropertiesService: {getScriptProperties: () => properties},
    LockService: {getScriptLock: () => lock},
    ContentService: {
      MimeType: {JSON: 'application/json'},
      createTextOutput: (text) => ({text, setMimeType() { return this; }}),
    },
    UrlFetchApp: {
      fetch(url, options) {
        calls.push({operation: 'fetch', url, options});
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ok: true,
            sequence: JSON.parse(JSON.parse(options.payload).payload).sequence}),
        };
      },
    },
  });
  for (const file of ['shared/SyncProtocol.gs', 'source/SourceSync.gs',
    'destination/DestinationCalendar.gs', 'destination/DestinationWebhook.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename: file});
  }
  return {context, calendar, events, calls, saved, properties, lock, logs,
    setNow: (value) => { now = value; }};
}

/** Build a complete valid snapshot whose single event falls within the rolling window. */
function createTestSnapshot(sequence = TEST_NOW, events) {
  return {
    version: 1,
    sequence,
    windowStart: new Date(sequence - 86400000).toISOString(),
    windowEnd: new Date(sequence + 90 * 86400000).toISOString(),
    events: events ?? [{syncId: TEST_SYNC_ID,
      start: {dateTime: new Date(TEST_NOW + 3600000).toISOString(), timeZone: 'America/New_York'},
      end: {dateTime: new Date(TEST_NOW + 7200000).toISOString(), timeZone: 'America/New_York'},
    }],
  };
}

/** Sign a web app request using the same exact-string transport as account A. */
function createTestRequest(snapshot, secret = TEST_SECRET) {
  const payload = JSON.stringify(snapshot);
  return {postData: {contents: JSON.stringify({payload,
    signature: crypto.createHmac('sha256', secret).update(payload).digest('hex'),
  })}};
}

module.exports = {createAppsScriptHarness, createTestSnapshot, createTestRequest,
  TEST_NOW, TEST_SYNC_ID, TEST_SECRET, TEST_KEYWORDS};
