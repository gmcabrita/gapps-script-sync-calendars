# Calendar out of office sync

One-way sync from Google account A to Google account B. Each account owns its Apps Script project. Calendar sharing is not required.

## Behavior

A timed event matches if its **title OR description** contains any keyword configured in A's `SOURCE_KEYWORDS` Script Property. Matching ignores letter case and uses substrings. All-day events and invitations declined by the source calendar are excluded. Keep your keywords in A's Script Properties. They are not sent to B or stored in this repository.

A sends only:

- An opaque sync ID derived from the source calendar ID and event ID.
- Start and end times, with time zones.
- The sync window, protocol version, and request sequence.

B creates events in its **primary calendar** with these settings:

| Setting | Value |
| --- | --- |
| Title | Out of office |
| Event type | Google Out of office |
| Visibility | Public |
| Availability | Busy |
| Start | Source start minus `OOO_BUFFER_MINUTES` (default: 10 minutes) |
| End | Source end plus `OOO_BUFFER_MINUTES` (default: 10 minutes) |
| Automatically decline | New and existing conflicting invitations |
| Decline message | Declined because I am out of office |

**This can decline meetings already accepted in B.** Removing an out of office event does not restore those acceptances. Test with accounts and calendars where this effect is acceptable.

B tags each copy with `extendedProperties.private.syncOwner = "calendar-ooo-sync-v1"` and stores the opaque sync ID in `extendedProperties.private.syncId`. It stores the original source end in `extendedProperties.private.syncSourceEnd` to preserve history when buffered copies leave the source window. It queries managed copies with `privateExtendedProperty: ['syncOwner=calendar-ooo-sync-v1']`. These are Advanced Calendar service metadata fields; `CalendarApp` also provides `setTag()` and `getTag()` on its event objects. The event description stays empty. Source titles, descriptions, locations, guests, meeting links, and raw event IDs are not sent. B returns only success status and the request sequence. Public visibility follows B's calendar sharing policy; this setting does not grant A access to B's calendar.

## Requirements

- Both accounts can authorize Apps Script.
- B can create Google Out of office events in its primary calendar. Google limits this feature to eligible accounts.
- B can deploy a web app with **Execute as: Me** and **Who has access: Anyone**, including callers that are not signed in. Some Workspace policies block this option.
- Both projects use the Advanced Calendar service, enabled by the supplied manifests.

The scripts require no external server or third account. Anyone can reach the destination endpoint, but each request must pass HMAC authentication. The public endpoint remains subject to Apps Script quotas and abuse limits.

## 1. Create two secrets

Run this command twice:

```sh
openssl rand -hex 32
```

Use the first result as `SHARED_SECRET` in both projects. Use the second as `SOURCE_ID_SECRET` in A only. Keep them different. Store them in Script Properties, not in code or this repository. Restrict project editor access: editors can access these properties.

## 2. Set up B

