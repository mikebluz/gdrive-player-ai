// js/google-drive-api.js
class GoogleDriveAPI {
  constructor({ clientId, apiKey }) {
    this.CLIENT_ID = clientId;
    this.API_KEY = apiKey;
    this.DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
    this.SCOPES = "https://www.googleapis.com/auth/drive.readonly";

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
          alert("Google sign-in failed.");
          return;
        }
        this.accessToken = response.access_token;
        console.log("🔑 Access token acquired");
        document.dispatchEvent(
          new CustomEvent("authStatusChanged", { detail: { isSignedIn: true } })
        );
      },
    });
  }

  async signIn() {
    if (!this.gisTokenClient) throw new Error("Token client not initialized");
    this.gisTokenClient.requestAccessToken({ prompt: "consent" });
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

  async searchFolders(folderName) {
    await this.ensureSignedIn();
    const res = await gapi.client.drive.files.list({
      q: `name contains '${folderName}' and mimeType='application/vnd.google-apps.folder'`,
      fields: "files(id, name, parents)",
    });
    return res.result.files || [];
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
    await this.ensureSignedIn();

    const res = await gapi.client.drive.files.list({
      q: `name = 'Artist name' and '${folderId}' in parents and trashed=false`,
      fields: "files(id, name, mimeType)",
    });
    const files = res.result.files || [];
    if (files.length === 0) return null;

    const file = files[0];
    const isGoogleDoc = file.mimeType === 'application/vnd.google-apps.document';
    const fetchUrl = isGoogleDoc
      ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`
      : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;

    const response = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    if (!response.ok) return null;

    const text = await response.text();
    return text.split('\n').map(l => l.trim()).find(l => l.length > 0) || null;
  }

  async fetchPlaylistOptions(fileName) {
    await this.ensureSignedIn();

    const res = await gapi.client.drive.files.list({
      q: `name = '${fileName}' and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "files(id, name, mimeType)",
    });
    const files = res.result.files || [];
    if (files.length === 0) throw new Error(`File "${fileName}" not found`);

    const file = files[0];
    console.log(`📄 Found "${file.name}" — mimeType: ${file.mimeType}`);

    let fetchUrl;
    switch (file.mimeType) {
      case 'application/vnd.google-apps.document':
        fetchUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`;
        break;
      case 'application/vnd.google-apps.spreadsheet':
        fetchUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv`;
        break;
      default:
        fetchUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
    }

    const response = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);

    const text = await response.text();
    return text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  }

  ensureSignedIn() {
    if (!this.accessToken) throw new Error("Not signed in with Google");
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
