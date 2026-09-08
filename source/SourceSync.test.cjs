const test = require('node:test');
const assert = require('node:assert/strict');
const {createAppsScriptHarness, TEST_NOW, TEST_KEYWORDS} = require('../test/AppsScriptHarness.cjs');

function sourceTestEvent(overrides = {}) {
  return {id: 'original-secret-id', summary: 'ORCHID private appointment',
    description: 'Private medical details', location: 'Private address',
    attendees: [{email: 'private@example.com'}], hangoutLink: 'https://private.example.com',
    start: {dateTime: '2026-09-08T10:00:00-04:00'},
    end: {dateTime: '2026-09-08T11:00:00-04:00'}, ...overrides};
}

test('keyword configuration trims whitespace, ignores case, and removes duplicates', () => {
  const {context} = createAppsScriptHarness();
  assert.deepEqual(Array.from(context.parseSourceKeywords('[" Orchid ", "TULIP", "orchid"]')),
    TEST_KEYWORDS);
});

test('missing or invalid keyword configuration stops before calendar reads and requests', () => {
  for (const value of [undefined, '', 'private-invalid-json', 'null', '{}', '[]',
    '"private-value"', '[" "]', '[null]', '[1]', '["private-value", false]']) {
    const harness = createAppsScriptHarness();
    if (value === undefined) delete harness.saved.SOURCE_KEYWORDS;
    else harness.saved.SOURCE_KEYWORDS = value;
    let reads = 0;
    harness.calendar.Calendars.get = () => { reads++; throw new Error('Unexpected calendar read'); };
    assert.throws(() => harness.context.syncSourceCalendar(), (error) => {
      assert.equal(error.message.includes('private-'), false);
      return /Source keywords|SOURCE_KEYWORDS/.test(error.message);
    });
    assert.equal(reads, 0);
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.saved.SOURCE_LAST_SEQUENCE, undefined);
    assert.equal(harness.lock.held, false);
  }
});

test('keyword changes in Script Properties take effect on the next poll without transmission', () => {
  const {context, calendar, calls, saved, logs} = createAppsScriptHarness();
  calendar.Events.list = () => ({items: [sourceTestEvent(),
    sourceTestEvent({id: 'new-selection', summary: 'Private VIOLET appointment'})]});
  context.syncSourceCalendar();
  saved.SOURCE_KEYWORDS = '[" VioLeT "]';
  context.syncSourceCalendar();
  const requests = calls.filter((call) => call.operation === 'fetch').map((call) => call.options.payload);
  const snapshots = requests.map((body) => JSON.parse(JSON.parse(body).payload));
  assert.equal(snapshots[0].events.length, 1);
  assert.equal(snapshots[1].events.length, 1);
  assert.notEqual(snapshots[0].events[0].syncId, snapshots[1].events[0].syncId);
  assert.equal(snapshots[1].events[0].syncId,
    context.signSyncPayload(JSON.stringify(['source@example.com', 'new-selection']), 'i'.repeat(64)));
  for (const keyword of [...TEST_KEYWORDS, 'violet', 'SOURCE_KEYWORDS']) {
    assert.equal(requests.join().toLowerCase().includes(keyword.toLowerCase()), false);
    assert.equal(logs.join().toLowerCase().includes(keyword.toLowerCase()), false);
  }
});

test('source sends only opaque identity and times for matching events', () => {
  const {context, calendar, calls, lock} = createAppsScriptHarness();
  calendar.Events.list = () => ({items: [sourceTestEvent(), sourceTestEvent({id: 'other', summary: 'Work'})]});
  context.syncSourceCalendar();
  const body = calls.find((call) => call.operation === 'fetch').options.payload;
  for (const forbidden of ['ORCHID', 'medical', 'private@example.com', 'original-secret-id',
    'Private address', 'https://private.example.com', 'source@example.com']) {
    assert.equal(body.includes(forbidden), false);
  }
  const snapshot = JSON.parse(JSON.parse(body).payload);
  assert.equal(snapshot.events.length, 1);
  assert.deepEqual(Object.keys(snapshot.events[0]).sort(), ['end', 'start', 'syncId']);
  assert.match(snapshot.events[0].syncId, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.events[0].start.dateTime, '2026-09-08T14:00:00.000Z');
  assert.equal(snapshot.events[0].start.timeZone, 'America/New_York');
  assert.equal(lock.held, false);
});

