/** Run under account A. Send a complete snapshot only after all source reads succeed. */
function syncSourceCalendar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const properties = PropertiesService.getScriptProperties();
    const sharedSecret = requireSyncProperty(properties, 'SHARED_SECRET', 32);
    const identitySecret = requireSyncProperty(properties, 'SOURCE_ID_SECRET', 32);
    if (sharedSecret === identitySecret) {
      throw new Error('Source identity secret must differ from the shared secret.');
    }
    const destinationUrl = requireSyncProperty(properties, 'DESTINATION_WEB_APP_URL');
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(destinationUrl)) {
      throw new Error('Source destination URL must be a deployed Apps Script web app.');
    }
    const keywords = parseSourceKeywords(requireSyncProperty(properties, 'SOURCE_KEYWORDS'));
    const calendarId = properties.getProperty('SOURCE_CALENDAR_ID') || 'primary';
    const calendar = Calendar.Calendars.get(calendarId);
    const previousSequence = readSyncSequence(properties, 'SOURCE_LAST_SEQUENCE');
    const sequence = Math.max(Date.now(), previousSequence + 1);
    const snapshot = buildSourceSnapshot(calendar.id, calendar.timeZone, identitySecret, sequence, keywords);
    validateSyncSnapshot(snapshot, Date.now());
    const payload = JSON.stringify(snapshot);
    const body = JSON.stringify({payload: payload, signature: signSyncPayload(payload, sharedSecret)});
    if (body.length > SYNC_SETTINGS.maxBodyLength) {
      throw new Error('Source snapshot exceeds the request size limit.');
    }
    // Consume the sequence before the request: a lost response must not cause a replay.
    properties.setProperty('SOURCE_LAST_SEQUENCE', String(sequence));
    const response = UrlFetchApp.fetch(destinationUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      followRedirects: true,
      muteHttpExceptions: true,
    });
    let result;
    try {
      result = JSON.parse(response.getContentText());
    } catch (error) {
      throw new Error('Source received a non-JSON response. Check web app access and URL.');
    }
    if (response.getResponseCode() !== 200 || !result || result.ok !== true ||
        result.sequence !== sequence) {
      throw new Error('Source sync rejected or incomplete. Check destination execution logs.');
    }
    console.log('Source sync complete. Matching events: ' + snapshot.events.length);
  } finally {
    lock.releaseLock();
  }
}

/** Validate source keyword configuration without including its values in errors. */
function parseSourceKeywords(value) {
  let keywords;
  try {
    keywords = JSON.parse(value);
  } catch (error) {
    throw new Error('Source keywords JSON invalid.');
  }
  if (!Array.isArray(keywords) || keywords.length === 0 || keywords.some(function (keyword) {
    return typeof keyword !== 'string' || keyword.trim().length === 0;
  })) {
    throw new Error('Source keywords must be a nonempty array of nonempty strings.');
  }
  return Array.from(new Set(keywords.map(function (keyword) {
    return keyword.trim().toLowerCase();
  })));
}

/** Expand recurring events so each occurrence retains its own source event ID. */
function buildSourceSnapshot(calendarId, calendarTimeZone, identitySecret, sequence, keywords) {
  const windowStart = new Date(sequence - SYNC_SETTINGS.historyDays * SYNC_SETTINGS.dayMs).toISOString();
  const windowEnd = new Date(sequence + SYNC_SETTINGS.futureDays * SYNC_SETTINGS.dayMs).toISOString();
  const sourceEvents = listSyncCalendarEvents(calendarId, {
    timeMin: windowStart,
    timeMax: windowEnd,
    singleEvents: true,
    showDeleted: false,
    maxResults: 2500,
  });
  const events = sourceEvents.filter(function (event) {
    return matchesSourceEvent(event, keywords);
  }).map(function (event) {
    if (typeof event.id !== 'string' || !event.id) {
      throw new Error('Source event ID missing.');
    }
    return {
      syncId: signSyncPayload(JSON.stringify([calendarId, event.id]), identitySecret),
      start: convertSourceBoundary(event.start, calendarTimeZone),
      end: convertSourceBoundary(event.end, calendarTimeZone),
    };
  }).filter(function (event) {
    // Calendar ignores milliseconds in timeMin/timeMax. Enforce the exact snapshot bounds here.
    return Date.parse(event.start.dateTime) < Date.parse(windowEnd) &&
      Date.parse(event.end.dateTime) > Date.parse(windowStart);
  });
  return {version: SYNC_SETTINGS.version, sequence: sequence, windowStart: windowStart,
    windowEnd: windowEnd, events: events};
}

/** Normalize timed event boundaries to UTC while retaining their Calendar time zones. */
function convertSourceBoundary(boundary, calendarTimeZone) {
  if (!boundary) throw new Error('Source event boundary missing.');
  const timeZone = boundary.timeZone || calendarTimeZone;
  if (typeof boundary.dateTime !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(boundary.dateTime)) {
    throw new Error('Source event dateTime requires an explicit UTC offset.');
  }
  const instant = new Date(boundary.dateTime);
  if (!Number.isFinite(instant.getTime())) throw new Error('Source event instant invalid.');
  return {dateTime: instant.toISOString(), timeZone: timeZone};
}

/** Install one polling trigger. Run manually as account A after a successful test sync. */
function installSourceSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncSourceCalendar') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncSourceCalendar').timeBased().everyMinutes(5).create();
}
