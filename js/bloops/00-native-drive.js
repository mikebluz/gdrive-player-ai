// 00-native-drive.js — Google auth via the native shell (Capacitor iOS app).
//
// Google refuses OAuth inside webviews (disallowed_useragent), so the GIS
// popup the web page uses can never work in the shell. Instead of touching
// the page's auth plumbing (bloopsAuth in 10-tracks, GoogleDriveAPI, the
// SharedAuth cache — all of which already work against a bearer token), this
// module installs a FAKE `google.accounts.oauth2` whose token client is
// backed by the BloopsAuth native plugin (ASWebAuthenticationSession +
// authorization-code + PKCE against an iOS-type OAuth client). Every
// existing consumer keeps its bookkeeping; only where the token comes from
// changes.
//
// Better than the web, deliberately: the native flow returns a REFRESH
// TOKEN, persisted in localStorage — so sign-in happens once, and later
// token requests (including GIS-style silent refreshes, prompt:'') resolve
// without any UI.
//
// Inert on the web (gated on Capacitor.isNativePlatform). Force on with
// localStorage bloopsNativeDrive='1', kill with '0'. The real GIS script may
// still be loaded by the page (10-tracks loads it unconditionally on the
// sign-in path); the fake survives it — `google`, `google.accounts` and
// `google.accounts.oauth2` are all non-writable, so the CDN script's
// assignments silently lose. Verify with google.accounts.oauth2.__bloopsNative.
(function () {
  'use strict';
  var IOS_CLIENT_ID = '327113425825-m29toc61isi4s0puq5ubmum3tejpsefg.apps.googleusercontent.com';

  var native = false;
  try { native = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); } catch (e) {}
  var force = null;
  try { force = localStorage.getItem('bloopsNativeDrive'); } catch (e) {}
  if (force === '0') return;
  if (!native && force !== '1') return;

  var log = function (m) { try { console.log('[native-drive] ' + m); } catch (e) {} };
  var plug = function () {
    try { return (window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins.BloopsAuth : null; } catch (e) { return null; }
  };

  var RT_KEY = 'bloopsDriveRefreshToken';
  var getRT = function () { try { return localStorage.getItem(RT_KEY) || ''; } catch (e) { return ''; } };
  var setRT = function (t) { try { if (t) localStorage.setItem(RT_KEY, t); else localStorage.removeItem(RT_KEY); } catch (e) {} };

  // One token acquisition: silent refresh when a stored refresh token exists,
  // else (when allowed) the interactive system auth sheet. `interactive` is
  // false for GIS prompt:'' requests — those must never surface UI.
  function acquire(scopes, interactive) {
    var p = plug();
    if (!p) return Promise.reject(new Error('BloopsAuth plugin absent'));
    var rt = getRT();
    var silent = rt
      ? p.refresh({ clientId: IOS_CLIENT_ID, refreshToken: rt }).then(function (r) {
          if (r && r.accessToken) { log('token refreshed silently'); return r; }
          throw new Error('empty refresh response');
        })
      : Promise.reject(new Error('no_session'));
    return silent.catch(function (e) {
      var msg = (e && e.message) || String(e);
      if (rt && msg.indexOf('invalid_grant') >= 0) setRT('');   // revoked/expired — start over
      if (!interactive) throw new Error('no_session');
      log('interactive sign-in (' + msg + ')');
      return p.signIn({ clientId: IOS_CLIENT_ID, scopes: scopes }).then(function (r) {
        if (r && r.refreshToken) setRT(r.refreshToken);
        log('interactive sign-in ok');
        return r;
      });
    });
  }

  var oauth2 = {
    __bloopsNative: true,
    initTokenClient: function (cfg) {
      return {
        requestAccessToken: function (opts) {
          var interactive = !(opts && opts.prompt === '');
          acquire((cfg && cfg.scope) || '', interactive).then(
            function (r) { try { cfg.callback({ access_token: r.accessToken, expires_in: r.expiresIn || 3600 }); } catch (e) {} },
            function (e) { try { cfg.callback({ error: (e && e.message) || 'auth_failed' }); } catch (e2) {} }
          );
        },
      };
    },
    revoke: function (token, cb) {
      try { fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token || ''), { method: 'POST' }).catch(function () {}); } catch (e) {}
      setRT('');
      try { if (cb) cb(); } catch (e) {}
    },
    hasGrantedAllScopes: function () { return true; },
  };

  var accounts = {};
  Object.defineProperty(accounts, 'oauth2', { value: oauth2, writable: false, configurable: false });
  var g = window.google || {};
  try { Object.defineProperty(g, 'accounts', { value: accounts, writable: false, configurable: false }); } catch (e) {}
  try { Object.defineProperty(window, 'google', { value: g, writable: false, configurable: false }); } catch (e) {}

  // ---- FAKE gapi: Drive/Docs REST over fetch ----------------------------
  // Google's gapi loader BREAKS on the shell's capacitor:// scheme —
  // measured: gapi.load('client') fires its SUCCESS callback while
  // gapi.client never materializes, so every Drive call dies on
  // "undefined is not an object (evaluating 'gapi.client.drive')". Plain
  // fetch to googleapis.com works fine here, and the app's whole gapi
  // surface is six mechanical methods (list ×14, setToken ×12, init ×3,
  // export ×2, create ×2, get ×1, request ×1) — so the shell fakes gapi the
  // same way it fakes GIS. Response shape matches gapi: {status, result
  // (parsed JSON), body (raw text)}; rejections carry {status, message,
  // result} so `e?.message` alerts stay meaningful. window.gapi is
  // non-writable, so the real api.js (which the page still loads) lands
  // and silently loses.
  var apiKey = '';
  var bearer = '';
  var authHeaders = function () {
    var t = bearer;
    if (!t) { try { var s = window.SharedAuth && window.SharedAuth.load && window.SharedAuth.load(); t = (s && s.token) || ''; } catch (e) {} }
    return t ? { Authorization: 'Bearer ' + t } : {};
  };
  var call = function (method, url, params, jsonBody) {
    var u = new URLSearchParams();
    var k;
    for (k in params) { if (params[k] != null) u.append(k, params[k]); }
    var headers = authHeaders();
    // the API key is only for UNauthenticated access — and the web app's key
    // is referrer-restricted to the site, so from capacitor://localhost it
    // 403s outright ("Requests from referer capacitor://localhost are
    // blocked", measured). With a Bearer token the key adds nothing: omit it.
    if (!headers.Authorization && apiKey && apiKey.indexOf('YOUR_') !== 0) u.append('key', apiKey);
    var q = u.toString();
    if (jsonBody) headers['Content-Type'] = 'application/json';
    return fetch(url + (q ? (url.indexOf('?') >= 0 ? '&' : '?') + q : ''), {
      method: method, headers: headers,
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    }).then(function (r) {
      return r.text().then(function (txt) {
        var js = null; try { js = txt ? JSON.parse(txt) : null; } catch (e) {}
        var res = { status: r.status, body: txt, result: js };
        if (!r.ok) {
          res.message = (js && js.error && js.error.message) || ('Drive HTTP ' + r.status);
          throw res;
        }
        return res;
      });
    });
  };
  var strip = function (p, drop) {
    var out = {}, k;
    for (k in p) { if (k !== drop && k !== 'resource') out[k] = p[k]; }
    return out;
  };
  var DRIVE = 'https://www.googleapis.com/drive/v3/files';
  var fakeGapi = {
    __bloopsNative: true,
    load: function (name, cb) {
      var fn = (typeof cb === 'function') ? cb : (cb && cb.callback);
      try { if (fn) fn(); } catch (e) {}
    },
    client: {
      init: function (cfg) { if (cfg && cfg.apiKey) apiKey = cfg.apiKey; return Promise.resolve(); },
      setToken: function (t) { bearer = (t && t.access_token) || ''; },
      request: function (cfg) { return call('GET', (cfg && cfg.path) || '', (cfg && cfg.params) || {}); },
      drive: {
        files: {
          list: function (p) { return call('GET', DRIVE, p || {}); },
          create: function (p) { return call('POST', DRIVE, strip(p, null), (p && p.resource) || {}); },
          get: function (p) { return call('GET', DRIVE + '/' + encodeURIComponent(p.fileId), strip(p, 'fileId')); },
          export: function (p) { return call('GET', DRIVE + '/' + encodeURIComponent(p.fileId) + '/export', { mimeType: p.mimeType }); },
        },
      },
    },
  };
  try { Object.defineProperty(window, 'gapi', { value: fakeGapi, writable: false, configurable: false }); } catch (e) {}

  // ---- swallow the REAL Google script loads -----------------------------
  // The page's sign-in path (10-tracks googleSignInForDrive) awaits
  // loadExternalScript for gsi/client and js/api.js UNCONDITIONALLY. Both
  // are fully faked above, so the real loads add nothing — and a flaky load
  // REJECTS the await and kills sign-in before the fakes are consulted
  // ("Sign-in failed: Failed to load https://accounts.google.com/gsi/client",
  // on-device). Intercept the insert and fire a synthetic load event, so
  // every such loader resolves instantly, network or no network.
  var SWALLOW = /accounts\.google\.com\/gsi\/client|apis\.google\.com\/js\/api\.js/;
  var swallowing = function (child) {
    return child && child.tagName === 'SCRIPT' && SWALLOW.test(child.src || '');
  };
  var fakeLoad = function (child) {
    log('swallowed script load: ' + child.src);
    setTimeout(function () { try { child.dispatchEvent(new Event('load')); } catch (e) {} }, 0);
    return child;
  };
  var origAppend = Node.prototype.appendChild;
  Node.prototype.appendChild = function (child) {
    try { if (swallowing(child)) return fakeLoad(child); } catch (e) {}
    return origAppend.call(this, child);
  };
  var origInsert = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (child, ref) {
    try { if (swallowing(child)) return fakeLoad(child); } catch (e) {}
    return origInsert.call(this, child, ref);
  };

  log('native Google auth installed (fake GIS + fake gapi, iOS client, refresh-token persistence)');
})();
