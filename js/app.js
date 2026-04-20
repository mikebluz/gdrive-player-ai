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
  const userCache = new UserSongCache();
  const cacheBtn = document.getElementById("cache-btn");
  const cacheBtnContainer = cacheBtn?.closest(".cache-btn-container");

  // --- Initialization ---
  (async function initApp() {
    try {
      showLoading("Initializing Google Drive API...");
      driveAPI = new GoogleDriveAPI(window.APP_CONFIG);
      player = new MusicPlayer(driveAPI);
      playlist = new PlaylistManager(player, userCache);
      await driveAPI.initialize();

      hideLoading();
      updateUIAuthState(false);

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
    if (value) {
      loadMusicFromDrive(value);
      e.target.value = "";
    }
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

  // Hide loading banner when first track is ready to play
  document.addEventListener("trackLoaded", (e) => {
    hideLoading();
    unfreezeUI();
    updateCacheBtn(e.detail?.track);
  });

  cacheBtn?.addEventListener("click", () => {
    const track = player?.currentTrack;
    if (!track) return;
    userCache.toggle(track);
    updateCacheBtn(track);
    playlist?.refreshCacheIndicators();
  });

  function updateCacheBtn(track) {
    if (!track || !cacheBtn || !cacheBtnContainer) return;
    cacheBtnContainer.style.display = "";
    cacheBtn.textContent = userCache.isCached(track.id) ? "Remove from cache" : "Save to cache";
  }

  async function loadQuickLoadOptions() {
    try {
      const options = await driveAPI.fetchPlaylistOptions("Serialbox Playlists");
      playlistSelect.innerHTML = '<option value="">— Quick Load —</option>';
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
      const [musicFiles, artistName] = await Promise.all([
        driveAPI.getMusicFilesFromFolders(folders),
        driveAPI.fetchArtistName(folders[0].id),
      ]);

      if (musicFiles.length === 0) {
        hideLoading();
        unfreezeUI();
        showError(`No music files found in folders named "${folderName}".`);
        return;
      }

      showLoading("Preparing first track...");
      player.defaultArtist = artistName || null;
      document.getElementById("playlist-heading").textContent = folderName;
      playlist.setTracks(musicFiles);
      showPlayerSections();
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
    const shuffleBtn = document.getElementById("shuffle-btn");
    if (shuffleBtn) shuffleBtn.disabled = true;
    signoutBtn.disabled = true;
  }

  function unfreezeUI() {
    playlistSelect.disabled = false;
    player.enableControls();
    const shuffleBtn = document.getElementById("shuffle-btn");
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
      document.querySelector(".playlist-section").style.display = "none";
      document.querySelector(".search-section").style.display = "none";
    } else {
      authorizeBtn.style.display = "";
      if (infoBox) infoBox.style.display = "";
      signoutBtn.style.display = "none";
      userStatus.style.display = "";
      userStatus.textContent = "❌ Not signed in";
      playlistSelect.disabled = true;
      mainContent.style.display = "none";
      footer.style.display = "none";

      player.stop();
      player.disableControls();
      playlist.clear();
    }
  }

  function showPlayerSections() {
    document.querySelector(".player-section").style.display = "";
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
});
