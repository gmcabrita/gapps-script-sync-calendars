const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createAppsScriptHarness, createTestSnapshot, TEST_NOW, TEST_SECRET, TEST_KEYWORDS} = require('../test/AppsScriptHarness.cjs');

test('matches either keyword in either field without case sensitivity', () => {
  const {context} = createAppsScriptHarness();
  for (const event of [
    {summary: 'Visit OrChId today'}, {summary: 'TULIP'},
    {description: '<p>Meet at ORCHID</p>'}, {description: 'My Tulip booking'},
    {summary: 'Unrelated', description: 'tulip'},
    {summary: 'orchid suffix'}, {summary: 'pretulippost'},
  ]) assert.equal(context.matchesSourceEvent(event, TEST_KEYWORDS), true);
  for (const event of [{}, {summary: 'Work', description: 'Meeting'},
    {summary: 'Tu lip'}, {summary: null, description: 1},
    {summary: 'orchid', status: 'cancelled'},
  ]) assert.equal(context.matchesSourceEvent(event, TEST_KEYWORDS), false);
});

test('all-day dates are excluded but timed events spanning a full day can match', () => {
  const {context} = createAppsScriptHarness();
  for (const event of [
    {start: {date: '2026-09-08'}, end: {date: '2026-09-09'}},
    {start: {date: '2026-09-08'}, end: {date: '2026-09-11'}},
    {start: {date: '2026-09-08'}}, {end: {date: '2026-09-09'}},
  ]) assert.equal(context.matchesSourceEvent({...event, summary: 'ORCHID'}, TEST_KEYWORDS), false);
  assert.equal(context.matchesSourceEvent({description: 'TULIP',
    start: {dateTime: '2026-09-08T00:00:00Z'}, end: {dateTime: '2026-09-09T00:00:00Z'},
  }, TEST_KEYWORDS), true);
});

test('only the self attendee declining excludes an otherwise matching invitation', () => {
  const {context} = createAppsScriptHarness();
  const matches = (attendees) => context.matchesSourceEvent({summary: 'Orchid', attendees}, TEST_KEYWORDS);
  assert.equal(matches([{self: true, responseStatus: 'declined'}]), false);
  assert.equal(matches([{self: false, responseStatus: 'accepted'},
    {self: true, responseStatus: 'declined'}]), false);
  for (const status of ['accepted', 'tentative', 'needsAction']) {
    assert.equal(matches([{self: true, responseStatus: status},
      {self: false, responseStatus: 'declined'}]), true);
  }
  assert.equal(matches([{responseStatus: 'declined'}]), true);
  assert.equal(matches([]), true);
  assert.equal(matches(undefined), true);
});

test('signatures use HMAC SHA-256 over the exact UTF-8 payload', () => {
  const {context} = createAppsScriptHarness();
  const payload = '{"timeZone":"Europe/Lisbon","text":"é"}';
  const expected = crypto.createHmac('sha256', TEST_SECRET).update(payload).digest('hex');
  assert.equal(context.signSyncPayload(payload, TEST_SECRET), expected);
  assert.equal(context.matchesSyncSignature(expected, expected), true);
  assert.equal(context.matchesSyncSignature('0'.repeat(64), expected), false);
  assert.equal(context.matchesSyncSignature(null, expected), false);
  assert.equal(context.matchesSyncSignature(expected.toUpperCase(), expected), false);
  assert.equal(context.encodeSyncHex([-1, -128, 0, 127]), 'ff80007f');
});

test('accepts a complete empty snapshot and a valid populated snapshot', () => {
  const {context} = createAppsScriptHarness();
  for (const snapshot of [createTestSnapshot(), createTestSnapshot(TEST_NOW, [])]) {
    assert.equal(context.validateSyncSnapshot(snapshot, TEST_NOW), snapshot);
  }
});

test('rejects invalid snapshots before reconciliation', () => {
  const {context} = createAppsScriptHarness();
  const mutations = [
    (s) => { s.version = 2; },
    (s) => { s.title = 'private title'; },
    (s) => { s.sequence -= 600001; },
    (s) => { s.sequence += 600001; },
    (s) => { s.windowStart = s.windowEnd; },
    (s) => { s.windowEnd = '2026-02-31T00:00:00.000Z'; },
    (s) => { s.events = null; },
    (s) => { s.events.push(s.events[0]); },
    (s) => { s.events = Array(501).fill(s.events[0]); },
    (s) => { s.events[0].syncId = 'raw-source-id'; },
    (s) => { s.events[0].description = 'private description'; },
    (s) => { s.events[0].start = null; },
    (s) => { s.events[0].start.timeZone = ''; },
    (s) => { s.events[0].start.dateTime = '2026-09-08T14:00:00'; },
    (s) => { s.events[0].end.dateTime = s.events[0].start.dateTime; },
    (s) => { s.events[0].end.dateTime = s.windowStart; },
    (s) => { s.events[0].start.dateTime = s.windowEnd; },
  ];
  for (const mutate of mutations) {
    const snapshot = createTestSnapshot();
    mutate(snapshot);
    assert.throws(() => context.validateSyncSnapshot(snapshot, TEST_NOW));
  }
});

test('invalid saved sequences stop both accounts without Calendar writes or network requests', () => {
  for (const value of ['bad', '-1', '1.5', 'Infinity', '9007199254740992']) {
    const harness = createAppsScriptHarness();
    harness.saved.SOURCE_LAST_SEQUENCE = value;
    harness.saved.DESTINATION_LAST_SEQUENCE = value;
    assert.throws(() => harness.context.syncSourceCalendar(), /saved sequence invalid/);
    assert.throws(() => harness.context.readSyncSequence(harness.properties, 'DESTINATION_LAST_SEQUENCE'),
      /saved sequence invalid/);
    assert.equal(harness.calls.length, 0);
  }
});

test('collects all pages and fails on a repeated page token or API error', () => {
  const {context, calendar} = createAppsScriptHarness();
  calendar.Events.list = (_, options) => options.pageToken
    ? {items: [{id: 'second'}]} : {items: [{id: 'first'}], nextPageToken: 'next'};
  assert.equal(JSON.stringify(context.listSyncCalendarEvents('primary', {})),
    JSON.stringify([{id: 'first'}, {id: 'second'}]));
  calendar.Events.list = () => ({items: [], nextPageToken: 'loop'});
  assert.throws(() => context.listSyncCalendarEvents('primary', {}), /pagination invalid/);
  calendar.Events.list = (_, options) => {
    if (options.pageToken) throw new Error('Quota exceeded');
    return {items: [{id: 'first'}], nextPageToken: 'next'};
  };
  assert.throws(() => context.listSyncCalendarEvents('primary', {}), /Quota exceeded/);
});