Sign in as account B at [Apps Script](https://script.google.com/). Create a standalone project.

Copy these files into the project. Copy only `.gs` files; tests stay local.

| Repository file | Apps Script file |
| --- | --- |
| `shared/SyncProtocol.gs` | `SyncProtocol.gs` |
| `destination/DestinationCalendar.gs` | `DestinationCalendar.gs` |
| `destination/DestinationWebhook.gs` | `DestinationWebhook.gs` |

In **Project Settings**, enable **Show appsscript.json manifest file in editor**. Replace its contents with `destination/appsscript.json`.

In **Project Settings → Script Properties**, add:

| Property | Value |
| --- | --- |
| `SHARED_SECRET` | The first secret |
| `OOO_BUFFER_MINUTES` | Optional. Minutes added before and after each event. Defaults to `10`; set `0` to disable. Accepts whole numbers from `0` to `1440`. |

Buffer changes take effect on the next sync and update existing copies in the source window. Missing configuration uses the default. Empty or invalid values stop reconciliation before Calendar reads or writes. The limit of one day per side prevents a configuration error from creating long blocks that decline meetings.

Select **Deploy → New deployment → Web app**:

1. Execute as **Me** (account B).
2. Set access to **Anyone**. An option restricted to signed-in Google users does not work with this transport.
3. Authorize the requested permissions.
4. Copy the web app URL ending in `/exec`.

The destination scope allows event access to calendars owned by B. The code uses only `primary`. It has no operation that returns calendar events to A.

## 3. Set up A

Sign in as account A and create another standalone Apps Script project.

| Repository file | Apps Script file |
| --- | --- |
| `shared/SyncProtocol.gs` | `SyncProtocol.gs` |
| `source/SourceSync.gs` | `SourceSync.gs` |

Enable the manifest editor and replace its contents with `source/appsscript.json`.

Add these Script Properties:

| Property | Value |
| --- | --- |
| `SHARED_SECRET` | The same first secret as B |
| `SOURCE_ID_SECRET` | The second secret, held only by A |
| `SOURCE_KEYWORDS` | Required. A JSON array of your keywords, entered directly in A's Script Properties. |
| `DESTINATION_WEB_APP_URL` | B's URL ending in `/exec` |
| `SOURCE_CALENDAR_ID` | Optional. Defaults to `primary`. Use a Calendar ID from A's calendar settings for another source calendar. |

Use JSON format for `SOURCE_KEYWORDS`, for example `["example keyword", "another example"]`. Replace these placeholders in Script Properties with your values. Leading and trailing whitespace is removed. Empty arrays, empty entries, non-string entries, invalid JSON, and missing configuration stop the sync before any request is sent to B. There is no default keyword list.

The source scope allows A's project to read calendars accessible to A. It does not grant B that access.

If either Apps Script project uses a standard Google Cloud project, also enable the Google Calendar API in that Cloud project.

## 4. Test and start

Use a time interval where automatic declines are acceptable.

1. In A, create a future event whose title contains one of your configured keywords.
2. Run `syncSourceCalendar` manually in A and authorize it.
3. Confirm that B has a public Google Out of office event starting before the source start and ending after the source end by the configured buffer. With the default, a 10:00–11:00 source event creates a 09:50–11:10 copy.
4. Run the sync again. Confirm there is still one copy.
5. Change the source time. Run the sync and confirm B's existing copy moves.
6. Remove the keyword from both source fields. Run the sync and confirm B's copy is deleted.
7. Test an event with a configured keyword in its description only. Use different letter case.
8. Test source deletion and recurring occurrences. Confirm that all-day events and invitations you decline in A produce no copies. Confirm that changing an already copied event to either excluded state removes its copy.
9. Run `installSourceSyncTrigger` in A. This installs one trigger that runs about every five minutes.

The trigger runs under A's account. To stop the sync, delete that trigger in A's **Triggers** page. Existing copies stay in B. To remove current copies through the sync, remove all matching keywords in A and run one successful sync before stopping.

After code changes, save both projects as needed. For B, use **Deploy → Manage deployments → Edit → New version → Deploy**. Saving the editor alone does not update an existing versioned web app deployment.

## Sync rules and limits

- Each poll sends a complete snapshot covering the previous **24 hours** and the next **90 days**. Events that overlap this interval are included.
- Matching events outside this window are not newly copied. Original source times define the window; the buffer can extend copies beyond it. Old copies whose original source end is before the window remain as history.
- B removes managed copies whose original source end is after the window start if they are absent from the snapshot. This includes source deletions, removed keywords, cancelled occurrences, events changed to all-day, invitations declined by the source calendar, and events moved beyond the future window.
- Source reads include every page before any request is sent. A source read failure sends nothing. A destination read failure causes no Calendar writes.
- Recurring source events expand into separate occurrences. Each occurrence keeps its identity when its time changes.
- All-day source events are excluded. A timed event that spans 24 hours can still match.
- Sync is limited to **500 matching occurrences per snapshot** and a **250,000-character request**. Exceeding either limit stops the poll without deletion. Apps Script runtime and Calendar quotas can impose lower limits.
- If a write fails partway through, the next complete snapshot repairs the state. Unchanged copies do not cause writes. Deleted destination copies are recreated while their source events still match.
- Requests expire after five minutes. A timestamp sequence and script locks prevent replay and concurrent writes. Saved insert IDs prevent duplicate creation after a lost response.
- Destination mappings use Script Properties and are removed when copies are deleted or leave the history window. Keep one source and one destination project for this sync.
- Change `SOURCE_KEYWORDS` in A's Script Properties to change selection on the next poll. Existing copies that no longer match are removed within the sync range. Keep at least one nonempty keyword; an empty list stops the sync.
- Edit `SYNC_SETTINGS` in `shared/SyncProtocol.gs` to change window lengths. Update the shared file in both deployed projects. Review the deletion effect before reducing the window.
- Do not delete internal Script Properties or edit managed event metadata. If a saved mapping conflicts with event metadata, or multiple copies have the same sync ID, the sync stops before writes. Remove any duplicate copy in B before the next poll.
- An invitation is excluded when an attendee has `self: true` and `responseStatus: 'declined'`. A decline by another attendee does not exclude it. Accepted, tentative, and unanswered invitations can match. For a source calendar other than A's primary calendar, `self` refers to that calendar's copy.
- Rotating `SOURCE_ID_SECRET`, or changing the source calendar, changes sync IDs and replaces active copies. This can trigger new automatic declines. Rotate `SHARED_SECRET` in both projects together.

## Troubleshooting

Check **Executions** in both projects. Logs contain counts or failure stages, without payloads or secrets.

| Destination failure stage | Check |
| --- | --- |
| Authentication | Matching shared secrets, valid JSON, request size |
| Validation | Both projects use the same protocol file, valid times and time zones |
| Replay check | No repeated request, clock difference under five minutes, valid sequence properties |
| Calendar reconciliation | Valid `OOO_BUFFER_MINUTES`, Calendar service enabled, authorization, Out of office eligibility, quotas, saved mappings and event metadata |

A non-JSON response usually indicates an incorrect deployment URL or web app access policy. B returns `{ "ok": false }` on failure because Apps Script does not expose custom HTTP response status codes here. A checks the JSON acknowledgement.

The sequence properties are `SOURCE_LAST_SEQUENCE` in A and `DESTINATION_LAST_SEQUENCE` in B. They contain timestamps in milliseconds. If a property is invalid or was manually set to a future value, stop A's trigger, wait five minutes for signed requests to expire, clear only those two sequence properties, and run a fresh sync. Keep secrets and `SYNC_EVENT_` mapping properties intact.

## Local checks

Node.js 20 or later. No dependencies or credentials are needed.

```sh
npm test
```

Tests use simulated Apps Script services. They check filtering, data limits, authentication, replay rejection, pagination, recurrence identity, time conversion, ownership, creation, update, deletion, and recovery from partial failures. They do not verify live Google authorization, web app deployment, account eligibility, or invitation declines. Complete the manual test before enabling the trigger.

Google documentation:

- [Calendar status events and Out of office restrictions](https://developers.google.com/workspace/calendar/api/guides/calendar-status)
- [Private extended properties](https://developers.google.com/workspace/calendar/api/guides/extended-properties)
- [Apps Script web apps](https://developers.google.com/apps-script/guides/web)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
