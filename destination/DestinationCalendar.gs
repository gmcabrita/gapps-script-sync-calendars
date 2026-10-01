const DESTINATION_CALENDAR_ID = 'primary';
const DESTINATION_MAPPING_PREFIX = 'SYNC_EVENT_';

/** Limit the buffer to one day per side to prevent long blocks from a configuration error. */
function parseDestinationBufferMinutes(value) {
  if (value === null) return 10;
  const text = typeof value === 'string' ? value.trim() : '';
  const minutes = Number(text);
  if (!/^\d+$/.test(text) || minutes > 1440) {
    throw new Error('Destination OOO_BUFFER_MINUTES must be an integer from 0 to 1440.');
  }
  return minutes;
}

/** Apply the buffer to source times on each sync so repeated syncs cannot extend it again. */
function buildDestinationEvent(event, bufferMinutes) {
  const bufferMs = bufferMinutes * 60 * 1000;
  return {
    summary: 'Out of office',
    visibility: 'public',
    transparency: 'opaque',
    // Turn off the calendar default reminders. An empty overrides list means no notifications.
    reminders: {useDefault: false, overrides: []},
    start: {
      dateTime: new Date(Date.parse(event.start.dateTime) - bufferMs).toISOString(),
      timeZone: event.start.timeZone,
    },
    end: {
      dateTime: new Date(Date.parse(event.end.dateTime) + bufferMs).toISOString(),
      timeZone: event.end.timeZone,
    },
    outOfOfficeProperties: {
      autoDeclineMode: 'declineAllConflictingInvitations',
      declineMessage: 'Declined because I am out of office',
    },
    extendedProperties: {private: {
      syncOwner: SYNC_SETTINGS.owner,
      syncId: event.syncId,
      syncSourceEnd: event.end.dateTime,
    }},
  };
}

/** Avoid Calendar writes and repeated decline processing when the managed fields match. */
function destinationEventNeedsUpdate(current, desired) {
  const metadata = current.extendedProperties && current.extendedProperties.private;
  return !metadata || metadata.syncSourceEnd !== desired.extendedProperties.private.syncSourceEnd ||
    ['summary', 'visibility'].some(function (field) {
    return current[field] !== desired[field];
  }) || (current.transparency || 'opaque') !== desired.transparency ||
    ['start', 'end'].some(function (field) {
    return !current[field] ||
      Date.parse(current[field].dateTime) !== Date.parse(desired[field].dateTime) ||
      current[field].timeZone !== desired[field].timeZone;
  }) || !current.reminders || current.reminders.useDefault !== false ||
    (current.reminders.overrides || []).length > 0 ||
    !current.outOfOfficeProperties ||
    current.outOfOfficeProperties.autoDeclineMode !== desired.outOfOfficeProperties.autoDeclineMode ||
    current.outOfOfficeProperties.declineMessage !== desired.outOfOfficeProperties.declineMessage;
}

/** Verify ownership before every update or delete; never adopt an unrelated calendar event. */
function assertDestinationOwnership(event, syncId) {
  const metadata = event.extendedProperties && event.extendedProperties.private;
  if (event.eventType !== 'outOfOffice' || !metadata || metadata.syncOwner !== SYNC_SETTINGS.owner ||
      metadata.syncId !== syncId || !/^[0-9a-f]{64}$/.test(syncId) ||
      (metadata.syncSourceEnd !== undefined && !Number.isFinite(Date.parse(metadata.syncSourceEnd))) ||
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
function upsertDestinationCopy(sourceEvent, copy, properties, bufferMinutes) {
  const desired = buildDestinationEvent(sourceEvent, bufferMinutes);
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
  const bufferMinutes = parseDestinationBufferMinutes(properties.getProperty('OOO_BUFFER_MINUTES'));
  const copies = collectDestinationCopies(snapshot, properties);
  const desiredIds = new Set(snapshot.events.map(function (event) { return event.syncId; }));
  const counts = {created: 0, updated: 0, deleted: 0, unchanged: 0};
  // Complete every create/update before deletions. An API failure is repaired by the next poll.
  snapshot.events.forEach(function (event) {
    counts[upsertDestinationCopy(event, copies.get(event.syncId), properties, bufferMinutes)]++;
  });
  copies.forEach(function (copy, syncId) {
    if (desiredIds.has(syncId)) return;
    if (copy.event && copy.event.status !== 'cancelled') {
      assertDestinationOwnership(copy.event, syncId);
      // Use the original end time so a buffer does not cause deletion when a copy becomes history.
      // Copies created before buffering was added have their original end time in the event itself.
      const sourceEnd = copy.event.extendedProperties.private.syncSourceEnd || copy.event.end.dateTime;
      if (Date.parse(sourceEnd) > Date.parse(snapshot.windowStart)) {
        Calendar.Events.remove(DESTINATION_CALENDAR_ID, copy.eventId);
        counts.deleted++;
      }
    }
    // Retain past Calendar events, but release their mapping to stay within Script Properties quotas.
    properties.deleteProperty(DESTINATION_MAPPING_PREFIX + syncId);
  });
  return counts;
}
