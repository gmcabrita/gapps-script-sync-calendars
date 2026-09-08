const DESTINATION_CALENDAR_ID = 'primary';
const DESTINATION_MAPPING_PREFIX = 'SYNC_EVENT_';

/** Build a public out of office event without source titles, descriptions, or attendees. */
function buildDestinationEvent(event) {
  return {
    summary: 'Out of office',
    visibility: 'public',
    transparency: 'opaque',
    start: event.start,
    end: event.end,
    outOfOfficeProperties: {
      autoDeclineMode: 'declineAllConflictingInvitations',
      declineMessage: 'Declined because I am out of office',
    },
    extendedProperties: {private: {syncOwner: SYNC_SETTINGS.owner, syncId: event.syncId}},
  };
}

/** Avoid Calendar writes and repeated decline processing when the managed fields match. */
function destinationEventNeedsUpdate(current, desired) {
  return ['summary', 'visibility'].some(function (field) {
    return current[field] !== desired[field];
  }) || (current.transparency || 'opaque') !== desired.transparency ||
    ['start', 'end'].some(function (field) {
    return !current[field] ||
      Date.parse(current[field].dateTime) !== Date.parse(desired[field].dateTime) ||
      current[field].timeZone !== desired[field].timeZone;
  }) || !current.outOfOfficeProperties ||
    current.outOfOfficeProperties.autoDeclineMode !== desired.outOfOfficeProperties.autoDeclineMode ||
    current.outOfOfficeProperties.declineMessage !== desired.outOfOfficeProperties.declineMessage;
}

/** Verify ownership before every update or delete; never adopt an unrelated calendar event. */
function assertDestinationOwnership(event, syncId) {
  const metadata = event.extendedProperties && event.extendedProperties.private;
  if (event.eventType !== 'outOfOffice' || !metadata || metadata.syncOwner !== SYNC_SETTINGS.owner ||
      metadata.syncId !== syncId || !/^[0-9a-f]{64}$/.test(syncId) ||
      !event.end || !Number.isFinite(Date.parse(event.end.dateTime))) {
    throw new Error('Destination event ownership or interval invalid.');
  }
}

/** Distinguish an unused insert ID from a deleted event ID, which must not be reused. */
function readDestinationEvent(eventId) {
  try {
    return Calendar.Events.get(DESTINATION_CALENDAR_ID, eventId);
  } catch (error) {
    const code = error.code || (error.details && error.details.code);
    const message = String(error.message || '');
    if (code === 410 || /\bGone\b|Resource has been deleted/i.test(message)) {
      return {id: eventId, status: 'cancelled'};
    }
    if (code === 404 || /\bNot Found\b/i.test(message)) return null;
    throw error;
  }
}

/** Read all managed copies and saved insert IDs before applying a complete snapshot. */
function collectDestinationCopies(snapshot, properties) {
  const copies = new Map();
  listSyncCalendarEvents(DESTINATION_CALENDAR_ID, {
    privateExtendedProperty: ['syncOwner=' + SYNC_SETTINGS.owner],
    timeMin: snapshot.windowStart,
    showDeleted: false,
    maxResults: 2500,
  }).forEach(function (event) {
    const syncId = event.extendedProperties && event.extendedProperties.private &&
      event.extendedProperties.private.syncId;
    assertDestinationOwnership(event, syncId);
    if (copies.has(syncId)) throw new Error('Destination duplicate sync identifier.');
    copies.set(syncId, {eventId: event.id, event: event});
  });
  const saved = properties.getProperties();
  Object.keys(saved).filter(function (key) {
    return key.startsWith(DESTINATION_MAPPING_PREFIX);
  }).forEach(function (key) {
    const syncId = key.slice(DESTINATION_MAPPING_PREFIX.length);
    const eventId = saved[key];
    if (!/^[0-9a-f]{64}$/.test(syncId) || !/^[0-9a-v]{5,1024}$/.test(eventId)) {
      throw new Error('Destination saved mapping invalid.');
    }
    if (copies.has(syncId)) {
      if (copies.get(syncId).eventId !== eventId) {
        throw new Error('Destination saved mapping conflicts with calendar metadata.');
      }
      return;
    }
    const event = readDestinationEvent(eventId);
    if (event && event.status !== 'cancelled') assertDestinationOwnership(event, syncId);
    copies.set(syncId, {eventId: eventId, event: event});
  });
  return copies;
}

/** Persist insert IDs before API calls so a lost insert response cannot create a duplicate. */
function upsertDestinationCopy(sourceEvent, copy, properties) {
  const desired = buildDestinationEvent(sourceEvent);
  const mappingKey = DESTINATION_MAPPING_PREFIX + sourceEvent.syncId;
  let current = copy && copy.event;
  let eventId = copy && copy.eventId;
  if (current && current.status === 'cancelled') {
    current = null;
    eventId = null;
  }
  if (!eventId) eventId = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  if (properties.getProperty(mappingKey) !== eventId) properties.setProperty(mappingKey, eventId);
  if (current) {
    assertDestinationOwnership(current, sourceEvent.syncId);
    if (!destinationEventNeedsUpdate(current, desired)) return 'unchanged';
    Calendar.Events.patch(desired, DESTINATION_CALENDAR_ID, eventId);
    return 'updated';
  }
  try {
    Calendar.Events.insert(Object.assign({id: eventId, eventType: 'outOfOffice'}, desired),
      DESTINATION_CALENDAR_ID);
    return 'created';
  } catch (error) {
    // Calendar may have accepted an insert before a timeout. Verify that exact ID before retrying.
    const inserted = readDestinationEvent(eventId);
    if (!inserted || inserted.status === 'cancelled') throw error;
    assertDestinationOwnership(inserted, sourceEvent.syncId);
    if (destinationEventNeedsUpdate(inserted, desired)) {
      Calendar.Events.patch(desired, DESTINATION_CALENDAR_ID, eventId);
    }
    return 'updated';
  }
}

/** Keep history before the window; remove only managed copies absent from a complete snapshot. */
function reconcileDestinationCalendar(snapshot, properties) {
  const copies = collectDestinationCopies(snapshot, properties);
  const desiredIds = new Set(snapshot.events.map(function (event) { return event.syncId; }));
  const counts = {created: 0, updated: 0, deleted: 0, unchanged: 0};
  // Complete every create/update before deletions. An API failure is repaired by the next poll.
  snapshot.events.forEach(function (event) {
    counts[upsertDestinationCopy(event, copies.get(event.syncId), properties)]++;
  });
  copies.forEach(function (copy, syncId) {
    if (desiredIds.has(syncId)) return;
    if (copy.event && copy.event.status !== 'cancelled') {
      assertDestinationOwnership(copy.event, syncId);
      if (Date.parse(copy.event.end.dateTime) > Date.parse(snapshot.windowStart)) {
        Calendar.Events.remove(DESTINATION_CALENDAR_ID, copy.eventId);
        counts.deleted++;
      }
    }
    // Retain past Calendar events, but release their mapping to stay within Script Properties quotas.
    properties.deleteProperty(DESTINATION_MAPPING_PREFIX + syncId);
  });
  return counts;
}