test('recurring instances use separate stable identities when rescheduled', () => {
  const {context, calendar} = createAppsScriptHarness();
  let sourceEvents = [sourceTestEvent({id: 'series_20260908T140000Z'}),
    sourceTestEvent({id: 'series_20260909T140000Z'})];
  calendar.Events.list = (_, options) => {
    assert.equal(options.singleEvents, true);
    assert.equal(options.showDeleted, false);
    return {items: sourceEvents};
  };
  const snapshot = () => context.buildSourceSnapshot('source@example.com', 'America/New_York', 'secret', TEST_NOW, TEST_KEYWORDS);
  const first = snapshot();
  assert.notEqual(first.events[0].syncId, first.events[1].syncId);
  sourceEvents = [{...sourceEvents[0], start: {dateTime: '2026-09-08T09:00:00-04:00'}}];
  const moved = snapshot();
  assert.equal(moved.events[0].syncId, first.events[0].syncId);
  assert.notEqual(moved.events[0].start.dateTime, first.events[0].start.dateTime);
});

test('source skips matching all-day events and invitations declined by self before serialization', () => {
  const {context, calendar, calls} = createAppsScriptHarness();
  calendar.Events.list = () => ({items: [
    sourceTestEvent({id: 'all-day', start: {date: '2026-09-08'}, end: {date: '2026-09-09'}}),
    sourceTestEvent({id: 'declined', attendees: [{self: true, responseStatus: 'declined'}]}),
    sourceTestEvent({id: 'accepted', attendees: [
      {self: true, responseStatus: 'accepted'}, {self: false, responseStatus: 'declined'},
    ]}),
  ]});
  context.syncSourceCalendar();
  const body = calls.find((call) => call.operation === 'fetch').options.payload;
  const snapshot = JSON.parse(JSON.parse(body).payload);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].syncId,
    context.signSyncPayload(JSON.stringify(['source@example.com', 'accepted']), 'i'.repeat(64)));
  assert.equal(body.includes('declined'), false);
  assert.equal(body.includes('all-day'), false);
});

test('source sends nothing if any source page fails or matching event is invalid', () => {
  for (const failure of ['page', 'event']) {
    const {context, calendar, calls, lock} = createAppsScriptHarness();
    calendar.Events.list = (_, options) => {
      if (failure === 'event') return {items: [sourceTestEvent({start: null})]};
      if (options.pageToken) throw new Error('Quota exceeded');
      return {items: [sourceTestEvent()], nextPageToken: 'next'};
    };
    assert.throws(() => context.syncSourceCalendar());
    assert.equal(calls.some((call) => call.operation === 'fetch'), false);
    assert.equal(lock.held, false);
  }
});

test('source skips overlapping runs and sequences successive snapshots', () => {
  const {context, lock, calls, saved} = createAppsScriptHarness();
  lock.available = false;
  context.syncSourceCalendar();
  assert.equal(calls.length, 0);
  lock.available = true;
  context.syncSourceCalendar();
  context.syncSourceCalendar();
  assert.equal(Number(saved.SOURCE_LAST_SEQUENCE), TEST_NOW + 1);
});

test('source enforces exact millisecond bounds after Calendar truncates query precision', () => {
  const {context, calendar} = createAppsScriptHarness();
  const sequence = TEST_NOW + 500;
  calendar.Events.list = () => ({items: [sourceTestEvent({
    start: {dateTime: new Date(TEST_NOW - 86400000 - 3600000).toISOString()},
    end: {dateTime: new Date(TEST_NOW - 86400000).toISOString()},
  })]});
  const snapshot = context.buildSourceSnapshot('source@example.com', 'UTC', 'secret', sequence, TEST_KEYWORDS);
  assert.equal(snapshot.events.length, 0);
  assert.doesNotThrow(() => context.validateSyncSnapshot(snapshot, sequence));
});

