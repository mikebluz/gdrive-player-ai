// js/app.js
document.addEventListener("DOMContentLoaded", () => {
  // --- DOM Element References ---
  const authorizeBtn = document.getElementById("authorize-btn");
  const signoutBtn = document.getElementById("signout-btn");
  const userStatus = document.getElementById("user-status");
  const infoBox = document.querySelector(".info-box");
  const loadingEl = document.getElementById("loading");
  const playlistSelect = document.getElementById("playlist-select");
  const mainContent = document.getElementById("main-content");
  const footer = document.getElementById("footer");

  // --- Core Objects (classes come from separate files) ---
  let driveAPI, player, playlist;
  let lastDriveFolderName = null;
  let _artworkBlobUrl = null;
  const albumArtImg = document.getElementById("album-art-img");
  const albumPlaceholder = document.getElementById("album-placeholder");
  const blobCache = new BlobCache();
  const addToTrackBtn = document.getElementById("add-to-track-btn");
  // OFFLINE (2026-07-16): the per-track cache model is gone. One switch saves
  // THE WHOLE CURRENT PLAYLIST to this device; loading a different playlist
  // deletes the old copy first (one playlist offline at a time, never stale).
  // State: OFFLINE_KEY holds {on, name, tracks:[{id,name,size}]} so the saved
  // playlist can also BOOT offline (no Drive listing needed).
  const offlineBtn = document.getElementById("offline-btn");
  const offlineBtnContainer = offlineBtn?.closest(".cache-btn-container");
  const OFFLINE_KEY = "gdrivePlayerOffline";
  const offlineIds = new Set();          // shared with PlaylistManager (indicators / fast path)
  let _offlineSaveGen = 0;               // aborts a save when the playlist changes mid-download
  const offlineState = () => { try { return JSON.parse(localStorage.getItem(OFFLINE_KEY) || "null"); } catch { return null; } };
  const setOfflineState = (st) => { try { st ? localStorage.setItem(OFFLINE_KEY, JSON.stringify(st)) : localStorage.removeItem(OFFLINE_KEY); } catch {} };

  // Click → save the currently selected track as a sequencer chip in
  // Bloops + drop it on a fresh stereo track. Mirrors the long-press
  // "Copy to Make track" menu on individual playlist rows so the user
  // can also act on the active track without scrolling the playlist.
  addToTrackBtn?.addEventListener("click", async () => {
    if (typeof window.bloopsImportAudio !== "function") {
      alert("Make import isn't available — Bloops side hasn't loaded yet.");
      return;
    }
    const idx = playlist?.currentIndex;
    const track = (idx >= 0) ? playlist?.tracks?.[idx] : null;
    if (!track) {
      alert("No track selected.");
      return;
    }
    const original = addToTrackBtn.textContent;
    addToTrackBtn.disabled = true;
    addToTrackBtn.textContent = "Adding…";
    try {
      // Reuse the playlist manager's tiered blob fetch (in-memory →
      // persistent cache → Drive) so we don't pay for a network round-
      // trip when the bytes are already local.
      const blob = await playlist._getTrackBlob(track);
      const entry = await window.bloopsImportAudio(blob, track.name);
      addToTrackBtn.textContent = `Added "${entry?.name || track.name}"`;
      setTimeout(() => { addToTrackBtn.textContent = original; }, 1600);
    } catch (e) {
      console.error("Add to Make track failed:", e);
      alert(`Couldn't add to Make: ${e?.message || e}`);
      addToTrackBtn.textContent = original;
    } finally {
      addToTrackBtn.disabled = false;
    }
  });

  // --- Initialization ---
  (async function initApp() {
    try {
      showLoading("Initializing Google Drive API...");
      driveAPI = new GoogleDriveAPI(window.APP_CONFIG);
      player = new MusicPlayer(driveAPI, blobCache);
      playlist = new PlaylistManager(player, offlineIds);
      // Exposed so the Bloops/Make side of the unified page can pause
      // playback when the user switches away from the Listen view, and
      // lazy-load the track when the Listen view is opened.
      window.musicPlayer = player;
      window.playlist = playlist;

      // Pre-set the UI from cached auth before gapi/GIS scripts load —
      // otherwise mobile users see the "Connect to Google Drive" header
      // for the seconds it takes initialize() to finish on a slow link,
      // which reads as a re-prompt even though no popup will actually
      // fire. The hydrate inside initialize() then dispatches the real
      // event so loadQuickLoadOptions runs.
      if (window.SharedAuth?.load?.()) {
        updateUIAuthState(true);
      }

      await driveAPI.initialize();

      hideLoading();
      // Reflect the real auth state — initialize() may have hydrated a
      // cached token (via SharedAuth) and already dispatched signed-in.
      // Unconditionally clobbering to false here flips the UI back to
      // the Connect button after the listener just lifted it.
      updateUIAuthState(!!driveAPI.accessToken);

      console.log("✅ App initialized successfully");
    } catch (err) {
      console.error("❌ Initialization error:", err);
      showError("Failed to initialize Google Drive API.");
    }
  })();

  // --- Auth UI Handlers ---
  authorizeBtn?.addEventListener("click", async () => {
    try {
      showLoading("Connecting to Google Drive...");
      await driveAPI.signIn();
      // GIS callback handles setting authStatusChanged event
    } catch (err) {
      console.error("Sign-in error:", err);
      showError("Failed to sign in to Google Drive.");
    } finally {
      hideLoading();
    }
  });

  signoutBtn?.addEventListener("click", () => {
    driveAPI.signOut();
  });

  playlistSelect?.addEventListener("change", (e) => {
    const value = e.target.value;
    if (!value) return;
    e.target.value = "";
    loadMusicFromDrive(value);
  });

  // --- Event: Auth Status Changed ---
  document.addEventListener("authStatusChanged", async (e) => {
    const { isSignedIn } = e.detail;
    updateUIAuthState(isSignedIn);
    if (isSignedIn) {
      showLoading("Loading your playlists...");
      await loadQuickLoadOptions();
    }
  });

  // When the user returns to the tab after an idle period:
  // 1. Refresh the token if it's near expiry
  // 2. Rebuild the prefetch window so the next tracks are cached before the
  //    current track ends — prevents iOS from blocking audio.play() after awaits
  //    in the 'ended' event handler chain.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && driveAPI?.accessToken) {
      const timeLeft = (driveAPI._tokenExpiry || 0) - Date.now();
      if (timeLeft < 5 * 60 * 1000) {
        try { await driveAPI.refreshTokenSilently(); } catch {}
      }
      if (playlist?.currentIndex >= 0) {
        playlist._buildPrefetchWindow(playlist.currentIndex);
      }
    }
  });

  // Hide loading banner when first track is ready to play
  document.addEventListener("trackLoaded", (e) => {
    hideLoading();
    unfreezeUI();
    updateOfflineBtn();
  });

  // ---- Make available offline (whole current playlist) -------------------
  function updateOfflineBtn(saving) {
    if (!offlineBtn) return;
    const hasTracks = !!(playlist && playlist.tracks && playlist.tracks.length);
    if (offlineBtnContainer) offlineBtnContainer.style.display = hasTracks ? "" : "none";
    if (saving != null) { offlineBtn.textContent = saving; return; }
    const st = offlineState();
    const here = st && st.on && st.name === lastDriveFolderName;
    offlineBtn.textContent = here ? "✓ Available offline — tap to remove" : "📥 Make available offline";
    offlineBtn.disabled = false;
  }
  async function refreshOfflineIds() {
    offlineIds.clear();
    try { (await blobCache.keys()).forEach((k) => offlineIds.add(k)); } catch {}
    playlist?.refreshCacheIndicators();
  }
  async function clearOffline() {
    ++_offlineSaveGen;
    setOfflineState(null);
    try { await blobCache.clear(); } catch {}
    await refreshOfflineIds();
    updateOfflineBtn();
  }
  async function saveCurrentPlaylistOffline() {
    if (!player || !playlist || !playlist.tracks || !playlist.tracks.length) return;
    const gen = ++_offlineSaveGen;
    const tracks = playlist.tracks.map((t) => ({ id: t.id, name: t.name, size: t.size ?? null }));
    const plName = lastDriveFolderName;
    offlineBtn && (offlineBtn.disabled = true);
    let done = 0, failed = 0;
    for (const t of tracks) {
      if (gen !== _offlineSaveGen) return;              // playlist changed — abort silently
      try {
        if (!(await blobCache.has(t.id))) await player.persistTrack(t);   // verified fetch + store
        if (await blobCache.has(t.id)) offlineIds.add(t.id); else failed++;
      } catch { failed++; }
      done++;
      updateOfflineBtn(`Saving… ${done}/${tracks.length}`);
      if (done % 3 === 0) playlist?.refreshCacheIndicators();
    }
    if (gen !== _offlineSaveGen) return;
    setOfflineState({ on: true, name: plName, tracks });
    playlist?.refreshCacheIndicators();
    updateOfflineBtn(failed ? `Offline (${tracks.length - failed}/${tracks.length} saved)` : null);
    if (!failed) updateOfflineBtn();
  }
  offlineBtn?.addEventListener("click", async () => {
    const st = offlineState();
    if (st && st.on && st.name === lastDriveFolderName) {
      if (typeof confirm === "function" && !confirm("Remove this playlist from offline storage?")) return;
      await clearOffline();
    } else {
      await clearOffline();                              // one playlist at a time
      await saveCurrentPlaylistOffline();
    }
  });

  async function loadQuickLoadOptions() {
    try {
      const options = await driveAPI.fetchPlaylistOptions("bloops/playlists");
      playlistSelect.innerHTML = '<option value="">— Folders —</option>';
      options.forEach(name => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        playlistSelect.appendChild(opt);
      });
      if (options.length > 0) await loadMusicFromDrive(options[0]);
    } catch (err) {
      console.error("Could not load Quick Load options:", err);
      hideLoading();
      unfreezeUI();
      // OFFLINE boot: no Drive listing (offline / auth down) — if a playlist
      // was saved for offline, load it straight from the stored track list;
      // playback then comes from the blob store with zero network.
      const st = offlineState();
      if (st && st.on && Array.isArray(st.tracks) && st.tracks.length && player && playlist) {
        player.defaultArtist = null;
        document.getElementById("playlist-heading-name").textContent = (st.name || "Offline") + " (offline)";
        setAlbumArt(null);
        playlist.setTracks(st.tracks);
        lastDriveFolderName = st.name || null;
        showPlayerSections();
        await refreshOfflineIds();
        updateOfflineBtn();
        return;
      }
      showError(`Could not load Quick Load options: ${err?.message || err}`);
    }
  }

  // --- Helper: Load music files from Drive ---
  async function loadMusicFromDrive(folderName) {
    if (!driveAPI.accessToken) {
      showError("You must sign in first!");
      return;
    }

    freezeUI();
    try {
      showLoading(`Searching for "${folderName}"...`);

      const folders = await driveAPI.searchFolders(folderName);
      if (folders.length === 0) {
        hideLoading();
        unfreezeUI();
        showError(`No folders found named "${folderName}".`);
        return;
      }

      showLoading("Loading music files...");
      const [musicFiles, artistName, artworkBlobUrl] = await Promise.all([
        driveAPI.getMusicFilesFromFolders(folders),
        driveAPI.fetchArtistName(folders[0].id),
        driveAPI.fetchArtworkBlobUrl(folders[0].id),
      ]);

      if (musicFiles.length === 0) {
        hideLoading();
        unfreezeUI();
        showError(`No music files found in folders named "${folderName}".`);
        return;
      }

      showLoading("Preparing first track...");
      player.defaultArtist = artistName || null;
      document.getElementById("playlist-heading-name").textContent = folderName;
      setAlbumArt(artworkBlobUrl);
      playlist.setTracks(musicFiles);
      showPlayerSections();
      lastDriveFolderName = folderName;
      // OFFLINE handoff: a DIFFERENT playlist replaces the stored one — wipe
      // the old copy, and if the offline switch was on, save this playlist.
      {
        const st = offlineState();
        if (st && st.name !== folderName) {
          const wasOn = !!st.on;
          await clearOffline();
          if (wasOn) saveCurrentPlaylistOffline();       // fire-and-forget; progress on the button
        } else { await refreshOfflineIds(); }
        updateOfflineBtn();
      }
    } catch (error) {
      console.error("Error loading music:", error);
      hideLoading();
      unfreezeUI();
      showError("Failed to load music files from Google Drive.");
    }
  }

  function freezeUI() {
    playlistSelect.disabled = true;
    player.disableControls();
    const shuffleBtn = document.getElementById("sb-shuffle-btn");
    if (shuffleBtn) shuffleBtn.disabled = true;
    signoutBtn.disabled = true;
  }

  function unfreezeUI() {
    playlistSelect.disabled = false;
    player.enableControls();
    const shuffleBtn = document.getElementById("sb-shuffle-btn");
    if (shuffleBtn) shuffleBtn.disabled = false;
    signoutBtn.disabled = false;
  }

  // --- UI STATE MANAGEMENT ---
  function updateUIAuthState(isSignedIn) {
    if (isSignedIn) {
      authorizeBtn.style.display = "none";
      if (infoBox) infoBox.style.display = "none";
      signoutBtn.style.display = "none";
      playlistSelect.disabled = false;
      mainContent.style.display = "";
      footer.style.display = "";
      document.querySelector(".player-section").style.display = "none";
      document.querySelector(".album-art-section").style.display = "none";
      document.querySelector(".playlist-section").style.display = "none";
      document.querySelector(".search-section").style.display = "none";
    } else {
      authorizeBtn.style.display = "";
      signoutBtn.style.display = "none";
      userStatus.style.display = "";
      userStatus.textContent = "❌ Not signed in";
      playlistSelect.disabled = true;

      player.stop();
      player.disableControls();

      // Signed out: if a playlist was saved for offline, it stays playable
      // (tracks stream from the blob store, no Drive needed).
      const stOff = offlineState();
      const offTracks = (stOff && stOff.on && Array.isArray(stOff.tracks)) ? stOff.tracks : [];
      if (infoBox) infoBox.style.display = offTracks.length > 0 ? "none" : "";
      if (offTracks.length > 0) {
        mainContent.style.display = "";
        footer.style.display = "";
        document.querySelector(".player-section").style.display = "";
        document.querySelector(".album-art-section").style.display = "";
        document.querySelector(".playlist-section").style.display = "";
        document.querySelector(".search-section").style.display = "none";
        player.defaultArtist = null;
        document.getElementById("playlist-heading-name").textContent = (stOff.name || "Offline") + " (offline)";
        setAlbumArt(null);
        playlist.setTracks(offTracks.map(t => ({ id: t.id, name: t.name, size: t.size ?? null })));
        lastDriveFolderName = stOff.name || null;
        refreshOfflineIds();
        updateOfflineBtn();
      } else {
        mainContent.style.display = "none";
        footer.style.display = "none";
        playlist.clear();
      }
    }
  }

  function setAlbumArt(blobUrl) {
    if (_artworkBlobUrl) {
      URL.revokeObjectURL(_artworkBlobUrl);
      _artworkBlobUrl = null;
    }
    if (blobUrl && albumArtImg) {
      _artworkBlobUrl = blobUrl;
      albumArtImg.src = blobUrl;
      albumArtImg.style.display = "";
      if (albumPlaceholder) albumPlaceholder.style.display = "none";
    } else {
      if (albumArtImg) albumArtImg.style.display = "none";
      if (albumPlaceholder) albumPlaceholder.style.display = "";
    }
  }

  function showPlayerSections() {
    document.querySelector(".player-section").style.display = "";
    document.querySelector(".album-art-section").style.display = "";
    document.querySelector(".playlist-section").style.display = "";
    document.querySelector(".search-section").style.display = "";
    signoutBtn.style.display = "inline-block";
  }

  // --- LOADING / FEEDBACK UTILITIES ---
  function showLoading(msg) {
    if (!loadingEl) return;
    clearTimeout(loadingEl._hideTimer);
    loadingEl.classList.remove("hidden", "banner-success");
    loadingEl.querySelector("p").textContent = msg;
  }

  function hideLoading() {
    if (loadingEl) loadingEl.classList.add("hidden");
  }

  function showBannerSuccess(msg) {
    if (!loadingEl) return;
    clearTimeout(loadingEl._hideTimer);
    loadingEl.classList.remove("hidden");
    loadingEl.classList.add("banner-success");
    loadingEl.querySelector("p").textContent = msg;
    loadingEl._hideTimer = setTimeout(() => {
      loadingEl.classList.add("hidden");
      loadingEl.classList.remove("banner-success");
    }, 2500);
  }

  function showMessage(msg, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      background:
        type === "error"
          ? "linear-gradient(135deg,#e53e3e,#c53030)"
          : type === "success"
          ? "linear-gradient(135deg,#38a169,#2f855a)"
          : "linear-gradient(135deg,#5a67d8,#667eea)",
      color: "white",
      padding: "15px 20px",
      borderRadius: "8px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
      fontWeight: "600",
      zIndex: 9999,
      animation: "slideIn 0.3s ease",
    });

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = "slideOut 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function showError(msg) {
    showMessage(msg, "error");
  }

  function showSuccess(msg) {
    showMessage(msg, "success");
  }

  // Small status pill that surfaces auto-prefetch activity. Useful when
  // playing in the car — lets the user see when the player is actively
  // downloading upcoming tracks (which can compete with the phone↔car
  // audio link on a weak connection).
  (function initPrefetchStatus() {
    const pill = document.createElement("div");
    pill.id = "prefetch-status";
    Object.assign(pill.style, {
      position: "fixed",
      bottom: "16px",
      left: "16px",
      background: "rgba(20,20,28,0.82)",
      color: "rgba(255,255,255,0.92)",
      padding: "6px 12px",
      borderRadius: "999px",
      fontSize: "12px",
      fontWeight: "500",
      letterSpacing: "0.2px",
      zIndex: 9998,
      opacity: "0",
      transform: "translateY(4px)",
      transition: "opacity 0.2s ease, transform 0.2s ease",
      pointerEvents: "none",
      fontFamily: "system-ui, -apple-system, sans-serif",
      boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
    });
    document.body.appendChild(pill);

    let hideTimer = null;
    const show = (text) => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      pill.textContent = text;
      pill.style.opacity = "1";
      pill.style.transform = "translateY(0)";
    };
    const hideAfter = (ms) => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        pill.style.opacity = "0";
        pill.style.transform = "translateY(4px)";
      }, ms);
    };

    document.addEventListener("prefetchStart", (e) => {
      show(`Prefetching upcoming tracks · 0/${e.detail.total}`);
    });
    document.addEventListener("prefetchProgress", (e) => {
      show(`Prefetching upcoming tracks · ${e.detail.done}/${e.detail.total}`);
    });
    document.addEventListener("prefetchComplete", (e) => {
      const { total, fetched, cached } = e.detail;
      const parts = [];
      if (fetched) parts.push(`${fetched} downloaded`);
      if (cached) parts.push(`${cached} from cache`);
      const detail = parts.length ? ` · ${parts.join(", ")}` : "";
      show(`Prefetch complete${detail}`);
      hideAfter(2200);
    });
  })();
});
