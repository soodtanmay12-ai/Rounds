// Rounds -- service worker
//
// WHAT THIS DOES:
// - Lets the page show real OS-level notifications via
//   self.registration.showNotification() (see showLocalNotification() in
//   index.html), and handles taps on those notifications so they bring you
//   back into the app at the right place.
// - Makes a best-effort attempt at a daily check via the Periodic
//   Background Sync API, ONLY where the browser supports it (Chrome on
//   Android, PWA installed to the home screen, and only once Chrome's own
//   engagement heuristics decide to allow it -- there is no way to force
//   this from here or from index.html).
//
// WHAT THIS DOES NOT DO:
// - This is NOT a substitute for real push notifications. A genuine
//   "remind me every day at a fixed time even if I haven't opened the app
//   in a week" requires a server that can wake up on a schedule and tell a
//   push service (e.g. via Firebase Cloud Messaging, or the raw Web Push
//   protocol) to deliver something to this specific device. Rounds is a
//   static site with no backend, so that piece doesn't exist yet.
//   Everything in this file only runs while the browser considers this
//   site's service worker "alive," which in practice means: the app is
//   open, was recently open, or (occasionally, Chrome/Android only)
//   periodic sync happens to fire.
// - The 'push' handler below is a placeholder. Nothing currently sends a
//   push message to this service worker -- there is no push
//   subscription or backend wired up to do so. It's kept here so that if
//   real push infrastructure is ever added later, wiring it in is a small
//   addition to this file rather than a new one.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch (e) { return; }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Rounds', {
      body: payload.body || '',
      icon: './apple-touch-icon.png',
      badge: './favicon-32.png',
      data: payload.dest || null
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const dest = event.notification.data || null;
  // event.action is set to the tapped action's id when one exists (empty
  // string for a tap on the notification body itself). Only one action
  // exists right now ('view-plan', added in index.html's
  // checkAndPushNotifications) and it goes to the same place a body-tap
  // would, so no branching is needed yet -- kept as a named variable since
  // future distinct actions will need to check it.
  const action = event.action || '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (dest) client.postMessage({ type: 'notification-click', dest, action });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

// Best-effort daily check -- see the file-level note above. If this never
// fires, or fires inconsistently, that's the browser's own scheduling
// decision, not a bug here; there is no way to force it from either side.
// Deliberately a single evening check rather than index.html's full
// three-stage escalation (gentle/mid/final) -- periodicsync itself fires
// unpredictably at best, so replicating fine-grained staging here would be
// precision this handler can't actually deliver on.
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'rounds-daily-check') {
    event.waitUntil(checkDailyStatus());
  }
});

async function checkDailyStatus() {
  const status = await readStatus();
  if (!status) return;
  // Local calendar date, matching toDateStr() in index.html exactly --
  // NOT toISOString(), which is UTC and would be wrong for several hours
  // a day in any timezone ahead of UTC (this app's status mirror is
  // always written in local-date terms).
  const now = new Date();
  const todayKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const hour = now.getHours();
  if (status.dateKey !== todayKey || status.isSpecialDay) return;
  const behindOnMcq = status.mcqCount < status.mcqTarget;
  const behindOnPlan = status.planRemaining > 0;
  if (hour >= 18 && (behindOnMcq || behindOnPlan)) {
    const mcqRemaining = Math.max(0, status.mcqTarget - status.mcqCount);
    const planBit = behindOnPlan ? `${status.planRemaining} plan item${status.planRemaining !== 1 ? 's' : ''} still open` : null;
    const mcqBit = behindOnMcq ? `${mcqRemaining} MCQ${mcqRemaining !== 1 ? 's' : ''}` : null;
    const parts = [planBit, mcqBit].filter(Boolean).join(' + ');
    // Mirrors index.html's daily-pace wording where possible -- leads with
    // Best Next Action's pick when the page happened to mirror one before
    // this ran, instead of a bare count with no suggested next move.
    const body = status.bestNextLabel ? `Start ${status.bestNextLabel} — ${parts}.` : `${parts} for today.`;
    await self.registration.showNotification('Rounds', {
      body,
      icon: './apple-touch-icon.png',
      badge: './favicon-32.png',
      tag: 'rounds-periodic-check',
      // Matches index.html's showLocalNotification for the same kind of
      // nudge -- an undismissed notification is what actually drives
      // Android's automatic home-screen icon badge (Chrome's own Badging
      // API docs confirm the API itself is a no-op on Android).
      requireInteraction: true
    });
  }
}

// Mirrors mirrorStatusToIndexedDB()/buildStatusSnapshot() in index.html --
// same DB/store/key names and field shape, read-only here. A service
// worker runs in its own global context and can't reach the page's
// variables or localStorage, only IndexedDB/Cache, hence this tiny
// separate snapshot instead of the real app data.
function readStatus() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('rounds-status', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('status'); };
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction('status', 'readonly');
          const getReq = tx.objectStore('status').get('latest');
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      };
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
