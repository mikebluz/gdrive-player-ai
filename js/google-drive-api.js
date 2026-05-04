// js/google-drive-api.js
class GoogleDriveAPI {
  constructor({ clientId, apiKey }) {
    this.CLIENT_ID = clientId;
    this.API_KEY = apiKey;
    this.DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
    this.SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly";

    this.gapiLoaded = false;
    this.gisTokenClient = null;
    this.accessToken = null;
  }

  async initialize() {
    await this.loadGapiClient();
    await this.loadGisClient();

    await gapi.client.init({
      apiKey: this.API_KEY,
      discoveryDocs: [this.DISCOVERY_DOC],
    });

    this.gapiLoaded = true;
    console.log("✅ Google Drive API client initialized");
  }

  async loadGapiClient() {
    return new Promise((resolve, reject) => {
      if (window.gapi) {
        gapi.load("client", resolve);
      } else {
        const script = document.createElement("script");
        script.src = "https://apis.google.com/js/api.js";
        script.onload = () => gapi.load("client", resolve);
        script.onerror = reject;
        document.head.appendChild(script);
      }
    });
  }

  async loadGisClient() {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) {
        this.initTokenClient();
        resolve();
      } else {
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.onload = () => {
          this.initTokenClient();
          resolve();
        };
        script.onerror = reject;
        document.head.appendChild(script);
      }
    });
  }

  initTokenClient() {
    this.gisTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: this.CLIENT_ID,
      scope: this.SCOPES,
      callback: (response) => {
        if (response.error) {
          console.error("OAuth error:", response);
          if (this._refreshResolve) {
            this._refreshReject(new Error(response.error));
            this._refreshResolve = this._refreshReject = null;
          } else {
            alert("Google sign-in failed.");
          }
          return;
        }
        this.accessToken = response.access_token;
        this._tokenExpiry = Date.now() + (response.expires_in || 3600) * 1000;
        gapi.client.setToken({ access_token: response.access_token });

        if (this._refreshResolve) {
          console.log("🔑 Access token refreshed");
          this._refreshResolve();
          this._refreshResolve = this._refreshReject = null;
        } else {
          console.log("🔑 Access token acquired");
          document.dispatchEvent(
            new CustomEvent("authStatusChanged", { detail: { isSignedIn: true } })
          );
        }
      },
    });
  }

  async signIn() {
    // When embedded inside the unified Bloops + Serialbox page, delegate
    // to the shared sign-in so both views use the same access token.
    if (typeof window !== 'undefined' && window.bloopsAuth && typeof window.bloopsAuth.signIn === 'function') {
      await window.bloopsAuth.signIn();
      this.accessToken = window.bloopsAuth.getToken();
      if (typeof gapi !== 'undefined' && gapi.client && this.accessToken) {
        gapi.client.setToken({ access_token: this.accessToken });
      }
      document.dispatchEvent(
        new CustomEvent("authStatusChanged", { detail: { isSignedIn: true } })
      );
      return;
    }
    if (!this.gisTokenClient) throw new Error("Token client not initialized");
    this.gisTokenClient.requestAccessToken({ prompt: "consent" });
  }

  refreshTokenSilently() {
    return new Promise((resolve, reject) => {
      this._refreshResolve = resolve;
      this._refreshReject = reject;
      this.gisTokenClient.requestAccessToken({ prompt: '' });
      setTimeout(() => {
        if (this._refreshResolve) {
          this._refreshResolve = this._refreshReject = null;
          reject(new Error('Token refresh timed out'));
        }
      }, 10000);
    });
  }

  signOut() {
    if (this.accessToken) {
      google.accounts.oauth2.revoke(this.accessToken, () => {
        this.accessToken = null;
        console.log("🚪 Signed out from Google");
        document.dispatchEvent(
          new CustomEvent("authStatusChanged", { detail: { isSignedIn: false } })
        );
      });
    }
  }

  async searchFolders(folderPath) {
    await this.ensureSignedIn();
    const segments = String(folderPath).split('/').map(s => s.trim()).filter(Boolean);
    if (segments.length === 0) return [];

    // Single-segment entry (no "/") — keep the old global lookup so
    // playlists files that just list folder names still resolve when
    // those folders live nested under something else, or were shared
    // into the user's Drive (and therefore aren't direct children of
    // 'root').
    if (segments.length === 1) {
      const name = segments[0];
      const safe = name.replace(/'/g, "\\'");
      const res = await gapi.client.drive.files.list({
        q: `name = '${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id, name, parents)",
      });
      return (res.result.files || []).filter(f => (f.name || '') === name);
    }

    // Multi-segment path — walk the hierarchy one level at a time. The
    // first segment is anchored at 'root' so an explicit path like
    // "bloops/exports" can't accidentally pick up a stray "exports"
    // folder somewhere else in the tree.
    let parents = ['root'];
    let leafMatches = [];
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      const safe = name.replace(/'/g, "\\'");
      const matches = [];
      for (const parentId of parents) {
        const res = await gapi.client.drive.files.list({
          q: `name = '${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`,
          fields: "files(id, name, parents)",
        });
        (res.result.files || []).forEach(f => {
          if ((f.name || '') === name) matches.push(f);
        });
      }
      if (matches.length === 0) return [];
      if (i === segments.length - 1) leafMatches = matches;
      else parents = matches.map(f => f.id);
    }
    return leafMatches;
  }

  async getMusicFilesFromFolders(folders) {
    const all = [];
    const results = await Promise.all(folders.map(f => this.getMusicFilesFromFolder(f.id)));
    results.forEach(r => all.push(...r));
    return [...new Map(all.map(f => [f.id, f])).values()];
  }

  async getMusicFilesFromFolder(folderId) {
    await this.ensureSignedIn();
    const musicFiles = [];
    let pageToken = null;

    do {
      const res = await gapi.client.drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "nextPageToken, files(id, name, size, mimeType)",
        pageToken,
      });

      for (const file of res.result.files || []) {
        if (this.isAudioFile(file.name)) {
          musicFiles.push({
            id: file.id,
            name: this.cleanFileName(file.name),
            size: file.size,
            downloadUrl: `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
          });
        }
      }
      pageToken = res.result.nextPageToken;
    } while (pageToken);

    return musicFiles;
  }

  async fetchArtistName(folderId) {
    try {
      await this.ensureSignedIn();

      const res = await gapi.client.drive.files.list({
        q: `name = 'Artist name' and '${folderId}' in parents and trashed=false`,
        fields: "files(id, name, mimeType)",
      });
      const files = res.result.files || [];
      if (files.length === 0) return null;

      const file = files[0];

      let text;
      if (file.mimeType === 'application/vnd.google-apps.document') {
        text = await this.fetchGoogleDocText(file.id);
      } else if (file.mimeType.startsWith('application/vnd.google-apps.')) {
        const res2 = await gapi.client.drive.files.export({ fileId: file.id, mimeType: 'text/html' });
        text = this.htmlToText(res2.body);
      } else {
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
          { headers: { Authorization: `Bearer ${this.accessToken}` } }
        );
        if (!response.ok) return null;
        text = await response.text();
      }

      return text.split('\n').map(l => l.trim()).find(l => l.length > 0) || null;
    } catch (e) {
      console.warn('fetchArtistName failed:', e);
      return null;
    }
  }

  async fetchArtworkBlobUrl(folderId) {
    try {
      const res = await gapi.client.drive.files.list({
        q: `name contains 'Artwork' and '${folderId}' in parents and trashed=false`,
        fields: "files(id, mimeType)",
      });
      const file = (res.result.files || []).find(f => f.mimeType.startsWith('image/'));
      if (!file) return null;
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
      if (!response.ok) return null;
      return URL.createObjectURL(await response.blob());
    } catch { return null; }
  }

  async fetchPlaylistOptions(filePath) {
    await this.ensureSignedIn();

    // Walk the path so callers can pass a nested location like
    // "bloops/playlists" — every "/" is a parent/child step. The last
    // segment is the file name; everything before it is the folder
    // chain, anchored at My Drive root.
    const segments = String(filePath).split('/').map(s => s.trim()).filter(Boolean);
    if (segments.length === 0) throw new Error('File path required');
    const fileName = segments.pop();

    let parentId = 'root';
    for (const folderName of segments) {
      const safeFolder = folderName.replace(/'/g, "\\'");
      const r = await gapi.client.drive.files.list({
        q: `name = '${safeFolder}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`,
        fields: "files(id, name)",
      });
      if (!r.result.files || r.result.files.length === 0) {
        throw new Error(`Folder "${folderName}" not found`);
      }
      parentId = r.result.files[0].id;
    }

    const safeName = fileName.replace(/'/g, "\\'");
    const res = await gapi.client.drive.files.list({
      q: `name = '${safeName}' and trashed=false and mimeType != 'application/vnd.google-apps.folder' and '${parentId}' in parents`,
      fields: "files(id, name, mimeType)",
    });
    const files = res.result.files || [];
    if (files.length === 0) throw new Error(`File "${filePath}" not found`);

    const file = files[0];
    console.log(`📄 Found "${file.name}" — mimeType: ${file.mimeType}`);

    let text;
    if (file.mimeType === 'application/vnd.google-apps.document') {
      text = await this.fetchGoogleDocText(file.id);
    } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
      const res2 = await gapi.client.drive.files.export({ fileId: file.id, mimeType: 'text/csv' });
      text = res2.body;
    } else {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
      if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
      text = await response.text();
    }

    return text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  }

  async fetchGoogleDocText(fileId) {
    const res = await gapi.client.request({
      path: `https://docs.googleapis.com/v1/documents/${fileId}`,
      params: { fields: 'body.content' },
    });
    const lines = [];
    for (const elem of res.result.body?.content || []) {
      if (elem.paragraph) {
        for (const pe of elem.paragraph.elements || []) {
          if (pe.textRun?.content) lines.push(pe.textRun.content);
        }
      }
    }
    return lines.join('');
  }

  htmlToText(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  }

  async ensureSignedIn() {
    if (this.accessToken) return;
    // Pull the current token from the shared Bloops auth surface, or
    // trigger a sign-in if no one has authenticated yet.
    if (typeof window !== 'undefined' && window.bloopsAuth && typeof window.bloopsAuth.getToken === 'function') {
      const tok = window.bloopsAuth.getToken();
      if (tok) {
        this.accessToken = tok;
        if (typeof gapi !== 'undefined' && gapi.client) gapi.client.setToken({ access_token: tok });
        return;
      }
      if (typeof window.bloopsAuth.signIn === 'function') {
        await window.bloopsAuth.signIn();
        this.accessToken = window.bloopsAuth.getToken();
        if (typeof gapi !== 'undefined' && gapi.client && this.accessToken) {
          gapi.client.setToken({ access_token: this.accessToken });
        }
        if (this.accessToken) return;
      }
    }
    throw new Error("Not signed in with Google");
  }

  isAudioFile(name) {
    return (
      ["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus"].includes(
        name.split(".").pop().toLowerCase()
      )
    );
  }

  cleanFileName(name) {
    return name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");
  }
}
