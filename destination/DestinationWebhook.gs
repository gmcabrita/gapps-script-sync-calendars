/** Web app entry point. All requests need a valid HMAC even with anonymous deployment access. */
function doPost(request) {
  let lock;
  let locked = false;
  let stage = 'authentication';
  try {
    const properties = PropertiesService.getScriptProperties();
    const sharedSecret = requireSyncProperty(properties, 'SHARED_SECRET', 32);
    const body = request && request.postData && request.postData.contents;
    if (typeof body !== 'string' || body.length > SYNC_SETTINGS.maxBodyLength) {
      throw new Error('Destination request size invalid.');
    }
    const envelope = JSON.parse(body);
    requireSyncFields(envelope, ['payload', 'signature']);
    if (typeof envelope.payload !== 'string' ||
        !matchesSyncSignature(envelope.signature, signSyncPayload(envelope.payload, sharedSecret))) {
      throw new Error('Destination request signature invalid.');
    }
    stage = 'validation';
    const snapshot = validateSyncSnapshot(JSON.parse(envelope.payload), Date.now());
    snapshot.events.forEach(function (event) {
      [event.start, event.end].forEach(function (boundary) {
        Utilities.formatDate(new Date(boundary.dateTime), boundary.timeZone, 'yyyy-MM-dd');
      });
    });
    lock = LockService.getScriptLock();
    locked = lock.tryLock(1000);
    if (!locked) throw new Error('Destination sync already running.');
    stage = 'replay check';
    if (snapshot.sequence <= readSyncSequence(properties, 'DESTINATION_LAST_SEQUENCE') ||
        Math.abs(Date.now() - snapshot.sequence) > SYNC_SETTINGS.maxClockSkewMs) {
      throw new Error('Destination request repeated or expired.');
    }
    // A later complete snapshot repairs partial writes. Never allow an older snapshot to overwrite it.
    properties.setProperty('DESTINATION_LAST_SEQUENCE', String(snapshot.sequence));
    stage = 'calendar reconciliation';
    const counts = reconcileDestinationCalendar(snapshot, properties);
    console.log('Destination sync complete. Created: ' + counts.created +
      ', updated: ' + counts.updated + ', deleted: ' + counts.deleted);
    return createDestinationResponse({ok: true, sequence: snapshot.sequence});
  } catch (error) {
    // Do not echo request data, credentials, or Calendar exception bodies to callers or logs.
    console.error('Destination sync failed at stage: ' + stage);
    return createDestinationResponse({ok: false});
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** Apps Script web apps return JSON status in the body; HTTP status alone is insufficient. */
function createDestinationResponse(result) {
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
