const test = require('node:test');
const assert = require('node:assert/strict');
const {createAppsScriptHarness, createTestSnapshot, createTestRequest,
  TEST_NOW, TEST_SYNC_ID} = require('../test/AppsScriptHarness.cjs');

function postSnapshot(harness, snapshot = createTestSnapshot()) {
  return JSON.parse(harness.context.doPost(createTestRequest(snapshot)).text);
}

function activeEvents(harness) {
  return Array.from(harness.events.values()).filter((event) => event.status !== 'cancelled');
}

function calendarWrites(harness) {
  return harness.calls.filter((call) => ['insert', 'patch', 'remove'].includes(call.operation));
}

test('creates genuine public out of office events with the screenshot decline settings', () => {
  const harness = createAppsScriptHarness();
  assert.deepEqual(postSnapshot(harness), {ok: true, sequence: TEST_NOW});
  const [event] = activeEvents(harness);
  assert.equal(event.eventType, 'outOfOffice');
  assert.equal(event.visibility, 'public');
  assert.equal(event.transparency ?? 'opaque', 'opaque');
  assert.equal(calendarWrites(harness)[0].event.transparency, 'opaque');
  assert.equal(event.summary, 'Out of office');
  assert.equal(event.outOfOfficeProperties.autoDeclineMode, 'declineAllConflictingInvitations');
  assert.equal(event.outOfOfficeProperties.declineMessage, 'Declined because I am out of office');
  assert.equal(event.extendedProperties.private.syncId, TEST_SYNC_ID);
  assert.equal(event.description, undefined);
  assert.equal(event.attendees, undefined);
  assert.equal(harness.calls.every((call) => call.calendarId === 'primary'), true);
  assert.equal(harness.lock.held, false);
});

test('unchanged snapshots do not write; moved events update the existing copy', () => {
  const harness = createAppsScriptHarness();
  postSnapshot(harness);
  const originalId = activeEvents(harness)[0].id;
  assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 1)).ok, true);
  assert.equal(calendarWrites(harness).length, 1);
  const moved = createTestSnapshot(TEST_NOW + 2);
  moved.events[0].start.dateTime = '2026-09-08T13:30:00.000Z';
  assert.equal(postSnapshot(harness, moved).ok, true);
  assert.equal(activeEvents(harness).length, 1);
  assert.equal(activeEvents(harness)[0].id, originalId);
  assert.equal(activeEvents(harness)[0].start.dateTime, moved.events[0].start.dateTime);
  assert.equal(calendarWrites(harness).at(-1).operation, 'patch');
});

test('an empty snapshot deletes only managed copies; past history remains', () => {
  const harness = createAppsScriptHarness();
  postSnapshot(harness);
  const managed = activeEvents(harness)[0];
  const pastSyncId = 'b'.repeat(64);
  harness.events.set('past00', {...structuredClone(managed), id: 'past00',
    start: {dateTime: '2026-09-01T13:00:00.000Z', timeZone: 'UTC'},
    end: {dateTime: '2026-09-01T14:00:00.000Z', timeZone: 'UTC'},
    extendedProperties: {private: {syncOwner: 'calendar-ooo-sync-v1', syncId: pastSyncId}},
  });
  harness.saved['SYNC_EVENT_' + pastSyncId] = 'past00';
  harness.events.set('unrelated', {id: 'unrelated', summary: 'Private work meeting',
    end: {dateTime: '2026-09-08T14:00:00.000Z'}});
  assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 1, [])).ok, true);
  assert.equal(harness.events.get(managed.id).status, 'cancelled');
  assert.notEqual(harness.events.get('past00').status, 'cancelled');
  assert.notEqual(harness.events.get('unrelated').status, 'cancelled');
  assert.equal(harness.saved['SYNC_EVENT_' + pastSyncId], undefined);
  assert.equal(harness.saved['SYNC_EVENT_' + TEST_SYNC_ID], undefined);
});

test('events that match again after deletion get a new destination ID', () => {
  const harness = createAppsScriptHarness();
  postSnapshot(harness);
  const originalId = activeEvents(harness)[0].id;
  postSnapshot(harness, createTestSnapshot(TEST_NOW + 1, []));
  assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 2)).ok, true);
  assert.equal(activeEvents(harness).length, 1);
  assert.notEqual(activeEvents(harness)[0].id, originalId);
});

test('a manually deleted destination copy is recreated with a new ID', () => {
  const harness = createAppsScriptHarness();
  postSnapshot(harness);
  const original = activeEvents(harness)[0];
  harness.events.set(original.id, {...original, status: 'cancelled'});
  assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 1)).ok, true);
  assert.equal(activeEvents(harness).length, 1);
  assert.notEqual(activeEvents(harness)[0].id, original.id);
});

test('lost insert responses reuse the saved ID without duplicate events', () => {
  const harness = createAppsScriptHarness();
  const insert = harness.calendar.Events.insert;
  harness.calendar.Events.insert = (...args) => { insert(...args); throw new Error('Timeout'); };
  assert.equal(postSnapshot(harness).ok, true);
  assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 1)).ok, true);
  assert.equal(activeEvents(harness).length, 1);
});

