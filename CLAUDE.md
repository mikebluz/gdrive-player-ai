# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Start Express server at http://localhost:3001
./deploy.sh      # Deploy to GoDaddy cPanel via SFTP (requires lftp)
```

There is no build step, no linter, and no test suite. All JavaScript runs directly in the browser.

## Architecture

This is a browser-based music player that streams audio files from Google Drive. It is a single-page app served by a minimal Express static server (`server.js`).

### Module structure

Four vanilla JS modules are loaded in order via `<script>` tags in `index.html`:

1. **`js/google-drive-api.js`** — `GoogleDriveAPI` class. Initializes `gapi` and Google Identity Services (GIS) OAuth client, handles sign-in/sign-out, searches Drive folders, paginates through audio files, and fetches artist metadata.
2. **`js/music-player.js`** — `MusicPlayer` class. Wraps the HTML5 `<audio>` element, manages blob URL lifecycle (creates on play, revokes on next load), and handles keyboard shortcuts (Space, Arrow keys).
3. **`js/playlist-manager.js`** — `PlaylistManager` class. Owns the track array, renders the playlist DOM, handles drag-and-drop and touch reordering, and implements shuffle (Fisher-Yates, preserves original order for restore).
4. **`js/app.js`** — Wires everything together, manages auth UI state, loads quick-load playlist options from a Drive file named "Serialbox Playlists", and shows loading/toast feedback.

### Event-driven communication

Modules communicate via custom DOM events (no external event bus):

| Event | Source | Consumer |
|---|---|---|
| `authStatusChanged` | `GoogleDriveAPI` | `app.js` (updates UI) |
| `trackLoaded` | `MusicPlayer` | `app.js` |
| `trackEnded` | `MusicPlayer` | `PlaylistManager` (advance track) |
| `requestNextTrack` | `MusicPlayer` | `PlaylistManager` |
| `requestPreviousTrack` | `MusicPlayer` | `PlaylistManager` |

### Key data flows

**Auth:** User clicks connect → GIS OAuth popup → access token stored in `GoogleDriveAPI` instance → `authStatusChanged` fires → UI updates.

**Loading music:** Folder name selected/searched → `driveAPI.searchFolders()` → `driveAPI.getMusicFilesFromFolders()` (paginated) → optionally `driveAPI.fetchArtistName()` from a special "Artist name" file in the folder → `playlist.setTracks()` renders list → first track auto-loads.

**Playback:** `PlaylistManager.playTrack(index)` → `MusicPlayer.loadTrack()` → fetch audio blob from Drive with `Authorization: Bearer <token>` header → blob converted to object URL → set as `<audio>` src → play.

### Google Drive folder convention

The app expects:
- A file named **"Serialbox Playlists"** containing folder names (one per line) used to populate the quick-load dropdown.
- Audio folders optionally containing a file named **"Artist name"** whose first line is used as the artist.
- Supported audio formats: `mp3, wav, flac, aac, ogg, m4a, opus`.

### Google API credentials

`CLIENT_ID` and `API_KEY` are hardcoded in `js/google-drive-api.js`. To use a different Google Cloud project, replace those constants and update the authorized JavaScript origins in the OAuth client configuration. The app uses the `drive.readonly` scope.

### Deployment

`deploy.sh` stages the project, installs production dependencies, and uploads via SFTP using `lftp`. See `pre_deploy.txt` for GoDaddy cPanel prerequisites (Node.js app setup, SFTP credentials).
