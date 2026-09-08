const SYNC_SETTINGS = Object.freeze({
  version: 1,
  owner: 'calendar-ooo-sync-v1',
  historyDays: 1,
  futureDays: 90,
  maxEvents: 500,
  maxBodyLength: 250000,
  maxClockSkewMs: 5 * 60 * 1000,
  dayMs: 24 * 60 * 60 * 1000,
});

/** Select timed events locally; skip all-day events and the source calendar's declined invitations. */
function matchesSourceEvent(event, keywords) {
  if (event.status === 'cancelled' ||
      (event.start && event.start.date) || (event.end && event.end.date)) return false;
  if ((event.attendees || []).some(function (attendee) {
    return attendee.self === true && attendee.responseStatus === 'declined';
  })) return false;
  return [event.summary, event.description].some(function (text) {
    return typeof text === 'string' && keywords.some(function (keyword) {
      return text.toLowerCase().includes(keyword);
    });
  });
}

/** Encode signed bytes as hex for signatures and opaque event identifiers. */
function encodeSyncHex(bytes) {
  return bytes.map(function (byte) {
    return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
  }).join('');
}

/** Sign the exact payload string; do not sign a parsed and reserialized object. */
function signSyncPayload(payload, secret) {
  return encodeSyncHex(Utilities.computeHmacSha256Signature(
    payload, secret, Utilities.Charset.UTF_8
  ));
}

/** Compare every character of a valid SHA-256 signature. */
function matchesSyncSignature(actual, expected) {
  if (typeof actual !== 'string' || !/^[0-9a-f]{64}$/.test(actual)) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/** Read configuration without including secret values in errors. */
function requireSyncProperty(properties, name, minimumLength) {
  const value = properties.getProperty(name);
  if (!value || value.length < (minimumLength || 1)) {
    throw new Error('Sync configuration missing or too short: ' + name);
  }
  return value;
}

/** Stop on corrupt replay state instead of accepting requests without sequence checks. */
function readSyncSequence(properties, name) {
  const sequence = Number(properties.getProperty(name) || 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Sync saved sequence invalid: ' + name);
  }
  return sequence;
}

/** Reject extra fields at the transport boundary. */
function requireSyncFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== fields.slice().sort().join(',')) {
    throw new Error('Sync object fields invalid.');
  }
}

/** The transport uses UTC instants plus explicit Calendar time zones. */
function parseSyncInstant(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Sync timestamp invalid.');
  }
  return Date.parse(value);
}

/** Validate the entire snapshot before any Calendar write or deletion. */
function validateSyncSnapshot(snapshot, now) {
  requireSyncFields(snapshot, ['version', 'sequence', 'windowStart', 'windowEnd', 'events']);
  if (snapshot.version !== SYNC_SETTINGS.version ||
      !Number.isSafeInteger(snapshot.sequence) ||
      Math.abs(now - snapshot.sequence) > SYNC_SETTINGS.maxClockSkewMs) {
    throw new Error('Sync version or request age invalid.');
  }
  const windowStart = parseSyncInstant(snapshot.windowStart);
  const windowEnd = parseSyncInstant(snapshot.windowEnd);
  if (windowStart !== snapshot.sequence - SYNC_SETTINGS.historyDays * SYNC_SETTINGS.dayMs ||
      windowEnd !== snapshot.sequence + SYNC_SETTINGS.futureDays * SYNC_SETTINGS.dayMs) {
    throw new Error('Sync window invalid.');
  }
  if (!Array.isArray(snapshot.events) || snapshot.events.length > SYNC_SETTINGS.maxEvents) {
    throw new Error('Sync event count invalid.');
  }
  const identifiers = new Set();
  snapshot.events.forEach(function (event) {
    requireSyncFields(event, ['syncId', 'start', 'end']);
    if (typeof event.syncId !== 'string' || !/^[0-9a-f]{64}$/.test(event.syncId) ||
        identifiers.has(event.syncId)) {
      throw new Error('Sync event identifier invalid or duplicated.');
    }
    identifiers.add(event.syncId);
    [event.start, event.end].forEach(function (boundary) {
      requireSyncFields(boundary, ['dateTime', 'timeZone']);
      parseSyncInstant(boundary.dateTime);
      if (typeof boundary.timeZone !== 'string' ||
          !/^[A-Za-z0-9_+\-/]{1,100}$/.test(boundary.timeZone)) {
        throw new Error('Sync time zone invalid.');
      }
    });
    const start = Date.parse(event.start.dateTime);
    const end = Date.parse(event.end.dateTime);
    if (start >= end || start >= windowEnd || end <= windowStart) {
      throw new Error('Sync event interval invalid.');
    }
  });
  return snapshot;
}

/** Fetch every page before reconciliation; a partial list must never cause deletion. */
function listSyncCalendarEvents(calendarId, options) {
  let pageToken;
  const seenTokens = new Set();
  const events = [];
  do {
    const parameters = Object.assign({}, options);
    if (pageToken) parameters.pageToken = pageToken;
    const page = Calendar.Events.list(calendarId, parameters);
    if (!page || (page.items !== undefined && !Array.isArray(page.items))) {
      throw new Error('Sync calendar page invalid.');
    }
    events.push.apply(events, page.items || []);
    pageToken = page.nextPageToken;
    if (pageToken && (typeof pageToken !== 'string' || seenTokens.has(pageToken))) {
      throw new Error('Sync calendar pagination invalid.');
    }
    seenTokens.add(pageToken);
  } while (pageToken);
  return events;
}
