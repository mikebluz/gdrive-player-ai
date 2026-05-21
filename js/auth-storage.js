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
        localStorage.setItem(KEY, JSON.stringify({
          token,
          expiresAt: Date.now() + (Number(expiresInSec) || 3600) * 1000,
        }));
      } catch {}
    },
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.token || !parsed?.expiresAt) return null;
        if (Date.now() > parsed.expiresAt - SAFETY_MS) {
          localStorage.removeItem(KEY);
          return null;
        }
        return parsed;
      } catch { return null; }
    },
    clear() {
      try { localStorage.removeItem(KEY); } catch {}
    },
  };
})();