test('source rejects ambiguous local dateTime values', () => {
  const {context} = createAppsScriptHarness();
  assert.throws(() => context.convertSourceBoundary({dateTime: '2026-09-08T10:00:00'},
    'America/New_York'), /explicit UTC offset/);
});

test('trigger installation replaces only this sync function trigger', () => {
  const {context} = createAppsScriptHarness();
  const deleted = [];
  const existing = [
    {getHandlerFunction: () => 'syncSourceCalendar'},
    {getHandlerFunction: () => 'anotherAutomation'},
  ];
  let created = false;
  context.ScriptApp = {
    getProjectTriggers: () => existing,
    deleteTrigger: (trigger) => deleted.push(trigger),
    newTrigger(handler) {
      assert.equal(handler, 'syncSourceCalendar');
      return {timeBased() { return this; }, everyMinutes(minutes) {
        assert.equal(minutes, 5); return this;
      }, create() { created = true; }};
    },
  };
  context.installSourceSyncTrigger();
  assert.deepEqual(deleted, [existing[0]]);
  assert.equal(created, true);
});

test('source and destination complete create, keyword removal, and description-only recreation', () => {
  const source = createAppsScriptHarness();
  const destination = createAppsScriptHarness();
  let event = sourceTestEvent();
  source.calendar.Events.list = () => ({items: [event]});
  source.context.UrlFetchApp.fetch = (_, options) => ({
    getResponseCode: () => 200,
    getContentText: () => destination.context.doPost({postData: {contents: options.payload}}).text,
  });
  const active = () => Array.from(destination.events.values()).filter((copy) => copy.status !== 'cancelled');
  source.context.syncSourceCalendar();
  assert.equal(active().length, 1);
  event = {...event, summary: 'Appointment'};
  source.context.syncSourceCalendar();
  assert.equal(active().length, 0);
  event = {...event, description: 'TULIP'};
  source.context.syncSourceCalendar();
  assert.equal(active().length, 1);
  assert.equal(active()[0].summary, 'Out of office');
});

test('source exclusions remove existing destination copies and accepting again restores a copy', () => {
  for (const excluded of [
    {start: {date: '2026-09-08'}, end: {date: '2026-09-09'}},
    {attendees: [{self: true, responseStatus: 'declined'}]},
  ]) {
    const source = createAppsScriptHarness();
    const destination = createAppsScriptHarness();
    let event = sourceTestEvent();
    source.calendar.Events.list = () => ({items: [event]});
    source.context.UrlFetchApp.fetch = (_, options) => ({
      getResponseCode: () => 200,
      getContentText: () => destination.context.doPost({postData: {contents: options.payload}}).text,
    });
    const active = () => Array.from(destination.events.values()).filter((copy) => copy.status !== 'cancelled');
    source.context.syncSourceCalendar();
    assert.equal(active().length, 1);
    event = sourceTestEvent(excluded);
    source.context.syncSourceCalendar();
    assert.equal(active().length, 0);
    event = sourceTestEvent({attendees: [{self: true, responseStatus: 'accepted'}]});
    source.context.syncSourceCalendar();
    assert.equal(active().length, 1);
  }
});

test('source requires an affirmative JSON acknowledgement for its sequence', () => {
  for (const response of ['<html>Sign in</html>', '{"ok":false}', '{"ok":true,"sequence":1}', 'null']) {
    const {context} = createAppsScriptHarness();
    context.UrlFetchApp.fetch = () => ({getResponseCode: () => 200, getContentText: () => response});
    assert.throws(() => context.syncSourceCalendar(), /Source/);
  }
});

test('source rejects reused secrets and URLs outside the Apps Script deployment endpoint', () => {
  for (const values of [
    {SOURCE_ID_SECRET: 's'.repeat(64)},
    {DESTINATION_WEB_APP_URL: 'https://example.com/collect'},
    {DESTINATION_WEB_APP_URL: 'https://script.google.com/macros/s/deployment/dev'},
  ]) {
    const {context, saved, calls} = createAppsScriptHarness();
    Object.assign(saved, values);
    assert.throws(() => context.syncSourceCalendar());
    assert.equal(calls.some((call) => call.operation === 'fetch'), false);
  }
});
