// Cross-page Google OAuth token persistence. Stored in localStorage so a
// single sign-in covers index, bloops, and player. The token is cleared
// when it expires (with a 60-second safety buffer) or on explicit sign-
// out. Bump KEY's version suffix if the requested OAuth scopes ever
// change so older narrow-scope tokens get discarded automatically.
(function () {
  const KEY = 'mw_drive_auth_v1';
  const SAFETY_MS = 60 * 1000;

  window.SharedAuth = {
    save(token, expiresInSec) {
      if (!token) return;
      try {
        const expiresAt = Date.now() + (Number(expiresInSec) || 3600) * 1000;
        localStorage.setItem(KEY, JSON.stringify({ token, expiresAt }));
        const mins = Math.round((expiresAt - Date.now()) / 60000);
        console.info(`🔐 SharedAuth.save → token cached (~${mins}m left)`);
      } catch (e) {
        console.warn('🔐 SharedAuth.save failed:', e);
      }
    },
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.token || !parsed?.expiresAt) {
          console.warn('🔐 SharedAuth.load → entry malformed, dropping');
          localStorage.removeItem(KEY);
          return null;
        }
        if (Date.now() > parsed.expiresAt - SAFETY_MS) {
          console.info('🔐 SharedAuth.load → token expired, clearing');
          localStorage.removeItem(KEY);
          return null;
        }
        return parsed;
      } catch (e) {
        console.warn('🔐 SharedAuth.load failed:', e);
        return null;
      }
    },
    clear() {
      // Log the caller so we can identify any unexpected wipe path.
      try {
        const stack = new Error().stack?.split('\n').slice(2, 5).join(' | ');
        console.warn(`🔐 SharedAuth.clear called from: ${stack}`);
      } catch {}
      try { localStorage.removeItem(KEY); } catch {}
    },
  };

  // One-shot diagnostic on script load — shows up in the console for every
  // page that includes auth-storage.js. Lets us tell at a glance whether
  // the cached token survived a cross-page navigation without needing to
  // hand-poke localStorage in DevTools.
  try {
    const stored = window.SharedAuth.load();
    if (stored?.token) {
      const minsLeft = Math.round((stored.expiresAt - Date.now()) / 60000);
      console.info(`🔐 SharedAuth: cached token present (~${minsLeft}m left)`);
    } else {
      console.info('🔐 SharedAuth: no cached token');
    }
  } catch {}
})();