test('failed inserts preserve a pending ID and never delete other copies', () => {
  const harness = createAppsScriptHarness();
  postSnapshot(harness);
  const originalId = activeEvents(harness)[0].id;
  const insert = harness.calendar.Events.insert;
  harness.calendar.Events.insert = () => { throw new Error('Quota exceeded'); };
  const changed = createTestSnapshot(TEST_NOW + 1);
  changed.events[0].syncId = 'b'.repeat(64);
  assert.equal(postSnapshot(harness, changed).ok, false);
  const pendingId = harness.saved['SYNC_EVENT_' + 'b'.repeat(64)];
  assert.ok(pendingId);
  assert.notEqual(harness.events.get(originalId).status, 'cancelled');
  harness.calendar.Events.insert = insert;
  changed.sequence++;
  changed.windowStart = new Date(changed.sequence - 86400000).toISOString();
  changed.windowEnd = new Date(changed.sequence + 90 * 86400000).toISOString();
  assert.equal(postSnapshot(harness, changed).ok, true);
  assert.equal(activeEvents(harness)[0].id, pendingId);
  assert.equal(harness.events.get(originalId).status, 'cancelled');
});

test('saved IDs recover accepted inserts missing from a subsequent list', () => {
  const harness = createAppsScriptHarness();
  postSnapshot(harness);
  harness.calendar.Events.list = () => ({items: []});
  assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 1)).ok, true);
  assert.equal(activeEvents(harness).length, 1);
  assert.equal(calendarWrites(harness).length, 1);
});

test('mapping conflicts, duplicates and changed ownership cause no writes', () => {
  for (const failure of ['metadata', 'mapping', 'duplicate']) {
    const harness = createAppsScriptHarness();
    postSnapshot(harness);
    const event = activeEvents(harness)[0];
    if (failure === 'metadata') delete event.extendedProperties;
    if (failure === 'mapping') harness.saved['SYNC_EVENT_' + TEST_SYNC_ID] = 'abcde';
    if (failure === 'duplicate') harness.events.set('abcde', {...structuredClone(event), id: 'abcde'});
    const writes = calendarWrites(harness).length;
    assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 1, [])).ok, false);
    assert.equal(calendarWrites(harness).length, writes);
  }
});

test('destination requests only managed events after the history boundary, including every page', () => {
  const harness = createAppsScriptHarness();
  const pages = [];
  harness.calendar.Events.list = (calendarId, options) => {
    assert.equal(calendarId, 'primary');
    assert.deepEqual(Array.from(options.privateExtendedProperty), ['syncOwner=calendar-ooo-sync-v1']);
    assert.equal(options.showDeleted, false);
    assert.equal(options.timeMin, createTestSnapshot().windowStart);
    assert.equal(options.timeMax, undefined);
    assert.equal(options.maxResults, 2500);
    pages.push(options.pageToken);
    return options.pageToken ? {items: []} : {items: [], nextPageToken: 'second'};
  };
  assert.equal(postSnapshot(harness).ok, true);
  assert.deepEqual(pages, [undefined, 'second']);
});

test('a failed destination page causes no writes', () => {
  const harness = createAppsScriptHarness();
  postSnapshot(harness);
  const list = harness.calendar.Events.list;
  harness.calendar.Events.list = (id, options) => {
    if (options.pageToken) throw new Error('Quota exceeded');
    return {...list(id, options), nextPageToken: 'second'};
  };
  const writes = calendarWrites(harness).length;
  assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 1, [])).ok, false);
  assert.equal(calendarWrites(harness).length, writes);
});

test('a later snapshot repairs a partial deletion and replay cannot restore stale state', () => {
  const harness = createAppsScriptHarness();
  const twoEvents = createTestSnapshot();
  twoEvents.events.push({...structuredClone(twoEvents.events[0]), syncId: 'b'.repeat(64)});
  assert.equal(postSnapshot(harness, twoEvents).ok, true);
  const remove = harness.calendar.Events.remove;
  let removals = 0;
  harness.calendar.Events.remove = (...args) => {
    if (++removals === 2) throw new Error('Quota exceeded');
    remove(...args);
  };
  const empty = createTestSnapshot(TEST_NOW + 1, []);
  assert.equal(postSnapshot(harness, empty).ok, false);
  assert.equal(activeEvents(harness).length, 1);
  assert.equal(postSnapshot(harness, empty).ok, false);
  assert.equal(postSnapshot(harness, twoEvents).ok, false);
  harness.calendar.Events.remove = remove;
  assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 2, [])).ok, true);
  assert.equal(activeEvents(harness).length, 0);
});

test('rejects unsigned, tampered, expired, oversized and malformed requests without calendar access', () => {
  const requests = [
    {},
    {postData: {contents: 'not JSON'}},
    createTestRequest(createTestSnapshot(), 'wrong secret'),
    createTestRequest(createTestSnapshot(TEST_NOW - 600001)),
    {postData: {contents: 'x'.repeat(250001)}},
    createTestRequest({...createTestSnapshot(), extra: 'private content'}),
  ];
  const tampered = createTestRequest(createTestSnapshot());
  tampered.postData.contents = tampered.postData.contents.replace('America/New_York', 'Europe/London');
  requests.push(tampered);
  for (const request of requests) {
    const harness = createAppsScriptHarness();
    assert.deepEqual(JSON.parse(harness.context.doPost(request).text), {ok: false});
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.lock.held, false);
    assert.equal(harness.logs.join().includes('private content'), false);
  }
});

test('rejects replay and concurrent requests before calendar access', () => {
  const harness = createAppsScriptHarness();
  postSnapshot(harness);
  const count = harness.calls.length;
  assert.equal(postSnapshot(harness).ok, false);
  assert.equal(harness.calls.length, count);
  harness.lock.available = false;
  assert.equal(postSnapshot(harness, createTestSnapshot(TEST_NOW + 1)).ok, false);
  assert.equal(harness.calls.length, count);
});
