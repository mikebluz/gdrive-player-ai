    // ---- Sign-in toggle --------------------------------------------------
    // Sign-in is REQUIRED to use Bloops (see initSigninGate below): the
    // full-page #signin-gate covers the app until a token is present. Once
    // signed in, this top-bar toggle lets the user sign back OUT (which
    // re-raises the gate). `body.no-google` still gates the Drive-only
    // controls (Save / Load, Export, Listen) as a second layer.
    function _signOutOfGoogle() {
      // Drop the in-process token + cached SharedAuth so the next gapi
      // call has no credential. Don't try to revoke server-side — that
      // would invalidate the token for the Player on other pages too;
      // local clear is what "sign out of Bloops" means here.
      googleAccessToken = null;
      try { window.SharedAuth?.clear?.(); } catch (e) {}
      try {
        if (typeof gapi !== 'undefined' && gapi.client && gapi.client.setToken) {
          gapi.client.setToken({ access_token: '' });
        }
      } catch (e) {}
      try { document.dispatchEvent(new CustomEvent('authStatusChanged', { detail: { isSignedIn: false } })); } catch (e) {}
    }
    (function initSigninToggle() {
      const btn = document.getElementById('signin-toggle-btn');
      if (!btn) return;
      const syncUI = () => {
        const on = !!(window.bloopsAuth && window.bloopsAuth.isSignedIn());
        document.body.classList.toggle('no-google', !on);
        btn.textContent = on ? 'Sign out' : 'Sign in';
        btn.title = on
          ? 'Sign out of Google (Save / Load, Export, and Listen will disable)'
          : 'Sign in with Google to enable Save / Load, Export, and the Listen view';
        btn.classList.toggle('signed-in', on);
        // If the user signs out while parked on the Listen view, bounce
        // them back to Make — the Player can't fetch playlists without
        // a token. .view-serialbox is the class the top-bar tabs flip.
        if (!on && document.body.classList.contains('view-serialbox')) {
          try { document.getElementById('bloops-tab')?.click(); } catch (e) {}
        }
      };
      syncUI();
      btn.addEventListener('click', async () => {
        if (window.bloopsAuth && window.bloopsAuth.isSignedIn()) {
          _signOutOfGoogle();
          syncUI();
          return;
        }
        // Warm up the AudioContext synchronously inside this gesture,
        // BEFORE the OAuth popup invalidates it. iOS only resumes a
        // suspended context if the gesture is still valid, so the
        // silent-buffer trick must run here, not in the OAuth callback
        // (where the gesture is gone). Persistent iOS-unlock listener
        // still covers later gestures if this attempt didn't take.
        try {
          if (typeof Tone !== 'undefined' && Tone.getContext) {
            const ac = Tone.getContext().rawContext;
            if (ac) {
              try { ac.resume?.(); } catch (e) {}
              try {
                const silent = ac.createBufferSource();
                silent.buffer = ac.createBuffer(1, 1, 22050);
                silent.connect(ac.destination);
                silent.start(0);
              } catch (e) {}
            }
            try { Tone.start(); } catch (e) {}
          }
        } catch (e) { console.warn('Audio warm-up failed:', e); }

        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Signing in…';
        try {
          await window.bloopsAuth.signIn();
        } catch (e) {
          console.error('Sign-in failed:', e);
          alert(`Sign-in failed: ${e?.message || e}`);
        } finally {
          btn.disabled = false;
          btn.textContent = original;
          syncUI();
        }
      });
      document.addEventListener('authStatusChanged', syncUI);
    })();

    // ---- Required sign-in gate ------------------------------------------
    // Bloops is gated behind Google sign-in. body.signin-required shows the
    // full-screen #signin-gate and hides the rest of the app (CSS). The
    // inline boot script raises the gate when no cached token exists; here
    // we wire the gate's button and drop / restore .signin-required as the
    // auth state changes (sign-out from the top bar re-raises it).
    (function initSigninGate() {
      const gateBtn = document.getElementById('signin-btn');
      const syncGate = () => {
        const on = !!(window.bloopsAuth && window.bloopsAuth.isSignedIn());
        // Sign-in is only REQUIRED when deployed. On localhost the boot
        // script sets window.BLOOPS_LOCAL and skips the gate, so never
        // re-raise it here (a local sign-out shouldn't lock the app).
        document.body.classList.toggle('signin-required', !on && !window.BLOOPS_LOCAL);
      };
      if (gateBtn) {
        gateBtn.addEventListener('click', async () => {
          if (!window.bloopsAuth) return;
          // Warm up the AudioContext inside this gesture, BEFORE the OAuth
          // popup invalidates it (same iOS-unlock trick the toggle uses).
          try {
            if (typeof Tone !== 'undefined' && Tone.getContext) {
              const ac = Tone.getContext().rawContext;
              if (ac) {
                try { ac.resume?.(); } catch (e) {}
                try {
                  const silent = ac.createBufferSource();
                  silent.buffer = ac.createBuffer(1, 1, 22050);
                  silent.connect(ac.destination);
                  silent.start(0);
                } catch (e) {}
              }
              try { Tone.start(); } catch (e) {}
            }
          } catch (e) { console.warn('Audio warm-up failed:', e); }

          const original = gateBtn.textContent;
          gateBtn.disabled = true;
          gateBtn.textContent = 'Signing in…';
          try {
            await window.bloopsAuth.signIn();
          } catch (e) {
            console.error('Sign-in failed:', e);
            alert(`Sign-in failed: ${e?.message || e}`);
          } finally {
            gateBtn.disabled = false;
            gateBtn.textContent = original;
            syncGate();
          }
        });
      }
      document.addEventListener('authStatusChanged', syncGate);
      syncGate();
    })();

    // Walks a "/"-separated folder path and returns the leaf folder ID,
    // creating any missing segments under My Drive root. Each segment is
    // matched against children of the previous segment (or 'root' for
    // the first), so two `bloops/effects` paths in different parents
    // never collide.
    async function findOrCreateDriveFolder(path) {
      const segments = String(path).split('/').map(s => s.trim()).filter(Boolean);
      if (segments.length === 0) throw new Error('Folder path required');
      let parentId = 'root';
      for (const name of segments) {
        const safe = name.replace(/'/g, "\\'");
        const q = `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
        const list = await gapi.client.drive.files.list({
          q, fields: 'files(id, name)', spaces: 'drive',
        });
        if (list.result.files && list.result.files.length > 0) {
          parentId = list.result.files[0].id;
        } else {
          const create = await gapi.client.drive.files.create({
            resource: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
            fields: 'id',
          });
          parentId = create.result.id;
        }
      }
      return parentId;
    }

    // Find-only path walk — returns the leaf folder ID or null if any
    // segment along the path is missing. Used by the init step to detect
    // which pieces of the bloops/* structure don't yet exist.
    async function findDriveFolderByPath(path) {
      const segments = String(path).split('/').map(s => s.trim()).filter(Boolean);
      if (segments.length === 0) return null;
      let parentId = 'root';
      for (const name of segments) {
        const safe = name.replace(/'/g, "\\'");
        const q = `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
        const list = await gapi.client.drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
        if (!list.result.files || list.result.files.length === 0) return null;
        parentId = list.result.files[0].id;
      }
      return parentId;
    }

    // Look up a single file by name inside a specific parent folder.
    async function findFileInFolder(name, parentId) {
      const safe = String(name).replace(/'/g, "\\'");
      const q = `name='${safe}' and trashed=false and '${parentId}' in parents and mimeType != 'application/vnd.google-apps.folder'`;
      const list = await gapi.client.drive.files.list({ q, fields: 'files(id, name, mimeType)' });
      return (list.result.files && list.result.files[0]) || null;
    }

    // Multipart upload that creates a Google Doc from text content. Drive
    // does the text/plain → application/vnd.google-apps.document
    // conversion server-side when the source body is text/plain and the
    // destination metadata mime is the Google Doc type. Used for the
    // bloops/playlists seed so the user can edit the file in Google Docs
    // directly without an extra "open with" step.
    async function uploadGoogleDocToDrive(name, content, parentId) {
      const boundary = 'bloops_init_' + Math.random().toString(36).slice(2);
      const metadata = {
        name,
        parents: [parentId],
        mimeType: 'application/vnd.google-apps.document',
      };
      const body =
        `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        `--${boundary}\r\n` +
        'Content-Type: text/plain; charset=UTF-8\r\n\r\n' +
        content + '\r\n' +
        `--${boundary}--`;
      const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${googleAccessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      if (!resp.ok) throw new Error(`Upload failed: ${resp.status} ${resp.statusText}`);
      return await resp.json();
    }

    // Init step: ensure the bloops/* folder layout (and the seed
    // playlists file) exists in Drive. Anything missing is listed in a
    // single confirmation dialog so the user opts in once for the whole
    // batch — no per-folder prompts.
    let _bloopsStructureEnsured = false;
    async function ensureBloopsStructure() {
      if (_bloopsStructureEnsured) return;
      const required = [
        { kind: 'folder', path: 'bloops' },
        { kind: 'folder', path: 'bloops/effects' },
        { kind: 'folder', path: 'bloops/projects' },
        { kind: 'folder', path: 'bloops/exports' },
        { kind: 'file',   parentPath: 'bloops', name: 'playlists', content: 'bloops/exports' },
      ];
      const missing = [];
      for (const item of required) {
        if (item.kind === 'folder') {
          const id = await findDriveFolderByPath(item.path);
          if (!id) missing.push(item);
        } else {
          const parentId = await findDriveFolderByPath(item.parentPath);
          if (!parentId) { missing.push(item); continue; }
          const found = await findFileInFolder(item.name, parentId);
          if (!found) missing.push(item);
        }
      }
      if (missing.length === 0) {
        _bloopsStructureEnsured = true;
        return;
      }
      const lines = missing.map(m =>
        m.kind === 'folder'
          ? `  • ${m.path}  (folder)`
          : `  • ${m.parentPath}/${m.name}  (file)`
      ).join('\n');
      const ok = confirm(
        `Bloops needs to set up the following in your Google Drive:\n\n` +
        `${lines}\n\n` +
        `Create them now?`
      );
      if (!ok) return;
      // Create folders first so files can be placed inside.
      for (const item of missing) {
        if (item.kind === 'folder') await findOrCreateDriveFolder(item.path);
      }
      for (const item of missing) {
        if (item.kind === 'file') {
          const parentId = await findOrCreateDriveFolder(item.parentPath);
          await uploadGoogleDocToDrive(item.name, item.content, parentId);
        }
      }
      _bloopsStructureEnsured = true;
    }

    async function uploadJsonToDrive(name, jsonString, folderId, existingFileId) {
      // POST /files for new uploads, PATCH /files/{id} to replace an existing
      // file in place (preserves the file's id / shared links / Drive history).
      const url = existingFileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=resumable`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
      const method = existingFileId ? 'PATCH' : 'POST';
      // PATCH must not include a `parents` field unless paired with the
      // addParents/removeParents query params, so omit it when updating.
      const metadata = existingFileId
        ? { name, mimeType: 'application/json' }
        : { name, parents: [folderId], mimeType: 'application/json' };
      const initResp = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${googleAccessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/json',
        },
        body: JSON.stringify(metadata),
      });
      if (!initResp.ok) throw new Error(`Drive init failed: ${initResp.status} ${await initResp.text()}`);
      const uploadUrl = initResp.headers.get('Location');
      if (!uploadUrl) throw new Error('Drive did not return an upload URL.');
      const putResp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: jsonString,
      });
      if (!putResp.ok) throw new Error(`Drive upload failed: ${putResp.status} ${await putResp.text()}`);
      return putResp.json();
    }

    async function uploadWavToDrive(name, blob, folderId) {
      const initResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${googleAccessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'audio/wav',
        },
        body: JSON.stringify({ name, parents: [folderId], mimeType: 'audio/wav' }),
      });
      if (!initResp.ok) throw new Error(`Drive init failed: ${initResp.status} ${await initResp.text()}`);
      const uploadUrl = initResp.headers.get('Location');
      if (!uploadUrl) throw new Error('Drive did not return an upload URL.');
      const putResp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'audio/wav' },
        body: blob,
      });
      if (!putResp.ok) throw new Error(`Drive upload failed: ${putResp.status} ${await putResp.text()}`);
      return putResp.json();
    }

    // Generic binary upload — used for the per-project assets subfolder
    // (recordings + imported samples). Same resumable flow as the JSON / WAV
    // helpers above, just with a caller-supplied mime type.
    async function uploadBlobToDrive(name, blob, folderId, mimeType) {
      const mime = mimeType || blob.type || 'application/octet-stream';
      const initResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${googleAccessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
        },
        body: JSON.stringify({ name, parents: [folderId], mimeType: mime }),
      });
      if (!initResp.ok) throw new Error(`Drive init failed: ${initResp.status} ${await initResp.text()}`);
      const uploadUrl = initResp.headers.get('Location');
      if (!uploadUrl) throw new Error('Drive did not return an upload URL.');
      const putResp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: blob,
      });
      if (!putResp.ok) throw new Error(`Drive upload failed: ${putResp.status} ${await putResp.text()}`);
      return putResp.json();
    }

    async function fetchDriveBinaryAsBlob(fileId) {
      const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { 'Authorization': `Bearer ${googleAccessToken}` },
      });
      if (!resp.ok) throw new Error(`Drive fetch failed: ${resp.status} ${await resp.text().catch(() => '')}`);
      return resp.blob();
    }

    async function findOrCreateDriveSubfolder(name, parentId) {
      const safeName = name.replace(/'/g, "\\'");
      const q = `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
      const list = await gapi.client.drive.files.list({
        q, fields: 'files(id, name)', spaces: 'drive',
      });
      if (list.result.files && list.result.files.length > 0) return list.result.files[0].id;
      const create = await gapi.client.drive.files.create({
        resource: { name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      return create.result.id;
    }

    // Convert a base64 data URL back to a Blob (round-trip of blobToDataUrl).
    function dataUrlToBlob(dataUrl) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataUrl || '');
      if (!m) return null;
      const mime = m[1] || 'application/octet-stream';
      const isB64 = !!m[2];
      const body = m[3] || '';
      let bytes;
      if (isB64) {
        const bin = atob(body);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        const decoded = decodeURIComponent(body);
        bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      }
      return new Blob([bytes], { type: mime });
    }

    function audioMimeToExt(mime) {
      if (!mime) return '.bin';
      if (mime.includes('webm')) return '.webm';
      if (mime.includes('mpeg')) return '.mp3';
      if (mime.includes('wav') || mime.includes('wave')) return '.wav';
      if (mime.includes('ogg')) return '.ogg';
      if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a';
      if (mime.includes('flac')) return '.flac';
      return '.bin';
    }

    function sanitizeFilename(s) {
      return (s || '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unnamed';
    }

    // Walk a snapshot tree and collect every 'sample:<id>' reference. Catches
    // ids in cellSounds / cellParams / sequence steps / saved sequences /
    // tracks items — wherever the user can pick a sound — without having to
    // enumerate each carrier explicitly.
    function collectSampleIdsFromTree(root) {
      const ids = new Set();
      const visit = (val) => {
        if (val == null) return;
        if (typeof val === 'string') {
          if (val.startsWith('sample:')) ids.add(val.slice(7));
        } else if (Array.isArray(val)) {
          for (const v of val) visit(v);
        } else if (typeof val === 'object') {
          for (const v of Object.values(val)) visit(v);
        }
      };
      visit(root);
      return [...ids];
    }

    // Read a single imported-sample blob from IndexedDB by id.
    async function getImportedSampleRecord(id) {
      try {
        const db = await getImportedDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('blobs', 'readonly');
          const req = tx.objectStore('blobs').get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      } catch (e) { return null; }
    }

    // Unified export options dialog — filename, format (WAV/MP3), sample
    // rate, optional Drive folder. Resolves with the chosen options or
    // null on cancel. Used by both the Drive export and Share flows.
    // Progress modal for long-running renders. Shows a fill bar plus
    // a "23 % — 4.2 s of 18.0 s" readout so the user can tell whether
    // the render is making forward progress vs. stalled. Returned
    // handle exposes setProgress / setLabel / close — caller drives
    // it from renderTracksToBuffer's onProgress + the encode / upload
    // phase transitions.
    function showRenderProgressModal(title, opts = {}) {
      const overlay = document.createElement('div');
      // Non-blocking mode: a corner status card with no backdrop and
      // pointer-events disabled, so the user can keep interacting with the
      // app (e.g. tweak Bloom live while it records in real time).
      overlay.className = 'sm-overlay render-progress-overlay' + (opts.nonBlocking ? ' render-progress-nonblock' : '');
      const modal = document.createElement('div');
      modal.className = 'sm-modal render-progress-modal';
      modal.innerHTML = `
        <div class="sm-title">${title || 'Rendering…'}</div>
        <div class="render-progress-status">Preparing…</div>
        <div class="render-progress-bar"><div class="render-progress-fill" style="width:0%"></div></div>
        <div class="render-progress-pct"></div>
        ${opts.note ? `<div class="render-progress-note">${opts.note}</div>` : ''}
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const statusEl = modal.querySelector('.render-progress-status');
      const fillEl   = modal.querySelector('.render-progress-fill');
      const pctEl    = modal.querySelector('.render-progress-pct');
      return {
        setProgress(pct, sec, totalSec) {
          const clamped = Math.max(0, Math.min(1, Number(pct) || 0));
          if (fillEl) fillEl.style.width = (clamped * 100).toFixed(1) + '%';
          if (pctEl && Number.isFinite(sec) && Number.isFinite(totalSec)) {
            pctEl.textContent = `${(clamped * 100).toFixed(0)} % — ${sec.toFixed(1)} s of ${totalSec.toFixed(1)} s`;
          } else if (pctEl) {
            pctEl.textContent = `${(clamped * 100).toFixed(0)} %`;
          }
        },
        // The phase / status line above the bar. Independent from the
        // percent + time-elapsed line below it so the user can see
        // BOTH "Decoding 5 sample banks…" and "0 % — 0.0 s of 18.0 s"
        // at the same time and know the render is still in setup.
        setStatus(label) {
          if (statusEl) statusEl.textContent = String(label || '');
        },
        setLabel(label) {
          if (statusEl) statusEl.textContent = String(label || '');
        },
        markDone() {
          if (fillEl) fillEl.style.width = '100%';
          if (statusEl) statusEl.textContent = 'Done';
          if (pctEl) pctEl.textContent = '100 %';
        },
        close() { try { overlay.remove(); } catch (e) {} },
      };
    }

    function showExportOptionsDialog(opts = {}) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'sm-overlay';
        const modal = document.createElement('div');
        modal.className = 'sm-modal';
        const defaultName = opts.defaultName || '';
        const defaultFolder = opts.defaultFolder || 'bloops/exports';
        const includeFolder = !!opts.includeFolder;
        const liveRate = (Tone.getContext && Tone.getContext().sampleRate) || 44100;
        const rateOptions = [22050, 32000, 44100, 48000];
        const rateOptionHtml = rateOptions.map(r => {
          const kHz = (r / 1000).toFixed(r === 22050 ? 2 : (r === 32000 ? 0 : 1));
          const note = r === 22050 ? ' (faster, smaller)'
                     : r === 44100 ? ' (CD quality)'
                     : r === 48000 ? ' (studio)'
                     : '';
          return `<option value="${r}">${kHz} kHz${note}</option>`;
        }).join('');
        modal.innerHTML = `
          <div class="sm-title">${opts.title || 'Export'}</div>
          <div class="sm-section-label">File name</div>
          <input type="text" id="exp-name" value="${defaultName}" style="width:100%;padding:6px 10px;background:#0a0a14;border:1px solid #2d2d3f;color:#e2e8f0;border-radius:6px;font-family:inherit;font-size:0.85rem;margin-bottom:10px;" />
          <div class="sm-section-label">Format</div>
          <div style="display:flex;gap:14px;margin-bottom:10px;color:#cbd5e0;font-size:0.85rem;">
            <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="radio" name="exp-fmt" value="wav" checked /> WAV</label>
            <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="radio" name="exp-fmt" value="mp3" /> MP3</label>
          </div>
          <div class="sm-section-label">Sample rate</div>
          <select id="exp-rate" style="width:100%;padding:6px 10px;background:#0a0a14;border:1px solid #2d2d3f;color:#e2e8f0;border-radius:6px;font-family:inherit;font-size:0.85rem;margin-bottom:10px;">
            ${rateOptionHtml}
          </select>
          ${includeFolder ? `
          <div class="sm-section-label">Google Drive folder</div>
          <input type="text" id="exp-folder" value="${defaultFolder}" style="width:100%;padding:6px 10px;background:#0a0a14;border:1px solid #2d2d3f;color:#e2e8f0;border-radius:6px;font-family:inherit;font-size:0.85rem;margin-bottom:10px;" />
          ` : ''}
          <div class="sm-footer">
            <button type="button" class="sm-preview" id="exp-cancel">Cancel</button>
            <button type="button" class="sm-apply" id="exp-go">${opts.applyLabel || 'Export'}</button>
          </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        // Pre-select the live rate when it matches a listed option, so
        // round-tripping the live context's rate is the obvious default.
        const rateSel = modal.querySelector('#exp-rate');
        const liveVal = String(Math.round(liveRate));
        if ([...rateSel.options].some(o => o.value === liveVal)) rateSel.value = liveVal;
        else rateSel.value = '44100';
        const cleanup = () => overlay.remove();
        const dismiss = (val) => { cleanup(); resolve(val); };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(null); });
        modal.querySelector('#exp-cancel').addEventListener('click', () => dismiss(null));
        modal.querySelector('#exp-go').addEventListener('click', () => {
          const filename = (modal.querySelector('#exp-name').value || '').trim() || defaultName;
          if (!filename) { dismiss(null); return; }
          const fmt = (modal.querySelector('input[name="exp-fmt"]:checked')?.value === 'mp3') ? 'mp3' : 'wav';
          const sampleRate = parseInt(rateSel.value, 10) || 44100;
          const folderEl = modal.querySelector('#exp-folder');
          const folder = folderEl ? ((folderEl.value || '').trim() || defaultFolder) : null;
          dismiss({ filename, fmt, sampleRate, folder });
        });
      });
    }

    async function exportTracksToDrive() {
      // Defensive: only run when the Mix view is active. Some
      // browsers fire a stale click on hidden #mix-view children
      // (e.g., during a fast tab swap or when a keyboard shortcut
      // lands on the still-bound button), which would pop the
      // Export dialog on the Make view.
      if (!document.body.classList.contains('view-mix')) return;
      const btn = document.getElementById('tracks-export-btn');
      const anyItems = tracks.some(t => (t.items || []).length > 0);
      if (!anyItems) { alert('Add at least one saved sequence to a track before exporting.'); return; }
      const defaultName = `sounds-mix-${new Date().toISOString().replace(/[:.]/g, '-').slice(0,19)}`;
      const choice = await showExportOptionsDialog({
        title: 'Export to Drive',
        defaultName,
        defaultFolder: 'bloops/exports',
        includeFolder: true,
        applyLabel: 'Export',
      });
      if (!choice) return;
      const { filename, fmt, sampleRate, folder } = choice;
      const ext  = fmt === 'mp3' ? 'mp3' : 'wav';
      const mime = fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav';

      const origText = btn.textContent;
      btn.disabled = true;
      const progress = showRenderProgressModal('Exporting…');
      try {
        btn.textContent = 'Rendering…';
        progress.setStatus('Starting render…');
        const buffer = await renderTracksToBuffer({
          sampleRate,
          onProgress: (pct, sec, totalSec) => progress.setProgress(pct, sec, totalSec),
          onStatus:   (label) => progress.setStatus(label),
        });
        btn.textContent = fmt === 'mp3' ? 'Encoding MP3…' : 'Encoding WAV…';
        progress.setStatus(fmt === 'mp3' ? 'Encoding MP3…' : 'Encoding WAV…');
        const blob = fmt === 'mp3'
          ? await audioBufferToMp3(buffer)
          : audioBufferToWav(buffer);

        btn.textContent = 'Signing in…';
        progress.setStatus('Signing in to Google Drive…');
        await googleSignInForDrive();

        btn.textContent = 'Uploading…';
        progress.setStatus('Uploading to Drive…');
        const folderId = await findOrCreateDriveFolder(folder);
        const file = await uploadBlobToDrive(`${filename}.${ext}`, blob, folderId, mime);

        btn.textContent = 'Saved';
        progress.markDone();
        alert(`Saved "${file.name || filename + '.' + ext}" to Drive folder "${folder}".`);
      } catch (e) {
        console.error(e);
        alert(`Export failed: ${e.message || e}`);
      } finally {
        progress.close();
        setTimeout(() => { btn.disabled = false; btn.textContent = origText; }, 1200);
      }
    }

    document.getElementById('tracks-export-btn').addEventListener('click', exportTracksToDrive);

    // Render the mix and hand the resulting WAV to the system share sheet —
    // on mobile this brings up text/email/chat targets without bouncing
    // through Drive. Falls back to a clear message when the browser doesn't
    // implement the Web Share API for files (e.g. desktop Firefox).
    async function shareTracksAudio() {
      if (!document.body.classList.contains('view-mix')) return;
      const btn = document.getElementById('tracks-share-btn');
      const anyItems = tracks.some(t => (t.items || []).length > 0);
      if (!anyItems) { alert('Add at least one saved sequence to a track before sharing.'); return; }
      if (typeof navigator.share !== 'function') {
        alert('This browser does not support sharing. Use Export to save the file and share it manually.');
        return;
      }
      const defaultName = `bloops-mix-${new Date().toISOString().replace(/[:.]/g, '-').slice(0,19)}`;
      const choice = await showExportOptionsDialog({
        title: 'Share mix',
        defaultName,
        includeFolder: false,
        applyLabel: 'Share',
      });
      if (!choice) return;
      const { filename, fmt, sampleRate } = choice;
      const ext  = fmt === 'mp3' ? 'mp3' : 'wav';
      const mime = fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav';
      const fullName = `${filename}.${ext}`;
      const origText = btn.textContent;
      btn.disabled = true;
      const progress = showRenderProgressModal('Sharing mix…');
      try {
        btn.textContent = 'Rendering…';
        progress.setStatus('Starting render…');
        const buffer = await renderTracksToBuffer({
          sampleRate,
          onProgress: (pct, sec, totalSec) => progress.setProgress(pct, sec, totalSec),
          onStatus:   (label) => progress.setStatus(label),
        });
        btn.textContent = fmt === 'mp3' ? 'Encoding MP3…' : 'Encoding WAV…';
        progress.setStatus(fmt === 'mp3' ? 'Encoding MP3…' : 'Encoding WAV…');
        const blob = fmt === 'mp3'
          ? await audioBufferToMp3(buffer)
          : audioBufferToWav(buffer);
        const file   = new File([blob], fullName, { type: mime });
        if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
          alert('This browser cannot share audio files directly. Use Export to save the file and share it manually.');
          return;
        }
        btn.textContent = 'Sharing…';
        progress.setStatus('Opening share sheet…');
        await navigator.share({
          title: 'Bloops mix',
          text:  'Made with Bloops',
          files: [file],
        });
        btn.textContent = 'Shared';
        progress.markDone();
      } catch (e) {
        // Web Share rejects with AbortError when the user dismisses the
        // share sheet — that's a normal cancel, not an error worth alerting.
        if (e && e.name !== 'AbortError') {
          console.error(e);
          alert(`Share failed: ${e.message || e}`);
        }
      } finally {
        progress.close();
        setTimeout(() => { btn.disabled = false; btn.textContent = origText; }, 1200);
      }
    }
    document.getElementById('tracks-share-btn').addEventListener('click', shareTracksAudio);

    // Capture the whole workspace into a JSON-friendly snapshot — what the
    // user has on screen plus every persisted side-store (saved sequences,
    // tracks, grid states, global FX). Loaded back later via the matching
    // restore path. Imported samples themselves are NOT bundled (their
    // blobs live in IndexedDB and could be megabytes); cell sound types
    // that reference 'sample:<id>' will only resolve on a device that
    // already has the sample registered.
    // Tracks the most recently saved or loaded project name so voice saves
    // can prepend it without re-asking the user. Stays null until a project
    // is named — voice flows then prompt the user for a project name first.
    let currentProjectName = null;

    // Reflects the active project name in the menubar label next to the
    // Project menu trigger. Empty when no project has been named, so the
    // CSS :empty rule keeps the gap from showing.
    function refreshProjectNameLabel() {
      const el = document.getElementById('project-name-label');
      if (!el) return;
      const name = (currentProjectName && currentProjectName.trim()) || '';
      el.textContent = name;
      el.title = name ? `Active project: ${name}` : 'No project loaded';
    }

    // ---- Workspace persistence (survives reloads) ----
    // Debounced snapshot to localStorage so an in-progress project — sequence,
    // grid setup, palette, tempo, modes, project name — comes back on
    // refresh without the user having to "Save". The dedicated per-store
    // persists (savedSequences / tracks / global FX / grid states) keep
    // working independently; this entry is the catch-all for live workspace
    // state that wasn't being written anywhere before.
    const WORKSPACE_LS_KEY = 'bloops-workspace';
    let _workspacePersistTimer = null;
    let _workspacePersistEnabled = false;
    // Synchronous persist — used by beforeunload and pagehide so the
    // very last edit lands before the browser tears the tab down. The
    // debounced persistWorkspace path skips persists that haven't fired
    // their 250 ms timer yet, which is the common case for "user makes
    // one edit and closes the tab."
    function persistWorkspaceNow() {
      if (!_workspacePersistEnabled) return;
      clearTimeout(_workspacePersistTimer);
      _workspacePersistTimer = null;
      const buildSnap = () => {
        const s = buildProjectSnapshot();
        s.currentProjectName = currentProjectName;
        return s;
      };
      try {
        localStorage.setItem(WORKSPACE_LS_KEY, JSON.stringify(buildSnap()));
      } catch (e) {
        try {
          const slim = buildSnap();
          (slim.savedSequences || []).forEach(s => { if (s && s.type === 'audio') delete s.audioDataUrl; });
          (slim.tracks || []).forEach(t => (t.items || []).forEach(it => {
            if (it && it.type === 'audio') delete it.audioDataUrl;
          }));
          localStorage.setItem(WORKSPACE_LS_KEY, JSON.stringify(slim));
        } catch (e2) { /* per-store persists still cover the basics */ }
      }
    }
    function persistWorkspace() {
      if (!_workspacePersistEnabled) return;
      clearTimeout(_workspacePersistTimer);
      _workspacePersistTimer = setTimeout(persistWorkspaceNow, 250);
      // Live-edit invalidation: persistWorkspace runs after every
      // structural mutation (step add / remove / replace, lane
      // shuffle, BPM change, root / scale change, etc.). If a Make-
      // mode sequence is playing, cancel any dispatches scheduled
      // past the 50 ms safety window and rewind affected streams so
      // the walk re-walks from the user's edit. In-place mutations
      // (changing a single field on an existing step object) don't
      // strictly need this — closures already see the live object —
      // but invalidating is cheap (a Map iteration) and correctness
      // wins over the rare structural edits dominate the cost.
      if (typeof _invalidatePlayback === 'function') {
        try { _invalidatePlayback(); } catch (e) {}
      }
    }
    // Auto-serialize on tab close. `pagehide` is the reliable event in
    // modern browsers (beforeunload is suppressed in some cases —
    // mobile Safari, bfcache); we listen for both. The pending debounce
    // is flushed synchronously so the workspace snapshot includes the
    // user's very last edit.
    window.addEventListener('beforeunload', () => { try { persistWorkspaceNow(); } catch (e) {} });
    window.addEventListener('pagehide',     () => { try { persistWorkspaceNow(); } catch (e) {} });

    function buildProjectSnapshot() {
      return {
        version: 1,
        savedAt: new Date().toISOString(),
        workspace: {
          sequence: sequence.map(cloneStep),
          pendingChord: pendingChord.map(p => ({ ...p, params: p.params ? { ...p.params } : undefined })),
          bpm: parseInt(tempoInput?.value, 10) || 120,
          noteLength,
          stepSubdivision,
          // Groove (swing / humanize) — project-wide rhythmic feel.
          groove: {
            swing:       grooveSwing,
            swingDiv:    grooveSwingDiv,
            humanizeMs:  grooveHumanizeMs,
            humanizeVel: grooveHumanizeVel,
            accentEvery: grooveAccentEvery,
            accentAmt:   grooveAccentAmt,
          },
          gridColumns,
          gridRows,
          chordMode: !!chordMode,
          loopMode:  !!loopMode,
          stepMode:  !!stepMode,
          multiSelectMode: !!multiSelectMode,
          activeSeqIndex,
          // Voice-editor open state — restored on reload so the user
          // doesn't have to re-open the grid every session.
          laneExpanderOpen: !!_laneExpanderOpen,
          // Poly-mode state — clone lane step arrays deep so storage
          // doesn't share references with the live workspace.
          polyMode: !!polyMode,
          activeLaneIdx,
          lanes: lanes.map((l, li) => ({
            name: l.name,
            steps: (l.steps || []).map(cloneStep),
            muted: !!l.muted,
            solo:  !!l.solo,
            driftMs:        Number.isFinite(l.driftMs)        ? l.driftMs        : 0,
            driftLocked:    !!l.driftLocked,
            driftOffsetSec: Number.isFinite(l.driftOffsetSec) ? l.driftOffsetSec : 0,
            pan:    Number.isFinite(l.pan)    ? l.pan    : 0,
            volume: Number.isFinite(l.volume) ? l.volume : 100,
            slip:   Number.isFinite(l.slip)   ? l.slip   : 0,
            collapsed: !!l.collapsed,
            fluidGridMode: !!l.fluidGridMode,
            ambientMode: !!l.ambientMode,
            // Bloom config — `playing` is never persisted as true (the
            // generator only ever starts on an explicit gesture).
            ambient: l.ambient ? JSON.parse(JSON.stringify({ ...l.ambient, playing: false })) : null,
            textMode: !!l.textMode,
            seqMode: !!l.seqMode,
            shapeMode: !!l.shapeMode,
            shape: l.shape ? JSON.parse(JSON.stringify(l.shape)) : null,
            text: l.text ? JSON.parse(JSON.stringify(l.text)) : null,
            // Per-lane voice. The active lane's live voice lives in
            // the globals (cellSounds / palette / etc.), so capture
            // those for it instead of relying on l.voice (which may
            // be stale from before the user's last edit). Other lanes
            // already have their voice frozen on their object from
            // the last activate-out — clone it here so the snapshot
            // doesn't share refs with the live workspace.
            voice: (li === activeLaneIdx)
              ? _captureVoiceGlobals()
              : (l.voice ? JSON.parse(JSON.stringify(l.voice)) : null),
            // Per-lane FX send levels — shallow clone so snapshot edits
            // don't share refs with the live lane.sends.
            sends: l.sends ? { ...l.sends } : null,
          })),
          stashedLanes: Array.isArray(_stashedLanes) ? _stashedLanes.map(l => ({
            name: l.name,
            steps: (l.steps || []).map(cloneStep),
            muted: !!l.muted,
            solo:  !!l.solo,
            driftMs:        Number.isFinite(l.driftMs)        ? l.driftMs        : 0,
            driftLocked:    !!l.driftLocked,
            driftOffsetSec: Number.isFinite(l.driftOffsetSec) ? l.driftOffsetSec : 0,
            pan:    Number.isFinite(l.pan)    ? l.pan    : 0,
            volume: Number.isFinite(l.volume) ? l.volume : 100,
            slip:   Number.isFinite(l.slip)   ? l.slip   : 0,
            collapsed: !!l.collapsed,
            fluidGridMode: !!l.fluidGridMode,
            ambientMode: !!l.ambientMode,
            ambient: l.ambient ? JSON.parse(JSON.stringify({ ...l.ambient, playing: false })) : null,
            textMode: !!l.textMode,
            seqMode: !!l.seqMode,
            shapeMode: !!l.shapeMode,
            shape: l.shape ? JSON.parse(JSON.stringify(l.shape)) : null,
            text: l.text ? JSON.parse(JSON.stringify(l.text)) : null,
            voice: l.voice ? JSON.parse(JSON.stringify(l.voice)) : null,
            sends: l.sends ? { ...l.sends } : null,
          })) : null,
        },
        grid: {
          rootIdx,
          baseOctave,
          octaveCount,
          masterFreqA,
          currentScale,
          palette: [...palette],
          chipPalette: [...chipPalette],
          restColor,
          cellSounds: [...cellSounds],
          cellParams: cellParams.map(p => ({ ...p })),
        },
        savedSequences: savedSequences.map(s => JSON.parse(JSON.stringify(s))),
        tracks: tracks.map(t => ({
          id: t.id,
          name: t.name,
          items: t.items,
          loopMode: !!t.loopMode,
          solo: !!t.solo,
          eq: t.eq || { low: 0, mid: 0, high: 0 },
          pan: Number.isFinite(t.pan) ? t.pan : 0,
          stereo: t.stereo !== false,
        })),
        globalFx: { ...globalFx },
        // Master Bloom (Mix) config — global, not per-lane. Never persist playing.
        masterAmbient: (typeof masterAmbient !== 'undefined' && masterAmbient)
          ? JSON.parse(JSON.stringify({ ...masterAmbient, playing: false })) : null,
        savedGridStates: JSON.parse(JSON.stringify(savedGridStates || [])),
        // Ensembles — user-built multi-tone voices (referenced as 'ensemble:<id>').
        ensembles: (typeof ensembles !== 'undefined' && ensembles)
          ? Array.from(ensembles.values()).map(d => JSON.parse(JSON.stringify(d))) : [],
      };
    }

    async function saveProjectToDrive(btn) {
      // Default to the loaded project's name (if any) so re-saving the same
      // project is a one-tap flow even when the user hasn't changed anything.
      const fallbackName = `bloops-project-${new Date().toISOString().replace(/[:.]/g, '-').slice(0,19)}`;
      const defaultName = (currentProjectName && currentProjectName.trim()) || fallbackName;
      const projectName = prompt('Name for this project:', defaultName);
      if (!projectName) return false;
      const filename = projectName.trim().replace(/\.json$/i, '') + '.json';
      const projectBase = filename.replace(/\.json$/i, '');

      const origText = btn ? btn.textContent : '';
      const setBtn = (text) => { if (btn) btn.textContent = text; };
      if (btn) btn.disabled = true;
      let saved = false;
      try {
        setBtn('Building…');
        const snapshot = buildProjectSnapshot();

        setBtn('Signing in…');
        await googleSignInForDrive();

        setBtn('Checking…');
        const folderId = await findOrCreateDriveFolder('bloops/projects');
        const existing = await listProjectsInDrive(folderId);
        // Drive permits multiple files with the same name in one folder, so
        // a strict-match scan is the only way to detect a name collision.
        const match = existing.find(f => f.name === filename);
        let existingFileId = null;
        if (match) {
          // Skip the overwrite confirm when the user accepted the default —
          // that's the "save my loaded project as-is" path and prompting
          // again would just be friction. Any other name match still asks.
          const isReSavingLoaded = currentProjectName && projectName.trim() === currentProjectName.trim();
          if (!isReSavingLoaded) {
            const ok = confirm(`A project named "${projectName.trim()}" already exists in "bloops/projects".\n\nOverwrite it?`);
            if (!ok) {
              setBtn(origText);
              if (btn) btn.disabled = false;
              return false;
            }
          }
          existingFileId = match.id;
        }

        // Extract any embedded audio (recordings + imported samples) to a
        // per-project assets subfolder. The JSON keeps lightweight Drive
        // file references instead of multi-megabyte base64 data URLs, which
        // also keeps the project under Drive's per-file size budget.
        const assetFolderName = `${projectBase}-assets`;
        let assetFolderId = null;
        const ensureAssetFolder = async () => {
          if (!assetFolderId) assetFolderId = await findOrCreateDriveSubfolder(assetFolderName, folderId);
          return assetFolderId;
        };

        // Saved sequences bank — extract audio entries.
        const savedAudioCount = (snapshot.savedSequences || []).filter(s => s && s.type === 'audio' && s.audioDataUrl).length;
        let uploadedSeq = 0;
        if (savedAudioCount > 0) {
          await ensureAssetFolder();
          for (let i = 0; i < snapshot.savedSequences.length; i++) {
            const s = snapshot.savedSequences[i];
            if (!s || s.type !== 'audio' || !s.audioDataUrl) continue;
            const blob = dataUrlToBlob(s.audioDataUrl);
            if (!blob) continue;
            uploadedSeq++;
            setBtn(`Audio ${uploadedSeq}/${savedAudioCount}…`);
            const ext = audioMimeToExt(blob.type);
            const fname = `seq-${String(i + 1).padStart(2, '0')}-${sanitizeFilename(s.name || 'rec')}${ext}`;
            const up = await uploadBlobToDrive(fname, blob, assetFolderId);
            s.audioDriveFileId = up.id;
            s.audioMimeType = blob.type || 'audio/webm';
            delete s.audioDataUrl;
          }
        }

        // Tracks — extract per-track audio items.
        const trackAudioRefs = [];
        (snapshot.tracks || []).forEach((t, ti) => {
          (t.items || []).forEach((it, ii) => {
            if (it && it.type === 'audio' && it.audioDataUrl) {
              trackAudioRefs.push({ ti, ii, item: it, trackName: t.name || `T${ti + 1}` });
            }
          });
        });
        if (trackAudioRefs.length > 0) {
          await ensureAssetFolder();
          for (let k = 0; k < trackAudioRefs.length; k++) {
            const ref = trackAudioRefs[k];
            const blob = dataUrlToBlob(ref.item.audioDataUrl);
            if (!blob) continue;
            setBtn(`Track audio ${k + 1}/${trackAudioRefs.length}…`);
            const ext = audioMimeToExt(blob.type);
            const fname = `track-${ref.ti + 1}-${sanitizeFilename(ref.trackName)}-${String(ref.ii + 1).padStart(2, '0')}-${sanitizeFilename(ref.item.name || 'take')}${ext}`;
            const up = await uploadBlobToDrive(fname, blob, assetFolderId);
            ref.item.audioDriveFileId = up.id;
            ref.item.audioMimeType = blob.type || 'audio/webm';
            delete ref.item.audioDataUrl;
          }
        }

        // Imported samples — only those actually referenced by the project.
        const sampleIds = collectSampleIdsFromTree(snapshot)
          .filter(id => sampleSamplers.get(id)?.imported === true);
        if (sampleIds.length > 0) {
          await ensureAssetFolder();
          snapshot.importedSamples = [];
          for (let k = 0; k < sampleIds.length; k++) {
            const id = sampleIds[k];
            const rec = await getImportedSampleRecord(id);
            if (!rec || !rec.blob) continue;
            setBtn(`Sample ${k + 1}/${sampleIds.length}…`);
            const ext = audioMimeToExt(rec.blob.type);
            const fname = `sample-${sanitizeFilename(id)}${ext}`;
            const up = await uploadBlobToDrive(fname, rec.blob, assetFolderId);
            snapshot.importedSamples.push({
              id,
              name: rec.name || sampleSamplers.get(id)?.name || id,
              driveFileId: up.id,
              mimeType: rec.blob.type || 'application/octet-stream',
              rootNote: sampleSamplers.get(id)?.rootNote || 'C4',
              // Persist the pad/voice metadata too — without padLoop the sample
              // reloads as a one-shot voice (no looping pad) on another device.
              tuneCents: Number.isFinite(rec.tuneCents) ? rec.tuneCents : 0,
              padLoop: !!rec.padLoop,
              padAttack: Number.isFinite(rec.padAttack) ? rec.padAttack : undefined,
              padRelease: Number.isFinite(rec.padRelease) ? rec.padRelease : undefined,
            });
          }
        }

        const jsonString = JSON.stringify(snapshot, null, 2);
        setBtn(existingFileId ? 'Overwriting…' : 'Uploading…');
        const file = await uploadJsonToDrive(filename, jsonString, folderId, existingFileId);

        currentProjectName = projectName.trim();
        refreshProjectNameLabel();
        setBtn(existingFileId ? 'Overwritten' : 'Saved');
        const assetSummary = (savedAudioCount + trackAudioRefs.length + sampleIds.length) > 0
          ? `\n\nAudio + samples were saved into "${assetFolderName}".`
          : '';
        alert(`${existingFileId ? 'Overwrote' : 'Saved'} "${file.name || filename}" in Drive folder "bloops/projects".${assetSummary}`);
        saved = true;
      } catch (e) {
        console.error(e);
        alert(`Save failed: ${e.message || e}`);
      } finally {
        if (btn) setTimeout(() => { btn.disabled = false; btn.textContent = origText; }, 1200);
      }
      return saved;
    }

    // ---- New project ---------------------------------------------------
    // Wipes the in-memory state plus every persisted side-store back to
    // the same shape the app boots into on a clean install. Runs after the
    // user has had a chance to save the current project.
    function resetToDefaultProject() {
      stopSequence();
      stopAllTracks();
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try { mediaRecorder.stop(); } catch (e) {}
      }
      if (_previewAudio) { try { _previewAudio.pause(); } catch (e) {} _previewAudio = null; }

      // Dispose live track audio nodes before we drop the array — same
      // teardown the project-load path uses.
      tracks.forEach(t => {
        if (t._recording) {
          try { t._recorder?.stop(); } catch (e) {}
          if (t._recStream) {
            try { t._recStream.getTracks().forEach(s => s.stop()); } catch (e) {}
          }
          t._recording = false;
          t._recorder = null;
          t._recStream = null;
        }
        if (t._bus)    { try { t._bus.dispose(); }    catch (e) {} t._bus = null; }
        if (t._panner) { try { t._panner.dispose(); } catch (e) {} t._panner = null; }
        if (t._mono)   { try { t._mono.dispose(); }   catch (e) {} t._mono = null; }
        if (t._samplers) {
          t._samplers.forEach(s => { try { s.dispose(); } catch (e) {} });
          t._samplers = null;
        }
        if (t.timer) { clearTimeout(t.timer); t.timer = null; }
      });

      // Workspace.
      sequence = [];
      pendingChord = [];
      selectedStepRefs = [];
      insertionPoint = null;
      activeSeqIndex = null;
      noteLength = 1;
      stepSubdivision = 0.5;
      gridColumns = 8;
      gridRows = 1;
      chordMode = false;
      loopMode = false;
      stepMode = false;
      multiSelectMode = false;

      if (typeof tempoInput  !== 'undefined' && tempoInput)  tempoInput.value  = '120';
      if (typeof tempoSlider !== 'undefined' && tempoSlider) tempoSlider.value = '120';
      wrapTemplate = null;
      activeWrapBankId = null;
      refreshWrapVisuals();
      renderWrapBank();
      clearWrapPendingHighlights();
      document.getElementById('loop-btn')?.classList.remove('active');
      const noteSel  = document.getElementById('note-length');        if (noteSel)  noteSel.value  = '1';
      const subSel   = document.getElementById('subdivision-select'); if (subSel)   subSel.value   = '0.5';
      const colsEl1 = document.getElementById('grid-cols-input'); if (colsEl1) colsEl1.value = '8';
      const rowsEl1 = document.getElementById('grid-rows-input'); if (rowsEl1) rowsEl1.value = '1';
      if (typeof refreshStepModeBtn === 'function') refreshStepModeBtn();
      else document.getElementById('step-mode-btn')?.classList.remove('active');
      const multiCb  = document.getElementById('multi-select-toggle');if (multiCb)  multiCb.checked = false;
      refreshHoldEnabled();

      // Grid (root, octaves, scale, palette, A4) + cell sounds via rebuildGrid.
      resetGridToDefault();

      // Global FX shape/send levels → defaults. Done BEFORE the lane rebuild
      // so the fresh lane's per-lane sends (_defaultLaneSends seeds them from
      // globalFx) start at the defaults, not the prior project's send levels.
      // The FX panel UI sync + applyGlobalFx() below still run afterwards.
      Object.keys(GLOBAL_FX_DEFAULTS).forEach(k => { globalFx[k] = GLOBAL_FX_DEFAULTS[k]; });

      // Variance lanes — dispose the old project's lane audio then rebuild a
      // single fresh lane aliased to the now-empty sequence (matching the
      // gridRows=1 default). Done after resetGridToDefault() so the new lane
      // captures the default voice, not the prior project's. renderSequence()
      // draws straight from lanes[] and never self-initializes, so without
      // this the prior project's lanes stick around after "new project".
      if (typeof disposeAllLaneAudio === 'function' && Array.isArray(lanes)) {
        disposeAllLaneAudio(lanes);
      }
      lanes = [];
      activeLaneIdx = 0;
      if (typeof ensureLanesInitialized === 'function') ensureLanesInitialized();

      // Saved sequences bank.
      savedSequences = [];
      persistSaved();

      // Tracks.
      tracks = [];
      persistTracks();

      // Saved grid states.
      savedGridStates = [];
      persistGridStates();
      refreshGridStateDropdown('');

      // Push the FX defaults (reset above) into the live audio chain + sync
      // the FX panel UI. applyGlobalFx() also re-applies every lane's sends,
      // so the freshly-rebuilt lane lands at the default (dry) send levels.
      applyGlobalFx();
      persistGlobalFx();
      [
        ['fx-rev',         'fx-rev-v',         'reverb',             '%'],
        ['fx-rev-size',    'fx-rev-size-v',    'reverbSize',         '%'],
        ['fx-rev-tone',    'fx-rev-tone-v',    'reverbTone',         '%'],
        ['fx-dly',         'fx-dly-v',         'delay',              '%'],
        ['fx-dly-time',    'fx-dly-time-v',    'delayTime',          ' ms'],
        ['fx-dly-fb',      'fx-dly-fb-v',      'delayFeedback',      '%'],
        ['fx-dst',         'fx-dst-v',         'distortion',         '%'],
        ['fx-cho',         'fx-cho-v',         'chorus',             '%'],
        ['fx-cho-freq',    'fx-cho-freq-v',    'chorusFreq',         ' Hz'],
        ['fx-cho-depth',   'fx-cho-depth-v',   'chorusDepth',        '%'],
        ['fx-vib',         'fx-vib-v',         'vibrato',            '%'],
        ['fx-vib-freq',    'fx-vib-freq-v',    'vibratoFreq',        ' Hz'],
        ['fx-vib-depth',   'fx-vib-depth-v',   'vibratoDepth',       '%'],
        ['fx-trm',         'fx-trm-v',         'tremolo',            '%'],
        ['fx-trm-freq',    'fx-trm-freq-v',    'tremoloFreq',        ' Hz'],
        ['fx-trm-depth',   'fx-trm-depth-v',   'tremoloDepth',       '%'],
        ['fx-phs',         'fx-phs-v',         'phaser',             '%'],
        ['fx-phs-freq',    'fx-phs-freq-v',    'phaserFreq',         ' Hz'],
        ['fx-phs-oct',     'fx-phs-oct-v',     'phaserOctaves',      ''],
        ['fx-af',          'fx-af-v',          'autoFilter',         '%'],
        ['fx-af-freq',     'fx-af-freq-v',     'autoFilterFreq',     ' Hz'],
        ['fx-af-depth',    'fx-af-depth-v',    'autoFilterDepth',    '%'],
        ['fx-af-base',     'fx-af-base-v',     'autoFilterBaseFreq', ' Hz'],
        ['fx-pp',          'fx-pp-v',          'pingPong',           '%'],
        ['fx-pp-time',     'fx-pp-time-v',     'pingPongTime',       ' ms'],
        ['fx-pp-fb',       'fx-pp-fb-v',       'pingPongFeedback',   '%'],
        ['fx-apan',        'fx-apan-v',        'autoPan',            '%'],
        ['fx-apan-freq',   'fx-apan-freq-v',   'autoPanFreq',        ' Hz'],
        ['fx-apan-depth',  'fx-apan-depth-v',  'autoPanDepth',       '%'],
      ].forEach(([id, valId, key, unit]) => {
        const input = document.getElementById(id);
        const label = document.getElementById(valId);
        if (input) input.value = String(globalFx[key]);
        if (label) label.textContent = globalFx[key] + unit;
      });

      currentProjectName = null;
      refreshProjectNameLabel();

      renderSequence();
      renderSavedSequences();
      renderTracks();
      const saveBtn = document.getElementById('save-btn');
      if (saveBtn) saveBtn.disabled = true;
    }

    // 3-button modal: Save first / Don't save / Cancel.
    function askNewProjectChoice() {
      return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'sm-overlay';
        const modal = document.createElement('div');
        modal.className = 'sm-modal';
        modal.innerHTML = `
          <div class="sm-title">Start a new project?</div>
          <div style="color:#a0aec0;font-family:'Segoe UI',sans-serif;font-size:0.85rem;line-height:1.4;margin-bottom:18px;">
            This clears the workspace, tracks, saved sequences, grid states, and effects. Save the current project first?
          </div>
          <div class="sm-footer">
            <button type="button" class="sm-preview" id="np-cancel">Cancel</button>
            <button type="button" class="sm-preview" id="np-discard">Don't save</button>
            <button type="button" class="sm-apply"   id="np-save">Save first…</button>
          </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        const close = (val) => { overlay.remove(); resolve(val); };
        overlay.addEventListener('click', e => { if (e.target === overlay) close('cancel'); });
        modal.querySelector('#np-cancel').addEventListener('click', () => close('cancel'));
        modal.querySelector('#np-discard').addEventListener('click', () => close('discard'));
        modal.querySelector('#np-save').addEventListener('click',   () => close('save'));
      });
    }

    async function newProject(btn) {
      const choice = await askNewProjectChoice();
      if (choice === 'cancel') return;
      if (choice === 'save') {
        const ok = await saveProjectToDrive(btn || null);
        if (!ok) return; // user cancelled the name prompt or the save errored
      }
      resetToDefaultProject();
    }

    // ---- Project menu (New / Save / Load) ----
    (function initProjectMenu() {
      const btn = document.getElementById('project-menu-btn');
      const panel = document.getElementById('project-panel');
      if (!btn || !panel) return;
      const TRIGGER_ID = 'project-menu-btn';
      const setOpen = (open) => {
        panel.classList.toggle('open', open);
        btn.classList.toggle('open', open);
        btn.textContent = open ? 'Project ▴' : 'Project ▾';
        if (open) pinPanelToButton(btn, panel);
      };
      window.addEventListener('resize', () => {
        if (panel.classList.contains('open')) pinPanelToButton(btn, panel);
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !panel.classList.contains('open');
        if (willOpen) document.dispatchEvent(new CustomEvent('menubar-panel-open', { detail: { id: TRIGGER_ID } }));
        setOpen(willOpen);
      });
      document.addEventListener('menubar-panel-open', (e) => {
        if (e.detail?.id !== TRIGGER_ID && panel.classList.contains('open')) setOpen(false);
      });
      document.addEventListener('click', (e) => {
        if (!panel.classList.contains('open')) return;
        if (panel.contains(e.target) || e.target === btn) return;
        setOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false);
      });

      const newBtn  = document.getElementById('project-new-opt');
      const saveBtn = document.getElementById('project-save-opt');
      const loadBtn = document.getElementById('project-load-opt');
      newBtn?.addEventListener('click', async () => {
        setOpen(false);
        await newProject(saveBtn);
      });
      saveBtn?.addEventListener('click', async () => {
        await saveProjectToDrive(saveBtn);
      });
      loadBtn?.addEventListener('click', async () => {
        await loadProjectFromDrive(loadBtn);
      });
      // Import MIDI: open file picker, then run importMidiFile().
      const midiBtn  = document.getElementById('project-import-midi-opt');
      const midiFile = document.getElementById('midi-import-file');
      midiBtn?.addEventListener('click', () => {
        setOpen(false);
        midiFile?.click();
      });
      midiFile?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try { await importMidiFile(file); }
        catch (err) { console.error(err); alert('MIDI import failed: ' + (err.message || err)); }
        finally { midiFile.value = ''; }
      });
    })();

    // ---- MIDI file import ----
    // Reads a .mid via @tonejs/midi (loaded as a global Midi class from
    // the CDN at the top of the page). Each MIDI track becomes a lane
    // (capped at 8 — the existing lane row limit) and each note becomes
    // a single-note step. Step subdivision is approximated from the
    // note's duration in beats so the playback rhythm matches the
    // imported file at the current BPM.
    async function importMidiFile(file) {
      if (typeof Midi === 'undefined') {
        alert('MIDI parser unavailable (Midi.js not loaded).');
        return;
      }
      const buf = await file.arrayBuffer();
      const midi = new Midi(buf);
      const tracks = (midi.tracks || []).filter(t => t.notes && t.notes.length > 0);
      if (tracks.length === 0) { alert('No notes found in MIDI file.'); return; }
      const LANE_CAP = 8;
      const useTracks = tracks.slice(0, LANE_CAP);
      // Map a note duration in beats to a subdivision in Bloops' units
      // (4 = whole, 2 = half, 1 = quarter, 0.5 = 1/8, 0.25 = 1/16, ...).
      // Bloops subdivision is in quarter-note multiples (sub = beats).
      const SUB_VALUES = [0.125, 0.25, 0.5, 1, 2, 4, 8, 12, 16];
      const quantizeSub = (beats) => {
        if (!Number.isFinite(beats) || beats <= 0) return 1;
        let best = SUB_VALUES[0], bestDiff = Infinity;
        SUB_VALUES.forEach(v => {
          const d = Math.abs(beats - v);
          if (d < bestDiff) { bestDiff = d; best = v; }
        });
        return best;
      };
      stopSequence();
      snapshotForUndo('Import MIDI');
      // Resize the lane count to the smaller of (tracks, cap). The
      // existing grid-rows setter trims lanes; recreate lanes from
      // scratch via _makeLane so the per-lane state starts clean.
      const targetLanes = useTracks.length;
      // Trim if needed (preserve existing lanes if user wanted to
      // merge — but for now overwrite cleanly).
      if (Array.isArray(lanes) && lanes.length > 0 && typeof disposeAllLaneAudio === 'function') {
        disposeAllLaneAudio(lanes);
      }
      lanes = [];
      for (let i = 0; i < targetLanes; i++) lanes.push(_makeLane(i));
      // BPM from the MIDI header (use first tempo); falls back to current.
      const tempo = midi.header && Array.isArray(midi.header.tempos) && midi.header.tempos[0];
      if (tempo && Number.isFinite(tempo.bpm)) {
        const bpmEl = tempoInput;
        if (bpmEl) bpmEl.value = String(Math.round(tempo.bpm));
      }
      // Build each lane's step list. Notes are read in time order;
      // gaps between notes become rest steps so timing roughly aligns.
      useTracks.forEach((trk, li) => {
        const lane = lanes[li];
        if (!lane) return;
        const notes = (trk.notes || []).slice().sort((a, b) => a.time - b.time);
        const steps = [];
        let cursor = 0; // beats
        const bpm = Number.isFinite(midi.header.tempos[0]?.bpm) ? midi.header.tempos[0].bpm : 120;
        const beatSec = 60 / bpm;
        notes.forEach(n => {
          const startBeats = n.time / beatSec;
          const durBeats = (n.duration || beatSec * 0.25) / beatSec;
          // Gap before this note → insert rest.
          if (startBeats > cursor + 0.0625) {
            const restBeats = startBeats - cursor;
            steps.push({ freq: null, label: '—', cellIndex: null, duration: 1, subdivision: quantizeSub(restBeats) });
          }
          const freq = 440 * Math.pow(2, ((n.midi || 0) - 69) / 12);
          let label;
          try { label = (typeof Tone !== 'undefined') ? Tone.Frequency(freq).toNote() : ('M' + n.midi); }
          catch (_) { label = 'M' + n.midi; }
          steps.push({
            freq, label,
            cellIndex: (typeof _findCellIdxForFreq === 'function') ? (_findCellIdxForFreq(freq) || null) : null,
            sound: (cellParams[0]?.type) || 'sine',
            params: { ...(cellParams[0] || { type: 'sine' }) },
            duration: 1,
            subdivision: quantizeSub(durBeats),
          });
          cursor = startBeats + durBeats;
        });
        lane.steps = steps;
        lane.name = trk.name || _laneName(li);
      });
      activeLaneIdx = 0;
      _aliasSequenceToActiveLane();
      // Sync the rows input to the new lane count.
      const rowsEl = document.getElementById('grid-rows-input');
      if (rowsEl) rowsEl.value = String(targetLanes);
      gridRows = targetLanes;
      renderSequence();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    // ---- Radial Tone — press-position-sensitive pitch bend per cell ----
    // When on, the cell pointerdown samples the press location and detunes
    // the note accordingly: top/left edges = -25 cents, bottom/right edges
    // = +25 cents, with a center deadzone (no bend). Drag-while-held bends
    // the live note in real time; with Keep on, the final detune is saved
    // into the new step's params.
    let radialTone = false;
    // Per-cell bend trajectory captured during a Radial Tone press.
    //   start    = cents at the press location (initial detune)
    //   end      = cents at the latest pointer position (live)
    //   current  = same as end; tracked separately in case we ever need
    //              to distinguish "live" from "captured-for-save"
    // When the press finalises into a step (click handler / single-voice
    // polyFinalize), start → end becomes a linear pitch ramp baked into
    // step.params.detune + step.bend so playback reproduces the gesture.
    const _radialBend = new Map(); // cellIdx -> { start, current, end }
    function _radialBendInit(cellIdx, cents) {
      _radialBend.set(cellIdx, { start: cents, current: cents, end: cents });
    }
    function _radialBendUpdate(cellIdx, cents) {
      const e = _radialBend.get(cellIdx);
      if (e) { e.current = cents; e.end = cents; }
      else _radialBendInit(cellIdx, cents);
    }
    // Bake the captured trajectory into a step's params + bend, then
    // delete the entry. Returns the mutated step. Safe to call when
    // there's no entry — leaves the step untouched.
    function _radialBendApplyToStep(cellIdx, step) {
      const e = _radialBend.get(cellIdx);
      _radialBend.delete(cellIdx);
      if (!e) return step;
      step.params = step.params ? { ...step.params } : {};
      step.params.detune = e.start;
      const deltaCents = e.end - e.start;
      // Save a linear pitch ramp only if the user actually moved more
      // than a tiny amount; static-bend cases rely on params.detune
      // alone (no bend object → playNote skips its frequency ramp).
      if (Math.abs(deltaCents) > 0.5) {
        step.bend = { semitones: deltaCents / 100, atFraction: 1 };
      }
      return step;
    }
    function radialBendCents(xFrac, yFrac) {
      // Project the press onto the anti-diagonal (top-right ↔ bottom-left
      // is the no-bend ridge). Top-left corner = max negative, bottom-
      // right corner = max positive. ±50 cents = ±½ semitone.
      const proj = (xFrac - 0.5) + (yFrac - 0.5);
      const absP = Math.abs(proj);
      const DEAD = 0.125;          // center deadzone (no bend inside)
      const SPAN = 0.5 - DEAD;     // remaining travel that maps to ±50
      if (absP <= DEAD) return 0;
      const adj = Math.sign(proj) * (absP - DEAD) / SPAN * 50;
      return Math.max(-50, Math.min(50, adj));
    }
    // Update the small "freq Hz" label on a cell to reflect the bent
    // pitch — gives the user visual confirmation that the radial bend
    // is taking effect even if their ear is still calibrating.
    function setCellFreqDisplayCents(cellIdx, cents) {
      const cell = cells[cellIdx];
      const note = notes[cellIdx];
      if (!cell || !note) return;
      const el = cell.querySelector('.cell-freq');
      if (!el) return;
      const bent = note.freq * Math.pow(2, (cents || 0) / 1200);
      const sign = cents > 0 ? '+' : (cents < 0 ? '' : '');
      el.textContent = cents
        ? `${Math.round(bent)} Hz (${sign}${cents.toFixed(0)}¢)`
        : `${Math.round(bent)} Hz`;
    }
    function resetCellFreqDisplay(cellIdx) {
      const cell = cells[cellIdx];
      const note = notes[cellIdx];
      if (!cell || !note) return;
      const el = cell.querySelector('.cell-freq');
      if (el) el.textContent = `${Math.round(note.freq)} Hz`;
    }
    // Disable the Radial Tone button (and force the mode off) when no
    // cell can actually use it — every cell is on a sample tone, which
    // Tone.Sampler can't bend per-voice. Re-evaluated on every tone
    // change via updateScaleBanner. The try/catch guards the cellParams
    // access against the temporal dead zone — the function is defined
    // earlier in the script than the `let cellParams` declaration, so
    // an early call (before the let runs) would otherwise throw
    // ReferenceError instead of being a no-op.
    function refreshRadialToneAvailability() {
      const btn = document.getElementById('radial-tone-btn');
      if (!btn) return;
      let allSamples = false;
      try {
        allSamples = Array.isArray(cellParams) && cellParams.length > 0
          && cellParams.every(p => isSampleType(p?.type));
      } catch (e) {
        return;
      }
      btn.disabled = allSamples;
      btn.title = allSamples
        ? 'Radial Tone — disabled while every cell is on a sample tone (Tone.Sampler can\'t bend per-voice). Pick a synth tone to re-enable.'
        : 'Radial Tone — when on, the press position inside each cell bends the pitch up to ±½ semitone (top/left = down, bottom/right = up). Drag to bend live; with Keep on, the bend is saved with the step.';
      if (allSamples && radialTone) {
        radialTone = false;
        document.body.classList.remove('radial-tone');
      }
    }
    (function initRadialToneToggle() {
      const btn = document.getElementById('radial-tone-btn');
      if (!btn) return;
      const KEY = 'bloops-radial-tone';
      radialTone = localStorage.getItem(KEY) === '1';
      document.body.classList.toggle('radial-tone', radialTone);
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        radialTone = !radialTone;
        document.body.classList.toggle('radial-tone', radialTone);
        try { localStorage.setItem(KEY, radialTone ? '1' : '0'); } catch (e) {}
      });
      // Defer the initial availability check — cellParams is declared
      // further down with `let`, so calling refreshRadialToneAvailability
      // synchronously here hits the temporal dead zone. By the time this
      // microtask runs, the script body has finished executing and
      // cellParams / rebuildGrid have populated.
      setTimeout(refreshRadialToneAvailability, 0);
    })();

    // ---- Edit-mode toggle (sits next to master-vol in the menubar) ----
    // When on, body.edit-mode is added; CSS reveals the per-cell sound-
    // editor carrots. Default off so a fresh load is a clean play view.
    (function initEditModeToggle() {
      const btn = document.getElementById('edit-mode-btn');
      if (!btn) return;
      const KEY = 'bloops-edit-mode';
      const initial = localStorage.getItem(KEY) === '1';
      document.body.classList.toggle('edit-mode', initial);
      // Mirror the on-state onto the button itself so the highlight
      // doesn't depend on body-scoped CSS cascading through deeper
      // selectors. Without this, the in-Sounds-panel button override
      // wins on specificity for some properties and the toggle's
      // visual state appeared stuck on after the first click.
      btn.classList.toggle('active', initial);
      btn.setAttribute('aria-pressed', initial ? 'true' : 'false');
      btn.addEventListener('click', () => {
        const on = !document.body.classList.contains('edit-mode');
        document.body.classList.toggle('edit-mode', on);
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        // Drop tap focus so the button doesn't retain a focus-ring
        // glow on mobile after the user releases.
        try { btn.blur(); } catch (e) {}
        try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {}
      });
    })();

    // ---- Jump mode -------------------------------------------------------
    // When on, every cell press shifts the grid so the pressed note is
    // the new lowest cell. Pressing the same note again drops the grid
    // an octave so that note is now the highest cell; a third press
    // returns it to lowest. Lets the user navigate pitch space by
    // playing rather than fiddling with the ± shift buttons.
    let jumpMode = false;
    let _lastJumpMidi = null;        // MIDI of the last pressed note in jump mode
    let _jumpState = 'low';          // 'low' = pressed note at cell 0; 'high' = at last cell
    // Smart-Triad toggle. When true (and Key mode is on), the first
    // press of a fresh wrap auto-builds the diatonic triad rooted on
    // the pressed pitch's scale degree. Default off — initialized at
    // boot from localStorage by initWrapTriadToggle below.
    let wrapSmartTriad = false;

    // Adjust rootIdx + baseOctave so the cell at `cellIdx` (0 for low,
    // last for high) lands on targetMidi. Snaps the grid into place via
    // rebuildGrid + the usual ancillary refreshes.
    function jumpGridTo(targetMidi, state) {
      const total = 12 * Math.max(1, octaveCount);
      const lastIdx = total - 1;
      let lowMidi = (state === 'high') ? (targetMidi - lastIdx) : targetMidi;
      const MIN_OCT = 0, MAX_OCT = 9;
      const minLow = 12 * (MIN_OCT + 1);          // C at MIN_OCT
      const maxLow = 12 * (MAX_OCT + 1) - lastIdx; // last cell still ≤ B of MAX_OCT
      lowMidi = Math.max(minLow, Math.min(maxLow, lowMidi));
      const newRoot = ((lowMidi % 12) + 12) % 12;
      const newBase = Math.floor(lowMidi / 12) - 1;
      if (newRoot === rootIdx && newBase === baseOctave) return;
      rootIdx = newRoot;
      baseOctave = newBase;
      const rootSel = document.getElementById('root-select');
      const octRange = document.getElementById('octave-range-select');
      if (rootSel)  rootSel.value  = String(rootIdx);
      if (octRange) octRange.value = `${baseOctave}x${octaveCount}`;
      try { rebuildGrid(); } catch (e) { console.warn('jump rebuildGrid failed:', e); }
      if (typeof refreshAllCellFreqLabels === 'function') refreshAllCellFreqLabels();
      if (typeof updateScaleBanner === 'function') updateScaleBanner();
      if (typeof persistWorkspace === 'function') persistWorkspace();
    }

    // Called by the cell-press handler. Plays the pressed note (audio
    // first per the no-lag rule) and then jumps the grid. Returns true
    // when the press was handled — the regular wrap / keep / poly path
    // is skipped in jump mode.
    function handleJumpModePress(cellIdx) {
      if (!jumpMode) return false;
      const note = notes[cellIdx];
      if (!note) return false;
      // Fire audio synchronously before the rebuild. The cell that just
      // got pressed will be replaced in rebuildGrid, but the note is
      // already scheduled so the user hears it without lag.
      try {
        const params = (Array.isArray(cellParams) && cellParams[cellIdx])
          ? { ...cellParams[cellIdx] }
          : undefined;
        playNote(note.freq, params);
      } catch (e) {}
      // Derive MIDI from freq using the same A4 reference the grid uses.
      // Round to nearest semitone — bent / off-tune cells (e.g. radial
      // tone bend) still snap to a clean MIDI for state tracking.
      const midi = Math.round(12 * Math.log2(note.freq / masterFreqA) + 69);
      if (midi === _lastJumpMidi) {
        _jumpState = (_jumpState === 'low') ? 'high' : 'low';
      } else {
        _jumpState = 'low';
        _lastJumpMidi = midi;
      }
      jumpGridTo(midi, _jumpState);
      return true;
    }

    (function initJumpModeToggle() {
      const btn = document.getElementById('jump-mode-btn');
      if (!btn) return;
      const KEY = 'bloops-jump-mode';
      const initial = localStorage.getItem(KEY) === '1';
      jumpMode = initial;
      btn.classList.toggle('active', initial);
      btn.setAttribute('aria-pressed', initial ? 'true' : 'false');
      btn.addEventListener('click', () => {
        jumpMode = !jumpMode;
        btn.classList.toggle('active', jumpMode);
        btn.setAttribute('aria-pressed', jumpMode ? 'true' : 'false');
        // Reset jump tracking whenever the mode itself is toggled so the
        // very first press after enabling always lands as "low" instead
        // of inheriting whatever state was left from a prior session.
        _lastJumpMidi = null;
        _jumpState = 'low';
        try { btn.blur(); } catch (e) {}
        try { localStorage.setItem(KEY, jumpMode ? '1' : '0'); } catch (e) {}
      });
    })();

    (function initWrapTriadToggle() {
      const btn = document.getElementById('wrap-triad-btn');
      if (!btn) return;
      const KEY = 'bloops-wrap-smart-triad';
      const initial = localStorage.getItem(KEY) === '1';
      wrapSmartTriad = initial;
      btn.classList.toggle('active', initial);
      btn.setAttribute('aria-pressed', initial ? 'true' : 'false');
      btn.addEventListener('click', () => {
        wrapSmartTriad = !wrapSmartTriad;
        btn.classList.toggle('active', wrapSmartTriad);
        btn.setAttribute('aria-pressed', wrapSmartTriad ? 'true' : 'false');
        try { btn.blur(); } catch (e) {}
        try { localStorage.setItem(KEY, wrapSmartTriad ? '1' : '0'); } catch (e) {}
      });
    })();

    // ---- Grid On/Off — XY pad fluid mode ----------------------------------
    // Grid On  = discrete cells (current behavior).
    // Grid Off = a blank XY pad. Each axis maps to a configurable param
    //            (pitch or volume). Press anywhere triggers a single
    //            sustained voice; drag bends both params live. The pad
    //            replaces the cell grid in the lane editor.
    let fluidGridMode = false;
    let gameMode = false;
    let progMode = false;
    // Bloom (generative ambient) mode mirror — see 17-ambient.js. Declared
    // here alongside the other mode mirrors so it's initialised before the
    // boot-time _syncFluidGridToActiveLane() call (13-prog-pad.js) reads it.
    let ambientMode = false;
    let textMode = false;
    let seqMode = false;
    let shapeMode = false;
    let _fluidSynth = null;
    let _fluidActive = false;
    let _fluidPointerId = null;
    // Live params from the in-flight XY pad gesture (or null when no
    // press is active). Read by updateKeepLabel so the Keep button can
    // surface the current freq while the user is dragging in Graph mode.
    let _liveXyParams = null;
    // Per-lane fluid-step playback tracker. Records {step, audioStartedAt}
    // so a rAF loop can interpolate the current freq within the gesture
    // and surface it on the Keep button as playback advances.
    const _fluidPlaybackByLane = new Map();
    let _fluidPlaybackRaf = 0;
    // Press recording (Grid Off + Keep). Captures one gesture worth of
    // (t, freq, volume, pan, xFrac, yFrac) samples; flushed to the
    // active lane's sequence as a single fluid step on release. The
    // sequencer then replays the gesture via scheduleStepAt below.
    let _xyRecording = null;
    // Gesture counter — used to pick a distinct color per recorded
    // press-release interval. Golden-angle (137.5°) hue rotation gives
    // every consecutive trail a visually-distinct hue without any
    // single hard-coded palette running out.
    let _xyTrailGestureCount = 0;
    // Per-gesture id — stamped onto every trail dot AND the committed
    // fluid step so playback can light up exactly the dots that belong
    // to the step currently sounding.
    let _xyGestureSeq = 0;
    // Pitch tracking ramps .frequency directly with an exponential
    // curve (equal ratio per second = pitch-linear), so a drag along
    // the X axis sounds like a continuous slide. Earlier versions
    // used a detune-relative model pinned to the attack frequency,
    // which worked for Tone.Synth but didn't transfer cleanly to
    // DuoSynth / MonoSynth's .detune semantics.

    // XY axis configuration — defaults to X = pitch (110–880 Hz, A2–A5)
    // and Y = volume (0–100 percent), inverted so the top of the pad
    // is loud. Persisted to localStorage so the user's last picks
    // survive reloads.
    const XY_DEFAULTS = {
      x: { param: 'pitch',  min: 110, max: 880 },
      y: { param: 'volume', min: 0,   max: 100 },
    };
    let xyConfig = (() => {
      try {
        const raw = JSON.parse(localStorage.getItem('bloops-xy-config') || 'null');
        if (raw && raw.x && raw.y) return raw;
      } catch (e) {}
      return JSON.parse(JSON.stringify(XY_DEFAULTS));
    })();
    // Scale overlay reads the workspace currentScale + rootIdx so
    // changes in the Sounds panel's Scale picker also move the XY
    // pad's guide lines — no duplicate scale dropdown.
    // Audio chain: synth → _fluidVolumeGain → _fluidPanner → globalSendTap.
    // Volume ramps live on the dedicated Gain so they don't fight the
    // synth's internal amplitude envelope (which was producing crunch
    // when we tried to ramp synth.volume in dB during drag). Pan ramps
    // on the separate Panner. Both nodes are built once and reused
    // across tone swaps; only the synth is rebuilt when xyTone changes.
    let _fluidVolumeGain = null;
    let _fluidPanner = null;
    function _ensureFluidPanner() {
      if (_fluidPanner) return _fluidPanner;
      try { _fluidPanner = new Tone.Panner(0).connect(globalSendTap); }
      catch (e) { _fluidPanner = null; }
      return _fluidPanner;
    }
    function _ensureFluidVolumeGain() {
      if (_fluidVolumeGain) return _fluidVolumeGain;
      const panner = _ensureFluidPanner();
      try { _fluidVolumeGain = new Tone.Gain(1).connect(panner || globalSendTap); }
      catch (e) { _fluidVolumeGain = null; }
      return _fluidVolumeGain;
    }
    function _persistXyConfig() {
      try { localStorage.setItem('bloops-xy-config', JSON.stringify(xyConfig)); } catch (e) {}
    }

    // Tones the XY pad's synth can use. Limited to sustained synth
    // types that bend cleanly under frequency / volume / pan ramps —
    // sample / percussive / noise types are excluded since they
    // don't translate to drag-across-the-field gestures. xyTone is
    // derived live from cellSounds[0] (the workspace Tone) when it's
    // in this whitelist, else falls back to 'sine'. That way the
    // Sounds dropdown's Tone… button drives the pad's tone too — no
    // duplicate selector.
    const XY_TONE_WHITELIST = new Set([
      'sine','square','triangle','sawtooth','pulse','fat',
      'fm','am','mono','bass','pad','xylo','bell','duo',
    ]);
    function _currentXyTone() {
      const t = Array.isArray(cellSounds) ? cellSounds[0] : null;
      return (typeof t === 'string' && XY_TONE_WHITELIST.has(t)) ? t : 'sine';
    }
    let _fluidSynthTone = null;
    // Build the right Tone.Synth subclass for the requested type. Each
    // case mirrors the equivalent branch in playNote / startSustainedNote
    // so timbre matches the cell-press version of the same tone.
    function _buildFluidSynth(type) {
      const env = { attack: 0.005, decay: 0.1, sustain: 0.8, release: 0.4 };
      switch (type) {
        case 'pulse':
          return new Tone.Synth({ oscillator: { type: 'pulse', width: 0.4 }, envelope: env });
        case 'fat':
          return new Tone.Synth({ oscillator: { type: 'fatsawtooth', count: 3, spread: 30 }, envelope: env });
        case 'fm':
          return new Tone.FMSynth({ harmonicity: 3, modulationIndex: 10, oscillator: { type: 'sine' }, envelope: env, modulation: { type: 'square' }, modulationEnvelope: { attack: 0.5, decay: 0, sustain: 1, release: 0.5 } });
        case 'am':
          return new Tone.AMSynth({ harmonicity: 2, oscillator: { type: 'sine' }, envelope: env, modulation: { type: 'square' }, modulationEnvelope: { attack: 0.5, decay: 0, sustain: 1, release: 0.5 } });
        case 'mono':
          return new Tone.MonoSynth({ oscillator: { type: 'sawtooth' }, envelope: env, filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.3, release: 2, baseFrequency: 200, octaves: 3 } });
        case 'bass':
          return new Tone.MonoSynth({ oscillator: { type: 'square' }, envelope: env, filterEnvelope: { attack: 0.005, decay: 0.18, sustain: 0.4, release: 0.4, baseFrequency: 80, octaves: 3.2 }, filter: { Q: 4, type: 'lowpass', rolloff: -24 } });
        case 'pad':
          return new Tone.AMSynth({ harmonicity: 1.5, oscillator: { type: 'sine' }, envelope: { attack: 1.2, decay: 0.5, sustain: 0.7, release: 2.5 }, modulation: { type: 'sine' }, modulationEnvelope: { attack: 1.0, decay: 0.5, sustain: 0.5, release: 2.0 } });
        case 'xylo':
          return new Tone.FMSynth({ harmonicity: 7, modulationIndex: 4, oscillator: { type: 'sine' }, envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.3 }, modulation: { type: 'sine' }, modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.2 } });
        case 'bell':
          return new Tone.FMSynth({ harmonicity: 2.14, modulationIndex: 4, oscillator: { type: 'sine' }, envelope: { attack: 0.001, decay: 2.0, sustain: 0.5, release: 0.8 }, modulation: { type: 'sine' }, modulationEnvelope: { attack: 0.001, decay: 0.5, sustain: 0.2, release: 0.5 } });
        case 'duo':
          return new Tone.DuoSynth({ voice0: { oscillator: { type: 'sine' }, envelope: env }, voice1: { oscillator: { type: 'sawtooth' }, envelope: env }, harmonicity: 1.5, vibratoAmount: 0.3, vibratoRate: 5 });
        case 'sine':
        case 'square':
        case 'triangle':
        case 'sawtooth':
        default:
          return new Tone.Synth({ oscillator: { type }, envelope: env });
      }
    }
    function _ensureFluidSynth() {
      // Rebuild when the workspace Tone has changed — but never while
      // a press is in flight, otherwise the active note cuts mid-drag.
      // The swap takes effect on the next press.
      const wantTone = _currentXyTone();
      if (_fluidSynth && _fluidSynthTone === wantTone) return _fluidSynth;
      if (_fluidActive) return _fluidSynth;
      if (_fluidSynth) {
        try { _fluidSynth.disconnect(); } catch (e) {}
        try { _fluidSynth.dispose(); } catch (e) {}
        _fluidSynth = null;
      }
      try {
        // Build the volume gain + panner if missing, then route the
        // synth through the gain so my volume ramps don't compete
        // with the synth's internal amplitude envelope.
        const dest = _ensureFluidVolumeGain() || _ensureFluidPanner() || globalSendTap;
        _fluidSynth = _buildFluidSynth(wantTone).connect(dest);
        _fluidSynthTone = wantTone;
      } catch (e) { _fluidSynth = null; _fluidSynthTone = null; }
      return _fluidSynth;
    }

    // Map a pointer position on the XY surface to (freq, volume).
    // Pitch axes lerp in log space so equal pixels = equal semitones;
    // volume axes lerp linearly in percent space. yFrac is inverted so
    // the top of the pad reads as max, not min.
    function _xyParamsFromPoint(clientX, clientY) {
      const surf = document.getElementById('xy-surface');
      if (!surf) return null;
      const rect = surf.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const xFrac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const yFrac = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const lerpAxis = (axis, frac) => {
        const lo = Number(axis.min);
        const hi = Number(axis.max);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
        if (axis.param === 'pitch') {
          const safeLo = Math.max(1, lo);
          const safeHi = Math.max(safeLo, hi);
          return Math.pow(2, Math.log2(safeLo) + frac * (Math.log2(safeHi) - Math.log2(safeLo)));
        }
        return lo + frac * (hi - lo);
      };
      const xVal = lerpAxis(xyConfig.x, xFrac);
      const yVal = lerpAxis(xyConfig.y, yFrac);
      // Defaults reflect "press anywhere makes sound" — if no axis is
      // mapped to pitch, the voice plays at 440 Hz; volume defaults to
      // full; pan to center. Each axis only writes its mapped field, so
      // mapping the same param to both X and Y has Y win (last write).
      const out = { freq: 440, volume: 100, pan: 0, xFrac, yFrac };
      if (xyConfig.x.param === 'pitch')  out.freq   = xVal;
      if (xyConfig.x.param === 'volume') out.volume = xVal;
      if (xyConfig.x.param === 'pan')    out.pan    = xVal;
      if (xyConfig.y.param === 'pitch')  out.freq   = yVal;
      if (xyConfig.y.param === 'volume') out.volume = yVal;
      if (xyConfig.y.param === 'pan')    out.pan    = yVal;
      return out;
    }

    function _setXyDot(xFrac, yFrac) {
      const dot = document.getElementById('xy-dot');
      if (!dot) return;
      dot.hidden = false;
      dot.style.left = (xFrac * 100) + '%';
      dot.style.top  = ((1 - yFrac) * 100) + '%';
    }
    function _hideXyDot() {
      const dot = document.getElementById('xy-dot');
      if (dot) dot.hidden = true;
    }
    // Recording-trail rendering. Each sample is a tiny dot positioned
    // at the same xFrac/yFrac the pointer was at when it was captured;
    // their collective shape is the gesture's path. Cleared on the
    // next press start (or via _clearXyTrail) so the pad doesn't
    // accumulate forever.
    function _clearXyTrail() {
      const overlay = document.getElementById('xy-overlay');
      if (!overlay) return;
      overlay.querySelectorAll('.xy-trail-dot').forEach(d => d.remove());
    }
    function _appendXyTrailDot(xFrac, yFrac, color, gestureId, sampleIdx) {
      const overlay = document.getElementById('xy-overlay');
      if (!overlay) return;
      const d = document.createElement('div');
      d.className = 'xy-trail-dot';
      d.style.left = (xFrac * 100) + '%';
      d.style.top  = ((1 - yFrac) * 100) + '%';
      if (color) d.style.background = color;
      if (gestureId != null) d.dataset.gestureId = String(gestureId);
      if (sampleIdx != null) d.dataset.sampleIdx = String(sampleIdx);
      overlay.appendChild(d);
    }
    // Golden-angle hue rotation per gesture. Each new press picks the
    // next hue ~137.5° around the wheel so consecutive trails sit on
    // opposite-ish sides of the color circle even after many presses.
    function _nextXyTrailColor() {
      const hue = (_xyTrailGestureCount * 137.508) % 360;
      _xyTrailGestureCount++;
      return `hsla(${hue.toFixed(1)}, 75%, 65%, 0.7)`;
    }
    // Re-render the scale overlay. Skipped when neither axis is mapped
    // to pitch — the overlay is meaningless when both axes are volume
    // or pan, since there's no frequency dimension to label.
    function _renderXyOverlay() {
      const overlay = document.getElementById('xy-overlay');
      if (!overlay) return;
      // Preserve trail dots through a re-render — only the scale
      // guide lines get rebuilt. Without this, every settings change
      // (axis min/max, scale, etc.) would erase the user's recorded
      // path on the pad.
      overlay.querySelectorAll('.xy-grid-line').forEach(n => n.remove());
      const scaleName = (typeof currentScale === 'string') ? currentScale : 'chromatic';
      const semis = (typeof SCALES === 'object' && SCALES) ? SCALES[scaleName] : null;
      if (!Array.isArray(semis) || semis.length === 0) return;
      const xIsPitch = xyConfig.x.param === 'pitch';
      const yIsPitch = xyConfig.y.param === 'pitch';
      if (!xIsPitch && !yIsPitch) return;
      const root = Number.isFinite(rootIdx) ? rootIdx : 0;
      // Safety cap on how many lines we draw per axis — long ranges
      // with a wide scale could otherwise produce hundreds.
      const MAX_LINES = 60;
      const collectNotes = (axis) => {
        const lo = Math.max(1, Number(axis.min) || 1);
        const hi = Math.max(lo + 0.001, Number(axis.max) || lo + 1);
        const lmin = Math.log2(lo);
        const lmax = Math.log2(hi);
        const midiMin = Math.ceil(12 * Math.log2(lo / 440) + 69);
        const midiMax = Math.floor(12 * Math.log2(hi / 440) + 69);
        const out = [];
        for (let m = midiMin; m <= midiMax && out.length < MAX_LINES; m++) {
          const pc = (((m - root) % 12) + 12) % 12;
          if (!semis.includes(pc)) continue;
          const freq = 440 * Math.pow(2, (m - 69) / 12);
          const frac = (Math.log2(freq) - lmin) / (lmax - lmin);
          if (frac < 0 || frac > 1) continue;
          const absPc = ((m % 12) + 12) % 12;
          const color = (Array.isArray(chipPalette) && chipPalette[absPc]) || '#4fd1c5';
          const octave = Math.floor(m / 12) - 1;
          const label = CHROMATIC[absPc] + octave;
          out.push({ frac, color, label });
        }
        return out;
      };
      const buildLine = (frac, color, label, isX) => {
        const line = document.createElement('div');
        line.className = 'xy-grid-line ' + (isX ? 'xy-grid-x' : 'xy-grid-y');
        if (isX) line.style.left = (frac * 100) + '%';
        else     line.style.top  = ((1 - frac) * 100) + '%';
        line.style.background = color;
        const lbl = document.createElement('span');
        lbl.className = 'xy-grid-label';
        lbl.textContent = label;
        lbl.style.color = color;
        line.appendChild(lbl);
        overlay.appendChild(line);
      };
      if (xIsPitch) collectNotes(xyConfig.x).forEach(n => buildLine(n.frac, n.color, n.label, true));
      if (yIsPitch) collectNotes(xyConfig.y).forEach(n => buildLine(n.frac, n.color, n.label, false));
    }
    // Format a single param value for the readout. pitch in Hz with a
    // 'k' suffix above 1000; volume as %; pan as L/C/R notation. Plain
    // integers so the value rounding mirrors what the user typed into
    // the min/max boxes.
    function _fmtXyParam(param, v) {
      if (!Number.isFinite(v)) return '—';
      if (param === 'pitch') {
        const hz = Math.round(v);
        return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz} Hz`;
      }
      if (param === 'volume') return `${Math.round(v)}%`;
      if (param === 'pan') {
        const r = Math.round(v);
        if (r === 0) return 'C';
        return (r < 0 ? 'L' : 'R') + Math.abs(r);
      }
      return String(Math.round(v));
    }
    function _updateXyReadout(params) {
      const readout = document.getElementById('xy-readout');
      if (!readout || !params) return;
      const pickVal = (axisParam) => {
        if (axisParam === 'pitch')  return params.freq;
        if (axisParam === 'volume') return params.volume;
        if (axisParam === 'pan')    return params.pan;
        return null;
      };
      const xLabel = xyConfig.x.param.charAt(0).toUpperCase() + xyConfig.x.param.slice(1);
      const yLabel = xyConfig.y.param.charAt(0).toUpperCase() + xyConfig.y.param.slice(1);
      const xv = _fmtXyParam(xyConfig.x.param, pickVal(xyConfig.x.param));
      const yv = _fmtXyParam(xyConfig.y.param, pickVal(xyConfig.y.param));
      readout.textContent = `${xLabel}: ${xv}  ·  ${yLabel}: ${yv}`;
    }

    function _startFluidPress(params) {
      const s = _ensureFluidSynth();
      if (!s || _fluidActive || !params) return;
      _fluidActive = true;
      _liveXyParams = params;
      try { updateKeepLabel(); } catch (e) {}
      const startFreq = Math.max(1, Number(params.freq) || 440);
      const volGain = Math.max(0, Math.min(1, (Number(params.volume) || 0) / 100));
      const panNorm = Math.max(-1, Math.min(1, (Number(params.pan) || 0) / 100));
      // Pin every signal to the press position before triggerAttack so
      // the synth's envelope opens onto the correct freq / volume / pan
      // immediately. setValueAtTime + linearRampToValueAtTime isn't
      // needed here — we want instant assignment, not a glide.
      try { if (s.frequency) s.frequency.value = startFreq; } catch (e) {}
      try { if (s.detune)    s.detune.value    = 0;         } catch (e) {}
      try { if (_fluidVolumeGain) _fluidVolumeGain.gain.value = volGain; } catch (e) {}
      try { if (_fluidPanner)     _fluidPanner.pan.value     = panNorm; } catch (e) {}
      try { s.triggerAttack(startFreq); } catch (e) {}
    }
    // rAF-throttled update target. pointermove fires up to ~120 Hz on
    // some devices; we coalesce into one audio-graph update per frame
    // (≈60 Hz). Multiple parameter cancellations per ms is what
    // produced the audible crunch — each cancel/reschedule cycle ends
    // the in-flight ramp mid-stride.
    let _xyPendingParams = null;
    let _xyRaf = 0;
    function _scheduleFluidUpdate(params) {
      _xyPendingParams = params;
      if (_xyRaf) return;
      _xyRaf = requestAnimationFrame(() => {
        _xyRaf = 0;
        const p = _xyPendingParams;
        _xyPendingParams = null;
        if (!p) return;
        _applyFluidParams(p);
        _setXyDot(p.xFrac, p.yFrac);
        _updateXyReadout(p);
        _liveXyParams = p;
        try { updateKeepLabel(); } catch (e) {}
      });
    }
    function _applyFluidParams(params) {
      if (!_fluidActive || !_fluidSynth || !params) return;
      const ctx = Tone.context && Tone.context.rawContext;
      const t = (ctx ? ctx.currentTime : Tone.now()) + 0.005;
      // Use Tone's high-level rampTo helpers — they wrap
      // cancelAndHoldAtTime + setValueAtTime + linearRampToValueAtTime
      // so the in-flight automation value is preserved when a new
      // target arrives. Avoids the sub-millisecond discontinuities the
      // manual cancelScheduledValues pattern produced at 60 Hz.
      const RAMP = 0.030;
      if (Number.isFinite(params.freq) && params.freq > 0 && _fluidSynth.frequency) {
        try { _fluidSynth.frequency.exponentialRampTo(Math.max(1, params.freq), RAMP, t); } catch (e) {}
      }
      if (Number.isFinite(params.volume) && _fluidVolumeGain && _fluidVolumeGain.gain) {
        const gain = Math.max(0, Math.min(1, params.volume / 100));
        try { _fluidVolumeGain.gain.linearRampTo(gain, RAMP, t); } catch (e) {}
      }
      if (Number.isFinite(params.pan) && _fluidPanner && _fluidPanner.pan) {
        const panNorm = Math.max(-1, Math.min(1, params.pan / 100));
        try { _fluidPanner.pan.linearRampTo(panNorm, RAMP, t); } catch (e) {}
      }
    }
    function _updateFluidPress(params) {
      // Public wrapper kept for backward compat; routes through the
      // rAF-throttled scheduler so callers don't need to know about it.
      _scheduleFluidUpdate(params);
    }
    function _endFluidPress() {
      if (!_fluidActive || !_fluidSynth) return;
      _fluidActive = false;
      _liveXyParams = null;
      try { updateKeepLabel(); } catch (e) {}
      try { _fluidSynth.triggerRelease(); } catch (e) {}
      _hideXyDot();
    }
    // Linear interpolate the current freq inside a fluid step's
    // sample stream at a given elapsed-time offset. Mirrors the same
    // exponentialRampToValueAtTime curve the audio graph follows — we
    // interpolate in log-space so the Keep readout matches what the
    // ear hears, instead of drifting from the audible pitch on long
    // glides.
    function _fluidFreqAt(step, elapsed) {
      if (!step || !Array.isArray(step.samples) || step.samples.length === 0) return null;
      const s = step.samples;
      if (elapsed <= s[0].t) return Number(s[0].freq) || null;
      const last = s[s.length - 1];
      if (elapsed >= last.t) return Number(last.freq) || null;
      for (let i = 1; i < s.length; i++) {
        if (elapsed <= s[i].t) {
          const a = s[i - 1], b = s[i];
          const af = Math.max(1, Number(a.freq) || 1);
          const bf = Math.max(1, Number(b.freq) || 1);
          const span = Math.max(1e-6, b.t - a.t);
          const t = (elapsed - a.t) / span;
          return af * Math.pow(bf / af, t);
        }
      }
      return Number(last.freq) || null;
    }
    // rAF loop driving live freq updates on the Keep label during
    // fluid-step playback. Reads each lane's recorded (step, audioStart)
    // entry from _fluidPlaybackByLane, interpolates the current freq
    // for the active lane only (the Keep button is per-lane), and
    // calls updateKeepLabel so the readout glides with the gesture.
    function _ensureFluidPlaybackRaf() {
      if (_fluidPlaybackRaf) return;
      const tick = () => {
        if (_fluidPlaybackByLane.size === 0) {
          _fluidPlaybackRaf = 0;
          return;
        }
        const ctx = Tone.context && Tone.context.rawContext;
        const now = ctx ? ctx.currentTime : Tone.now();
        // Expire any entries whose gesture has ended — keeps the map
        // bounded if a scheduled-removal visual is dropped for any
        // reason (tab backgrounded, lookahead jitter).
        for (const [lane, entry] of _fluidPlaybackByLane) {
          const dur = Number(entry.step?.fluidDuration) || 0;
          if (now - entry.audioStartedAt > dur + 0.25) {
            _fluidPlaybackByLane.delete(lane);
          }
        }
        try { updateKeepLabel(); } catch (e) {}
        _fluidPlaybackRaf = requestAnimationFrame(tick);
      };
      _fluidPlaybackRaf = requestAnimationFrame(tick);
    }
    // Append a finished XY recording as a single fluid step on the
    // active lane. step.duration is chosen so the sequencer waits for
    // (roughly) the gesture's natural length before advancing — keeps
    // played-back fluid steps in tempo with the surrounding notes.
    function _commitFluidRecording(rec) {
      if (!rec || !Array.isArray(rec.samples) || rec.samples.length === 0) return;
      const last = rec.samples[rec.samples.length - 1];
      // Minimum 0.15 s so a single-tap recording (just one sample at
      // t=0) gets a meaningful audible hold instead of an instant
      // attack/release click during playback.
      const fluidDur = Math.max(0.15, Number(last.t) || 0);
      const bpm = parseInt(tempoInput?.value, 10) || 120;
      const sub = stepSubdivision;
      const oneStepSec = Math.max(0.001, (60 / bpm) * sub);
      const duration = Math.max(1, Math.round(fluidDur / oneStepSec));
      const first = rec.samples[0];
      const step = {
        isFluid: true,
        tone: rec.tone || _currentXyTone(),
        // Strip xFrac/yFrac to keep the saved step compact — playback
        // only needs t/freq/volume/pan.
        samples: rec.samples.map(s => ({
          t: s.t, freq: s.freq, volume: s.volume, pan: s.pan,
        })),
        fluidDuration: fluidDur,
        duration,
        subdivision: sub,
        // gestureId links this step to its trail dots on the pad so
        // playback can highlight the dots as their corresponding
        // samples are reached. Dots set data-gesture-id at record time.
        gestureId: rec.gestureId,
        // Use the first sample's freq as the chip's display freq /
        // pitch class — drives color tinting in renderSequence.
        freq:  Number.isFinite(first.freq) ? first.freq : null,
        label: 'XY',
      };
      addToSequence(step);
    }
    // Play a fluid step back: build a temporary synth + volume gain +
    // panner chain, schedule the recorded sample stream as a series of
    // ramps from triggerAttack at fireTime through triggerRelease at
    // fireTime + fluidDuration. Disposed automatically after release.
    // destination: optional Tone node to route the panner into. Live
    // Make playback omits it (default globalSendTap → master + FX).
    // Track playback / export pass the per-lane bus head so fluid
    // steps inherit lane volume / pan / FX like every other step.
    function _playFluidStep(step, fireTime, destination) {
      if (!step || !Array.isArray(step.samples) || step.samples.length === 0) return;
      const tone = step.tone || 'sine';
      const isOffline = !!(Tone.getContext && Tone.getContext().isOffline);
      if (isOffline) {
        try {
          console.log('[fluid offline] firing at', fireTime, 'tone=', tone,
            'samples=', step.samples.length, 'hasDest=', !!destination);
        } catch (e) {}
      }
      let synth, panner, gain;
      try {
        const dest = destination || globalSendTap;
        panner = new Tone.Panner(0).connect(dest);
        gain   = new Tone.Gain(1).connect(panner);
        synth  = _buildFluidSynth(tone).connect(gain);
      } catch (e) {
        if (isOffline) console.warn('[fluid offline] build failed', e);
        try { synth?.dispose(); } catch (err) {}
        try { gain?.dispose(); } catch (err) {}
        try { panner?.dispose(); } catch (err) {}
        return;
      }
      // Offline render: park strong refs to every node we just built
      // in the offline voice-ref array. Without this the GC can claim
      // them before the offline OfflineAudioContext flushes their
      // scheduled events — making XY recordings silent in the exported
      // WAV even though they sound fine in live playback.
      if (Array.isArray(_offlineVoiceRefs)) {
        _offlineVoiceRefs.push(synth);
        _offlineVoiceRefs.push(gain);
        _offlineVoiceRefs.push(panner);
      }
      const first = step.samples[0];
      const initFreq = Math.max(1, Number(first.freq) || 440);
      const initGain = Math.max(0, Math.min(1, (Number(first.volume) || 0) / 100));
      const initPan  = Math.max(-1, Math.min(1, (Number(first.pan) || 0) / 100));
      try { synth.frequency.value = initFreq; } catch (e) {}
      try { gain.gain.value = initGain; } catch (e) {}
      try { panner.pan.value = initPan; } catch (e) {}
      try { synth.triggerAttack(initFreq, fireTime); } catch (e) {}
      for (let i = 1; i < step.samples.length; i++) {
        const s = step.samples[i];
        const at = fireTime + (Number(s.t) || 0);
        const f = Math.max(1, Number(s.freq) || 440);
        const v = Math.max(0.0001, Math.min(1, (Number(s.volume) || 0) / 100));
        const p = Math.max(-1, Math.min(1, (Number(s.pan) || 0) / 100));
        try { synth.frequency.exponentialRampToValueAtTime(f, at); } catch (e) {}
        try { gain.gain.linearRampToValueAtTime(v, at); } catch (e) {}
        try { panner.pan.linearRampToValueAtTime(p, at); } catch (e) {}
      }
      const lastT = Number(step.samples[step.samples.length - 1].t) || 0;
      const releaseAt = fireTime + lastT + 0.05;
      try { synth.triggerRelease(releaseAt); } catch (e) {}
      // Highlight each trail dot as its sample is reached. Visual-only,
      // separate from the audio scheduling. Uses scheduleVisual (which
      // accounts for Tone's audio-thread lookahead) so the flashes line
      // up with what's actually sounding. Dots may be missing if the
      // user cleared the pad or reloaded since recording — that's fine,
      // the querySelector just returns null and we skip.
      const gid = step.gestureId;
      // (isOffline already captured at top of function.)
      if (!isOffline && gid != null && typeof scheduleVisual === 'function') {
        step.samples.forEach((s, i) => {
          const at = fireTime + (Number(s.t) || 0);
          scheduleVisual(() => {
            const dot = document.querySelector(
              `.xy-trail-dot[data-gesture-id="${gid}"][data-sample-idx="${i}"]`
            );
            if (!dot) return;
            dot.classList.add('playing');
            setTimeout(() => dot.classList.remove('playing'), 140);
          }, at);
        });
      }
      // Dispose after the synth's natural release tail. Wall-clock
      // setTimeout because Tone doesn't expose post-trigger callbacks.
      // Skipped during offline render — the OfflineContext disposes
      // every node when Tone.Offline finishes, and a stray wall-clock
      // timer could (in theory) fire mid-render and disconnect nodes
      // before their scheduled events have been consumed by the
      // OfflineAudioContext.
      if (!isOffline) {
        const ctxNow = (Tone.context && Tone.context.rawContext) ? Tone.context.rawContext.currentTime : Tone.now();
        const disposeMs = Math.max(0, (releaseAt - ctxNow + 1.5)) * 1000;
        setTimeout(() => {
          try { synth.disconnect(); synth.dispose(); } catch (e) {}
          try { gain.disconnect();  gain.dispose();  } catch (e) {}
          try { panner.disconnect(); panner.dispose(); } catch (e) {}
        }, disposeMs);
      }
    }

    // Pointer event wiring on the XY surface. The handlers short-
    // circuit when fluidGridMode is off so they don't run while the
    // pad is hidden.
    (function bindXyPadHandlers() {
      const surf = document.getElementById('xy-surface');
      if (!surf) return;
      surf.addEventListener('pointerdown', (e) => {
        if (!fluidGridMode) return;
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        const p = _xyParamsFromPoint(e.clientX, e.clientY);
        if (!p) return;
        e.preventDefault();
        _fluidPointerId = e.pointerId;
        try { surf.setPointerCapture(e.pointerId); } catch (err) {}
        _startFluidPress(p);
        _setXyDot(p.xFrac, p.yFrac);
        _updateXyReadout(p);
        // Begin recording if Keep mode is on. Trails accumulate across
        // gestures — each press picks a new hue so the user can see
        // every recorded interval distinctly. Clear is the only path
        // that wipes the pad.
        if (keepMode) {
          const color = _nextXyTrailColor();
          _xyGestureSeq++;
          const gestureId = _xyGestureSeq;
          _xyRecording = {
            startedAt: performance.now(),
            tone: _currentXyTone(),
            color,
            gestureId,
            samples: [{ t: 0, freq: p.freq, volume: p.volume, pan: p.pan, xFrac: p.xFrac, yFrac: p.yFrac }],
          };
          _appendXyTrailDot(p.xFrac, p.yFrac, color, gestureId, 0);
        }
      });
      surf.addEventListener('pointermove', (e) => {
        if (!fluidGridMode || !_fluidActive || e.pointerId !== _fluidPointerId) return;
        const p = _xyParamsFromPoint(e.clientX, e.clientY);
        if (!p) return;
        _scheduleFluidUpdate(p);
        if (_xyRecording) {
          const t = (performance.now() - _xyRecording.startedAt) / 1000;
          // Skip near-duplicate samples (didn't move enough since the
          // last) — keeps the recorded samples list compact.
          const last = _xyRecording.samples[_xyRecording.samples.length - 1];
          const dx = Math.abs(p.xFrac - (last ? last.xFrac : 0));
          const dy = Math.abs(p.yFrac - (last ? last.yFrac : 0));
          if (dx > 0.003 || dy > 0.003 || t - last.t > 0.05) {
            const sampleIdx = _xyRecording.samples.length;
            _xyRecording.samples.push({ t, freq: p.freq, volume: p.volume, pan: p.pan, xFrac: p.xFrac, yFrac: p.yFrac });
            _appendXyTrailDot(p.xFrac, p.yFrac, _xyRecording.color, _xyRecording.gestureId, sampleIdx);
          }
        }
      });
      const endPress = (e) => {
        if (e.pointerId !== _fluidPointerId) return;
        _fluidPointerId = null;
        _endFluidPress();
        // Flush the recording (if any) into the active lane's sequence
        // as a single fluid step — even a single press with no drag
        // commits (one-sample recording is treated as a brief hold of
        // that position in _commitFluidRecording). The trail stays on
        // the pad until the next press / Clear for visual confirmation.
        if (_xyRecording && _xyRecording.samples.length >= 1) {
          // Stamp the actual press duration onto the last sample so
          // single-point presses get an audible hold length instead
          // of triggerAttack → immediate release.
          const endT = (performance.now() - _xyRecording.startedAt) / 1000;
          const lastIdx = _xyRecording.samples.length - 1;
          if (_xyRecording.samples[lastIdx].t < endT) {
            // For multi-sample recordings: extend the final t to the
            // actual release time so playback holds the last position
            // through the natural press duration.
            _xyRecording.samples[lastIdx] = { ..._xyRecording.samples[lastIdx], t: endT };
          }
          try { _commitFluidRecording(_xyRecording); } catch (err) {}
        }
        _xyRecording = null;
      };
      surf.addEventListener('pointerup', endPress);
      surf.addEventListener('pointercancel', endPress);
    })();

    // Wire the X/Y param + min/max controls. Defaults restore on
    // param change so switching from pitch → volume doesn't leave
    // a stale Hz range in the volume axis (or vice versa).
    (function bindXyPadControls() {
      const ids = {
        xParam: document.getElementById('xy-x-param'),
        xMin:   document.getElementById('xy-x-min'),
        xMax:   document.getElementById('xy-x-max'),
        yParam: document.getElementById('xy-y-param'),
        yMin:   document.getElementById('xy-y-min'),
        yMax:   document.getElementById('xy-y-max'),
      };
      // Defer initial overlay render past the temporal dead zone for
      // SCALES (declared further down). Without the defer, the IIFE
      // throws at typeof SCALES and halts the rest of init.
      setTimeout(() => {
        try { _renderXyOverlay(); } catch (e) {}
      }, 0);
      const refresh = () => {
        if (!ids.xParam) return;
        ids.xParam.value = xyConfig.x.param;
        ids.xMin.value   = xyConfig.x.min;
        ids.xMax.value   = xyConfig.x.max;
        ids.yParam.value = xyConfig.y.param;
        ids.yMin.value   = xyConfig.y.min;
        ids.yMax.value   = xyConfig.y.max;
        try { _renderXyOverlay(); } catch (e) {}
      };
      refresh();
      const onParamChange = (axis, sel, defaults) => {
        sel?.addEventListener('change', () => {
          xyConfig[axis].param = sel.value;
          // Reset min/max to sensible defaults for the new param so
          // a Hz range doesn't carry into a percent axis.
          xyConfig[axis].min = defaults[xyConfig[axis].param].min;
          xyConfig[axis].max = defaults[xyConfig[axis].param].max;
          refresh();
          _persistXyConfig();
          try { _renderXyOverlay(); } catch (e) {}
        });
      };
      const paramDefaults = {
        pitch:  { min: 110, max: 880 },
        volume: { min: 0,   max: 100 },
        pan:    { min: -100, max: 100 },
      };
      onParamChange('x', ids.xParam, paramDefaults);
      onParamChange('y', ids.yParam, paramDefaults);
      const onMinMax = (input, axis, field) => {
        input?.addEventListener('input', () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          xyConfig[axis][field] = v;
          _persistXyConfig();
          try { _renderXyOverlay(); } catch (e) {}
        });
      };
      onMinMax(ids.xMin, 'x', 'min');
      onMinMax(ids.xMax, 'x', 'max');
      onMinMax(ids.yMin, 'y', 'min');
      onMinMax(ids.yMax, 'y', 'max');
    })();
