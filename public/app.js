// ==========================================================================
// LiveCode — Real-Time Client Application & Protection Engine
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // Persistent Client Session Token (Maintains Host Identity on Browser Refresh)
  let userToken = null;
  try {
    userToken = sessionStorage.getItem('livecode_user_token');
    if (!userToken) {
      userToken = 'usr_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
      sessionStorage.setItem('livecode_user_token', userToken);
    }
  } catch (e) {
    userToken = 'usr_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
  }

  // URL Parsing to extract Room ID
  const pathParts = window.location.pathname.split('/');
  let currentRoomId = pathParts[2] || null;

  // Local State
  let currentUser = null;
  let isHost = false;
  let isCopyDisabled = false;
  let isPasteDisabled = false;
  let isReadOnly = false;
  let isExamMode = false;
  let serverTimeOffset = 0;
  let currentTimerState = {
    mode: 'countdown',
    duration: 300,
    remaining: 300,
    elapsed: 0,
    isRunning: false,
    startedAt: null,
    targetEndTime: null
  };
  let defaultSampleCode = `# Simple greeting and calculation program

name = input("What's your name? ")
age = int(input("How old are you? "))

# Calculate approximate birth year
current_year = 2026
birth_year = current_year - age

print(f"Hello, {name}! You were likely born in {birth_year}.")
`;
  let roomCode = defaultSampleCode;
  let roomLanguage = 'python';
  let usersList = [];
  let isSyntaxHighlightEnabled = true;
  let activeSelection = null;
  let activeRestingCursorUserId = null;
  let lastTypingTime = 0;
  let currentActiveFile = 'Untitled';
  let openTabs = ['Untitled'];
  const unsavedFiles = new Set();
  const fileSavedContents = new Map();
  const tabBufferMap = new Map();
  const remoteCursors = new Map();
  let syncedHoveredTreePath = null;
  let syncedHoveredTreeAction = null;
  let syncedHoveredTabName = null;
  let syncedDraggingPath = null;
  let syncedDragOverPath = null;
  let syncedRootDragOver = false;
  let renamingValue = '';
  let renamingCursor = null;
  let localRenaming = false;
  let localCreating = false;

  // DOM Element References
  const displayRoomId = document.getElementById('displayRoomId');
  const roomShareBtn = document.getElementById('roomShareBtn');
  const settingsDisplayRoomId = document.getElementById('settingsDisplayRoomId');
  const settingsRoomShareBtn = document.getElementById('settingsRoomShareBtn');
  const codeTextarea = document.getElementById('codeTextarea');
  const highlightCode = document.getElementById('highlightCode');
  const lineNumbers = document.getElementById('lineNumbers');
  const languageSelect = document.getElementById('languageSelect');
  const protectionBanner = document.getElementById('protectionBanner');
  const watermarkOverlay = document.getElementById('watermarkOverlay');
  const editorTabs = document.getElementById('editorTabs');

  // Mouse Wheel Scroll on Editor Tabs Bar
  if (editorTabs) {
    editorTabs.addEventListener('wheel', (e) => {
      if (editorTabs.scrollWidth > editorTabs.clientWidth) {
        if (Math.abs(e.deltaY) >= Math.abs(e.deltaX) && e.deltaY !== 0) {
          e.preventDefault();
          let delta = e.deltaY;
          if (e.deltaMode === 1) delta *= 28; // Line scroll multiplier (e.g. Windows wheel mouse)
          else if (e.deltaMode === 2) delta *= editorTabs.clientWidth; // Page scroll
          editorTabs.scrollLeft += delta;
        }
      }
    }, { passive: false });
  }

  // Update Tabs Overflow / Shrunk State
  function updateTabsOverflowState() {
    if (!editorTabs) return;
    const isOverflowing = editorTabs.scrollWidth > editorTabs.clientWidth + 1;
    const firstInactiveTab = editorTabs.querySelector('.editor-tab:not(.active)');
    const isShrunk = firstInactiveTab ? firstInactiveTab.getBoundingClientRect().width < 130 : false;
    editorTabs.classList.toggle('tabs-overflowing', isOverflowing || isShrunk);
  }

  if (window.ResizeObserver && editorTabs) {
    const tabsResizeObserver = new ResizeObserver(() => {
      updateTabsOverflowState();
    });
    tabsResizeObserver.observe(editorTabs);
  }
  window.addEventListener('resize', updateTabsOverflowState);

  // Protection Toggles
  const toggleCopyProtection = document.getElementById('toggleCopyProtection');
  const togglePasteProtection = document.getElementById('togglePasteProtection');
  const toggleReadOnly = document.getElementById('toggleReadOnly');
  const toggleLiveSharing = document.getElementById('toggleLiveSharing');
  const toggleLiveSharingSettings = document.getElementById('toggleLiveSharingSettings');
  const toggleLiveSharingMobile = document.getElementById('toggleLiveSharingMobile');
  const settingsLanguageSelect = document.getElementById('settingsLanguageSelect');
  const toggleSyntaxHighlight = document.getElementById('toggleSyntaxHighlight');
  const toggleExamMode = document.getElementById('toggleExamMode');
  const examModeToggleLabel = document.getElementById('examModeToggleLabel');
  const examModeBanner = document.getElementById('examModeBanner');
  const candidateViolationChip = document.getElementById('candidateViolationChip');
  const examFullscreenModal = document.getElementById('examFullscreenModal');
  const examEnterFullscreenBtn = document.getElementById('examEnterFullscreenBtn');
  const examFullscreenTimerVal = document.getElementById('examFullscreenTimerVal');
  const examTimeModal = document.getElementById('examTimeModal');
  const cancelExamTimeBtn = document.getElementById('cancelExamTimeBtn');
  const startExamWithTimeBtn = document.getElementById('startExamWithTimeBtn');
  const examDurationInput = document.getElementById('examDurationInput');
  const proctorAuditModal = document.getElementById('proctorAuditModal');
  const closeProctorAuditBtn = document.getElementById('closeProctorAuditBtn');
  const dismissProctorAuditBtn = document.getElementById('dismissProctorAuditBtn');
  const proctorCandidateSubtitle = document.getElementById('proctorCandidateSubtitle');
  const proctorStatTabSwitches = document.getElementById('proctorStatTabSwitches');
  const proctorStatWindowBlurs = document.getElementById('proctorStatWindowBlurs');
  const proctorStatFullscreenExits = document.getElementById('proctorStatFullscreenExits');
  const proctorAuditLogsContainer = document.getElementById('proctorAuditLogsContainer');
  const copyProtectionToggleLabel = document.getElementById('copyProtectionToggleLabel');

  // Actions & Buttons
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const formatCodeBtn = document.getElementById('formatCodeBtn');
  const runCodeBtn = document.getElementById('runCodeBtn');
  const downloadCodeBtn = document.getElementById('downloadCodeBtn');
  const copyCodeBtn = document.getElementById('copyCodeBtn');
  
  const profileBtn = document.getElementById('profileBtn');
  const profileDropdown = document.getElementById('profileDropdown');

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsDropdown = document.getElementById('settingsDropdown');
  const toggleFilesBtn = document.getElementById('toggleFilesBtn');
  const toggleUsersBtn = document.getElementById('toggleUsersBtn');
  const toggleChatBtn = document.getElementById('toggleChatBtn');
  const activeUserCount = document.getElementById('activeUserCount');

  // Drawers & Sidebars
  const sidebar = document.getElementById('sidebar');
  const chatDrawer = document.getElementById('chatDrawer');
  const outputDrawer = document.getElementById('outputDrawer');
  const consoleOutput = document.getElementById('consoleOutput');
  const htmlPreviewContainer = document.getElementById('htmlPreviewContainer');
  const htmlPreviewFrame = document.getElementById('htmlPreviewFrame');

  // Lists & Containers
  const userListContainer = document.getElementById('userListContainer');
  const collaboratorCursorsContainer = document.getElementById('collaboratorCursors');
  
  const persistentCursorEl = document.createElement('div');
  persistentCursorEl.className = 'collaborator-cursor-item';
  persistentCursorEl.style.display = 'none';
  const persistentCaret = document.createElement('div');
  persistentCaret.className = 'collaborator-caret';
  const persistentFlag = document.createElement('div');
  persistentFlag.className = 'collaborator-flag';
  persistentCursorEl.appendChild(persistentCaret);
  persistentCursorEl.appendChild(persistentFlag);
  
  // Wait to append until we're sure the container is ready
  setTimeout(() => {
    document.getElementById('collaboratorCursors').appendChild(persistentCursorEl);
  }, 100);

  const mousePointerContainer = document.getElementById('mousePointerContainer');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendChatBtn = document.getElementById('sendChatBtn');
  const toastContainer = document.getElementById('toastContainer');

  // Join Room & New Room UI Elements
  const joinRoomNavBtn = document.getElementById('joinRoomNavBtn');
  const newRoomNavBtn = document.getElementById('newRoomNavBtn');
  const settingsJoinRoomBtn = document.getElementById('settingsJoinRoomBtn');
  const settingsNewRoomBtn = document.getElementById('settingsNewRoomBtn');
  const joinRoomModal = document.getElementById('joinRoomModal');
  const closeJoinRoomModalBtn = document.getElementById('closeJoinRoomModalBtn');
  const cancelJoinRoomBtn = document.getElementById('cancelJoinRoomBtn');
  const joinRoomForm = document.getElementById('joinRoomForm');
  const joinRoomInput = document.getElementById('joinRoomInput');
  const joinRoomStatus = document.getElementById('joinRoomStatus');
  const joinUsernameInput = document.getElementById('joinUsernameInput');
  const submitJoinRoomBtn = document.getElementById('submitJoinRoomBtn');
  const joinModalCreateNewBtn = document.getElementById('joinModalCreateNewBtn');

  // Retrieve saved username from localStorage
  let savedUsername = '';
  try { savedUsername = (localStorage.getItem('livecode_username') || '').trim(); } catch(e){}

  function extractRoomId(val) {
    if (!val) return '';
    let s = val.trim();
    const match = s.match(/\/room\/([a-zA-Z0-9_-]+)/i);
    if (match) return match[1].toLowerCase();
    s = s.replace(/^[a-zA-Z]+:\/\/[^/]+\/?/i, '');
    s = s.replace(/^\/+/, '').split('/')[0].split('?')[0].split('#')[0];
    return s.toLowerCase();
  }

  function openJoinRoomModal() {
    if (settingsDropdown && !settingsDropdown.classList.contains('hidden')) {
      settingsDropdown.classList.add('hidden');
    }
    if (!joinRoomModal) return;
    joinRoomModal.classList.remove('hidden');
    if (joinUsernameInput) {
      joinUsernameInput.value = savedUsername || (currentUser ? currentUser.name : '');
    }
    if (joinRoomInput) {
      joinRoomInput.value = '';
      setTimeout(() => joinRoomInput.focus(), 80);
    }
    if (joinRoomStatus) {
      joinRoomStatus.className = 'hidden';
      joinRoomStatus.textContent = '';
      joinRoomStatus.style.color = '';
    }
    if (submitJoinRoomBtn) {
      submitJoinRoomBtn.disabled = false;
      submitJoinRoomBtn.textContent = 'Join Session';
    }
  }

  function closeJoinRoomModal() {
    if (joinRoomModal) {
      joinRoomModal.classList.add('hidden');
    }
    if (joinRoomStatus) {
      joinRoomStatus.className = 'hidden';
      joinRoomStatus.textContent = '';
      joinRoomStatus.style.color = '';
    }
  }

  let roomCheckDebounceTimer = null;
  function handleJoinRoomInput() {
    if (!joinRoomInput || !joinRoomStatus) return;
    const rawVal = joinRoomInput.value.trim();
    const cleanId = extractRoomId(rawVal);

    if (roomCheckDebounceTimer) clearTimeout(roomCheckDebounceTimer);

    if (!cleanId) {
      joinRoomStatus.className = 'hidden';
      joinRoomStatus.textContent = '';
      joinRoomStatus.style.color = '';
      return;
    }

    if (currentRoomId && cleanId === currentRoomId.toLowerCase()) {
      joinRoomStatus.className = '';
      joinRoomStatus.style.color = '#f59e0b';
      joinRoomStatus.textContent = '⚠️ You are currently in this room.';
      return;
    }

    roomCheckDebounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(cleanId)}`);
        if (res.ok) {
          const data = await res.json();
          joinRoomStatus.className = '';
          joinRoomStatus.style.color = '#10b981';
          const userCount = typeof data.userCount === 'number' ? data.userCount : 0;
          const userLabel = userCount === 1 ? '1 user' : `${userCount} users`;
          const lang = (data.language || 'python').toUpperCase();
          joinRoomStatus.innerHTML = `✓ Active room found • <strong>${lang}</strong> (${userLabel})`;
        } else if (res.status === 404) {
          joinRoomStatus.className = '';
          joinRoomStatus.style.color = '#94a3b8';
          joinRoomStatus.textContent = 'ℹ️ Room does not exist yet. It will be created when you join.';
        }
      } catch (e) {
        // Ignore network errors in preview
      }
    }, 250);
  }

  function handleJoinRoomSubmit(e) {
    if (e) e.preventDefault();
    if (!joinRoomInput) return;
    const rawVal = joinRoomInput.value.trim();
    const cleanId = extractRoomId(rawVal);

    if (!cleanId) {
      if (joinRoomStatus) {
        joinRoomStatus.className = '';
        joinRoomStatus.style.color = '#ef4444';
        joinRoomStatus.textContent = 'Please enter a valid room code or link.';
      }
      joinRoomInput.focus();
      return;
    }

    if (currentRoomId && cleanId === currentRoomId.toLowerCase()) {
      if (joinRoomStatus) {
        joinRoomStatus.className = '';
        joinRoomStatus.style.color = '#f59e0b';
        joinRoomStatus.textContent = 'You are already in this room.';
      }
      joinRoomInput.focus();
      return;
    }

    const chosenName = (joinUsernameInput ? joinUsernameInput.value : '').trim();
    if (chosenName) {
      savedUsername = chosenName;
      try {
        localStorage.setItem('livecode_username', chosenName);
      } catch (err) {}
    }

    if (submitJoinRoomBtn) {
      submitJoinRoomBtn.disabled = true;
      submitJoinRoomBtn.textContent = 'Connecting...';
    }

    window.location.href = `/room/${encodeURIComponent(cleanId)}`;
  }

  async function createNewRoomAndNavigate() {
    try {
      showToast('Creating new session...');
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: 'python',
          copyDisabled: false,
          userToken: userToken
        })
      });
      const data = await res.json();
      if (data && data.roomId) {
        window.location.href = `/room/${data.roomId}`;
      } else {
        window.location.href = '/';
      }
    } catch (e) {
      window.location.href = '/';
    }
  }

  if (joinRoomNavBtn) {
    joinRoomNavBtn.addEventListener('click', openJoinRoomModal);
  }
  if (newRoomNavBtn) {
    newRoomNavBtn.addEventListener('click', () => {
      createNewRoomAndNavigate();
    });
  }
  if (settingsJoinRoomBtn) {
    settingsJoinRoomBtn.addEventListener('click', openJoinRoomModal);
  }
  if (settingsNewRoomBtn) {
    settingsNewRoomBtn.addEventListener('click', () => {
      if (settingsDropdown) settingsDropdown.classList.add('hidden');
      createNewRoomAndNavigate();
    });
  }
  if (closeJoinRoomModalBtn) {
    closeJoinRoomModalBtn.addEventListener('click', closeJoinRoomModal);
  }
  if (cancelJoinRoomBtn) {
    cancelJoinRoomBtn.addEventListener('click', closeJoinRoomModal);
  }
  if (joinModalCreateNewBtn) {
    joinModalCreateNewBtn.addEventListener('click', () => {
      closeJoinRoomModal();
      createNewRoomAndNavigate();
    });
  }
  if (joinRoomForm) {
    joinRoomForm.addEventListener('submit', handleJoinRoomSubmit);
  }
  if (joinRoomInput) {
    joinRoomInput.addEventListener('input', handleJoinRoomInput);
  }
  if (joinRoomModal) {
    joinRoomModal.addEventListener('click', (e) => {
      if (e.target === joinRoomModal) {
        closeJoinRoomModal();
      }
    });
  }

  // Keyboard shortcut Alt+J or Ctrl+Alt+J to open Join Room modal
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault();
      if (joinRoomModal && !joinRoomModal.classList.contains('hidden')) {
        closeJoinRoomModal();
      } else {
        openJoinRoomModal();
      }
    } else if (e.key === 'Escape') {
      if (joinRoomModal && !joinRoomModal.classList.contains('hidden')) {
        closeJoinRoomModal();
      }
    }
  });

  // --------------------------------------------------------------------------
  // 1. Initial Room Joining (Direct Website Access without Modal Popup)
  // --------------------------------------------------------------------------

  // Initial display setup
  updateEditorDisplay();

  if (!currentRoomId) {
    autoCreateAndJoinRoom(savedUsername || 'User');
  } else {
    joinRoom(currentRoomId, savedUsername);
  }

  async function autoCreateAndJoinRoom(username) {
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: 'python',
          copyDisabled: false,
          userToken: userToken
        })
      });
      const data = await res.json();
      currentRoomId = data.roomId;
      window.history.pushState({}, '', `/room/${currentRoomId}`);
      joinRoom(currentRoomId, username);
    } catch (err) {
      joinRoom('main', username);
    }
  }

  function setAllRoomIdDisplays(roomId) {
    if (!roomId) return;
    const text = roomId.toUpperCase();
    document.querySelectorAll('.room-id').forEach(el => {
      el.textContent = text;
    });
  }

  function joinRoom(roomId, username) {
    setAllRoomIdDisplays(roomId);
    socket.emit('join-room', { roomId, username, userToken });
  }

  // --------------------------------------------------------------------------
  // 2. Socket.io Event Handlers (Real-Time Synchronization)
  // --------------------------------------------------------------------------

  socket.on('room-state', (state) => {
    currentRoomId = state.roomId;
    setAllRoomIdDisplays(state.roomId);
    
    roomCode = state.code;
    codeTextarea.value = roomCode;
    
    if (state.openTabs && Array.isArray(state.openTabs)) {
      openTabs = [...state.openTabs];
    } else {
      openTabs = state.activeFile ? [state.activeFile] : ['Untitled'];
    }
    if (state.activeFile !== undefined) currentActiveFile = state.activeFile;
    if (currentActiveFile && !openTabs.includes(currentActiveFile)) openTabs.push(currentActiveFile);
    if (state.files && state.files.length > 0) {
      shellFiles = state.files;
    } else {
      shellFiles = [];
    }
    if (state.cwd) currentShellCwd = state.cwd;
    const isMobileScreen = window.matchMedia('(max-width: 768px)').matches;
    if (isMobileScreen) {
      if (sidebar) sidebar.classList.add('collapsed');
      if (chatDrawer) chatDrawer.classList.add('collapsed');
      updateSidebarToggleState();
      updateChatDrawerToggleState();
    } else {
      if (state.sidebarCollapsed !== undefined) {
        if (state.sidebarCollapsed) {
          sidebar.classList.add('collapsed');
        } else {
          sidebar.classList.remove('collapsed');
        }
        updateSidebarToggleState();
      }
      if (state.chatDrawerCollapsed !== undefined && chatDrawer) {
        if (state.chatDrawerCollapsed) {
          chatDrawer.classList.add('collapsed');
        } else {
          chatDrawer.classList.remove('collapsed');
        }
        updateChatDrawerToggleState();
      }
    }
    if (state.consoleCollapsed !== undefined && outputDrawer) {
      if (state.consoleCollapsed) {
        outputDrawer.classList.add('collapsed');
      } else {
        outputDrawer.classList.remove('collapsed');
      }
    }
    if (state.consoleExpanded !== undefined && outputDrawer) {
      if (state.consoleExpanded) {
        outputDrawer.classList.add('expanded');
      } else {
        outputDrawer.classList.remove('expanded');
      }
    }
    if (state.consoleHeight && outputDrawer) {
      outputDrawer.style.height = (typeof state.consoleHeight === 'number') ? `${state.consoleHeight}px` : state.consoleHeight;
    }
    updateConsoleButtonsState();
    if (state.activeDrawerTab) {
      switchDrawerTab(state.activeDrawerTab, false);
    }
    if (state.collapsedFolders && Array.isArray(state.collapsedFolders)) {
      collapsedFolders.clear();
      state.collapsedFolders.forEach(f => collapsedFolders.add(f));
    }
    if (state.selectedFolder !== undefined) {
      selectedFolder = state.selectedFolder || '';
    }
    renderFilesList();
    renderTabs();
    
    roomLanguage = state.language || 'python';
    if (languageSelect) languageSelect.value = roomLanguage;
    updateDropdownUI(roomLanguage);

    currentUser = state.currentUser;
    isHost = state.isHost;

    // Show guest username modal if joining a live shared session without a saved username
    if (!isHost && !savedUsername && state.settings && state.settings.liveSharingEnabled) {
      promptGuestUsernameModal();
    }

    updateRoleBadge();
    if (isHost) {
      getOrInitWorker();
    }

    // Synchronize Server Time & Initialize Collaborative Timer
    if (state.serverTime) {
      serverTimeOffset = state.serverTime - Date.now();
    }
    if (state.timer) {
      applyTimerState(state.timer);
    }

    // Apply Room Settings
    applyProtectionSettings(state.settings);
    
    // Update Users & History
    usersList = state.users || [];
    if (state.voiceParticipants && Array.isArray(state.voiceParticipants)) {
      updateVoiceParticipants(state.voiceParticipants);
    }
    renderUsers();
    renderChat(state.chat || []);

    // Initial Syntax Highlight & Line Count
    updateEditorDisplay();

    // Auto-show terminal on fresh start if python and not collapsed
    if (roomLanguage === 'python') {
      htmlPreviewContainer.classList.add('hidden');
      consoleOutput.classList.remove('hidden');
      if (isHost && !isExecutionRunning) {
        startShellMode();
      }
    }

    // Restore terminal output scroll if synced
    if (state.outputScroll) {
      setTimeout(() => {
        if (terminal && typeof state.outputScroll.line === 'number') {
          try { terminal.scrollToLine(state.outputScroll.line); } catch (e) {}
        }
        const viewport = consoleOutput ? consoleOutput.querySelector('.xterm-viewport') : null;
        if (viewport && typeof state.outputScroll.top === 'number') {
          viewport.scrollTop = state.outputScroll.top;
        }
      }, 120);
    }

    // Initialize Shared Common Undo / Redo History
    if (state.undoHistory && typeof state.undoHistory === 'object') {
      Object.entries(state.undoHistory).forEach(([fKey, stack]) => {
        if (Array.isArray(stack)) fileUndoHistory.set(fKey, [...stack]);
      });
    }
    if (state.redoHistory && typeof state.redoHistory === 'object') {
      Object.entries(state.redoHistory).forEach(([fKey, stack]) => {
        if (Array.isArray(stack)) fileRedoHistory.set(fKey, [...stack]);
      });
    }
    updateUndoRedoUI();
  });

  socket.on('settings-update', ({ settings, updatedBy }) => {
    applyProtectionSettings(settings);
  });

  socket.on('code-update', ({ code, senderId, cursor, activeFile, openTabs: newOpenTabs }) => {
    if (Array.isArray(newOpenTabs)) {
      openTabs = [...newOpenTabs];
    }
    if (activeFile !== undefined && activeFile !== null) {
      currentActiveFile = activeFile;
      if (activeFile && !openTabs.includes(currentActiveFile)) openTabs.push(currentActiveFile);
    }
    renderFilesList();
    renderTabs({ preserveScroll: true });
    if (senderId !== socket.id) {
      finalizeTypingSnapshot();
      const cursorPos = codeTextarea.selectionStart;
      codeTextarea.value = code;
      roomCode = code;
      if (currentActiveFile) {
        tabBufferMap.set(currentActiveFile, code);
      }
      codeTextarea.setSelectionRange(cursorPos, cursorPos);
      updateUndoRedoUI();
      
      if (senderId && cursor) {
        const user = usersList.find(u => u.id === senderId);
        if (user) {
          activeRestingCursorUserId = senderId;
          lastTypingTime = Date.now();
          user.cursor = cursor;
          const existing = remoteCursors.get(senderId) || {};
          remoteCursors.set(senderId, {
            ...existing,
            cursor: cursor,
            name: user.name,
            color: user.color,
            isInsideEditor: true
          });

          if (cursor.selection && cursor.selection.start !== cursor.selection.end) {
            activeSelection = {
              userId: senderId,
              start: cursor.selection.start,
              end: cursor.selection.end,
              color: user.color
            };
          } else if (!cursor.selection || cursor.selection.start === cursor.selection.end) {
            if (activeSelection && activeSelection.userId === senderId) {
              activeSelection = null;
            }
          }
          
          if (window._remoteTypingTimer) clearTimeout(window._remoteTypingTimer);
          window._remoteTypingTimer = setTimeout(() => {
            renderCollaboratorCursors();
            renderUsers();
          }, 1500);
        }
      } else if (senderId && activeSelection && activeSelection.userId === senderId) {
        activeSelection = null;
      }
      
      updateEditorDisplay();
      renderCollaboratorCursors();
      renderUsers();
    }
  });

  socket.on('users-update', ({ users }) => {
    usersList = users;
    if (currentUser) {
      const meInUsers = users.find(u => u.id === socket.id || (currentUser.token && u.token === currentUser.token));
      if (meInUsers) {
        if (typeof meInUsers.isHost === 'boolean' && meInUsers.isHost !== isHost) {
          isHost = meInUsers.isHost;
          currentUser.isHost = isHost;
          updateRoleBadge();
          applyProtectionSettings({ copyDisabled: isCopyDisabled, pasteDisabled: isPasteDisabled, readOnly: isReadOnly, examMode: isExamMode });
          if (isHost) {
            getOrInitWorker();
          }
        }
        if (meInUsers.violations) {
          currentUser.violations = meInUsers.violations;
          if (typeof updateCandidateViolationDisplay === 'function') {
            updateCandidateViolationDisplay();
          }
        }
      }
    }
    const currentIds = new Set(users.map(u => u.id));
    for (let id of remoteCursors.keys()) {
      if (!currentIds.has(id)) {
        const rc = remoteCursors.get(id);
        if (rc && rc.mousePointerEl) {
          rc.mousePointerEl.remove();
        }
        remoteCursors.delete(id);
      }
    }
    if (activeSelection && !currentIds.has(activeSelection.userId)) {
      activeSelection = null;
    }
    if (activeRestingCursorUserId && !currentIds.has(activeRestingCursorUserId)) {
      activeRestingCursorUserId = null;
    }
    users.forEach(u => {
      if (u.id !== socket.id && u.cursor) {
        if (!remoteCursors.has(u.id)) {
          remoteCursors.set(u.id, { cursor: u.cursor, name: u.name, color: u.color });
        } else {
          const existing = remoteCursors.get(u.id);
          existing.name = u.name;
          existing.color = u.color;
        }
      }
    });
    renderUsers();
    renderCollaboratorCursors();
    renderFilesList();
  });

  // Real-time Anti-Cheat Alerts for Room Host
  socket.on('proctor-alert', ({ user, violation }) => {
    if (!isHost) return;
    showToast(`🚨 Anti-Cheat: ${user.name} - ${violation.details || violation.type}`, 'warning');
    const existing = usersList.find(u => u.id === user.id || (user.token && u.token === user.token));
    if (existing) {
      existing.violations = user.violations;
      renderUsers();
    }
    if (activeAuditUserId === user.id && proctorAuditModal && !proctorAuditModal.classList.contains('hidden')) {
      openProctorAuditModal(user);
    }
  });

  function hexToRgba(hex, alpha = 1) {
    if (!hex || typeof hex !== 'string') return `rgba(0, 240, 255, ${alpha})`;
    let c = hex.replace('#', '');
    if (c.length === 3) {
      c = c.split('').map(x => x + x).join('');
    }
    const num = parseInt(c, 16);
    if (isNaN(num)) return `rgba(0, 240, 255, ${alpha})`;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // UI Button Hover Sync
  socket.on('btn-hover-update', ({ btnId, isHovered, color }) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      if (isHovered) {
        if (color) {
          btn.style.setProperty('--hover-color', color);
          btn.style.setProperty('--hover-bg', hexToRgba(color, 0.12));
          btn.style.setProperty('--resizer-color', color);
        }
        btn.classList.add('is-hovered');
      } else {
        btn.classList.remove('is-hovered');
        btn.style.removeProperty('--hover-color');
        btn.style.removeProperty('--hover-bg');
        btn.style.removeProperty('--resizer-color');
      }
    }
  });

  // Timer Dropdown Open/Close Sync
  socket.on('timer-dropdown-update', ({ isOpen, userId }) => {
    if (userId !== socket.id) {
      setTimerDropdownOpen(isOpen, false);
    }
  });

  // Timer Dropdown Item Hover Sync
  socket.on('timer-dropdown-item-hover-update', ({ itemId, isHovered, userId }) => {
    if (userId !== socket.id) {
      let item = null;
      if (itemId && itemId.startsWith('preset-')) {
        const sec = itemId.replace('preset-', '');
        item = timerPresets ? timerPresets.querySelector(`.timer-preset-btn[data-seconds="${sec}"]`) : null;
      } else if (itemId) {
        item = document.getElementById(itemId);
      }
      if (item) {
        if (isHovered) {
          const user = usersList.find(u => u.id === userId);
          if (user && user.color) {
            item.style.setProperty('--hover-color', user.color);
            item.style.setProperty('--hover-bg', hexToRgba(user.color, 0.15));
            item.style.setProperty('--resizer-color', user.color);
          }
          item.classList.add('is-hovered');
        } else {
          item.classList.remove('is-hovered');
          item.style.removeProperty('--hover-color');
          item.style.removeProperty('--hover-bg');
          item.style.removeProperty('--resizer-color');
        }
      }
    }
  });

  // Editor Context Menu Open/Close & Position Sync
  socket.on('context-menu-update', ({ isOpen, x, y, userId }) => {
    if (userId !== socket.id) {
      setContextMenuOpen(isOpen, x, y, false);
    }
  });

  // Context Menu Item Hover Sync
  socket.on('context-menu-item-hover-update', ({ itemId, isHovered, userId }) => {
    if (userId !== socket.id) {
      const item = document.getElementById(itemId);
      if (item) {
        if (isHovered) {
          const user = usersList.find(u => u.id === userId);
          if (user && user.color) {
            item.style.setProperty('--hover-color', user.color);
            item.style.setProperty('--hover-bg', hexToRgba(user.color, 0.15));
          }
          item.classList.add('is-hovered');
        } else {
          item.classList.remove('is-hovered');
          item.style.removeProperty('--hover-color');
          item.style.removeProperty('--hover-bg');
        }
      }
    }
  });

  // Console Copy Tick Mark Sync
  socket.on('console-copy-tick-update', ({ userId }) => {
    if (userId !== socket.id) {
      triggerConsoleCopyTick(false);
    }
  });

  // Shared Common Room Undo / Redo State Sync
  socket.on('undo-redo-update', ({ fileKey, undoStack, redoStack, action, code, cursor, senderId, senderName }) => {
    if (Array.isArray(undoStack)) {
      fileUndoHistory.set(fileKey, [...undoStack]);
    }
    if (Array.isArray(redoStack)) {
      fileRedoHistory.set(fileKey, [...redoStack]);
    }
    updateUndoRedoUI();

    if (senderId !== socket.id && code !== undefined && (!currentActiveFile || currentActiveFile === fileKey)) {
      isApplyingUndoRedo = true;
      try {
        codeTextarea.value = code;
        roomCode = code;
        if (currentActiveFile) {
          tabBufferMap.set(currentActiveFile, roomCode);
        }
        updateEditorDisplay();
        if (cursor) {
          const safeStart = Math.min(cursor.selStart ?? code.length, code.length);
          const safeEnd = Math.min(cursor.selEnd ?? safeStart, code.length);
          codeTextarea.setSelectionRange(safeStart, safeEnd);
          lastSelectionPos = { start: safeStart, end: safeEnd };
        }
        if (action === 'undo') {
          showToast(`↩️ ${senderName || 'Collaborator'} performed Undo`);
        } else if (action === 'redo') {
          showToast(`↪️ ${senderName || 'Collaborator'} performed Redo`);
        }
      } finally {
        isApplyingUndoRedo = false;
      }
    }
  });

  // Tab Hover Sync
  socket.on('tab-hover-update', ({ tabName, isHovered, color }) => {
    if (isHovered) syncedHoveredTabName = tabName;
    else if (syncedHoveredTabName === tabName) syncedHoveredTabName = null;
    const tabsContainer = document.getElementById('editorTabs');
    if (tabsContainer) {
      const tabs = tabsContainer.querySelectorAll('.editor-tab');
      tabs.forEach(t => {
        const titleSpan = t.querySelector('span[title]');
        if (titleSpan && titleSpan.getAttribute('title') === tabName) {
          if (isHovered) {
            if (color) {
              t.style.setProperty('--hover-color', color);
              t.style.setProperty('--hover-bg', hexToRgba(color, 0.1));
            }
            t.classList.add('is-hovered');
          } else {
            t.classList.remove('is-hovered');
            t.style.removeProperty('--hover-color');
            t.style.removeProperty('--hover-bg');
          }
        }
      });
    }
  });

  // Console Resizer Drag Sync
  socket.on('console-drag-update', ({ isDragging, color }) => {
    const resizer = document.getElementById('consoleResizer');
    if (resizer) {
      if (isDragging) {
        if (color) {
          resizer.style.setProperty('--resizer-color', color);
        }
        resizer.classList.add('is-dragging');
      } else {
        resizer.classList.remove('is-dragging');
        resizer.style.removeProperty('--resizer-color');
      }
    }
  });

  // Tab Close Button Hover Sync
  socket.on('tab-close-hover-update', ({ tabName, isHovered }) => {
    const tabsContainer = document.getElementById('editorTabs');
    if (tabsContainer) {
      const tabs = tabsContainer.querySelectorAll('.editor-tab');
      tabs.forEach(t => {
        const titleSpan = t.querySelector('span[title]');
        if (titleSpan && titleSpan.getAttribute('title') === tabName) {
          const closeBtn = t.querySelector('.editor-tab-close');
          if (closeBtn) {
            if (isHovered) closeBtn.classList.add('is-hovered');
            else closeBtn.classList.remove('is-hovered');
          }
        }
      });
    }
  });

  function getTextWidth(text, font) {
    const canvas = getTextWidth.canvas || (getTextWidth.canvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    context.font = font || '13.6px monospace';
    return context.measureText(text).width;
  }

  function updateInputCursorDisplay(inputEl, cursor) {
    if (!inputEl || !cursor) return;
    const wrapper = inputEl.closest('.inline-input-wrapper');
    if (!wrapper) return;

    let caretEl = wrapper.querySelector('.remote-input-caret');
    let selEl = wrapper.querySelector('.remote-input-selection');

    if (!caretEl) {
      caretEl = document.createElement('div');
      caretEl.className = 'remote-input-caret';
      wrapper.appendChild(caretEl);
    }
    if (!selEl) {
      selEl = document.createElement('div');
      selEl.className = 'remote-input-selection';
      wrapper.appendChild(selEl);
    }

    const val = inputEl.value || '';
    const style = window.getComputedStyle(inputEl);
    const font = `${style.fontSize} ${style.fontFamily}`;
    const padLeft = parseFloat(style.paddingLeft) || 4;

    const startPos = Math.min(cursor.start, val.length);
    const endPos = Math.min(cursor.end, val.length);

    const leftWidth = getTextWidth(val.slice(0, startPos), font);

    if (startPos !== endPos) {
      const selWidth = getTextWidth(val.slice(startPos, endPos), font);
      selEl.style.display = 'block';
      selEl.style.left = `${padLeft + leftWidth - inputEl.scrollLeft}px`;
      selEl.style.width = `${selWidth}px`;
      caretEl.style.display = 'none';
    } else {
      selEl.style.display = 'none';
      caretEl.style.display = 'block';
      caretEl.style.left = `${padLeft + leftWidth - inputEl.scrollLeft}px`;
    }
  }

  // File Tree Item Hover Sync
  socket.on('tree-hover-update', ({ path, isHovered }) => {
    if (isHovered) {
      syncedHoveredTreePath = path;
    } else if (syncedHoveredTreePath === path) {
      syncedHoveredTreePath = null;
    }
    const fileListContainer = document.getElementById('fileListContainer');
    if (fileListContainer) {
      const items = fileListContainer.querySelectorAll('.user-item');
      items.forEach(item => {
        if (item.dataset.path === path) {
          if (isHovered) item.classList.add('is-hovered');
          else item.classList.remove('is-hovered');
        } else if (!isHovered && !syncedHoveredTreePath) {
          item.classList.remove('is-hovered');
        }
      });
    }
  });

  // File Tree Action Buttons (Rename / Delete) Hover Sync
  socket.on('tree-action-hover-update', ({ path, action, isHovered }) => {
    if (isHovered) {
      syncedHoveredTreeAction = { path, action };
      syncedHoveredTreePath = path;
    } else if (syncedHoveredTreeAction && syncedHoveredTreeAction.path === path && syncedHoveredTreeAction.action === action) {
      syncedHoveredTreeAction = null;
    }
    const fileListContainer = document.getElementById('fileListContainer');
    if (fileListContainer) {
      const items = fileListContainer.querySelectorAll('.user-item');
      items.forEach(item => {
        if (item.dataset.path === path) {
          if (isHovered) item.classList.add('is-hovered');
          const btn = action === 'rename' ? item.querySelector('.rename-btn') : item.querySelector('.delete-btn');
          if (btn) {
            if (isHovered) btn.classList.add('is-hovered');
            else btn.classList.remove('is-hovered');
          }
        }
      });
    }
  });

  // Realtime Rename Sync
  socket.on('tree-rename-start', ({ path, initialName, cursor, senderId }) => {
    if (senderId !== socket.id) {
      localRenaming = false;
      renamingPath = path;
      renamingValue = initialName || '';
      renamingCursor = cursor || { start: (initialName || '').length, end: (initialName || '').length };
      renderFilesList();
      setTimeout(() => {
        const inputEl = document.querySelector('.inline-rename-input');
        if (inputEl) updateInputCursorDisplay(inputEl, renamingCursor);
      }, 0);
    }
  });

  socket.on('tree-rename-input', ({ path, value, cursor, senderId }) => {
    if (senderId !== socket.id) {
      renamingPath = path;
      renamingValue = value || '';
      if (cursor) renamingCursor = cursor;
      const inputEl = document.querySelector('.inline-rename-input');
      if (inputEl) {
        inputEl.value = renamingValue;
        updateInputCursorDisplay(inputEl, renamingCursor);
      } else {
        renderFilesList();
      }
    }
  });

  socket.on('tree-rename-cursor-update', ({ path, cursor, senderId }) => {
    if (senderId !== socket.id && renamingPath === path) {
      renamingCursor = cursor;
      const inputEl = document.querySelector('.inline-rename-input');
      if (inputEl) {
        updateInputCursorDisplay(inputEl, renamingCursor);
      }
    }
  });

  socket.on('tree-rename-end', ({ path }) => {
    if (renamingPath === path || !path) {
      renamingPath = null;
      renamingValue = '';
      renamingCursor = null;
      localRenaming = false;
      renderFilesList();
    }
  });

  // Realtime Inline Create Sync
  socket.on('tree-create-start', ({ type, parentFolder, cursor, senderId }) => {
    if (senderId !== socket.id) {
      localCreating = false;
      inlineCreatingItem = { type, parentFolder, value: '', cursor: cursor || { start: 0, end: 0 } };
      renderFilesList();
      setTimeout(() => {
        const inputEl = document.querySelector('.inline-create-input');
        if (inputEl) updateInputCursorDisplay(inputEl, inlineCreatingItem.cursor);
      }, 0);
    }
  });

  socket.on('tree-create-input', ({ value, cursor, senderId }) => {
    if (senderId !== socket.id && inlineCreatingItem) {
      inlineCreatingItem.value = value || '';
      if (cursor) inlineCreatingItem.cursor = cursor;
      const inputEl = document.querySelector('.inline-create-input');
      if (inputEl) {
        inputEl.value = inlineCreatingItem.value;
        updateInputCursorDisplay(inputEl, inlineCreatingItem.cursor);
      }
    }
  });

  socket.on('tree-create-cursor-update', ({ cursor, senderId }) => {
    if (senderId !== socket.id && inlineCreatingItem) {
      inlineCreatingItem.cursor = cursor;
      const inputEl = document.querySelector('.inline-create-input');
      if (inputEl) {
        updateInputCursorDisplay(inputEl, inlineCreatingItem.cursor);
      }
    }
  });

  socket.on('tree-create-end', () => {
    inlineCreatingItem = null;
    localCreating = false;
    renderFilesList();
  });

  socket.on('tree-select-update', ({ path }) => {
    selectedFolder = path || '';
    renderFilesList();
  });

  // Real-time Tree Drag & Drop Sync
  socket.on('tree-drag-start-update', ({ path, userId }) => {
    syncedDraggingPath = path;
    const fileListContainer = document.getElementById('fileListContainer');
    if (fileListContainer) {
      const items = fileListContainer.querySelectorAll('.user-item');
      items.forEach(item => {
        if (item.dataset.path === path) {
          item.classList.add('is-dragging');
        }
      });
    }
  });

  socket.on('tree-drag-over-update', ({ targetPath, isFolder, isRoot }) => {
    syncedDragOverPath = targetPath || null;
    syncedRootDragOver = !!isRoot;
    const fileListContainer = document.getElementById('fileListContainer');
    if (fileListContainer) {
      if (isRoot) {
        fileListContainer.classList.add('root-drag-over');
      } else {
        fileListContainer.classList.remove('root-drag-over');
      }
      const items = fileListContainer.querySelectorAll('.user-item');
      items.forEach(item => {
        if (isFolder && targetPath && item.dataset.path === targetPath) {
          item.classList.add('drag-folder-over');
        } else {
          item.classList.remove('drag-folder-over');
        }
      });
    }
  });

  socket.on('tree-drag-leave-update', ({ targetPath, isRoot }) => {
    const fileListContainer = document.getElementById('fileListContainer');
    if (fileListContainer) {
      if (isRoot) {
        fileListContainer.classList.remove('root-drag-over');
        syncedRootDragOver = false;
      }
      if (targetPath) {
        const items = fileListContainer.querySelectorAll('.user-item');
        items.forEach(item => {
          if (item.dataset.path === targetPath) {
            item.classList.remove('drag-folder-over');
          }
        });
        if (syncedDragOverPath === targetPath) {
          syncedDragOverPath = null;
        }
      }
    }
  });

  socket.on('tree-drag-end-update', () => {
    syncedDraggingPath = null;
    syncedDragOverPath = null;
    syncedRootDragOver = false;
    const fileListContainer = document.getElementById('fileListContainer');
    if (fileListContainer) {
      fileListContainer.classList.remove('root-drag-over');
      const items = fileListContainer.querySelectorAll('.user-item');
      items.forEach(item => {
        item.classList.remove('is-dragging');
        item.classList.remove('drag-folder-over');
      });
    }
  });

  socket.on('file-system-update', ({ files, cwd, sidebarCollapsed, collapsedFolders: remoteCollapsedFolders }) => {
    if (files !== undefined) {
      shellFiles = files && files.length > 0 ? files : [];
      try { localStorage.setItem('livecode_files', JSON.stringify(shellFiles)); } catch(e){}
    }
    if (cwd !== undefined) currentShellCwd = cwd;
    if (sidebarCollapsed !== undefined) {
      if (sidebarCollapsed) {
        sidebar.classList.add('collapsed');
      } else {
        sidebar.classList.remove('collapsed');
      }
      updateSidebarToggleState();
    }
    if (Array.isArray(remoteCollapsedFolders)) {
      collapsedFolders.clear();
      remoteCollapsedFolders.forEach(f => collapsedFolders.add(f));
    }
    renderFilesList();
  });

  socket.on('sidebar-update', ({ collapsed, collapsedFolders: remoteCollapsedFolders }) => {
    if (collapsed !== undefined) {
      if (collapsed) {
        sidebar.classList.add('collapsed');
      } else {
        sidebar.classList.remove('collapsed');
      }
      updateSidebarToggleState();
    }
    if (Array.isArray(remoteCollapsedFolders)) {
      collapsedFolders.clear();
      remoteCollapsedFolders.forEach(f => collapsedFolders.add(f));
      renderFilesList();
    }
  });

  socket.on('chat-drawer-update', ({ collapsed }) => {
    if (collapsed !== undefined && chatDrawer) {
      if (collapsed) {
        chatDrawer.classList.add('collapsed');
      } else {
        chatDrawer.classList.remove('collapsed');
      }
      updateChatDrawerToggleState();
    }
  });

  socket.on('drawer-tab-update', ({ tab }) => {
    if (tab) {
      switchDrawerTab(tab, false);
    }
  });

  socket.on('console-update', ({ collapsed, expanded, height, isDragging, color }) => {
    if (!outputDrawer) return;
    if (isDragging) {
      outputDrawer.style.transition = 'none';
    } else {
      outputDrawer.style.transition = '';
    }
    if (collapsed !== undefined) {
      if (collapsed) {
        outputDrawer.classList.add('collapsed');
      } else {
        outputDrawer.classList.remove('collapsed');
      }
    }
    if (expanded !== undefined) {
      if (expanded) {
        outputDrawer.classList.add('expanded');
      } else {
        outputDrawer.classList.remove('expanded');
      }
    }
    if (height !== undefined) {
      if (height === null || height === '') {
        outputDrawer.style.height = '';
      } else {
        outputDrawer.style.height = (typeof height === 'number') ? `${height}px` : height;
      }
    }
    const resizer = document.getElementById('consoleResizer');
    if (resizer) {
      if (isDragging) {
        if (color) {
          resizer.style.setProperty('--resizer-color', color);
        }
        resizer.classList.add('is-dragging');
      } else if (isDragging === false) {
        resizer.classList.remove('is-dragging');
        resizer.style.removeProperty('--resizer-color');
      }
    }
    updateConsoleButtonsState();
    if (isDragging) {
      if (fitAddon) fitAddon.fit();
    } else {
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
      }, 50);
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
      }, 260);
    }
  });

  socket.on('cursor-update', ({ userId, cursor }) => {
    if (userId === socket.id) return;
    const user = usersList.find(u => u.id === userId);
    if (user) {
      activeRestingCursorUserId = userId;
      user.cursor = cursor;
      const existing = remoteCursors.get(userId) || {};
      remoteCursors.set(userId, {
        ...existing,
        cursor: cursor,
        name: user.name,
        color: user.color,
        isInsideEditor: true
      });

      if (cursor.selection && cursor.selection.start !== cursor.selection.end) {
        activeSelection = {
          userId: userId,
          start: cursor.selection.start,
          end: cursor.selection.end,
          color: user.color
        };
        // Clear local browser selection so only one selection exists globally
        window.getSelection().removeAllRanges();
        codeTextarea.setSelectionRange(codeTextarea.selectionStart, codeTextarea.selectionStart);
      } else if (!cursor.selection || cursor.selection.start === cursor.selection.end) {
        if (activeSelection) {
          activeSelection = null;
        }
      }
      renderUsers();
      renderCollaboratorCursors();
    }
  });

  socket.on('clear-selections', () => {
    window.getSelection().removeAllRanges();
    codeTextarea.setSelectionRange(codeTextarea.selectionStart, codeTextarea.selectionStart);
    if (activeSelection !== null) {
      activeSelection = null;
      renderCollaboratorCursors();
    }
  });

  socket.on('mouse-update', (data) => {
    const { userId } = data;
    if (!userId || userId === socket.id) return;
    const user = usersList.find(u => u.id === userId);
    if (user) {
      const existing = remoteCursors.get(userId) || { cursor: user.cursor, name: user.name, color: user.color };
      existing.mouseData = data;
      existing.lastMouseMove = Date.now();
      remoteCursors.set(userId, existing);
      renderCollaboratorCursors();
    }
  });

  socket.on('scroll-update', ({ userId, top, left }) => {
    if (userId === socket.id) return;
    isRemoteScroll = true;
    codeTextarea.scrollTop = top;
    codeTextarea.scrollLeft = left;
    
    // Update visual layers immediately
    highlightCode.parentElement.scrollTop = top;
    highlightCode.parentElement.scrollLeft = left;
    lineNumbers.scrollTop = top;
    renderCollaboratorCursors();
    
    // Reset flag after browser processes the scroll event
    setTimeout(() => { isRemoteScroll = false; }, 50);
  });

  socket.on('output-scroll-update', ({ userId, top, line }) => {
    if (userId === socket.id || !consoleOutput) return;
    isRemoteOutputScroll = true;
    if (terminal && typeof line === 'number') {
      try {
        terminal.scrollToLine(line);
      } catch (e) {}
    }
    const viewport = consoleOutput.querySelector('.xterm-viewport');
    if (viewport && typeof top === 'number') {
      viewport.scrollTop = top;
    } else if (typeof top === 'number') {
      consoleOutput.scrollTop = top;
    }
    setTimeout(() => { isRemoteOutputScroll = false; }, 80);
  });

  socket.on('host-assigned', ({ isHost: newIsHost }) => {
    isHost = newIsHost;
    if (currentUser) currentUser.isHost = isHost;
    updateRoleBadge();
    applyProtectionSettings({ copyDisabled: isCopyDisabled, pasteDisabled: isPasteDisabled, readOnly: isReadOnly, examMode: isExamMode });
    if (isHost) {
      getOrInitWorker();
    }
    showToast('👑 You are now the Room Host! Security controls unlocked.');
  });

  socket.on('execute-on-host', ({ code }) => {
    if (isHost) {
      runPythonCode(code || codeTextarea.value);
    }
  });

  socket.on('execute-shell', ({ command, currentCode, activeFile, openTabs: reqTabs, skipPrompt }) => {
    if (reqTabs && Array.isArray(reqTabs)) {
      openTabs = [...reqTabs];
      renderTabs();
    }
    if (isHost) {
      const worker = getOrInitWorker();
      if (worker) worker.postMessage({ type: 'shell', command: command, currentCode: currentCode, activeFile: activeFile || currentActiveFile, skipPrompt: skipPrompt });
    }
  });

  socket.on('terminate-on-host', () => {
    if (isHost && isExecutionRunning) {
      terminateExecution();
    }
  });

  socket.on('protection-alert', ({ message }) => {
    showToast(message, 'warning');
  });

  socket.on('room-error', ({ message, code }) => {
    showToast(`🔒 ${message}`, 'error');
    if (code === 'LIVE_SHARING_OFF' || code === 'ROOM_KILLED' || code === 'ROOM_EXPIRED') {
      const guestUsernameModal = document.getElementById('guestUsernameModal');
      if (guestUsernameModal) {
        guestUsernameModal.classList.remove('hidden');
        guestUsernameModal.innerHTML = `
          <div style="background: var(--bg-card, #12151e); border: 1px solid var(--border-color, #272d3d); border-radius: 8px; padding: 24px; max-width: 440px; width: 90%; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
            <h3 style="margin-top: 0; color: #ef4444; font-size: 1.25rem;">${code === 'ROOM_KILLED' || code === 'ROOM_EXPIRED' ? '🛑 Room Closed' : '🔒 Access Denied'}</h3>
            <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
              ${(code === 'ROOM_KILLED' || code === 'ROOM_EXPIRED') ? '<button onclick="window.location.href=\'/\'" class="btn btn-primary" style="padding: 8px 16px;">New Session</button>' : ''}
              <button type="button" id="roomErrorJoinBtn" class="btn btn-secondary" style="padding: 8px 16px;">Join Another Room</button>
            </div>
          </div>
        `;
        const roomErrorJoinBtn = document.getElementById('roomErrorJoinBtn');
        if (roomErrorJoinBtn) {
          roomErrorJoinBtn.addEventListener('click', () => {
            guestUsernameModal.classList.add('hidden');
            openJoinRoomModal();
          });
        }
      }
    }
  });

  function promptGuestUsernameModal() {
    const guestUsernameModal = document.getElementById('guestUsernameModal');
    if (!guestUsernameModal) return;

    guestUsernameModal.innerHTML = `
      <div style="background: var(--bg-card, #1e293b); border: 1px solid var(--border-color, #334155); border-radius: 12px; padding: 24px; width: 90%; max-width: 400px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); text-align: center;">
        <div style="font-size: 2rem; margin-bottom: 8px;">👤</div>
        <h3 style="margin: 0 0 8px 0; color: var(--text-primary, #f8fafc); font-size: 1.25rem;">Enter Your Username</h3>
        <p style="margin: 0 0 16px 0; color: var(--text-muted, #94a3b8); font-size: 0.875rem;">A username is required to join this live code sharing session.</p>
        <form id="guestUsernameForm" onsubmit="event.preventDefault();">
          <input type="text" id="guestUsernameInput" placeholder="Enter username..." maxlength="30" autocomplete="off" style="width: 100%; padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border-color, #334155); background: var(--bg-surface, #0f172a); color: var(--text-primary, #f8fafc); font-size: 0.95rem; margin-bottom: 16px; outline: none; box-sizing: border-box;">
          <button type="submit" id="submitGuestUsernameBtn" class="btn btn-primary" style="width: 100%; padding: 10px; font-weight: 600; cursor: pointer;">Join Live Session</button>
        </form>
      </div>
    `;

    guestUsernameModal.classList.remove('hidden');
    const input = document.getElementById('guestUsernameInput');
    const form = document.getElementById('guestUsernameForm');
    if (input) setTimeout(() => input.focus(), 100);

    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        const cleanName = (input ? input.value : '').trim();
        if (!cleanName) return;
        
        savedUsername = cleanName;
        if (currentUser) currentUser.name = cleanName;
        try { localStorage.setItem('livecode_username', cleanName); } catch(err){}
        socket.emit('update-username', { username: cleanName });
        guestUsernameModal.classList.add('hidden');
        updateRoleBadge();
        renderUsers();
      };
    }
  }

  socket.on('live-sharing-resumed', (state) => {
    showToast('🟢 Live Code Sharing resumed by Host!');
    
    currentRoomId = state.roomId;
    setAllRoomIdDisplays(state.roomId);
    
    roomCode = state.code;
    codeTextarea.value = roomCode;
    
    if (state.openTabs && Array.isArray(state.openTabs)) {
      openTabs = [...state.openTabs];
    }
    if (state.activeFile !== undefined) currentActiveFile = state.activeFile;
    if (currentActiveFile && !openTabs.includes(currentActiveFile)) openTabs.push(currentActiveFile);
    if (state.files && state.files.length > 0) {
      shellFiles = state.files;
    }
    if (state.cwd) currentShellCwd = state.cwd;
    const isMobileScreen = window.matchMedia('(max-width: 768px)').matches;
    if (isMobileScreen) {
      if (sidebar) sidebar.classList.add('collapsed');
      if (chatDrawer) chatDrawer.classList.add('collapsed');
      updateSidebarToggleState();
      updateChatDrawerToggleState();
    } else {
      if (state.sidebarCollapsed !== undefined) {
        if (state.sidebarCollapsed) {
          sidebar.classList.add('collapsed');
        } else {
          sidebar.classList.remove('collapsed');
        }
        updateSidebarToggleState();
      }
      if (state.chatDrawerCollapsed !== undefined && chatDrawer) {
        if (state.chatDrawerCollapsed) {
          chatDrawer.classList.add('collapsed');
        } else {
          chatDrawer.classList.remove('collapsed');
        }
        updateChatDrawerToggleState();
      }
    }
    if (state.consoleCollapsed !== undefined && outputDrawer) {
      if (state.consoleCollapsed) {
        outputDrawer.classList.add('collapsed');
      } else {
        outputDrawer.classList.remove('collapsed');
      }
    }
    if (state.consoleExpanded !== undefined && outputDrawer) {
      if (state.consoleExpanded) {
        outputDrawer.classList.add('expanded');
      } else {
        outputDrawer.classList.remove('expanded');
      }
    }
    if (state.consoleHeight && outputDrawer) {
      outputDrawer.style.height = (typeof state.consoleHeight === 'number') ? `${state.consoleHeight}px` : state.consoleHeight;
    }
    updateConsoleButtonsState();
    if (state.activeDrawerTab) {
      switchDrawerTab(state.activeDrawerTab, false);
    }
    if (state.collapsedFolders && Array.isArray(state.collapsedFolders)) {
      collapsedFolders.clear();
      state.collapsedFolders.forEach(f => collapsedFolders.add(f));
    }
    if (state.selectedFolder !== undefined) {
      selectedFolder = state.selectedFolder || '';
    }
    renderFilesList();
    renderTabs();

    if (state.outputScroll) {
      setTimeout(() => {
        if (terminal && typeof state.outputScroll.line === 'number') {
          try { terminal.scrollToLine(state.outputScroll.line); } catch (e) {}
        }
        const viewport = consoleOutput ? consoleOutput.querySelector('.xterm-viewport') : null;
        if (viewport && typeof state.outputScroll.top === 'number') {
          viewport.scrollTop = state.outputScroll.top;
        }
      }, 120);
    }
    
    roomLanguage = state.language || 'python';
    if (languageSelect) languageSelect.value = roomLanguage;
    updateDropdownUI(roomLanguage);

    currentUser = state.currentUser;
    isHost = state.isHost;

    if (!isHost && !savedUsername) {
      promptGuestUsernameModal();
    } else {
      const guestUsernameModal = document.getElementById('guestUsernameModal');
      if (guestUsernameModal) {
        guestUsernameModal.classList.add('hidden');
      }
    }

    updateRoleBadge();
    applyProtectionSettings(state.settings);
    
    usersList = state.users || [];
    renderUsers();
    renderChat(state.chat || []);
    updateEditorDisplay();
  });

  socket.on('chat-message', (msg) => {
    appendChatMessage(msg);
  });

  const outputStatusBadge = document.getElementById('outputStatusBadge');

  function updateOutputStatus(status, text, isRemote = false) {
    if (!outputStatusBadge) return;
    if (!status || status === 'hidden') {
      outputStatusBadge.className = 'output-status-badge hidden';
      outputStatusBadge.textContent = '';
      if (typeof setRunningUIState === 'function') setRunningUIState(false);
    } else {
      outputStatusBadge.className = `output-status-badge ${status}`;
      outputStatusBadge.textContent = text;
      if (typeof setRunningUIState === 'function') {
        if (status === 'running') {
          setRunningUIState(true);
        } else {
          setRunningUIState(false);
        }
      }
    }

    if (!isRemote) {
      socket.emit('output-sync', { action: 'status', status: status, text: text });
    }
  }

  socket.on('output-update', (data) => {
    if (outputDrawer) {
      outputDrawer.classList.remove('collapsed');
      updateConsoleButtonsState();
    }
    if (consoleOutput) consoleOutput.classList.remove('hidden');
    if (htmlPreviewContainer) htmlPreviewContainer.classList.add('hidden');

    if (data.action === 'clear') {
      isShellMode = false;
      isTerminalExpectingInput = false;
      currentTerminalInputBuffer = '';
      if (!terminal) initTerminal();
      if (terminal) {
        terminal.reset();
        if (data.message) {
          terminal.write(`\x1b[36m${data.message}\x1b[0m\r\n`);
        }
      }
      if (data.shell) {
        startShellMode(true);
      }
    } else if (data.action === 'append') {
      appendConsoleLine(data.type, data.text, true);
    } else if (data.action === 'status' || data.status) {
      if (data.status === 'running') {
        isShellMode = false;
        isTerminalExpectingInput = false;
        currentTerminalInputBuffer = '';
      }
      updateOutputStatus(data.status, data.text, true);
    } else if (data.action === 'input_request') {
      isShellMode = false;
      if (!terminal) initTerminal();
      if (data.text && terminal) {
        terminal.write(`\x1b[36m${data.text}\x1b[0m`);
      }
      showConsoleInput();
    } else if (data.action === 'shell_command') {
      if (!terminal) initTerminal();
      if (terminal) {
        const cwd = data.cwd !== undefined ? data.cwd : '~';
        const renderedCmd = renderShellInput(data.cmd ? data.cmd.trim() : '');
        terminal.write(`\r\x1b[2K\x1b[1;34m${cwd}\x1b[32m$ \x1b[0m${renderedCmd}\r\n`);
      }
    } else if (data.action === 'shell_prompt') {
      if (!terminal) initTerminal();
      if (terminal) {
        const cwd = data.cwd !== undefined ? data.cwd : (data.text ? data.text.replace(/\$\s*$/, '') : '~');
        terminal.write(`\r\x1b[2K\x1b[1;34m${cwd}\x1b[32m$ \x1b[0m`);
      }
      isShellMode = true;
      isTerminalExpectingInput = true;
      currentTerminalInputBuffer = '';
      showConsoleInput();
    } else if (data.action === 'terminal_input') {
      if (!terminal) initTerminal();
      if (terminal) {
        if (data.isShellMode) {
          isShellMode = true;
          isTerminalExpectingInput = true;
          let displayCwd = (data.cwd || currentShellCwd || '~');
          if (displayCwd.startsWith('/home/pyodide')) {
            displayCwd = displayCwd.replace('/home/pyodide', '~');
          }
          if (displayCwd === '') displayCwd = '~';
          const promptFormatted = `\x1b[1;34m${displayCwd}\x1b[32m$ \x1b[0m`;
          currentTerminalInputBuffer = data.buffer !== undefined ? data.buffer : '';
          if (data.ctrlC) {
            terminal.write('\x1b[35m^C\x1b[0m\r\n');
          }
          terminal.write(`\r\x1b[2K${promptFormatted}${renderShellInput(currentTerminalInputBuffer)}`);
        } else {
          currentTerminalInputBuffer = data.buffer !== undefined ? data.buffer : '';
          if (data.diff) {
            terminal.write(data.diff);
          } else if (data.char) {
            terminal.write('\x1b[35m' + data.char + '\x1b[0m');
          }
        }
      }
    } else if (data.action === 'input_resolved') {
      if (terminal && !data.isShellMode && !isShellMode) {
        // If remote client resolved the input, write newline to advance terminal
        terminal.write('\r\n');
      }
      isShellMode = false;
      hideConsoleInput();
    }
  });

  // --------------------------------------------------------------------------
  // 3. Security & Copy/Paste Protection Engine
  // --------------------------------------------------------------------------

  function applyProtectionSettings(settings) {
    const previousExamMode = isExamMode;
    if (settings.copyDisabled !== undefined) isCopyDisabled = settings.copyDisabled;
    if (settings.pasteDisabled !== undefined) isPasteDisabled = settings.pasteDisabled;
    if (settings.readOnly !== undefined) isReadOnly = settings.readOnly;
    if (settings.examMode !== undefined) isExamMode = settings.examMode;
    if (settings.examDuration) {
      if (!currentTimerState || !currentTimerState.isRunning) {
        currentTimerState.mode = 'countdown';
        currentTimerState.duration = settings.examDuration;
        currentTimerState.remaining = settings.examDuration;
        currentTimerState.isRunning = false;
        renderTimerUI();
      }
    }
    if (settings.liveSharingEnabled !== undefined) isLiveSharingEnabled = settings.liveSharingEnabled;
    if (settings.syntaxHighlight !== undefined) {
      isSyntaxHighlightEnabled = settings.syntaxHighlight;
      updateEditorDisplay();
    }

    // Update UI toggle states
    toggleCopyProtection.checked = isCopyDisabled;
    togglePasteProtection.checked = isPasteDisabled;
    toggleReadOnly.checked = isReadOnly;
    if (toggleExamMode) {
      toggleExamMode.classList.toggle('active', isExamMode);
      toggleExamMode.title = isExamMode
        ? 'Exam Mode: ACTIVE (Click to turn off)'
        : 'Exam Mode: Enforce Fullscreen & Anti-Cheat Proctoring';
    }
    if (toggleLiveSharing) {
      toggleLiveSharing.checked = isLiveSharingEnabled;
    }
    if (toggleLiveSharingSettings) {
      toggleLiveSharingSettings.checked = isLiveSharingEnabled;
    }
    if (toggleLiveSharingMobile) {
      toggleLiveSharingMobile.checked = isLiveSharingEnabled;
    }
    if (toggleSyntaxHighlight) {
      toggleSyntaxHighlight.checked = isSyntaxHighlightEnabled;
    }

    // Control permission for non-hosts (disable switches if not host)
    toggleCopyProtection.disabled = !isHost;
    togglePasteProtection.disabled = !isHost;
    toggleReadOnly.disabled = !isHost;
    if (toggleLiveSharing) {
      toggleLiveSharing.disabled = !isHost;
    }
    if (toggleLiveSharingSettings) {
      toggleLiveSharingSettings.disabled = !isHost;
    }
    if (toggleLiveSharingMobile) {
      toggleLiveSharingMobile.disabled = !isHost;
    }
    if (toggleSyntaxHighlight) {
      toggleSyntaxHighlight.disabled = !isHost;
    }

    // Apply Copy & Exam Protection CSS classes (Exempt Host)
    if ((isCopyDisabled || isExamMode) && !isHost) {
      document.body.classList.add('copy-disabled');
      codeTextarea.setAttribute('draggable', 'false');
    } else {
      document.body.classList.remove('copy-disabled');
      codeTextarea.removeAttribute('draggable');
    }
    
    if (protectionBanner) {
      if (isCopyDisabled) {
        protectionBanner.classList.remove('hidden');
      } else {
        protectionBanner.classList.add('hidden');
      }
    }

    if (examModeBanner) {
      if (isExamMode) {
        examModeBanner.classList.remove('hidden');
      } else {
        examModeBanner.classList.add('hidden');
      }
    }

    // When host turns OFF exam mode, automatically exit guests from fullscreen and clean up timer alarm
    if (previousExamMode && !isExamMode) {
      if (!isHost && typeof exitExamFullscreen === 'function' && isCurrentlyFullscreen()) {
        exitExamFullscreen();
        showToast('🎓 Exam Mode ended by host. Fullscreen exited.', 'info');
      }
      if (typeof stopAlarmRinging === 'function') {
        stopAlarmRinging();
      }
      if (typeof hideTimesUpModal === 'function') {
        hideTimesUpModal();
      }
    }

    // In Exam Mode, ensure timer dropdown is closed for guests
    if (isExamMode && !isHost) {
      if (typeof setTimerDropdownOpen === 'function') {
        setTimerDropdownOpen(false, false);
      }
    }

    if (typeof updateCandidateViolationDisplay === 'function') {
      updateCandidateViolationDisplay();
    }
    if (typeof checkFullscreenExamMode === 'function') {
      checkFullscreenExamMode();
    }

    // Apply Live Code Sharing UI states to all chips and dots
    document.querySelectorAll('.pulse-dot').forEach(dot => {
      dot.classList.toggle('off', !isLiveSharingEnabled);
    });
    document.querySelectorAll('.room-id-chip, .settings-compact-chip, #settingsRoomShareBtn').forEach(chip => {
      chip.classList.toggle('live-sharing-off', !isLiveSharingEnabled);
    });
    if (currentRoomId) {
      setAllRoomIdDisplays(currentRoomId);
    }

    // Apply Read-Only mode
    if (isReadOnly) {
      document.body.classList.add('read-only-mode');
      codeTextarea.readOnly = !isHost; // Host can edit even if read-only
    } else {
      document.body.classList.remove('read-only-mode');
      codeTextarea.readOnly = false;
    }

    // Update timer chip status (e.g., stop blinking red if host unlocked read-only)
    if (typeof renderTimerUI === 'function') {
      renderTimerUI();
    }

    renderUsers();

    // Update Download, Copy, Cut, Paste and Undo/Redo Buttons State
    updateDownloadButtonState();
    updateCopyButtonState();
    updateUndoRedoUI();
  }

  function updateDownloadButtonState() {
    const isDownloadAllowed = (!isCopyDisabled && !isExamMode) || isHost;
    if (downloadCodeBtn) {
      downloadCodeBtn.disabled = !isDownloadAllowed;
      if (!isDownloadAllowed) {
        downloadCodeBtn.title = (isExamMode && !isHost)
          ? '🔒 Downloading is locked during Exam Mode'
          : '🔒 Downloading is locked because copy protection is enabled';
      } else {
        downloadCodeBtn.title = 'Download Code File';
      }
    }
  }

  function updateCopyButtonState() {
    const isCopyAllowed = (!isCopyDisabled && !isExamMode) || isHost;
    const isCutAllowed = isCopyAllowed && (!isReadOnly || isHost);
    const isPasteAllowed = (!isPasteDisabled && !isExamMode && !isReadOnly) || isHost;
    const isConsoleCopyAllowed = !isExamMode || isHost;

    if (copyCodeBtn) {
      copyCodeBtn.disabled = !isCopyAllowed;
      if (!isCopyAllowed) {
        copyCodeBtn.title = (isExamMode && !isHost)
          ? '🔒 Copying is locked during Exam Mode'
          : '🔒 Copying is locked because copy protection is enabled';
      } else {
        copyCodeBtn.title = 'Copy Code to Clipboard';
      }
    }

    const copyConsoleBtnEl = document.getElementById('copyConsoleBtn');
    if (copyConsoleBtnEl) {
      copyConsoleBtnEl.disabled = !isConsoleCopyAllowed;
      if (!isConsoleCopyAllowed) {
        copyConsoleBtnEl.title = '🔒 Copying console output is locked during Exam Mode';
      } else {
        copyConsoleBtnEl.title = 'Copy Output to Clipboard';
      }
    }

    const ctxCut = document.getElementById('ctxCutBtn');
    if (ctxCut) {
      if (!isCutAllowed) {
        ctxCut.classList.add('disabled');
        ctxCut.title = (isExamMode && !isHost)
          ? '🔒 Cutting is locked during Exam Mode'
          : (isReadOnly && !isHost)
            ? '🔒 Cutting is locked because editor is in read-only mode'
            : '🔒 Cutting is locked because copy protection is enabled';
      } else {
        ctxCut.classList.remove('disabled');
        ctxCut.removeAttribute('title');
      }
    }

    const ctxCopy = document.getElementById('ctxCopyBtn');
    if (ctxCopy) {
      if (!isCopyAllowed) {
        ctxCopy.classList.add('disabled');
        ctxCopy.title = (isExamMode && !isHost)
          ? '🔒 Copying is locked during Exam Mode'
          : '🔒 Copying is locked because copy protection is enabled';
      } else {
        ctxCopy.classList.remove('disabled');
        ctxCopy.removeAttribute('title');
      }
    }

    const ctxPaste = document.getElementById('ctxPasteBtn');
    if (ctxPaste) {
      if (!isPasteAllowed || (isReadOnly && !isHost)) {
        ctxPaste.classList.add('disabled');
        ctxPaste.title = (isExamMode && !isHost)
          ? '🔒 Pasting is locked during Exam Mode'
          : (isReadOnly && !isHost)
            ? '🔒 Pasting is locked because editor is in read-only mode'
            : '🔒 Pasting is locked because paste protection is enabled';
      } else {
        ctxPaste.classList.remove('disabled');
        ctxPaste.removeAttribute('title');
      }
    }
  }

  // Security Controls Permission Notification for Guests
  let lastSecurityToastTime = 0;
  function notifySecurityRestricted() {
    const now = Date.now();
    if (now - lastSecurityToastTime < 2000) return;
    lastSecurityToastTime = now;
    showToast('⚠️ Only the room host can modify security controls.', 'warning');
  }

  // Intercept any clicks on security controls by non-host guests
  const protectionPanelEl = document.getElementById('protectionPanel');
  if (protectionPanelEl) {
    protectionPanelEl.addEventListener('click', (e) => {
      if (!isHost) {
        e.preventDefault();
        e.stopPropagation();
        notifySecurityRestricted();
      }
    }, true);
  }

  const liveSharingToggleLabelEl = document.getElementById('liveSharingToggleLabel');
  if (liveSharingToggleLabelEl) {
    liveSharingToggleLabelEl.addEventListener('click', (e) => {
      if (!isHost) {
        e.preventDefault();
        e.stopPropagation();
        notifySecurityRestricted();
      }
    }, true);
  }

  // Security Toggles Event Listeners (Host Action)
  toggleCopyProtection.addEventListener('change', () => {
    if (!isHost) {
      toggleCopyProtection.checked = isCopyDisabled;
      notifySecurityRestricted();
      return;
    }
    socket.emit('update-settings', { copyDisabled: toggleCopyProtection.checked });
  });

  togglePasteProtection.addEventListener('change', () => {
    if (!isHost) {
      togglePasteProtection.checked = isPasteDisabled;
      notifySecurityRestricted();
      return;
    }
    socket.emit('update-settings', { pasteDisabled: togglePasteProtection.checked });
  });

  toggleReadOnly.addEventListener('change', () => {
    if (!isHost) {
      toggleReadOnly.checked = isReadOnly;
      notifySecurityRestricted();
      return;
    }
    socket.emit('update-settings', { readOnly: toggleReadOnly.checked });
  });

  function openExamTimeModal() {
    if (!examTimeModal) return;
    examTimeModal.classList.remove('hidden');
    if (examDurationInput) {
      examDurationInput.value = '5';
      examDurationInput.focus();
      examDurationInput.select();
    }
    const presetBtns = examTimeModal.querySelectorAll('.exam-preset-btn');
    presetBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.minutes === '5');
    });
  }

  function closeExamTimeModal() {
    if (examTimeModal) {
      examTimeModal.classList.add('hidden');
    }
  }

  if (toggleExamMode) {
    toggleExamMode.addEventListener('click', () => {
      if (!isHost) {
        notifySecurityRestricted();
        return;
      }
      if (!isExamMode) {
        // Ask host to set time before turning on Exam Mode
        openExamTimeModal();
      } else {
        // Turning off exam mode directly (server atomically resets timer with silent: true)
        socket.emit('update-settings', { examMode: false });
      }
    });
  }

  // Preset buttons in Exam Time Modal
  if (examTimeModal) {
    examTimeModal.querySelectorAll('.exam-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mins = btn.dataset.minutes;
        if (examDurationInput) {
          examDurationInput.value = mins;
        }
        examTimeModal.querySelectorAll('.exam-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    if (examDurationInput) {
      examDurationInput.addEventListener('input', () => {
        const val = examDurationInput.value.trim();
        examTimeModal.querySelectorAll('.exam-preset-btn').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.minutes === val);
        });
      });
      examDurationInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (startExamWithTimeBtn) startExamWithTimeBtn.click();
        }
      });
    }

    if (cancelExamTimeBtn) {
      cancelExamTimeBtn.addEventListener('click', closeExamTimeModal);
    }

    if (startExamWithTimeBtn) {
      startExamWithTimeBtn.addEventListener('click', () => {
        if (!isHost) {
          closeExamTimeModal();
          return;
        }
        let mins = 5;
        if (examDurationInput) {
          const parsed = parseInt(examDurationInput.value, 10);
          if (!isNaN(parsed) && parsed > 0) {
            mins = Math.min(360, Math.max(1, parsed));
          }
        }
        const totalSeconds = mins * 60;
        closeExamTimeModal();

        // Immediately update local timer state on host
        applyTimerState({
          mode: 'countdown',
          duration: totalSeconds,
          remaining: totalSeconds,
          isRunning: false,
          startedAt: null,
          targetEndTime: null
        });

        // Set duration on server and enable exam mode atomically
        socket.emit('timer-action', { action: 'set-mode', mode: 'countdown', duration: totalSeconds });
        socket.emit('timer-action', { action: 'set-duration', duration: totalSeconds });
        socket.emit('update-settings', { examMode: true, examDuration: totalSeconds });
        showToast(`🎓 Exam Mode activated for ${mins}m (timer begins on test start).`, 'info');
      });
    }

    examTimeModal.addEventListener('click', (e) => {
      if (e.target === examTimeModal) {
        closeExamTimeModal();
      }
    });
  }

  let hasPromptedUsernameOnLiveShare = false;

  function handleLiveSharingToggleChange(sourceCheckbox) {
    if (!isHost) {
      if (sourceCheckbox) sourceCheckbox.checked = isLiveSharingEnabled;
      if (toggleLiveSharing) toggleLiveSharing.checked = isLiveSharingEnabled;
      if (toggleLiveSharingSettings) toggleLiveSharingSettings.checked = isLiveSharingEnabled;
      if (toggleLiveSharingMobile) toggleLiveSharingMobile.checked = isLiveSharingEnabled;
      notifySecurityRestricted();
      return;
    }
    const isChecked = sourceCheckbox.checked;
    if (isChecked) {
      if (!hasPromptedUsernameOnLiveShare && !savedUsername) {
        const inputName = prompt('Enter your username for Live Code Sharing:', '');
        if (inputName && inputName.trim()) {
          const cleanName = inputName.trim();
          savedUsername = cleanName;
          if (currentUser) currentUser.name = cleanName;
          try { localStorage.setItem('livecode_username', cleanName); } catch(e){}
          socket.emit('update-username', { username: cleanName });
          updateRoleBadge();
          hasPromptedUsernameOnLiveShare = true;
        } else {
          // User canceled or entered empty username: revert toggle state
          if (toggleLiveSharing) toggleLiveSharing.checked = false;
          if (toggleLiveSharingSettings) toggleLiveSharingSettings.checked = false;
          if (toggleLiveSharingMobile) toggleLiveSharingMobile.checked = false;
          showToast('⚠️ Live Code Sharing requires a username.', 'warning');
          return;
        }
      }
    }
    if (toggleLiveSharing) toggleLiveSharing.checked = isChecked;
    if (toggleLiveSharingSettings) toggleLiveSharingSettings.checked = isChecked;
    if (toggleLiveSharingMobile) toggleLiveSharingMobile.checked = isChecked;
    socket.emit('update-settings', { liveSharingEnabled: isChecked });
  }

  if (toggleLiveSharing) {
    toggleLiveSharing.addEventListener('change', () => {
      handleLiveSharingToggleChange(toggleLiveSharing);
    });
  }

  if (toggleLiveSharingSettings) {
    toggleLiveSharingSettings.addEventListener('change', () => {
      handleLiveSharingToggleChange(toggleLiveSharingSettings);
    });
  }

  if (toggleLiveSharingMobile) {
    toggleLiveSharingMobile.addEventListener('change', () => {
      handleLiveSharingToggleChange(toggleLiveSharingMobile);
    });
  }

  if (toggleSyntaxHighlight) {
    toggleSyntaxHighlight.addEventListener('change', () => {
      if (!isHost) {
        toggleSyntaxHighlight.checked = isSyntaxHighlightEnabled;
        notifySecurityRestricted();
        return;
      }
      socket.emit('update-settings', { syntaxHighlight: toggleSyntaxHighlight.checked });
      // Remove local toast because the server sends a chat message now, but we can keep local apply
      isSyntaxHighlightEnabled = toggleSyntaxHighlight.checked;
      updateEditorDisplay();
    });
  }

  // Strict Copy Prevention Listener (Exempt Host)
  document.addEventListener('copy', (e) => {
    if ((isCopyDisabled || isExamMode) && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', '');
      }
      showToast('⚠️ Copying code is disabled during Exam Mode!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'copy' });
    }
  }, true);

  // Cut Prevention Listener (Exempt Host)
  document.addEventListener('cut', (e) => {
    if ((isCopyDisabled || isExamMode) && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Cut is disabled during Exam Mode!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'cut' });
    }
  }, true);

  // Paste Prevention Listener (Exempt Host)
  document.addEventListener('paste', (e) => {
    if ((isPasteDisabled || isExamMode) && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Pasting is disabled during Exam Mode!', 'warning');
    }
  }, true);

  // Drag-and-Drop Text Prevention Listener (Exempt Host)
  document.addEventListener('dragstart', (e) => {
    if ((isCopyDisabled || isExamMode) && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.clearData();
      }
      showToast('⚠️ Dragging text is disabled during Exam Mode!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'dragstart-attempt' });
    }
  }, true);

  document.addEventListener('drag', (e) => {
    if ((isCopyDisabled || isExamMode) && !isHost) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  document.addEventListener('drop', (e) => {
    if ((isCopyDisabled || isExamMode) && !isHost) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // Keyboard Shortcuts Prevention (Ctrl+C, Cmd+C, Ctrl+X, Cmd+X, Ctrl+V, Cmd+V - Exempt Host)
  document.addEventListener('keydown', (e) => {
    const isCmdOrCtrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // Reset resting cursor to local user on any keypress
    if (activeRestingCursorUserId !== socket.id) {
      activeRestingCursorUserId = socket.id;
      renderCollaboratorCursors();
    }

    // New Tab shortcut: Ctrl+Alt+N / Cmd+Alt+N, Alt+T, Alt+N, or Ctrl+Alt+T / Cmd+Alt+T
    if ((isCmdOrCtrl && e.altKey && (key === 'n' || key === 't')) || 
        (e.altKey && (key === 't' || key === 'n'))) {
      e.preventDefault();
      e.stopPropagation();
      createNewTab();
      return;
    }

    // Prevent Save (Ctrl+S / Cmd+S for all)
    if (isCmdOrCtrl && key === 's') {
      e.preventDefault();
      e.stopPropagation();
      if ((isCopyDisabled || isExamMode) && !isHost) {
        showToast('⚠️ Saving / downloading code files is disabled during Exam Mode.', 'warning');
        socket.emit('copy-violation-attempt', { type: 'shortcut-save' });
      } else {
        if (downloadCodeBtn && !downloadCodeBtn.disabled) {
          downloadCodeBtn.click();
        } else {
          showToast('⚠️ Downloading files is locked while copy protection is active!', 'warning');
        }
      }
      return;
    }

    // Global Undo shortcut: Ctrl+Z or Cmd+Z (without shift)
    if (isCmdOrCtrl && !e.shiftKey && key === 'z') {
      if (isExamMode && !isHost) {
        e.preventDefault();
        e.stopPropagation();
        showToast('⚠️ Undo is disabled during Exam Mode.', 'warning');
        return;
      }
      const activeEl = document.activeElement;
      const tag = activeEl ? activeEl.tagName.toLowerCase() : '';
      const isOtherInput = activeEl && activeEl !== codeTextarea &&
        (tag === 'input' || tag === 'textarea' || activeEl.isContentEditable || activeEl.closest('#terminalContainer') || activeEl.closest('.xterm') || activeEl.closest('.chat-panel'));
      if (!isOtherInput) {
        e.preventDefault();
        e.stopPropagation();
        executeUndo();
        return;
      }
    }

    // Global Redo shortcut: Ctrl+Y or Cmd+Y or Ctrl+Shift+Z or Cmd+Shift+Z
    if ((isCmdOrCtrl && key === 'y') || (isCmdOrCtrl && e.shiftKey && key === 'z')) {
      if (isExamMode && !isHost) {
        e.preventDefault();
        e.stopPropagation();
        showToast('⚠️ Redo is disabled during Exam Mode.', 'warning');
        return;
      }
      const activeEl = document.activeElement;
      const tag = activeEl ? activeEl.tagName.toLowerCase() : '';
      const isOtherInput = activeEl && activeEl !== codeTextarea &&
        (tag === 'input' || tag === 'textarea' || activeEl.isContentEditable || activeEl.closest('#terminalContainer') || activeEl.closest('.xterm') || activeEl.closest('.chat-panel'));
      if (!isOtherInput) {
        e.preventDefault();
        e.stopPropagation();
        executeRedo();
        return;
      }
    }

    // Toggle comment shortcut: Ctrl+/ or Cmd+/ or Ctrl+Shift+C
    if (
      (isCmdOrCtrl && (key === '/' || e.code === 'Slash' || e.key === '/')) ||
      (isCmdOrCtrl && e.shiftKey && key === 'c')
    ) {
      if (document.activeElement === codeTextarea || document.activeElement?.closest('#codeEditorArea')) {
        e.preventDefault();
        e.stopPropagation();
        toggleComment();
        return;
      }
    }

    // Prevent Copy
    if (isCmdOrCtrl && (key === 'c' || key === 'insert') && (isCopyDisabled || isExamMode) && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Clipboard Copy (Ctrl+C / Cmd+C) is disabled during Exam Mode.', 'warning');
      socket.emit('copy-violation-attempt', { type: 'shortcut-copy' });
    }

    // Prevent Cut
    if (isCmdOrCtrl && key === 'x' && (isCopyDisabled || isExamMode) && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Cut (Ctrl+X / Cmd+X) is disabled during Exam Mode.', 'warning');
    }

    // Prevent Paste
    if (isCmdOrCtrl && (key === 'v' || (e.shiftKey && key === 'insert')) && (isPasteDisabled || isExamMode) && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Paste is disabled during Exam Mode.', 'warning');
    }
  }, true);

  // Context Menu Interception on Document / Editor Area (Exempt Host)
  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    // Let custom editor context menu handle codeTextarea
    if (target && target.closest('#codeTextarea')) {
      return;
    }
    if ((isCopyDisabled || isExamMode) && !isHost) {
      if (target && (target.closest('#codeEditorArea') || target.closest('.editor-section') || target.closest('#consoleOutput') || target.closest('#terminalContainer') || target.closest('.xterm'))) {
        e.preventDefault();
        e.stopPropagation();
        showToast('⚠️ Context menu disabled during Exam Mode.', 'warning');
      }
    }
  }, true);

  // --------------------------------------------------------------------------
  // Anti-Cheat Proctoring & Exam Mode Engine
  // --------------------------------------------------------------------------
  let tabHiddenStartTime = null;
  let windowBlurStartTime = null;
  let activeAuditUserId = null;

  function isCurrentlyFullscreen() {
    return Boolean(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
  }

  async function requestExamFullscreen() {
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        await el.webkitRequestFullscreen();
      } else if (el.mozRequestFullScreen) {
        await el.mozRequestFullScreen();
      } else if (el.msRequestFullscreen) {
        await el.msRequestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen request failed:', err);
      showToast('⚠️ Fullscreen access denied or blocked. Please allow fullscreen to continue test.', 'warning');
    }
  }

  async function exitExamFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.webkitFullscreenElement) {
        await document.webkitExitFullscreen();
      } else if (document.mozFullScreenElement) {
        await document.mozCancelFullScreen();
      } else if (document.msFullscreenElement) {
        await document.msExitFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen exit failed:', err);
    }
  }

  function updateExamFullscreenTimerDisplay() {
    if (typeof renderTimerUI === 'function') {
      renderTimerUI();
    }
  }

  function checkFullscreenExamMode() {
    if (isExamMode && !isHost) {
      if (!isCurrentlyFullscreen()) {
        updateExamFullscreenTimerDisplay();
        if (examFullscreenModal) examFullscreenModal.classList.remove('hidden');
      } else {
        if (examFullscreenModal) examFullscreenModal.classList.add('hidden');
      }
    } else {
      if (examFullscreenModal) examFullscreenModal.classList.add('hidden');
    }
  }

  // Fullscreen change listener
  const fullscreenEvents = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
  fullscreenEvents.forEach(evtName => {
    document.addEventListener(evtName, () => {
      const isFs = isCurrentlyFullscreen();
      if (!isFs) {
        if (isExamMode && !isHost && currentRoomId) {
          if (examFullscreenModal) examFullscreenModal.classList.remove('hidden');
          socket.emit('proctor-violation', {
            type: 'FULLSCREEN_EXIT',
            details: 'Candidate exited fullscreen mode'
          });
          showToast('⚠️ Fullscreen exited! Editor locked until fullscreen resumed.', 'warning');
        }
      } else {
        if (examFullscreenModal) examFullscreenModal.classList.add('hidden');
      }
    });
  });

  // Enter Fullscreen Button Listener (Start Test)
  if (examEnterFullscreenBtn) {
    examEnterFullscreenBtn.addEventListener('click', async () => {
      await requestExamFullscreen();
      setTimeout(checkFullscreenExamMode, 350);
      // Start the countdown timer when user clicks Start Test
      if (!currentTimerState || !currentTimerState.isRunning) {
        socket.emit('timer-action', { action: 'start' });
      }
    });
  }

  // 1. Page Visibility API (Tab Switch Detection)
  document.addEventListener('visibilitychange', () => {
    if (isHost || !currentRoomId) return;

    if (document.hidden) {
      tabHiddenStartTime = Date.now();
    } else {
      if (tabHiddenStartTime) {
        const awayMs = Date.now() - tabHiddenStartTime;
        tabHiddenStartTime = null;
        if (awayMs > 500) {
          const seconds = (awayMs / 1000).toFixed(1);
          socket.emit('proctor-violation', {
            type: 'TAB_SWITCH',
            awayMs,
            details: `Tab switched (hidden for ${seconds}s)`
          });
          if (isHost) {
            showToast(`⚠️ Tab switch detected (${seconds}s). Incident logged to host.`, 'warning');
          }
        }
      }
    }
  });

  // 2. Window Blur / Focus Detection
  window.addEventListener('blur', () => {
    if (isHost || !currentRoomId) return;
    // If page is already hidden, visibilitychange handles it
    if (!document.hidden && !windowBlurStartTime) {
      windowBlurStartTime = Date.now();
    }
  });

  window.addEventListener('focus', () => {
    if (isHost || !currentRoomId) return;
    if (windowBlurStartTime) {
      const awayMs = Date.now() - windowBlurStartTime;
      windowBlurStartTime = null;
      if (awayMs > 1000 && !document.hidden) {
        const seconds = (awayMs / 1000).toFixed(1);
        socket.emit('proctor-violation', {
          type: 'WINDOW_BLUR',
          awayMs,
          details: `Window lost focus (inactive for ${seconds}s)`
        });
        if (isHost) {
          showToast(`⚠️ Window focus lost (${seconds}s). Incident logged to host.`, 'warning');
        }
      }
    }
  });

  // Candidate Violation Display Update
  function updateCandidateViolationDisplay() {
    if (!candidateViolationChip) return;
    if (!isHost) {
      candidateViolationChip.classList.add('hidden');
      return;
    }
    const v = currentUser ? currentUser.violations : null;
    const count = v && typeof v.count === 'number' ? v.count : 0;
    if (count > 0 && isExamMode) {
      candidateViolationChip.classList.remove('hidden');
      candidateViolationChip.innerHTML = `<span>⚠️ ${count} Warning${count > 1 ? 's' : ''} Logged</span>`;
    } else {
      candidateViolationChip.classList.add('hidden');
    }
  }

  // Host Anti-Cheat Audit Modal
  function openProctorAuditModal(user) {
    if (!isHost || !proctorAuditModal || !user) return;
    activeAuditUserId = user.id;

    if (proctorCandidateSubtitle) {
      proctorCandidateSubtitle.textContent = `Candidate: ${user.name || 'Anonymous'}`;
    }

    const v = user.violations || { count: 0, tabSwitches: 0, blurCount: 0, fullscreenExits: 0, logs: [] };
    if (proctorStatTabSwitches) proctorStatTabSwitches.textContent = v.tabSwitches || 0;
    if (proctorStatWindowBlurs) proctorStatWindowBlurs.textContent = v.blurCount || 0;
    if (proctorStatFullscreenExits) proctorStatFullscreenExits.textContent = v.fullscreenExits || 0;

    if (proctorAuditLogsContainer) {
      proctorAuditLogsContainer.innerHTML = '';
      const logs = Array.isArray(v.logs) ? v.logs : [];
      if (logs.length === 0) {
        proctorAuditLogsContainer.innerHTML = `
          <div style="text-align: center; color: var(--text-muted); padding: 24px; font-size: 0.85rem;">
            No anti-cheat infractions recorded for this candidate.
          </div>
        `;
      } else {
        // Display latest first
        [...logs].reverse().forEach(log => {
          let tagClass = 'tab';
          let tagText = 'TAB SWITCH';
          if (log.type === 'WINDOW_BLUR') {
            tagClass = 'blur';
            tagText = 'WINDOW BLUR';
          } else if (log.type === 'FULLSCREEN_EXIT') {
            tagClass = 'fullscreen';
            tagText = 'FULLSCREEN EXIT';
          }
          const item = document.createElement('div');
          item.className = 'proctor-log-item';
          item.innerHTML = `
            <span class="proctor-log-time">${escapeHtml(log.time || '')}</span>
            <span class="proctor-log-tag ${tagClass}">${tagText}</span>
            <span style="color: var(--text-secondary); flex: 1;">${escapeHtml(log.details || '')}</span>
          `;
          proctorAuditLogsContainer.appendChild(item);
        });
      }
    }

    proctorAuditModal.classList.remove('hidden');
  }

  function closeProctorAuditModal() {
    if (proctorAuditModal) proctorAuditModal.classList.add('hidden');
    activeAuditUserId = null;
  }

  if (closeProctorAuditBtn) {
    closeProctorAuditBtn.addEventListener('click', closeProctorAuditModal);
  }
  if (dismissProctorAuditBtn) {
    dismissProctorAuditBtn.addEventListener('click', closeProctorAuditModal);
  }
  if (proctorAuditModal) {
    proctorAuditModal.addEventListener('click', (e) => {
      if (e.target === proctorAuditModal) {
        closeProctorAuditModal();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Editor Undo / Redo History Management System
  // --------------------------------------------------------------------------
  const MAX_UNDO_STACK = 150;
  const fileUndoHistory = new Map();
  const fileRedoHistory = new Map();
  let isApplyingUndoRedo = false;
  let typingSession = null;
  let lastSelectionPos = { start: 0, end: 0 };

  function getUndoStack(file) {
    const key = file || currentActiveFile || 'Untitled';
    if (!fileUndoHistory.has(key)) {
      fileUndoHistory.set(key, []);
    }
    return fileUndoHistory.get(key);
  }

  function getRedoStack(file) {
    const key = file || currentActiveFile || 'Untitled';
    if (!fileRedoHistory.has(key)) {
      fileRedoHistory.set(key, []);
    }
    return fileRedoHistory.get(key);
  }

  function updateUndoRedoUI() {
    const fileKey = currentActiveFile || 'Untitled';
    const undoStack = getUndoStack(fileKey);
    const redoStack = getRedoStack(fileKey);

    const isUndoRedoBlocked = isExamMode && !isHost;
    const canUndo = !isUndoRedoBlocked && undoStack.length > 0;
    const canRedo = !isUndoRedoBlocked && redoStack.length > 0;

    if (undoBtn) {
      undoBtn.disabled = !canUndo;
      undoBtn.title = isUndoRedoBlocked
        ? '🔒 Undo is disabled during Exam Mode'
        : 'Undo (Ctrl+Z)';
    }
    if (redoBtn) {
      redoBtn.disabled = !canRedo;
      redoBtn.title = isUndoRedoBlocked
        ? '🔒 Redo is disabled during Exam Mode'
        : 'Redo (Ctrl+Y)';
    }

    if (ctxUndoBtn) {
      if (canUndo) {
        ctxUndoBtn.classList.remove('disabled');
        ctxUndoBtn.removeAttribute('title');
      } else {
        ctxUndoBtn.classList.add('disabled');
        if (isUndoRedoBlocked) {
          ctxUndoBtn.title = '🔒 Undo is disabled during Exam Mode';
        }
      }
    }
    if (ctxRedoBtn) {
      if (canRedo) {
        ctxRedoBtn.classList.remove('disabled');
        ctxRedoBtn.removeAttribute('title');
      } else {
        ctxRedoBtn.classList.add('disabled');
        if (isUndoRedoBlocked) {
          ctxRedoBtn.title = '🔒 Redo is disabled during Exam Mode';
        }
      }
    }
  }

  function syncUndoRedoToServer(action = null) {
    if (!socket || !socket.connected) return;
    const fileKey = currentActiveFile || 'Untitled';
    const undoStack = getUndoStack(fileKey);
    const redoStack = getRedoStack(fileKey);
    socket.emit('undo-redo-sync', {
      fileKey,
      undoStack: undoStack,
      redoStack: redoStack,
      action: action,
      code: roomCode,
      cursor: { selStart: lastSelectionPos.start, selEnd: lastSelectionPos.end }
    });
  }

  function finalizeTypingSnapshot() {
    if (typingSession) {
      if (typingSession.timer) clearTimeout(typingSession.timer);
      typingSession = null;
      syncUndoRedoToServer();
    }
  }

  function recordExplicitSnapshot() {
    finalizeTypingSnapshot();
    if (!codeTextarea) return;
    const fileKey = currentActiveFile || 'Untitled';
    const undoStack = getUndoStack(fileKey);
    const redoStack = getRedoStack(fileKey);
    redoStack.length = 0;

    const currentCode = codeTextarea.value;
    const last = undoStack[undoStack.length - 1];
    if (!last || last.code !== currentCode) {
      undoStack.push({
        code: currentCode,
        selStart: codeTextarea.selectionStart,
        selEnd: codeTextarea.selectionEnd
      });
      if (undoStack.length > MAX_UNDO_STACK) undoStack.shift();
    }
    updateUndoRedoUI();
    syncUndoRedoToServer();
  }

  function handleUserTypingInput(prevCode) {
    const fileKey = currentActiveFile || 'Untitled';
    const undoStack = getUndoStack(fileKey);
    const redoStack = getRedoStack(fileKey);

    if (redoStack.length > 0) {
      redoStack.length = 0;
    }

    if (!typingSession || typingSession.file !== fileKey) {
      const last = undoStack[undoStack.length - 1];
      if (!last || last.code !== prevCode) {
        undoStack.push({
          code: prevCode,
          selStart: lastSelectionPos.start,
          selEnd: lastSelectionPos.end
        });
        if (undoStack.length > MAX_UNDO_STACK) undoStack.shift();
      }
      typingSession = {
        file: fileKey,
        timer: null
      };
      syncUndoRedoToServer();
    }

    if (typingSession) {
      if (typingSession.timer) clearTimeout(typingSession.timer);
      typingSession.timer = setTimeout(() => {
        finalizeTypingSnapshot();
      }, 650);
    }
  }

  function applyEditorSnapshot(snapshot) {
    if (!snapshot || snapshot.code === undefined || !codeTextarea) return;
    isApplyingUndoRedo = true;
    try {
      codeTextarea.value = snapshot.code;
      roomCode = snapshot.code;

      if (currentActiveFile) {
        tabBufferMap.set(currentActiveFile, roomCode);
        const savedContent = fileSavedContents.get(currentActiveFile);
        if (savedContent !== undefined && savedContent === roomCode) {
          unsavedFiles.delete(currentActiveFile);
        } else {
          unsavedFiles.add(currentActiveFile);
        }
        renderTabs({ preserveScroll: true });
      }

      updateEditorDisplay();

      const safeStart = Math.min(snapshot.selStart ?? snapshot.code.length, snapshot.code.length);
      const safeEnd = Math.min(snapshot.selEnd ?? safeStart, snapshot.code.length);
      codeTextarea.focus();
      codeTextarea.setSelectionRange(safeStart, safeEnd);
      lastSelectionPos = { start: safeStart, end: safeEnd };

      const lines = snapshot.code.substring(0, safeStart).split('\n');
      const line = lines.length;
      const ch = lines[lines.length - 1].length + 1;
      const selection = (safeStart !== safeEnd) ? { start: safeStart, end: safeEnd } : null;

      activeRestingCursorUserId = socket.id;
      socket.emit('code-change', {
        code: roomCode,
        cursor: { line, ch, selection },
        activeFile: currentActiveFile
      });
      emitCursorPosition();
    } finally {
      isApplyingUndoRedo = false;
    }
  }

  function executeUndo() {
    if (isExamMode && !isHost) {
      showToast('⚠️ Undo is disabled during Exam Mode.', 'warning');
      return;
    }
    if (isReadOnly && !isHost) {
      showToast('⚠️ Editor is currently in read-only mode.', 'warning');
      return;
    }
    finalizeTypingSnapshot();
    if (!codeTextarea) return;
    const fileKey = currentActiveFile || 'Untitled';
    const undoStack = getUndoStack(fileKey);
    const redoStack = getRedoStack(fileKey);

    if (undoStack.length === 0) {
      showToast('ℹ️ Nothing to undo');
      return;
    }

    const currentSnapshot = {
      code: codeTextarea.value,
      selStart: codeTextarea.selectionStart,
      selEnd: codeTextarea.selectionEnd
    };

    const prevSnapshot = undoStack.pop();
    redoStack.push(currentSnapshot);
    if (redoStack.length > MAX_UNDO_STACK) redoStack.shift();

    applyEditorSnapshot(prevSnapshot);
    updateUndoRedoUI();
    showToast('↩️ Undo');

    socket.emit('undo-redo-sync', {
      fileKey,
      undoStack: undoStack,
      redoStack: redoStack,
      action: 'undo',
      code: roomCode,
      cursor: { selStart: prevSnapshot.selStart, selEnd: prevSnapshot.selEnd }
    });
  }

  function executeRedo() {
    if (isExamMode && !isHost) {
      showToast('⚠️ Redo is disabled during Exam Mode.', 'warning');
      return;
    }
    if (isReadOnly && !isHost) {
      showToast('⚠️ Editor is currently in read-only mode.', 'warning');
      return;
    }
    finalizeTypingSnapshot();
    if (!codeTextarea) return;
    const fileKey = currentActiveFile || 'Untitled';
    const undoStack = getUndoStack(fileKey);
    const redoStack = getRedoStack(fileKey);

    if (redoStack.length === 0) {
      showToast('ℹ️ Nothing to redo');
      return;
    }

    const currentSnapshot = {
      code: codeTextarea.value,
      selStart: codeTextarea.selectionStart,
      selEnd: codeTextarea.selectionEnd
    };

    const nextSnapshot = redoStack.pop();
    undoStack.push(currentSnapshot);
    if (undoStack.length > MAX_UNDO_STACK) undoStack.shift();

    applyEditorSnapshot(nextSnapshot);
    updateUndoRedoUI();
    showToast('↪️ Redo');

    socket.emit('undo-redo-sync', {
      fileKey,
      undoStack: undoStack,
      redoStack: redoStack,
      action: 'redo',
      code: roomCode,
      cursor: { selStart: nextSnapshot.selStart, selEnd: nextSnapshot.selEnd }
    });
  }

  // --------------------------------------------------------------------------
  // 4. Editor Highlighting & Real-Time Sync Logic
  // --------------------------------------------------------------------------
  codeTextarea.addEventListener('input', () => {
    activeRestingCursorUserId = socket.id;
    const prevCode = roomCode;
    const newCode = codeTextarea.value;

    if (!isApplyingUndoRedo && prevCode !== newCode) {
      handleUserTypingInput(prevCode);
    }

    roomCode = newCode;
    if (currentActiveFile) {
      tabBufferMap.set(currentActiveFile, roomCode);
      const savedContent = fileSavedContents.get(currentActiveFile);
      if (savedContent !== undefined && savedContent === roomCode) {
        unsavedFiles.delete(currentActiveFile);
      } else {
        unsavedFiles.add(currentActiveFile);
      }
      renderTabs();
    }
    updateEditorDisplay();

    // Calculate line & character cursor & selection
    const cursorPos = codeTextarea.selectionStart;
    const selEnd = codeTextarea.selectionEnd;
    lastSelectionPos = { start: cursorPos, end: selEnd };

    const textBeforeCursor = roomCode.substring(0, cursorPos);
    const lines = textBeforeCursor.split('\n');
    const line = lines.length;
    const ch = lines[lines.length - 1].length + 1;
    const selection = (cursorPos !== selEnd) ? { start: cursorPos, end: selEnd } : null;

    // Emit live changes to server
    socket.emit('code-change', {
      code: roomCode,
      cursor: { line, ch, selection },
      activeFile: currentActiveFile
    });

    updateUndoRedoUI();
  });

  function formatCode() {
    if (isReadOnly && !isHost) {
      showToast('⚠️ Editor is currently in read-only mode.', 'warning');
      return;
    }
    const raw = codeTextarea.value;
    if (!raw.trim()) return;
    recordExplicitSnapshot();

    try {
      const lines = raw.split('\n');
      const formattedLines = [];
      let indentLevel = 0;
      let inMultiLineString = false;
      let multiLineQuote = '';

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) {
          formattedLines.push('');
          continue;
        }

        // Handle multiline string literals (""" or ''')
        if (inMultiLineString) {
          formattedLines.push(line);
          if (trimmed.includes(multiLineQuote)) {
            inMultiLineString = false;
            multiLineQuote = '';
          }
          continue;
        }

        if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
          const quote = trimmed.substring(0, 3);
          const rest = trimmed.substring(3);
          if (!rest.includes(quote)) {
            inMultiLineString = true;
            multiLineQuote = quote;
          }
        }

        // Decrease indent for dedent keywords (elif, else, except, finally)
        if (/^(elif|else|except|finally)\b/.test(trimmed) || /^(\]|\}|\))/.test(trimmed)) {
          indentLevel = Math.max(0, indentLevel - 1);
        }

        // Format line with 2-space indentation
        formattedLines.push('  '.repeat(indentLevel) + trimmed);

        // Increase indent if line ends with a colon (and is not inside a string/comment)
        if (trimmed.endsWith(':') && !trimmed.startsWith('#')) {
          indentLevel++;
        }
      }

      const formatted = formattedLines.join('\n');
      if (formatted !== raw) {
        const selStart = codeTextarea.selectionStart;
        const selEnd = codeTextarea.selectionEnd;
        codeTextarea.value = formatted;
        codeTextarea.selectionStart = Math.min(selStart, formatted.length);
        codeTextarea.selectionEnd = Math.min(selEnd, formatted.length);
        codeTextarea.dispatchEvent(new Event('input'));
        showToast('✨ Code formatted (Shift+Alt+F)');
      } else {
        showToast('✨ Code is already formatted');
      }
    } catch (err) {
      showToast('⚠️ Formatting encountered an issue.', 'warning');
    }
  }

  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      executeUndo();
    });
  }

  if (redoBtn) {
    redoBtn.addEventListener('click', () => {
      executeRedo();
    });
  }

  if (formatCodeBtn) {
    formatCodeBtn.addEventListener('click', () => {
      formatCode();
    });
  }

  // --------------------------------------------------------------------------
  // Selection Replacement, Commenting & Indentation Helpers
  // --------------------------------------------------------------------------

  function replaceTextareaRange(newText, start, end, newSelStart, newSelEnd) {
    recordExplicitSnapshot();
    if (typeof codeTextarea.setRangeText === 'function') {
      codeTextarea.setRangeText(newText, start, end, 'preserve');
    } else {
      codeTextarea.value = codeTextarea.value.substring(0, start) + newText + codeTextarea.value.substring(end);
    }
    codeTextarea.selectionStart = newSelStart;
    codeTextarea.selectionEnd = newSelEnd;
    codeTextarea.dispatchEvent(new Event('input'));
    finalizeTypingSnapshot();
    if (newSelStart === newSelEnd) {
      if (activeSelection !== null) {
        activeSelection = null;
      }
      socket.emit('clear-selections');
      emitCursorPosition();
    }
  }

  function getCommentSyntax() {
    const lang = (roomLanguage || 'python').toLowerCase();
    let ext = '';
    if (currentActiveFile && currentActiveFile.includes('.')) {
      ext = currentActiveFile.split('.').pop().toLowerCase();
    }

    if (lang === 'html' || ext === 'html' || ext === 'htm' || ext === 'xml') {
      return { type: 'block', prefix: '<!-- ', suffix: ' -->' };
    }
    if (lang === 'css' || ext === 'css') {
      return { type: 'block', prefix: '/* ', suffix: ' */' };
    }
    if (lang === 'sql' || ext === 'sql') {
      return { type: 'line', token: '-- ' };
    }
    if (
      ['javascript', 'js', 'typescript', 'ts', 'cpp', 'c', 'csharp', 'cs', 'java', 'json'].includes(lang) ||
      ['js', 'ts', 'jsx', 'tsx', 'c', 'cpp', 'cc', 'h', 'hpp', 'java', 'cs'].includes(ext)
    ) {
      return { type: 'line', token: '// ' };
    }
    // Default to python / shell / general '#' comment
    return { type: 'line', token: '# ' };
  }

  function toggleComment() {
    if (isReadOnly && !isHost) {
      showToast('⚠️ Editor is currently in read-only mode.', 'warning');
      return;
    }
    recordExplicitSnapshot();
    const value = codeTextarea.value;
    const start = codeTextarea.selectionStart;
    const end = codeTextarea.selectionEnd;

    const syntax = getCommentSyntax();

    const lineStartIndex = value.lastIndexOf('\n', start - 1) + 1;
    const endSearchPos = (end > start && value[end - 1] === '\n') ? end - 1 : end;
    let lineEndIndex = value.indexOf('\n', endSearchPos);
    if (lineEndIndex === -1) lineEndIndex = value.length;

    const block = value.substring(lineStartIndex, lineEndIndex);
    const lines = block.split('\n');

    if (syntax.type === 'block') {
      const pfx = syntax.prefix;
      const sfx = syntax.suffix;
      const trimmedBlock = block.trim();
      const rawPfx = pfx.trim();
      const rawSfx = sfx.trim();

      const isCommented = trimmedBlock.startsWith(rawPfx) && trimmedBlock.endsWith(rawSfx);
      let newBlock;

      if (isCommented) {
        let inner = block;
        const pfxPos = inner.indexOf(rawPfx);
        const afterPfx = inner.startsWith(pfx, pfxPos) ? pfxPos + pfx.length : pfxPos + rawPfx.length;
        inner = inner.substring(0, pfxPos) + inner.substring(afterPfx);

        const sfxPos = inner.lastIndexOf(rawSfx);
        if (sfxPos !== -1) {
          const sfxLen = (sfxPos >= 1 && inner.substring(sfxPos - 1, sfxPos + rawSfx.length) === sfx) ? sfx.length : rawSfx.length;
          const actualStart = (sfxPos >= 1 && inner.substring(sfxPos - 1, sfxPos + rawSfx.length) === sfx) ? sfxPos - 1 : sfxPos;
          inner = inner.substring(0, actualStart) + inner.substring(actualStart + sfxLen);
        }
        newBlock = inner;
      } else {
        newBlock = `${pfx}${block}${sfx}`;
      }

      const newStart = lineStartIndex;
      const newEnd = lineStartIndex + newBlock.length;
      replaceTextareaRange(newBlock, lineStartIndex, lineEndIndex, newStart, newEnd);
      return;
    }

    // Line comment style (# or // or --)
    const token = syntax.token;
    const rawToken = token.trim();

    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    const allCommented = nonEmptyLines.length > 0 && nonEmptyLines.every(l => l.trim().startsWith(rawToken));

    let newLines;
    if (allCommented) {
      newLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed.startsWith(rawToken)) return line;
        const tokenIdx = line.indexOf(rawToken);
        if (line.substring(tokenIdx, tokenIdx + token.length) === token) {
          return line.substring(0, tokenIdx) + line.substring(tokenIdx + token.length);
        }
        return line.substring(0, tokenIdx) + line.substring(tokenIdx + rawToken.length);
      });
    } else {
      let minIndent = Infinity;
      nonEmptyLines.forEach(l => {
        const match = l.match(/^(\s*)/);
        const indentLen = match ? match[1].length : 0;
        if (indentLen < minIndent) minIndent = indentLen;
      });
      if (minIndent === Infinity) minIndent = 0;

      newLines = lines.map(line => {
        if (lines.length > 1 && line.trim().length === 0) {
          return line;
        }
        if (line.length >= minIndent) {
          return line.substring(0, minIndent) + token + line.substring(minIndent);
        }
        return token + line;
      });
    }

    const newBlock = newLines.join('\n');
    let newStart, newEnd;

    if (start === end) {
      const addedDiff = newBlock.length - block.length;
      const newCursor = Math.min(lineStartIndex + newBlock.length, Math.max(lineStartIndex, start + addedDiff));
      newStart = newCursor;
      newEnd = newCursor;
    } else {
      newStart = lineStartIndex;
      newEnd = lineStartIndex + newBlock.length;
    }

    replaceTextareaRange(newBlock, lineStartIndex, lineEndIndex, newStart, newEnd);
  }

  function indentSelectedText() {
    if (isReadOnly && !isHost) {
      showToast('⚠️ Editor is currently in read-only mode.', 'warning');
      return;
    }
    recordExplicitSnapshot();
    const value = codeTextarea.value;
    const start = codeTextarea.selectionStart;
    const end = codeTextarea.selectionEnd;

    if (start === end) {
      replaceTextareaRange('  ', start, end, start + 2, start + 2);
      return;
    }

    const lineStartIndex = value.lastIndexOf('\n', start - 1) + 1;
    const endSearchPos = (end > start && value[end - 1] === '\n') ? end - 1 : end;
    let lineEndIndex = value.indexOf('\n', endSearchPos);
    if (lineEndIndex === -1) lineEndIndex = value.length;

    const block = value.substring(lineStartIndex, lineEndIndex);
    const lines = block.split('\n');

    const newLines = lines.map(line => '  ' + line);
    const newBlock = newLines.join('\n');

    const addedTotal = newBlock.length - block.length;
    const newStart = (start === lineStartIndex) ? lineStartIndex : start + 2;
    const newEnd = end + addedTotal;

    replaceTextareaRange(newBlock, lineStartIndex, lineEndIndex, newStart, newEnd);
  }

  function dedentSelectedText() {
    if (isReadOnly && !isHost) {
      showToast('⚠️ Editor is currently in read-only mode.', 'warning');
      return;
    }
    recordExplicitSnapshot();
    const value = codeTextarea.value;
    const start = codeTextarea.selectionStart;
    const end = codeTextarea.selectionEnd;

    if (start === end) {
      const lineStartIndex = value.lastIndexOf('\n', start - 1) + 1;
      let lineEndIndex = value.indexOf('\n', start);
      if (lineEndIndex === -1) lineEndIndex = value.length;
      const line = value.substring(lineStartIndex, lineEndIndex);

      let removeCount = 0;
      if (line.startsWith('  ')) {
        removeCount = 2;
      } else if (line.startsWith(' ') || line.startsWith('\t')) {
        removeCount = 1;
      }

      if (removeCount > 0) {
        const newLine = line.substring(removeCount);
        const newCursor = Math.max(lineStartIndex, start - removeCount);
        replaceTextareaRange(newLine, lineStartIndex, lineEndIndex, newCursor, newCursor);
      }
      return;
    }

    const lineStartIndex = value.lastIndexOf('\n', start - 1) + 1;
    const endSearchPos = (end > start && value[end - 1] === '\n') ? end - 1 : end;
    let lineEndIndex = value.indexOf('\n', endSearchPos);
    if (lineEndIndex === -1) lineEndIndex = value.length;

    const block = value.substring(lineStartIndex, lineEndIndex);
    const lines = block.split('\n');

    let removedAtFirstLine = 0;
    let totalRemoved = 0;

    const newLines = lines.map((line, idx) => {
      let removeCount = 0;
      if (line.startsWith('  ')) {
        removeCount = 2;
      } else if (line.startsWith(' ') || line.startsWith('\t')) {
        removeCount = 1;
      }
      if (idx === 0) {
        removedAtFirstLine = Math.min(removeCount, Math.max(0, start - lineStartIndex));
      }
      totalRemoved += removeCount;
      return line.substring(removeCount);
    });

    if (totalRemoved === 0) return;

    const newBlock = newLines.join('\n');
    const newStart = Math.max(lineStartIndex, start - removedAtFirstLine);
    const newEnd = Math.max(newStart, end - totalRemoved);

    replaceTextareaRange(newBlock, lineStartIndex, lineEndIndex, newStart, newEnd);
  }

  // Tab key indent, Ctrl+S save, and formatting/commenting shortcuts inside textarea
  codeTextarea.addEventListener('keydown', (e) => {
    const isCmdOrCtrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // Undo shortcut: Ctrl+Z or Cmd+Z (without Shift)
    if (isCmdOrCtrl && !e.shiftKey && key === 'z') {
      e.preventDefault();
      e.stopPropagation();
      executeUndo();
      return;
    }

    // Redo shortcut: Ctrl+Y or Cmd+Y or Ctrl+Shift+Z or Cmd+Shift+Z
    if ((isCmdOrCtrl && key === 'y') || (isCmdOrCtrl && e.shiftKey && key === 'z')) {
      e.preventDefault();
      e.stopPropagation();
      executeRedo();
      return;
    }

    // Break typing group on Enter
    if (e.key === 'Enter') {
      finalizeTypingSnapshot();
    }

    // Deletion of highlighted text: capture explicit snapshot before removal
    if ((e.key === 'Backspace' || e.key === 'Delete') && codeTextarea.selectionStart !== codeTextarea.selectionEnd) {
      finalizeTypingSnapshot();
      recordExplicitSnapshot();
    }

    // Toggle comment shortcuts: Ctrl+/ or Cmd+/ or Ctrl+Shift+C
    if (
      (isCmdOrCtrl && (key === '/' || e.code === 'Slash' || e.key === '/')) ||
      (isCmdOrCtrl && e.shiftKey && key === 'c')
    ) {
      e.preventDefault();
      e.stopPropagation();
      toggleComment();
      return;
    }

    // Tab key indent (give space) and Shift+Tab (reverse space)
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        dedentSelectedText();
      } else {
        indentSelectedText();
      }
      return;
    }

    // Formatting shortcuts: Shift+Alt+F or Ctrl+Shift+I / Cmd+Shift+I or Ctrl+Shift+F
    if (
      (e.shiftKey && e.altKey && key === 'f') ||
      (isCmdOrCtrl && e.shiftKey && (key === 'i' || key === 'f'))
    ) {
      e.preventDefault();
      e.stopPropagation();
      formatCode();
      return;
    }

    if (isCmdOrCtrl && key === 's') {
      e.preventDefault();
      e.stopPropagation();
      saveActiveFile();
      return;
    }
  });

  // --------------------------------------------------------------------------
  // Editor Context Menu Logic
  // --------------------------------------------------------------------------

  const editorContextMenu = document.getElementById('editorContextMenu');
  const ctxUndoBtn = document.getElementById('ctxUndoBtn');
  const ctxRedoBtn = document.getElementById('ctxRedoBtn');
  const ctxCutBtn = document.getElementById('ctxCutBtn');
  const ctxCopyBtn = document.getElementById('ctxCopyBtn');
  const ctxPasteBtn = document.getElementById('ctxPasteBtn');
  const ctxCommentBtn = document.getElementById('ctxCommentBtn');
  const ctxIndentBtn = document.getElementById('ctxIndentBtn');
  const ctxDedentBtn = document.getElementById('ctxDedentBtn');
  const ctxFormatBtn = document.getElementById('ctxFormatBtn');

  function setContextMenuOpen(open, x = 0, y = 0, emit = true) {
    if (!editorContextMenu) return;
    if (open) {
      updateUndoRedoUI();
      updateCopyButtonState();
      const safeX = Math.min(window.innerWidth - 210, Math.max(10, x));
      const safeY = Math.min(window.innerHeight - 260, Math.max(10, y));
      editorContextMenu.style.left = `${safeX}px`;
      editorContextMenu.style.top = `${safeY}px`;
      editorContextMenu.classList.remove('hidden');
    } else {
      if (!editorContextMenu.classList.contains('hidden')) {
        editorContextMenu.classList.add('hidden');
      }
    }
    if (emit) {
      socket.emit('context-menu-toggle', { isOpen: open, x, y });
    }
  }

  function hideContextMenu(emit = true) {
    setContextMenuOpen(false, 0, 0, emit);
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#editorContextMenu')) {
      if (editorContextMenu && !editorContextMenu.classList.contains('hidden')) {
        hideContextMenu(true);
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (editorContextMenu && !editorContextMenu.classList.contains('hidden')) {
        hideContextMenu(true);
      }
    }
  });

  let contextSelection = null;

  codeTextarea.addEventListener('mousedown', (e) => {
    if (e.button === 2) {
      if (codeTextarea.selectionStart !== codeTextarea.selectionEnd) {
        contextSelection = {
          start: codeTextarea.selectionStart,
          end: codeTextarea.selectionEnd
        };
      } else {
        contextSelection = null;
      }
    }
  });

  codeTextarea.addEventListener('contextmenu', (e) => {
    if (!editorContextMenu) return;
    e.preventDefault();
    e.stopPropagation();

    if (contextSelection) {
      codeTextarea.setSelectionRange(contextSelection.start, contextSelection.end);
      lastSelectionPos = {
        start: contextSelection.start,
        end: contextSelection.end
      };
      contextSelection = null;
    } else {
      lastSelectionPos = {
        start: codeTextarea.selectionStart,
        end: codeTextarea.selectionEnd
      };
    }

    emitCursorPosition();
    setContextMenuOpen(true, e.clientX, e.clientY, true);
  });

  if (ctxUndoBtn) {
    ctxUndoBtn.addEventListener('click', () => {
      hideContextMenu();
      executeUndo();
    });
  }

  if (ctxRedoBtn) {
    ctxRedoBtn.addEventListener('click', () => {
      hideContextMenu();
      executeRedo();
    });
  }

  function performContextCopyFallback(text, hasSelection, start, end) {
    try {
      const tempArea = document.createElement('textarea');
      tempArea.value = text;
      tempArea.style.position = 'fixed';
      tempArea.style.left = '-9999px';
      tempArea.style.top = '-9999px';
      document.body.appendChild(tempArea);
      tempArea.focus();
      tempArea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(tempArea);
      if (ok) {
        showToast(hasSelection ? '📋 Copied selection to clipboard!' : '📋 Copied code to clipboard!');
      } else {
        showToast('⚠️ Failed to copy code to clipboard.', 'warning');
      }
    } catch (err) {
      showToast('⚠️ Failed to copy code to clipboard.', 'warning');
    }
    codeTextarea.focus();
    if (hasSelection) {
      codeTextarea.setSelectionRange(start, end);
    }
  }

  if (ctxCutBtn) {
    ctxCutBtn.addEventListener('click', () => {
      hideContextMenu();
      if ((isCopyDisabled || isExamMode) && !isHost) {
        showToast('⚠️ Cut is locked during Exam Mode!', 'warning');
        socket.emit('copy-violation-attempt', { type: 'cut' });
        return;
      }
      if (isReadOnly && !isHost) {
        showToast('⚠️ Editor is in read-only mode!', 'warning');
        return;
      }

      const start = (codeTextarea.selectionStart !== undefined) ? codeTextarea.selectionStart : lastSelectionPos.start;
      const end = (codeTextarea.selectionEnd !== undefined) ? codeTextarea.selectionEnd : lastSelectionPos.end;
      const hasSelection = (start !== undefined && end !== undefined && start !== end);

      if (!hasSelection) {
        showToast('Select text to cut.', 'warning');
        codeTextarea.focus();
        return;
      }

      const s = Math.min(start, end);
      const e = Math.max(start, end);
      const textToCut = codeTextarea.value.substring(s, e);

      const cutSuccess = () => {
        replaceTextareaRange('', s, e, s, s);
        showToast('✂️ Cut text to clipboard!');
        codeTextarea.focus();
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCut).then(() => {
          cutSuccess();
        }).catch(() => {
          performContextCopyFallback(textToCut, true, s, e);
          replaceTextareaRange('', s, e, s, s);
        });
      } else {
        performContextCopyFallback(textToCut, true, s, e);
        replaceTextareaRange('', s, e, s, s);
      }
    });
  }

  if (ctxCopyBtn) {
    ctxCopyBtn.addEventListener('click', () => {
      hideContextMenu();
      if ((isCopyDisabled || isExamMode) && !isHost) {
        showToast('⚠️ Copying is locked during Exam Mode!', 'warning');
        socket.emit('copy-violation-attempt', { type: 'copy-button-attempt' });
        return;
      }

      const start = (codeTextarea.selectionStart !== undefined) ? codeTextarea.selectionStart : lastSelectionPos.start;
      const end = (codeTextarea.selectionEnd !== undefined) ? codeTextarea.selectionEnd : lastSelectionPos.end;
      const hasSelection = (start !== undefined && end !== undefined && start !== end);
      const textToCopy = hasSelection ? codeTextarea.value.substring(start, end) : codeTextarea.value;

      if (!textToCopy) {
        showToast('Nothing to copy.', 'warning');
        codeTextarea.focus();
        return;
      }

      const copySuccess = () => {
        showToast(hasSelection ? '📋 Copied selection to clipboard!' : '📋 Copied code to clipboard!');
        codeTextarea.focus();
        if (hasSelection) {
          codeTextarea.setSelectionRange(start, end);
        }
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          copySuccess();
        }).catch(() => {
          performContextCopyFallback(textToCopy, hasSelection, start, end);
        });
      } else {
        performContextCopyFallback(textToCopy, hasSelection, start, end);
      }
    });
  }

  function handlePasteText(text) {
    if (!text) return;
    const start = (codeTextarea.selectionStart !== undefined) ? codeTextarea.selectionStart : lastSelectionPos.start;
    const end = (codeTextarea.selectionEnd !== undefined) ? codeTextarea.selectionEnd : lastSelectionPos.end;
    const s = Math.min(start, end);
    const e = Math.max(start, end);
    const newSel = s + text.length;
    replaceTextareaRange(text, s, e, newSel, newSel);
    showToast('📋 Pasted from clipboard!');
    codeTextarea.focus();
  }

  if (ctxPasteBtn) {
    ctxPasteBtn.addEventListener('click', async () => {
      hideContextMenu();
      if ((isPasteDisabled || isExamMode) && !isHost) {
        showToast('⚠️ Pasting into editor is disabled during Exam Mode!', 'warning');
        return;
      }
      if (isReadOnly && !isHost) {
        showToast('⚠️ Editor is in read-only mode!', 'warning');
        return;
      }

      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();
          if (text) {
            handlePasteText(text);
          } else {
            showToast('Clipboard is empty or contains no text.', 'warning');
          }
        } else {
          codeTextarea.focus();
          const ok = document.execCommand('paste');
          if (!ok) {
            showToast('⚠️ Use Ctrl+V / Cmd+V to paste.', 'warning');
          }
        }
      } catch (err) {
        codeTextarea.focus();
        showToast('⚠️ Clipboard read permission denied. Use Ctrl+V / Cmd+V to paste.', 'warning');
      }
    });
  }

  if (ctxCommentBtn) {
    ctxCommentBtn.addEventListener('click', () => {
      hideContextMenu();
      toggleComment();
      codeTextarea.focus();
    });
  }
  if (ctxIndentBtn) {
    ctxIndentBtn.addEventListener('click', () => {
      hideContextMenu();
      indentSelectedText();
      codeTextarea.focus();
    });
  }
  if (ctxDedentBtn) {
    ctxDedentBtn.addEventListener('click', () => {
      hideContextMenu();
      dedentSelectedText();
      codeTextarea.focus();
    });
  }
  if (ctxFormatBtn) {
    ctxFormatBtn.addEventListener('click', () => {
      hideContextMenu();
      formatCode();
      codeTextarea.focus();
    });
  }

  // Context Menu Item Hover Synchronization
  [
    'ctxCutBtn',
    'ctxCopyBtn',
    'ctxPasteBtn',
    'ctxUndoBtn',
    'ctxRedoBtn',
    'ctxCommentBtn',
    'ctxIndentBtn',
    'ctxDedentBtn',
    'ctxFormatBtn'
  ].forEach(itemId => {
    const item = document.getElementById(itemId);
    if (item) {
      item.addEventListener('mouseenter', () => {
        socket.emit('context-menu-item-hover', { itemId, isHovered: true });
      });
      item.addEventListener('mouseleave', () => {
        socket.emit('context-menu-item-hover', { itemId, isHovered: false });
      });
    }
  });

  function emitCursorPosition() {
    activeRestingCursorUserId = socket.id;
    const cursorPos = codeTextarea.selectionStart;
    const selEnd = codeTextarea.selectionEnd;
    const textBeforeCursor = codeTextarea.value.substring(0, cursorPos);
    const lines = textBeforeCursor.split('\n');
    const line = lines.length;
    const ch = lines[lines.length - 1].length + 1;
    const selection = (cursorPos !== selEnd) ? { start: cursorPos, end: selEnd } : null;

    if (activeSelection !== null) {
      activeSelection = null;
    }
    
    renderCollaboratorCursors();
    socket.emit('cursor-change', { line, ch, selection });
  }

  ['click', 'keyup'].forEach(evt => {
    codeTextarea.addEventListener(evt, emitCursorPosition);
  });

  ['click', 'keyup', 'select'].forEach(evt => {
    codeTextarea.addEventListener(evt, () => {
      if (!isApplyingUndoRedo && codeTextarea) {
        lastSelectionPos = {
          start: codeTextarea.selectionStart,
          end: codeTextarea.selectionEnd
        };
      }
    });
  });

  codeTextarea.addEventListener('click', () => {
    finalizeTypingSnapshot();
  });

  codeTextarea.addEventListener('paste', () => {
    finalizeTypingSnapshot();
    recordExplicitSnapshot();
  });

  codeTextarea.addEventListener('cut', () => {
    finalizeTypingSnapshot();
    recordExplicitSnapshot();
  });

  // Track real-time selection while dragging before mouse release
  let isMouseDownInTextarea = false;
  codeTextarea.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      isMouseDownInTextarea = true;
      socket.emit('clear-selections');
    }
  });
  document.addEventListener('mouseup', () => {
    isMouseDownInTextarea = false;
  });

  let lastSelectionEmitTime = 0;
  codeTextarea.addEventListener('mousemove', () => {
    if (isMouseDownInTextarea) {
      const now = Date.now();
      if (now - lastSelectionEmitTime > 30) {
        lastSelectionEmitTime = now;
        emitCursorPosition();
      }
    }
  });

  // Sync scrolling between textarea and syntax highlight layer / line numbers / collaborator cursors
  let isRemoteScroll = false;
  codeTextarea.addEventListener('scroll', () => {
    highlightCode.parentElement.scrollTop = codeTextarea.scrollTop;
    highlightCode.parentElement.scrollLeft = codeTextarea.scrollLeft;
    lineNumbers.scrollTop = codeTextarea.scrollTop;
    renderCollaboratorCursors();
    
    if (!isRemoteScroll) {
      socket.emit('scroll-sync', { top: codeTextarea.scrollTop, left: codeTextarea.scrollLeft });
    }
  });

  function updateEditorDisplay() {
    // 1. Update Line Numbers
    const linesCount = (codeTextarea.value.match(/\n/g) || []).length + 1;
    let numbersHtml = '';
    for (let i = 1; i <= linesCount; i++) {
      numbersHtml += `${i}\n`;
    }
    lineNumbers.textContent = numbersHtml;

    // 2. Syntax Highlighting via Prism (Python)
    let codeContent = codeTextarea.value;
    if (codeContent.endsWith('\n')) {
      codeContent += ' ';
    }

    if (isSyntaxHighlightEnabled) {
      codeTextarea.classList.remove('syntax-disabled');
      const prismLang = roomLanguage === 'html' ? 'markup' : (window.Prism && Prism.languages[roomLanguage] ? roomLanguage : 'python');
      if (window.Prism && Prism.languages[prismLang]) {
        try {
          highlightCode.className = `language-${prismLang}`;
          highlightCode.innerHTML = Prism.highlight(codeContent, Prism.languages[prismLang], prismLang);
        } catch (e) {
          highlightCode.textContent = codeContent;
        }
      } else {
        highlightCode.textContent = codeContent;
      }
    } else {
      codeTextarea.classList.add('syntax-disabled');
      highlightCode.className = 'language-plaintext';
      highlightCode.textContent = codeContent;
    }

    // 3. Keep scroll perfectly aligned
    highlightCode.parentElement.scrollTop = codeTextarea.scrollTop;
    highlightCode.parentElement.scrollLeft = codeTextarea.scrollLeft;
    lineNumbers.scrollTop = codeTextarea.scrollTop;

    const editorWrapper = document.getElementById('editorWrapper');
    const editorTabs = document.getElementById('editorTabs');
    const editorSection = document.querySelector('.editor-section');
    if (openTabs.length === 0) {
      if (editorWrapper) editorWrapper.style.visibility = 'hidden';
      if (editorTabs) editorTabs.style.display = 'flex';
      if (editorSection) editorSection.style.backgroundColor = 'var(--bg-surface)';
      codeTextarea.disabled = true;
    } else {
      if (editorWrapper) editorWrapper.style.visibility = 'visible';
      if (editorTabs) editorTabs.style.display = 'flex';
      if (editorSection) editorSection.style.backgroundColor = 'var(--bg-editor)';
      codeTextarea.disabled = false;
      codeTextarea.placeholder = 'Write your Python code here...';
    }

    renderCollaboratorCursors();
  }

  function getMonospaceMetrics() {
    const span = document.createElement('span');
    span.style.fontFamily = "'Fira Code', 'Consolas', 'Courier New', monospace";
    span.style.fontSize = '14px';
    span.style.lineHeight = '1.6';
    span.style.visibility = 'hidden';
    span.style.position = 'absolute';
    span.style.top = '-9999px';
    span.textContent = 'M'.repeat(100);
    document.body.appendChild(span);
    const width = span.getBoundingClientRect().width / 100;
    document.body.removeChild(span);
    const charWidth = width || 8.4;
    const lineHeight = 22.4;
    return { charWidth, lineHeight };
  }

  function getSelectionRects(start, end, code) {
    if (start >= end) return [];
    const safeEnd = Math.min(end, code.length);
    const safeStart = Math.min(start, safeEnd);

    const textBeforeStart = code.substring(0, safeStart);
    const startLines = textBeforeStart.split('\n');
    const startLine = startLines.length;
    const startCh = startLines[startLines.length - 1].length + 1;

    const textBeforeEnd = code.substring(0, safeEnd);
    const endLines = textBeforeEnd.split('\n');
    const endLine = endLines.length;
    const endCh = endLines[endLines.length - 1].length + 1;

    const allLines = code.split('\n');
    const rects = [];

    for (let l = startLine; l <= endLine; l++) {
      const lineContent = allLines[l - 1] || '';
      const chStart = (l === startLine) ? startCh : 1;
      const chEnd = (l === endLine) ? endCh : (lineContent.length + 1);
      const count = Math.max(1, chEnd - chStart);

      rects.push({
        line: l,
        chStart: chStart,
        count: count
      });
    }

    return rects;
  }

  let activeUserTimeout = null;

  function isPosInsideElement(x, y, elementId) {
    const el = document.getElementById(elementId);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function renderCollaboratorCursors() {
    if (collaboratorCursorsContainer) {
      // Clear ONLY the selection boxes, keep the persistent cursor
      Array.from(collaboratorCursorsContainer.children).forEach(child => {
        if (child !== persistentCursorEl) {
          child.remove();
        }
      });
    }
    if (mousePointerContainer) {
      if (!mousePointerContainer.hasAttribute('data-initialized')) {
        mousePointerContainer.innerHTML = '';
        mousePointerContainer.setAttribute('data-initialized', 'true');
      }
      // Clean up any orphaned pointer DOM nodes that do not belong to an active remote user
      const existingPointerEls = mousePointerContainer.querySelectorAll('.remote-mouse-pointer');
      existingPointerEls.forEach(pointerEl => {
        const uId = pointerEl.dataset.userId || (pointerEl.id ? pointerEl.id.replace('remote-pointer-', '') : null);
        if (!uId || !remoteCursors.has(uId)) {
          pointerEl.remove();
        }
      });
    }

    const { charWidth, lineHeight } = getMonospaceMetrics();
    const paddingTop = 12;
    const paddingLeft = 12;
    const currentCode = codeTextarea.value || '';

    // If the active user is remote and actively typing, hide the local native blinking cursor so there's only one.
    const isTypingActive = Date.now() - lastTypingTime < 1500;
    if (activeRestingCursorUserId !== socket.id && activeRestingCursorUserId !== null && isTypingActive) {
      codeTextarea.classList.add('hide-caret');
    } else {
      codeTextarea.classList.remove('hide-caret');
    }

    // 1. Render active room text selection highlight if present (releases old selection on new)
    if (activeSelection && activeSelection.start < activeSelection.end) {
      const rects = getSelectionRects(activeSelection.start, activeSelection.end, currentCode);
      rects.forEach(r => {
        const sTop = (r.line - 1) * lineHeight + paddingTop - codeTextarea.scrollTop;
        const sLeft = (r.chStart - 1) * charWidth + paddingLeft - codeTextarea.scrollLeft;
        const sWidth = r.count * charWidth;

        if (sTop >= -25 && sTop <= codeTextarea.clientHeight + 25) {
          const selEl = document.createElement('div');
          selEl.className = 'collaborator-selection-box';
          selEl.style.transform = `translate(${sLeft}px, ${sTop}px)`;
          selEl.style.width = `${sWidth}px`;
          selEl.style.height = `${lineHeight}px`;
          selEl.style.backgroundColor = activeSelection.color;
          collaboratorCursorsContainer.appendChild(selEl);
        }
      });
    }

    // 2. Render persistent resting cursors and mice (ONLY for the LAST active user)
    remoteCursors.forEach((data, userId) => {
      if (userId === socket.id) return;

      const userColor = data.color || '#00f0ff';
      const userName = data.name || 'Collaborator';

      const isActivelyMoving = data.lastMouseMove && (Date.now() - data.lastMouseMove < 1000);

      if (isActivelyMoving && data.mouseData) {
        const m = data.mouseData;
        let posX = null;
        let posY = null;
        let isInsideEditor = false;

        if (m.target === 'editor') {
          const codeEditorArea = document.getElementById('codeEditorArea');
          if (codeEditorArea && codeTextarea) {
            const rect = codeEditorArea.getBoundingClientRect();

            if (m.offsetX !== undefined && m.offsetY !== undefined) {
              posX = rect.left + m.offsetX - codeTextarea.scrollLeft;
              posY = rect.top + m.offsetY - codeTextarea.scrollTop;
            } else if (m.line !== undefined && m.col !== undefined) {
              posX = rect.left + (m.col - 1) * charWidth + paddingLeft - codeTextarea.scrollLeft;
              posY = rect.top + (m.line - 1) * lineHeight + paddingTop - codeTextarea.scrollTop;
            }

            // Only display if within current visible bounds of local editor
            if (posX !== null && posY !== null) {
              if (posX >= rect.left - 10 && posX <= rect.right && posY >= rect.top - 10 && posY <= rect.bottom) {
                isInsideEditor = true;
              } else {
                // Scrolled out of view or occluded
                posX = null;
                posY = null;
              }
            }
          }
        } else if (m.target === 'output') {
          const outputDrawer = document.getElementById('outputDrawer');
          if (outputDrawer && !outputDrawer.classList.contains('collapsed')) {
            const rect = outputDrawer.getBoundingClientRect();
            posX = rect.left + (m.relX || 0) * rect.width;
            posY = rect.top + (m.relY || 0) * rect.height;
          }
        } else if (m.target === 'sidebar') {
          const sidebar = document.getElementById('sidebar');
          if (sidebar && !sidebar.classList.contains('collapsed')) {
            const rect = sidebar.getBoundingClientRect();
            posX = rect.left + (m.relX || 0);
            posY = rect.top + (m.relY || 0);
          }
        } else if (m.target === 'header') {
          const header = document.querySelector('.app-header');
          if (header) {
            const rect = header.getBoundingClientRect();
            posX = rect.left + (m.relX || 0);
            posY = rect.top + (m.relY || 0);
          }
        } else if (m.target === 'viewport') {
          posX = (m.relX !== undefined ? m.relX : (m.x ? m.x / window.innerWidth : 0)) * window.innerWidth;
          posY = (m.relY !== undefined ? m.relY : (m.y ? m.y / window.innerHeight : 0)) * window.innerHeight;
        } else if (m.x !== undefined && m.y !== undefined) {
          posX = m.x;
          posY = m.y;
        }

        if (posX !== null && posY !== null) {
          let el = data.mousePointerEl || document.getElementById('remote-pointer-' + userId);
          if (!el) {
            el = document.createElement('div');
            el.id = 'remote-pointer-' + userId;
            el.dataset.userId = userId;
            el.className = 'remote-mouse-pointer';
            mousePointerContainer.appendChild(el);
            data.mousePointerMode = null; // Forces initial render
          }
          data.mousePointerEl = el;

          el.style.transform = `translate3d(${posX}px, ${posY}px, 0)`;
          
          if (data.mousePointerMode !== isInsideEditor) {
            data.mousePointerMode = isInsideEditor;
            if (isInsideEditor) {
              // Inside editor: Text I-beam cursor icon aligned to code
              el.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${userColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="4" x2="12" y2="20"></line>
                  <line x1="8" y1="4" x2="16" y2="4"></line>
                  <line x1="8" y1="20" x2="16" y2="20"></line>
                </svg>
                <span class="mouse-pointer-label" style="background-color: ${userColor}; padding: 1px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: 700; color: white; margin-left: 4px;">${escapeHtml(userName)}</span>
              `;
            } else {
              // Outside editor: Standard arrow cursor icon
              el.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="${userColor}" stroke="#ffffff" stroke-width="1.5">
                  <path d="M3 3l7 18 3-7 7-3L3 3z"/>
                </svg>
                <span class="mouse-pointer-label" style="background-color: ${userColor}; padding: 1px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: 700; color: white; margin-left: 4px;">${escapeHtml(userName)}</span>
              `;
            }
          }
        } else if (data.mousePointerEl) {
          data.mousePointerEl.remove();
          data.mousePointerEl = null;
        }
      } else if (data.mousePointerEl) {
        data.mousePointerEl.remove();
        data.mousePointerEl = null;
      }
      
      // RESTING CURSOR at specific line/column (ONLY for the LAST active cursor)
      if (userId === activeRestingCursorUserId && data.cursor && data.cursor.line) {
        const top = (data.cursor.line - 1) * lineHeight + paddingTop - codeTextarea.scrollTop;
        const left = (data.cursor.ch - 1) * charWidth + paddingLeft - codeTextarea.scrollLeft;

        const hasSelection = (activeSelection && activeSelection.start < activeSelection.end) || 
                             (data.cursor && data.cursor.selection && data.cursor.selection.start !== data.cursor.selection.end);

        if (top >= -25 && top <= codeTextarea.clientHeight + 25) {
          persistentCursorEl.style.display = 'flex';
          persistentCursorEl.style.transform = `translate(${left}px, ${top}px)`;
          persistentCaret.style.backgroundColor = userColor;
          persistentFlag.style.backgroundColor = userColor;
          if (hasSelection) {
            persistentFlag.style.display = 'none';
          } else {
            persistentFlag.style.display = 'block';
            persistentFlag.textContent = isTypingActive ? `${userName} (typing...)` : userName;
          }
        } else {
          persistentCursorEl.style.display = 'none';
        }
      }
    });
    
    // If active user disconnected, no active user, active user is local, or active user has no valid cursor
    const activeData = activeRestingCursorUserId ? remoteCursors.get(activeRestingCursorUserId) : null;
    if (!activeRestingCursorUserId || activeRestingCursorUserId === socket.id || !activeData || !activeData.cursor || !activeData.cursor.line) {
      persistentCursorEl.style.display = 'none';
    }
  }


  // Real-Time Floating Mouse Pointers Tracking with Contextual Coordinate Mapping
  let lastMouseMoveTime = 0;
  window.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMouseMoveTime < 30) return;
    lastMouseMoveTime = now;

    const codeEditorArea = document.getElementById('codeEditorArea');
    const outputDrawer = document.getElementById('outputDrawer');
    const sidebar = document.getElementById('sidebar');
    const header = document.querySelector('.app-header');

    let payload = null;

    // 1. Check if inside code editor area
    if (codeEditorArea && codeTextarea) {
      const rect = codeEditorArea.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const { charWidth, lineHeight } = getMonospaceMetrics();
        const paddingTop = 12;
        const paddingLeft = 12;

        const offsetX = e.clientX - rect.left + codeTextarea.scrollLeft;
        const offsetY = e.clientY - rect.top + codeTextarea.scrollTop;

        const line = Math.max(1, Math.floor((offsetY - paddingTop) / lineHeight) + 1);
        const col = Math.max(1, Math.floor((offsetX - paddingLeft) / charWidth) + 1);

        payload = {
          target: 'editor',
          line: line,
          col: col,
          offsetX: offsetX,
          offsetY: offsetY
        };
      }
    }

    // 2. Check if inside output / console drawer
    if (!payload && outputDrawer && !outputDrawer.classList.contains('collapsed')) {
      const rect = outputDrawer.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        payload = {
          target: 'output',
          relX: (e.clientX - rect.left) / (rect.width || 1),
          relY: (e.clientY - rect.top) / (rect.height || 1)
        };
      }
    }

    // 3. Check if inside sidebar
    if (!payload && sidebar && !sidebar.classList.contains('collapsed')) {
      const rect = sidebar.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        payload = {
          target: 'sidebar',
          relX: e.clientX - rect.left,
          relY: e.clientY - rect.top
        };
      }
    }

    // 4. Check if inside header
    if (!payload && header) {
      const rect = header.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        payload = {
          target: 'header',
          relX: e.clientX - rect.left,
          relY: e.clientY - rect.top
        };
      }
    }

    // 5. Fallback: viewport relative
    if (!payload) {
      payload = {
        target: 'viewport',
        relX: e.clientX / window.innerWidth,
        relY: e.clientY / window.innerHeight
      };
    }

    socket.emit('mouse-move', payload);
  });

  // Custom Language Dropdown Logic & Live Sync
  const languageDropdownBtn = document.getElementById('languageDropdownBtn');
  const languageDropdownMenu = document.getElementById('languageDropdownMenu');
  const languageSelectedLabel = document.getElementById('languageSelectedLabel');

  function updateDropdownUI(lang) {
    if (languageSelectedLabel) {
      const displayMap = { python: 'Python 3' };
      languageSelectedLabel.textContent = displayMap[lang] || lang;
    }
    if (settingsLanguageSelect) {
      settingsLanguageSelect.value = lang;
    }
    if (languageDropdownMenu) {
      const items = languageDropdownMenu.querySelectorAll('.dropdown-item');
      items.forEach(item => {
        if (item.dataset.value === lang) {
          item.classList.add('selected');
        } else {
          item.classList.remove('selected');
        }
      });
    }
  }

  function setLanguageDropdownOpen(open, emit = true) {
    if (!languageDropdownMenu || !languageDropdownBtn) return;
    if (open) {
      languageDropdownMenu.classList.remove('hidden');
      languageDropdownBtn.classList.add('is-open');
    } else {
      languageDropdownMenu.classList.add('hidden');
      languageDropdownBtn.classList.remove('is-open');
    }
    if (emit) {
      socket.emit('language-dropdown-toggle', { isOpen: open });
    }
  }

  if (settingsLanguageSelect) {
    settingsLanguageSelect.addEventListener('change', () => {
      const val = settingsLanguageSelect.value;
      if (val && val !== roomLanguage) {
        roomLanguage = val;
        if (languageSelect) languageSelect.value = val;
        updateDropdownUI(val);
        updateEditorDisplay();
        socket.emit('language-change', { language: val });
      }
    });
  }

  if (languageDropdownBtn) {
    languageDropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !languageDropdownMenu.classList.contains('hidden');
      setLanguageDropdownOpen(!isOpen, true);
    });
  }

  if (languageDropdownMenu) {
    languageDropdownMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.dropdown-item');
      if (!item) return;
      const val = item.dataset.value;
      if (val) {
        if (roomLanguage === val) {
          setLanguageDropdownOpen(false, true);
          return;
        }
        roomLanguage = val;
        if (languageSelect) languageSelect.value = val;
        updateDropdownUI(val);
        updateEditorDisplay();
        socket.emit('language-change', { language: val });
        setLanguageDropdownOpen(false, true);
      }
    });

    languageDropdownMenu.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('mouseenter', () => {
        socket.emit('language-dropdown-item-hover', { value: item.dataset.value, isHovered: true });
      });
      item.addEventListener('mouseleave', () => {
        socket.emit('language-dropdown-item-hover', { value: item.dataset.value, isHovered: false });
      });
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#languageSelectWrapper') && languageDropdownMenu && !languageDropdownMenu.classList.contains('hidden')) {
      setLanguageDropdownOpen(false, true);
    }
  });

  socket.on('language-dropdown-update', ({ isOpen }) => {
    setLanguageDropdownOpen(isOpen, false);
  });

  socket.on('language-dropdown-item-hover-update', ({ value, isHovered }) => {
    if (!languageDropdownMenu) return;
    const item = languageDropdownMenu.querySelector(`.dropdown-item[data-value="${value}"]`);
    if (item) {
      if (isHovered) item.classList.add('is-hovered');
      else item.classList.remove('is-hovered');
    }
  });

  socket.on('language-update', ({ language }) => {
    if (language) {
      roomLanguage = language;
      if (languageSelect) languageSelect.value = language;
      updateDropdownUI(language);
      updateEditorDisplay();
    }
  });

  // --------------------------------------------------------------------------
  // 5. Code Execution Engine (Pyodide Persistent WebAssembly Worker Engine)
  // --------------------------------------------------------------------------

  let activeExecutionWorker = null;
  let isExecutionRunning = false;
  let isPyodideReady = false;
  const stopConsoleBtn = document.getElementById('stopConsoleBtn');

  function createPyodideWorkerBlob() {
    const workerScript = `
      const hostOrigin = (self.originUrl || (self.location && self.location.origin) || '');

      // Cache Pyodide assets in CacheStorage for instant subsequent loads
      const CACHE_NAME = 'livecode-pyodide-v1';
      const origFetch = self.fetch;
      self.fetch = async function(resource, init) {
        const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');
        if (url && (url.includes('/vendor/pyodide/') || url.endsWith('.wasm') || url.endsWith('.zip') || url.endsWith('.json') || url.endsWith('.js'))) {
          if ('caches' in self) {
            try {
              const cache = await caches.open(CACHE_NAME);
              const match = await cache.match(resource);
              if (match) return match;
              const res = await origFetch(resource, init);
              if (res && res.ok) {
                try { await cache.put(resource, res.clone()); } catch(e){}
              }
              return res;
            } catch(e){}
          }
        }
        return origFetch(resource, init);
      };

      importScripts(hostOrigin + '/vendor/pyodide/pyodide.js');
      let pyodide = null;
      let initPromise = null;

      function scanFilesFS() {
        if (!pyodide || !pyodide.FS) return [];
        const res = [];
        const base = '/home/pyodide';
        function walk(currentDir, prefix) {
          let entries = [];
          try { entries = pyodide.FS.readdir(currentDir); } catch(e) { return; }
          const dirs = [];
          const files = [];
          for (const entry of entries) {
            if (entry === '.' || entry === '..' || entry.startsWith('.')) continue;
            const fullPath = currentDir + '/' + entry;
            try {
              const stat = pyodide.FS.stat(fullPath);
              if (pyodide.FS.isDir(stat.mode)) dirs.push(entry);
              else files.push(entry);
            } catch(e) {}
          }
          dirs.sort();
          files.sort();
          for (const d of dirs) {
            res.push(prefix + d + '/');
            walk(currentDir + '/' + d, prefix + d + '/');
          }
          for (const f of files) {
            res.push(prefix + f);
          }
        }
        walk(base, '');
        return res;
      }

      function getCwdFS() {
        try {
          return pyodide.runPython("import os\\nos.getcwd()");
        } catch(e) {
          return '/home/pyodide';
        }
      }

      const initPyodide = () => {
        if (pyodide) return Promise.resolve(pyodide);
        if (initPromise) return initPromise;

        initPromise = (async () => {
          self.postMessage({ type: 'status', text: 'initializing' });
          pyodide = await loadPyodide({
            indexURL: (self.originUrl || '') + '/vendor/pyodide/',
            stdout: (text) => self.postMessage({ type: 'stdout', text: text }),
            stderr: (text) => self.postMessage({ type: 'stderr', text: text })
          });

          await pyodide.runPythonAsync(\`
import builtins
import json
from js import XMLHttpRequest, eval as js_eval

def custom_input(prompt_text=""):
    xhr = XMLHttpRequest.new()
    target_url = js_eval("self.originUrl || ''") + "/api/sync-input"
    xhr.open("POST", target_url, False)
    xhr.setRequestHeader("Content-Type", "application/json")
    room_id = js_eval("self.currentRoomId || ''")
    payload = json.dumps({"roomId": str(room_id), "promptText": str(prompt_text)})
    xhr.send(payload)
    if xhr.status == 200:
        return xhr.responseText.rstrip('\\\\n')
    return ""
builtins.input = custom_input
          \`);

          try { pyodide.FS.mkdirTree('/home/pyodide'); } catch(e){}

          const files = scanFilesFS();
          const cwd = getCwdFS();
          self.postMessage({ type: 'status', text: 'ready', files: files, cwd: cwd });
          return pyodide;
        })();

        return initPromise;
      };

      self.onmessage = async function(e) {
        const { type, code, roomId, origin } = e.data;
        if (roomId) self.currentRoomId = roomId;
        if (origin) self.originUrl = origin;

        if (type === 'init') {
          try {
            await initPyodide();
            if (e.data.activeFile && e.data.activeFile !== 'Untitled' && !e.data.activeFile.startsWith('Untitled')) {
              try {
                if (!pyodide.FS.analyzePath(e.data.activeFile).exists) {
                  const dir = e.data.activeFile.includes('/') ? e.data.activeFile.substring(0, e.data.activeFile.lastIndexOf('/')) : null;
                  if (dir) pyodide.FS.mkdirTree(dir);
                  pyodide.FS.writeFile(e.data.activeFile, e.data.currentCode || '');
                }
              } catch(err){}
            }
            if (e.data.files && Array.isArray(e.data.files)) {
              e.data.files.forEach(f => {
                try {
                  if (f.endsWith('/')) {
                    pyodide.FS.mkdirTree(f.slice(0, -1));
                  } else if (f.includes('/')) {
                    const d = f.substring(0, f.lastIndexOf('/'));
                    pyodide.FS.mkdirTree(d);
                    if (!pyodide.FS.analyzePath(f).exists) {
                      pyodide.FS.writeFile(f, '');
                    }
                  } else {
                    if (!pyodide.FS.analyzePath(f).exists) {
                      pyodide.FS.writeFile(f, '');
                    }
                  }
                } catch(err){}
              });
            }
          } catch (err) {
            self.postMessage({ type: 'error', error: 'Failed to initialize Python engine: ' + (err && err.message ? err.message : err) });
          }
        } else if (type === 'save_file') {
          try {
            await initPyodide();
            if (e.data.filename) {
              const fileDir = e.data.filename.includes('/') ? e.data.filename.substring(0, e.data.filename.lastIndexOf('/')) : null;
              if (fileDir) {
                try { pyodide.FS.mkdirTree(fileDir); } catch(dErr){}
              }
              pyodide.FS.writeFile(e.data.filename, e.data.content !== undefined ? e.data.content : '');
            }
            const files = scanFilesFS();
            const cwd = getCwdFS();
            self.postMessage({ type: 'shell_done', files: files, cwd: cwd, skipPrompt: true });
          } catch(err) {
            self.postMessage({ type: 'shell_done' });
          }
        } else if (type === 'run') {
          try {
            await initPyodide();
            if (e.data.allFiles && typeof e.data.allFiles === 'object') {
              for (const [fPath, fContent] of Object.entries(e.data.allFiles)) {
                try {
                  const dir = fPath.includes('/') ? fPath.substring(0, fPath.lastIndexOf('/')) : null;
                  if (dir) {
                    try { pyodide.FS.mkdirTree(dir); } catch(dErr){}
                  }
                  pyodide.FS.writeFile(fPath, fContent !== undefined ? fContent : '');
                } catch(wErr){}
              }
            }
            if (code !== undefined && e.data.activeFile && e.data.activeFile !== 'Untitled' && !e.data.activeFile.startsWith('Untitled')) {
              const fileDir = e.data.activeFile.includes('/') ? e.data.activeFile.substring(0, e.data.activeFile.lastIndexOf('/')) : null;
              if (fileDir) {
                try { pyodide.FS.mkdirTree(fileDir); } catch(dErr){}
              }
              pyodide.FS.writeFile(e.data.activeFile, code);
            }
            try {
              await pyodide.runPythonAsync("import sys, os\\n_cwd = os.getcwd()\\nfor _k in list(sys.modules.keys()):\\n    _m = sys.modules.get(_k)\\n    if _m is not None:\\n        _f = getattr(_m, '__file__', None)\\n        if _f and (_f.startswith('/home/pyodide') or _f.startswith(_cwd)):\\n            del sys.modules[_k]");
            } catch(_rErr){}
            await pyodide.runPythonAsync(code);
            self.postMessage({ type: 'done' });
          } catch (err) {
            self.postMessage({ type: 'error', error: err.message });
          }
        } else if (type === 'shell') {
          try {
            const cmd = (e.data.command || '').trim();
            if (!cmd) {
              self.postMessage({ type: 'shell_done' });
              return;
            }
            if (cmd === 'clear') {
              self.postMessage({ type: 'shell_clear' });
              return;
            }
            await initPyodide();

            const rawParts = cmd.match(/(?:[^\\s"']+|"[^"]*"|'[^']*')+/g) || [cmd];
            let action = rawParts[0] ? rawParts[0].trim().replace(/^["']|["']$/g, '').replace(/:$/, '') : '';
            const parts = rawParts.map(m => (m.startsWith('"') && m.endsWith('"')) || (m.startsWith("'") && m.endsWith("'")) ? m.slice(1, -1) : m);
            let pyCode = '';
            if (action === 'ls') {
              const target = parts[1] || '.';
              if (!e.data.skipPrompt) {
                pyCode = "import os\\ntry:\\n    target = " + JSON.stringify(target) + "\\n    items = sorted(os.listdir(target))\\n    res = []\\n    for f in items:\\n        full = os.path.join(target, f)\\n        if os.path.isdir(full):\\n            res.append('\\x1b[1;34m' + f + '/\\x1b[0m')\\n        else:\\n            res.append(f)\\n    if res:\\n        print('  '.join(res))\\nexcept Exception as err:\\n    print(err)";
              }
            } else if (action === 'pwd') {
              pyCode = "import os\\nprint(os.getcwd())";
            } else if (action === 'cd') {
              const dir = parts[1] || '/home/pyodide';
              pyCode = "import os\\ntry:\\n    target_dir = " + JSON.stringify(dir) + "\\n    if target_dir == '~' or target_dir.startswith('~/'):\\n        target_dir = target_dir.replace('~', '/home/pyodide', 1)\\n    os.chdir(target_dir)\\nexcept Exception as err:\\n    print(err)";
            } else if (action === 'cat') {
              const file = parts[1];
              if (file) pyCode = "try:\\n    with open(" + JSON.stringify(file) + ", 'r') as f:\\n        print(f.read())\\nexcept Exception as err:\\n    print(err)";
            } else if (action === 'open') {
              const file = parts[1];
              if (file) {
                try {
                  const content = pyodide.FS.readFile(file, { encoding: 'utf8' });
                  self.postMessage({ type: 'open_file', filename: file, content: content });
                } catch (err) {
                  self.postMessage({ type: 'open_file', filename: file, content: '' });
                }
              }
              const files = scanFilesFS();
              const cwd = getCwdFS();
              self.postMessage({ type: 'shell_done', files: files, cwd: cwd, skipPrompt: true });
              return;
            } else if (action === 'mkdir') {
              const dir = parts[1];
              if (dir) pyCode = "import os\\ntry:\\n    os.makedirs(" + JSON.stringify(dir) + ", exist_ok=True)\\nexcept Exception as err:\\n    print(err)";
            } else if (action === 'touch') {
              const file = parts[1];
              if (file) {
                try {
                  const d = file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : null;
                  if (d) {
                    try { pyodide.FS.mkdirTree(d); } catch(dErr){}
                  }
                  if (!pyodide.FS.analyzePath(file).exists || e.data.currentCode !== undefined) {
                    pyodide.FS.writeFile(file, e.data.currentCode !== undefined ? e.data.currentCode : '');
                  }
                } catch(tErr) {
                  pyCode = "import os\\ntry:\\n    d = os.path.dirname(" + JSON.stringify(file) + ")\\n    if d:\\n        os.makedirs(d, exist_ok=True)\\n    open(" + JSON.stringify(file) + ", 'a').close()\\nexcept Exception as err:\\n    print(err)";
                }
              }
            } else if (action === 'rmdir') {
              const dir = parts[1];
              if (dir) pyCode = "import os\\ntry:\\n    if os.path.isdir(" + JSON.stringify(dir) + "):\\n        if len(os.listdir(" + JSON.stringify(dir) + ")) == 0:\\n            os.rmdir(" + JSON.stringify(dir) + ")\\n        else:\\n            print('rmdir: failed to remove ' + " + JSON.stringify(dir) + " + ': Directory not empty')\\n    else:\\n        print('rmdir: failed to remove ' + " + JSON.stringify(dir) + " + ': Not a directory')\\nexcept Exception as err:\\n    print(err)";
            } else if (action === 'rm') {
              const hasRecursive = parts.some(p => p === '-r' || p === '-rf' || p === '-fr' || p === '-R');
              const targets = parts.slice(1).filter(p => !p.startsWith('-'));
              const target = targets[0];
              if (target) {
                pyCode = "import os, shutil\\ntry:\\n    t = " + JSON.stringify(target) + "\\n    is_rec = " + (hasRecursive ? "True" : "False") + "\\n    if os.path.isdir(t):\\n        if is_rec:\\n            shutil.rmtree(t)\\n        else:\\n            print('rm: cannot remove ' + t + ': Is a directory')\\n    elif os.path.exists(t):\\n        os.remove(t)\\n    else:\\n        if not " + (parts.includes('-f') || parts.includes('-rf') || parts.includes('-fr') ? "True" : "False") + ":\\n            print('rm: cannot remove ' + t + ': No such file or directory')\\nexcept Exception as err:\\n    print(err)";
              }
            } else if (action === 'cp') {
              const src = parts[1];
              const dst = parts[2];
              if (src && dst) pyCode = "import shutil\\ntry:\\n    shutil.copy2(" + JSON.stringify(src) + ", " + JSON.stringify(dst) + ")\\nexcept Exception as err:\\n    print(err)";
            } else if (action === 'mv') {
              const src = parts[1];
              const dst = parts[2];
              if (src && dst) pyCode = "import shutil\\ntry:\\n    shutil.move(" + JSON.stringify(src) + ", " + JSON.stringify(dst) + ")\\nexcept Exception as err:\\n    print(err)";
            } else if (action === 'echo') {
              const text = parts.slice(1).join(' ');
              pyCode = "print(" + JSON.stringify(text) + ")";
            } else if (action === 'python' || action === 'python3') {
              const pyTarget = parts[1];
              if (pyTarget) {
                pyCode = "import os, runpy\\ntry:\\n    runpy.run_path(" + JSON.stringify(pyTarget) + ", run_name='__main__')\\nexcept Exception as err:\\n    import traceback; traceback.print_exc()";
              } else {
                pyCode = "print('Python 3.11 (Pyodide WebAssembly Console)')";
              }
            } else {
              self.postMessage({ type: 'stderr', text: "bash: " + action + ": command not found" });
            }
            if (pyCode) {
              await pyodide.runPythonAsync(pyCode);
            }
            const files = scanFilesFS();
            const cwd = getCwdFS();
            self.postMessage({ type: 'shell_done', files: files, cwd: cwd, skipPrompt: e.data.skipPrompt || false });
          } catch (err) {
            self.postMessage({ type: 'stderr', text: err.message });
            self.postMessage({ type: 'shell_done' });
          }
        }
      };
    `;
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  }

  const pyodideWorkerBlobUrl = createPyodideWorkerBlob();

  function getOrInitWorker() {
    if (!isHost) return null;
    if (!activeExecutionWorker) {
      activeExecutionWorker = new Worker(pyodideWorkerBlobUrl);

      activeExecutionWorker.onmessage = (e) => {
        if (e.data.type === 'status') {
          const { text } = e.data;
          if (text === 'initializing') {
            if (isExecutionRunning) {
              updateOutputStatus('running', 'Initializing...');
            } else {
              updateOutputStatus('system', '⚡ Initializing Console...');
            }
          } else if (text === 'ready') {
            isPyodideReady = true;
            if (e.data.files && e.data.files.length > 0) {
              const merged = Array.from(new Set([...shellFiles, ...e.data.files]));
              shellFiles = merged;
              try { localStorage.setItem('livecode_files', JSON.stringify(shellFiles)); } catch(e){}
              renderFilesList();
            }
            if (e.data.cwd) currentShellCwd = e.data.cwd;
            renderFilesList();
            socket.emit('file-system-sync', {
              files: shellFiles,
              cwd: currentShellCwd,
              sidebarCollapsed: sidebar ? sidebar.classList.contains('collapsed') : false,
              collapsedFolders: Array.from(collapsedFolders)
            });
            
            if (!isExecutionRunning) {
              updateOutputStatus('completed', '✔ Ready');
              setTimeout(() => {
                if (!isExecutionRunning) updateOutputStatus('hidden');
              }, 1200);
            }
          }
        } else if (e.data.type === 'stdout') {
          appendConsoleLine('normal', e.data.text);
        } else if (e.data.type === 'stderr') {
          appendConsoleLine('error', e.data.text);
        } else if (e.data.type === 'done') {
          setRunningUIState(false);
          updateOutputStatus('completed', '✔');
          startShellMode();
        } else if (e.data.type === 'error') {
          setRunningUIState(false);
          updateOutputStatus('error', '❌ Error');
          appendConsoleLine('error', `Python Traceback:\n${e.data.error}`);
          startShellMode();
        } else if (e.data.type === 'shell_done') {
          if (e.data.files) {
            shellFiles = e.data.files;
            try { localStorage.setItem('livecode_files', JSON.stringify(shellFiles)); } catch(e){}
          }
          if (e.data.cwd) currentShellCwd = e.data.cwd;
          renderFilesList();
          socket.emit('file-system-sync', {
            files: shellFiles,
            cwd: currentShellCwd,
            sidebarCollapsed: sidebar ? sidebar.classList.contains('collapsed') : false,
            collapsedFolders: Array.from(collapsedFolders)
          });
          if (!e.data.skipPrompt) {
            startShellMode();
          }
        } else if (e.data.type === 'shell_clear') {
          if (terminal) terminal.reset();
          socket.emit('output-sync', { action: 'clear', shell: true });
          startShellMode();
        } else if (e.data.type === 'open_file') {
          finalizeTypingSnapshot();
          currentActiveFile = e.data.filename;
          if (!fileSavedContents.has(e.data.filename)) {
            fileSavedContents.set(e.data.filename, e.data.content);
          }
          const draft = tabBufferMap.has(e.data.filename) ? tabBufferMap.get(e.data.filename) : e.data.content;
          codeTextarea.value = draft;
          roomCode = draft;
          tabBufferMap.set(e.data.filename, draft);
          if (draft === fileSavedContents.get(e.data.filename)) {
            unsavedFiles.delete(e.data.filename);
          } else {
            unsavedFiles.add(e.data.filename);
          }
          if (currentActiveFile && !openTabs.includes(currentActiveFile)) openTabs.push(currentActiveFile);
          updateEditorDisplay();
          renderFilesList();
          renderTabs({ preserveScroll: true });
          updateUndoRedoUI();
          socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
        }
      };

      activeExecutionWorker.onerror = (err) => {
        setRunningUIState(false);
        updateOutputStatus('error', '❌ Error');
        const msg = (err && err.message) ? err.message : 'Execution error';
        appendConsoleLine('error', `Worker Error: ${msg}`);
      };

      // Initialize engine in background
      activeExecutionWorker.postMessage({ type: 'init', roomId: currentRoomId, origin: window.location.origin, currentCode: codeTextarea.value, activeFile: currentActiveFile, files: shellFiles });
    }
    return activeExecutionWorker;
  }

  // Pre-initialize Python WebAssembly worker immediately if host or creating room
  if (!currentRoomId || isHost) {
    getOrInitWorker();
  }

  function setRunningUIState(running) {
    isExecutionRunning = running;

    if (running) {
      runCodeBtn.classList.remove('btn-success');
      runCodeBtn.classList.add('btn-danger', 'is-running');
      runCodeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>';
      runCodeBtn.title = 'Stop Execution ⏹';
    } else {
      runCodeBtn.classList.remove('btn-danger', 'is-running');
      runCodeBtn.classList.add('btn-success');
      runCodeBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
      runCodeBtn.title = 'Run Code';
    }
  }

  function terminateExecution(reason = 'Execution terminated by user') {
    if (activeExecutionWorker) {
      activeExecutionWorker.terminate();
      activeExecutionWorker = null;
    }
    setRunningUIState(false);
    updateOutputStatus('error', '🛑 Stopped');
    appendConsoleLine('error', `🛑 [${reason}]`);
    showToast('🛑 Code execution terminated.');

    // Pre-warm fresh worker for next run
    getOrInitWorker();
    startShellMode();
  }

  function runPythonCode(codeToRun) {
    if (!isHost) return;

    if (isExecutionRunning) {
      terminateExecution();
      return;
    }

    outputDrawer.classList.remove('collapsed');
    updateConsoleButtonsState();
    if (terminal) {
      terminal.reset();
    } else {
      consoleOutput.innerHTML = '';
    }
    isShellMode = false;
    htmlPreviewContainer.classList.add('hidden');
    consoleOutput.classList.remove('hidden');

    socket.emit('output-sync', { action: 'clear' });
    updateOutputStatus('running', 'Running...');
    setRunningUIState(true);

    if (currentActiveFile) {
      tabBufferMap.set(currentActiveFile, codeToRun !== undefined ? codeToRun : (codeTextarea ? codeTextarea.value : ''));
    }

    const allFiles = {};
    for (const [fName, fCode] of fileSavedContents.entries()) {
      if (fName && fName !== 'Untitled' && !fName.startsWith('Untitled')) {
        allFiles[fName] = fCode;
      }
    }
    for (const [fName, fCode] of tabBufferMap.entries()) {
      if (fName && fName !== 'Untitled' && !fName.startsWith('Untitled')) {
        allFiles[fName] = fCode;
      }
    }

    const worker = getOrInitWorker();
    if (worker) {
      worker.postMessage({
        type: 'run',
        code: codeToRun,
        activeFile: currentActiveFile,
        allFiles: allFiles,
        roomId: currentRoomId,
        origin: window.location.origin
      });
    }
  }

  runCodeBtn.addEventListener('click', () => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    if (codeTextarea) {
      codeTextarea.blur();
    }
    const codeToRun = codeTextarea ? codeTextarea.value : '';
    if (isHost) {
      if (isExecutionRunning) {
        terminateExecution();
      } else {
        runPythonCode(codeToRun);
      }
    } else {
      if (isExecutionRunning) {
        socket.emit('request-terminate-code');
      } else {
        socket.emit('request-run-code', { code: codeToRun });
      }
    }
  });

  let terminal = null;
  let fitAddon = null;
  let isTerminalExpectingInput = false;
  let currentTerminalInputBuffer = '';
  let isShellMode = false;
  let shellHistory = [];
  let shellHistoryIndex = -1;
  let shellFiles = [];
  try {
    const savedFiles = localStorage.getItem('livecode_files');
    if (savedFiles) {
      const parsed = JSON.parse(savedFiles);
      if (Array.isArray(parsed) && parsed.length > 0) {
        shellFiles = parsed;
      }
    }
  } catch(e){}

  let currentShellCwd = '/home/pyodide';
  const shellCommands = ['ls', 'cd', 'cat', 'open', 'pwd', 'clear', 'mkdir', 'rmdir', 'touch', 'rm', 'cp', 'mv', 'echo'];

  const createFileBtn = document.getElementById('createFileBtn');
  const createFolderBtn = document.getElementById('createFolderBtn');
  const collapseFoldersBtn = document.getElementById('collapseFoldersBtn');
  const refreshFilesBtn = document.getElementById('refreshFilesBtn');

  if (collapseFoldersBtn) {
    collapseFoldersBtn.addEventListener('click', () => {
      if (shellFiles) {
        shellFiles.forEach(f => {
          if (f.endsWith('/')) {
            collapsedFolders.add(f);
          } else if (f.includes('/')) {
            const parts = f.split('/');
            parts.pop();
            let current = '';
            parts.forEach(p => {
              current = current ? current + '/' + p : p;
              collapsedFolders.add(current + '/');
            });
          }
        });
      }
      renderFilesList();
      emitSidebarState();
    });
  }

  if (refreshFilesBtn) {
    refreshFilesBtn.addEventListener('click', () => {
      refreshFilesTree();
    });
  }

  // Live Sync Hover on buttons throughout the interface
  const syncedHoverButtonIds = [
    // Header Actions
    'languageSelect',
    'languageDropdownBtn',
    'timerBtn',
    'timerStartPauseBtn',
    'timerResetBtn',
    'undoBtn',
    'redoBtn',
    'formatCodeBtn',
    'runCodeBtn',
    'downloadCodeBtn',
    'copyCodeBtn',
    'voiceCallBtn',
    'settingsBtn',
    'accountRenameBtn',
    'roomCopyIcon',
    'settingsRoomCopyIcon',
    'liveSharingToggleLabel',
    'liveSharingToggleLabelSettings',
    'copyProtectionToggleLabel',
    'pasteProtectionToggleLabel',
    'readOnlyToggleLabel',
    'syntaxHighlightToggleLabel',

    // Execution Console & Output Header Buttons (Image 1)
    'copyConsoleBtn',
    'clearConsoleBtn',
    'expandConsoleBtn',
    'collapseConsoleBtn',

    // Sidebar & Chat Drawer Collapse/Expand Arrow Buttons (Image 2)
    'sidebarCollapseBtn',
    'sidebarExpandBtn',
    'closeChatBtn',
    'chatDrawerExpandBtn',

    // Sidebar Header Buttons
    'createFileBtn',
    'createFolderBtn',
    'collapseFoldersBtn',
    'refreshFilesBtn',

    // Chat
    'sendChatBtn',

    // Drawer Tabs (Chat & Activity)
    'drawerTabChatBtn',
    'drawerTabActivityBtn',

    // Console Resizer
    'consoleResizer'
  ];

  syncedHoverButtonIds.forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('mouseenter', () => {
        socket.emit('btn-hover', { btnId, isHovered: true, color: currentUser?.color });
      });
      btn.addEventListener('mouseleave', () => {
        socket.emit('btn-hover', { btnId, isHovered: false, color: currentUser?.color });
      });
    }
  });

  function refreshFilesTree() {
    if (isHost) {
      const worker = getOrInitWorker();
      if (worker) {
        worker.postMessage({ type: 'shell', command: 'ls', currentCode: codeTextarea.value, activeFile: currentActiveFile, skipPrompt: true });
      }
    } else {
      socket.emit('request-shell-command', { command: 'ls', currentCode: codeTextarea.value, activeFile: currentActiveFile, skipPrompt: true });
    }
  }

  if (createFileBtn) {
    createFileBtn.addEventListener('click', () => {
      if (selectedFolder && collapsedFolders.has(selectedFolder)) {
        collapsedFolders.delete(selectedFolder);
      }
      localCreating = true;
      inlineCreatingItem = { type: 'file', parentFolder: selectedFolder, value: '', cursor: { start: 0, end: 0 } };
      renderFilesList();
      socket.emit('tree-create-start', { type: 'file', parentFolder: selectedFolder, cursor: { start: 0, end: 0 } });
    });
  }

  if (createFolderBtn) {
    createFolderBtn.addEventListener('click', () => {
      if (selectedFolder && collapsedFolders.has(selectedFolder)) {
        collapsedFolders.delete(selectedFolder);
      }
      localCreating = true;
      inlineCreatingItem = { type: 'folder', parentFolder: selectedFolder, value: '', cursor: { start: 0, end: 0 } };
      renderFilesList();
      socket.emit('tree-create-start', { type: 'folder', parentFolder: selectedFolder, cursor: { start: 0, end: 0 } });
    });
  }

  function createNewTab() {
    let baseName = 'Untitled';
    let newName = 'Untitled.py';
    let counter = 1;
    const existing = new Set([...openTabs, ...(shellFiles || [])]);
    while (existing.has(newName) || (counter === 1 && existing.has('Untitled'))) {
      counter++;
      newName = `Untitled-${counter}.py`;
    }

    if (currentActiveFile && codeTextarea) {
      tabBufferMap.set(currentActiveFile, codeTextarea.value);
    }

    if (!openTabs.includes(newName)) {
      openTabs.push(newName);
    }
    currentActiveFile = newName;
    tabBufferMap.set(newName, '');
    unsavedFiles.add(newName);
    if (codeTextarea) codeTextarea.value = '';
    roomCode = '';
    updateEditorDisplay();
    renderTabs();
    renderFilesList();
    socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
    const tabsContainer = document.getElementById('editorTabs');
    if (tabsContainer) {
      setTimeout(() => {
        tabsContainer.scrollTo({ left: tabsContainer.scrollWidth, behavior: 'smooth' });
      }, 20);
    }
    if (codeTextarea) {
      codeTextarea.focus();
      codeTextarea.setSelectionRange(0, 0);
      emitCursorPosition();
      setTimeout(() => {
        if (codeTextarea) {
          codeTextarea.focus();
          codeTextarea.setSelectionRange(0, 0);
          emitCursorPosition();
        }
      }, 0);
    }
  }

  function openFileInTab(filename, customTabs = null, options = {}) {
    finalizeTypingSnapshot();
    if (customTabs && Array.isArray(customTabs)) {
      openTabs = [...customTabs];
    }
    if (currentActiveFile && codeTextarea) {
      tabBufferMap.set(currentActiveFile, codeTextarea.value);
    }
    if (filename && !openTabs.includes(filename)) {
      openTabs.push(filename);
    }
    renderTabs(options);
    updateUndoRedoUI();
    if (filename !== currentActiveFile) {
      if (isHost) {
        const worker = getOrInitWorker();
        if (worker) {
          if (currentActiveFile && tabBufferMap.has(currentActiveFile) && currentActiveFile !== 'Untitled' && !currentActiveFile.startsWith('Untitled')) {
            try {
              worker.postMessage({
                type: 'save_file',
                filename: currentActiveFile,
                content: tabBufferMap.get(currentActiveFile),
                skipPrompt: true
              });
            } catch(e){}
          }
          worker.postMessage({ type: 'shell', command: 'open ' + filename, activeFile: currentActiveFile, skipPrompt: true });
        }
      } else {
        socket.emit('request-shell-command', { command: 'open ' + filename, activeFile: currentActiveFile, openTabs: openTabs, skipPrompt: true });
      }
    } else {
      renderFilesList();
      socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
    }
  }

  function renderTabs(options = {}) {
    updateUndoRedoUI();
    const tabsContainer = document.getElementById('editorTabs');
    if (!tabsContainer) return;
    const prevScrollLeft = tabsContainer.scrollLeft;
    tabsContainer.innerHTML = '';
    
    openTabs.forEach(tabName => {
      const tabEl = document.createElement('div');
      const isUnsaved = unsavedFiles.has(tabName);
      const isHovered = syncedHoveredTabName === tabName;
      tabEl.className = `editor-tab ${tabName === currentActiveFile ? 'active' : ''} ${isUnsaved ? 'unsaved' : ''} ${isHovered ? 'is-hovered' : ''}`;
      tabEl.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
        <span class="editor-tab-title" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;" title="${tabName}">${tabName}</span>
        ${isUnsaved ? '<span class="unsaved-dot" title="Unsaved changes" style="flex-shrink: 0;">•</span>' : ''}
        <div class="editor-tab-close" title="Close Tab" style="flex-shrink: 0;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </div>
      `;
      
      tabEl.addEventListener('mouseenter', () => {
        socket.emit('tab-hover', { tabName, isHovered: true, color: currentUser?.color });
      });
      tabEl.addEventListener('mouseleave', () => {
        socket.emit('tab-hover', { tabName, isHovered: false, color: currentUser?.color });
      });

      tabEl.addEventListener('click', (e) => {
        if (e.target.closest('.editor-tab-close')) return;
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
        if (codeTextarea) {
          codeTextarea.blur();
        }
        if (tabName !== currentActiveFile) {
          openFileInTab(tabName, null, { preserveScroll: true });
        }
      });
      
      const closeBtn = tabEl.querySelector('.editor-tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('mouseenter', () => {
          socket.emit('tab-close-hover', { tabName, isHovered: true });
        });
        closeBtn.addEventListener('mouseleave', () => {
          socket.emit('tab-close-hover', { tabName, isHovered: false });
        });
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          socket.emit('tab-close-hover', { tabName, isHovered: false });
          openTabs = openTabs.filter(t => t !== tabName);
          if (openTabs.length === 0) {
            currentActiveFile = '';
            if (codeTextarea) codeTextarea.value = '';
            roomCode = '';
            updateEditorDisplay();
            renderTabs();
            renderFilesList();
            socket.emit('code-change', { code: roomCode, cursor: null, activeFile: '', openTabs: openTabs });
            return;
          }
          
          if (tabName === currentActiveFile) {
            const nextTab = openTabs[openTabs.length - 1];
            openFileInTab(nextTab, openTabs);
          } else {
            renderTabs({ preserveScroll: true });
            socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
          }
        });
      }
      
      tabsContainer.appendChild(tabEl);
    });

    // Add New Tab '+' button
    const newTabBtn = document.createElement('button');
    newTabBtn.type = 'button';
    newTabBtn.className = 'editor-tab-new';
    newTabBtn.id = 'newTabBtn';
    newTabBtn.title = 'New Tab (Ctrl+Alt+N / Alt+T)';
    newTabBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
    `;
    newTabBtn.addEventListener('mouseenter', () => {
      socket.emit('btn-hover', { btnId: 'newTabBtn', isHovered: true, color: currentUser?.color });
    });
    newTabBtn.addEventListener('mouseleave', () => {
      socket.emit('btn-hover', { btnId: 'newTabBtn', isHovered: false, color: currentUser?.color });
    });
    newTabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      createNewTab();
    });
    tabsContainer.appendChild(newTabBtn);

    // Restore scroll position immediately after rebuilding DOM
    tabsContainer.scrollLeft = prevScrollLeft;

    // Ensure active tab is visible within tabs scroll viewport only if not preserving scroll and not already fully visible
    if (!options.preserveScroll) {
      const activeTabEl = tabsContainer.querySelector('.editor-tab.active');
      if (activeTabEl) {
        const containerRect = tabsContainer.getBoundingClientRect();
        const activeRect = activeTabEl.getBoundingClientRect();
        const stickyPlusWidth = 36;
        const isFullyVisible = (activeRect.left >= containerRect.left - 1) &&
                               (activeRect.right <= containerRect.right - stickyPlusWidth + 1);
        if (!isFullyVisible) {
          activeTabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
      }
    }

    // Update tabs overflowing state for close button visibility
    updateTabsOverflowState();
    requestAnimationFrame(() => updateTabsOverflowState());
  }

  let selectedFolder = '';
  const collapsedFolders = new Set();
  let inlineCreatingItem = null;

  function commitInlineCreate(name) {
    if (!inlineCreatingItem) return;
    const cleanName = name ? name.trim() : '';
    const type = inlineCreatingItem.type;
    const parentFolder = inlineCreatingItem.parentFolder;
    inlineCreatingItem = null;
    localCreating = false;
    socket.emit('tree-create-end');

    if (!cleanName) {
      renderFilesList();
      return;
    }

    let fullPath = cleanName;
    const normalizedParent = (parentFolder && parentFolder !== '/') ? parentFolder : '';
    if (normalizedParent) {
      const prefix = normalizedParent.endsWith('/') ? normalizedParent : normalizedParent + '/';
      fullPath = prefix + cleanName;
    }

    if (type === 'folder') {
      const folderPath = fullPath.endsWith('/') ? fullPath : fullPath + '/';
      const cleanFolderPath = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
      const cmd = `mkdir "${cleanFolderPath}"`;
      sendShellCommand(cmd, { silent: true, skipPrompt: true });

      if (!shellFiles.includes(folderPath)) {
        shellFiles.push(folderPath);
      }
      selectedFolder = folderPath;
      renderFilesList();
      socket.emit('tree-select', { path: selectedFolder });
    } else {
      const cmd = `touch "${fullPath}"`;
      sendShellCommand(cmd, { silent: true, skipPrompt: true });

      if (!shellFiles.includes(fullPath)) {
        shellFiles.push(fullPath);
      }
      currentActiveFile = fullPath;
      if (codeTextarea) codeTextarea.value = '';
      roomCode = '';
      if (!openTabs.includes(fullPath)) {
        openTabs.push(fullPath);
      }
      updateEditorDisplay();
      renderTabs();
      renderFilesList();
      socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
      if (codeTextarea) {
        codeTextarea.focus();
        codeTextarea.setSelectionRange(0, 0);
        emitCursorPosition();
        setTimeout(() => {
          if (codeTextarea) {
            codeTextarea.focus();
            codeTextarea.setSelectionRange(0, 0);
            emitCursorPosition();
          }
        }, 0);
      }
    }
  }

  function sendShellCommand(cmd, options = {}) {
    const isSilent = Boolean(options.silent);
    const skipPrompt = options.skipPrompt !== undefined ? options.skipPrompt : isSilent;

    let displayCwd = currentShellCwd.startsWith('/home/pyodide') 
      ? currentShellCwd.replace('/home/pyodide', '~') 
      : currentShellCwd;
    if (displayCwd === '') displayCwd = '~';

    if (!isSilent) {
      if (!terminal) initTerminal();
      if (terminal) {
        terminal.write(`\r\x1b[2K\x1b[1;34m${displayCwd}\x1b[32m$ \x1b[0m${cmd}\r\n`);
      }
      socket.emit('output-sync', { action: 'shell_command', cwd: displayCwd, cmd: cmd });
    }

    if (isHost) {
      const worker = getOrInitWorker();
      if (worker) worker.postMessage({ type: 'shell', command: cmd, currentCode: codeTextarea.value, activeFile: currentActiveFile, skipPrompt: skipPrompt });
    } else {
      socket.emit('request-shell-command', { command: cmd, currentCode: codeTextarea.value, activeFile: currentActiveFile, skipPrompt: skipPrompt });
    }
  }

  let renamingPath = null;

  function commitInlineRename(child, newName) {
    const cleanNewName = newName.trim();
    const oldPath = child.path;
    renamingPath = null;
    renamingValue = '';
    renamingCursor = null;
    localRenaming = false;
    socket.emit('tree-rename-end', { path: oldPath });

    if (!cleanNewName || cleanNewName === child.name) {
      renderFilesList();
      return;
    }

    const isFolder = child.isFolder;
    const cleanOldPath = isFolder && child.path.endsWith('/') ? child.path.slice(0, -1) : child.path;
    const pathParts = cleanOldPath.split('/');
    pathParts.pop();
    const parentDir = pathParts.join('/');

    let newPath = parentDir ? `${parentDir}/${cleanNewName}` : cleanNewName;
    if (isFolder) newPath += '/';

    const cleanNewPath = isFolder ? newPath.slice(0, -1) : newPath;
    const cmd = `mv "${cleanOldPath}" "${cleanNewPath}"`;
    sendShellCommand(cmd, { silent: true, skipPrompt: true });

    if (!isFolder) {
      if (unsavedFiles.has(child.path) || unsavedFiles.has(cleanOldPath)) {
        unsavedFiles.delete(child.path);
        unsavedFiles.delete(cleanOldPath);
        unsavedFiles.add(cleanNewPath);
      }
      if (fileSavedContents.has(child.path) || fileSavedContents.has(cleanOldPath)) {
        const val = fileSavedContents.get(child.path) || fileSavedContents.get(cleanOldPath);
        fileSavedContents.delete(child.path);
        fileSavedContents.delete(cleanOldPath);
        fileSavedContents.set(cleanNewPath, val);
      }
      if (tabBufferMap.has(child.path) || tabBufferMap.has(cleanOldPath)) {
        const buf = tabBufferMap.get(child.path) || tabBufferMap.get(cleanOldPath);
        tabBufferMap.delete(child.path);
        tabBufferMap.delete(cleanOldPath);
        tabBufferMap.set(cleanNewPath, buf);
      }
      if (fileUndoHistory.has(child.path) || fileUndoHistory.has(cleanOldPath)) {
        const h = fileUndoHistory.get(child.path) || fileUndoHistory.get(cleanOldPath);
        fileUndoHistory.delete(child.path);
        fileUndoHistory.delete(cleanOldPath);
        fileUndoHistory.set(cleanNewPath, h);
      }
      if (fileRedoHistory.has(child.path) || fileRedoHistory.has(cleanOldPath)) {
        const h = fileRedoHistory.get(child.path) || fileRedoHistory.get(cleanOldPath);
        fileRedoHistory.delete(child.path);
        fileRedoHistory.delete(cleanOldPath);
        fileRedoHistory.set(cleanNewPath, h);
      }

      const openIdx = openTabs.findIndex(t => t === child.path || t === cleanOldPath);
      if (openIdx !== -1) openTabs[openIdx] = cleanNewPath;

      if (currentActiveFile === child.path || currentActiveFile === cleanOldPath) {
        currentActiveFile = cleanNewPath;
      }
      renderTabs();
      socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
    }

    renderFilesList();
  }

  function deleteTreeItem(targetPath, isFolder) {
    const cleanPath = isFolder && targetPath.endsWith('/') ? targetPath.slice(0, -1) : targetPath;
    const pathParts = cleanPath.split('/');
    const itemName = pathParts[pathParts.length - 1];

    if (!confirm(`Are you sure you want to delete ${isFolder ? 'folder' : 'file'} "${itemName}"?`)) return;

    const cmd = isFolder ? `rm -r "${cleanPath}"` : `rm "${cleanPath}"`;
    sendShellCommand(cmd, { silent: true, skipPrompt: true });

    if (!isFolder) {
      openTabs = openTabs.filter(t => t !== targetPath && t !== cleanPath);
      if (openTabs.length === 0) {
        currentActiveFile = '';
        if (codeTextarea) codeTextarea.value = '';
        roomCode = '';
        updateEditorDisplay();
        socket.emit('code-change', { code: roomCode, cursor: null, activeFile: '', openTabs: openTabs });
      } else if (currentActiveFile === targetPath || currentActiveFile === cleanPath) {
        currentActiveFile = openTabs[openTabs.length - 1];
        openFileInTab(currentActiveFile, openTabs);
      } else {
        socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
      }
      renderTabs();
    }
  }

  function saveActiveFile() {
    let filename = currentActiveFile;

    if (!filename || filename === 'Untitled' || filename === 'Untitled.py' || filename.startsWith('Untitled')) {
      const input = prompt('Save file as:', 'untitled.py');
      if (!input || !input.trim()) return;
      filename = input.trim();
    }

    const content = codeTextarea ? codeTextarea.value : roomCode;

    if (isHost) {
      const worker = getOrInitWorker();
      if (worker) {
        worker.postMessage({
          type: 'save_file',
          filename: filename,
          content: content,
          skipPrompt: true
        });
      }
    } else {
      socket.emit('request-shell-command', {
        command: 'touch ' + filename,
        currentCode: content,
        activeFile: filename,
        skipPrompt: true
      });
    }

    const oldFile = currentActiveFile;
    currentActiveFile = filename;

    const tabIdx = openTabs.indexOf(oldFile);
    if (tabIdx !== -1) {
      openTabs[tabIdx] = filename;
    } else if (!openTabs.includes(filename)) {
      openTabs.push(filename);
    }

    if (!shellFiles.includes(filename)) {
      shellFiles.push(filename);
      try { localStorage.setItem('livecode_files', JSON.stringify(shellFiles)); } catch(e){}
    }

    if (oldFile && oldFile !== filename) {
      unsavedFiles.delete(oldFile);
      fileSavedContents.delete(oldFile);
      tabBufferMap.delete(oldFile);
      if (fileUndoHistory.has(oldFile)) {
        fileUndoHistory.set(filename, fileUndoHistory.get(oldFile));
        fileUndoHistory.delete(oldFile);
      }
      if (fileRedoHistory.has(oldFile)) {
        fileRedoHistory.set(filename, fileRedoHistory.get(oldFile));
        fileRedoHistory.delete(oldFile);
      }
    }
    unsavedFiles.delete(filename);
    fileSavedContents.set(filename, content);
    tabBufferMap.set(filename, content);

    renderTabs();
    renderFilesList();
    showToast(`Saved ${filename}`, 'success');
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveActiveFile();
    }
  }, true);

  function handleTreeDrop(sourcePath, targetNode) {
    const fileListContainer = document.getElementById('fileListContainer');
    if (fileListContainer) {
      fileListContainer.classList.remove('root-drag-over');
    }
    if (!sourcePath) return;
    const isSourceFolder = sourcePath.endsWith('/');
    const cleanSource = isSourceFolder ? sourcePath.slice(0, -1) : sourcePath;
    const sourceName = cleanSource.split('/').pop();

    let targetDir = '';
    if (targetNode && targetNode.isFolder) {
      targetDir = targetNode.path.endsWith('/') ? targetNode.path.slice(0, -1) : targetNode.path;
    } else if (targetNode && !targetNode.isFolder) {
      const cleanTarget = targetNode.path;
      const targetParts = cleanTarget.split('/');
      targetParts.pop();
      targetDir = targetParts.join('/');
    } else {
      targetDir = '';
    }

    if (isSourceFolder && targetDir && targetDir.startsWith(cleanSource)) {
      showToast('⚠️ Cannot move a folder into itself!', 'warning');
      return;
    }

    const newPath = targetDir ? `${targetDir}/${sourceName}${isSourceFolder ? '/' : ''}` : `${sourceName}${isSourceFolder ? '/' : ''}`;
    const cleanNewPath = isSourceFolder && newPath.endsWith('/') ? newPath.slice(0, -1) : newPath;

    if (cleanNewPath === cleanSource) return;

    const cmd = `mv "${cleanSource}" "${cleanNewPath}"`;
    sendShellCommand(cmd, { silent: true, skipPrompt: true });

    if (!isSourceFolder) {
      if (unsavedFiles.has(sourcePath) || unsavedFiles.has(cleanSource)) {
        unsavedFiles.delete(sourcePath);
        unsavedFiles.delete(cleanSource);
        unsavedFiles.add(cleanNewPath);
      }
      if (fileSavedContents.has(sourcePath) || fileSavedContents.has(cleanSource)) {
        const val = fileSavedContents.get(sourcePath) || fileSavedContents.get(cleanSource);
        fileSavedContents.delete(sourcePath);
        fileSavedContents.delete(cleanSource);
        fileSavedContents.set(cleanNewPath, val);
      }
      if (tabBufferMap.has(sourcePath) || tabBufferMap.has(cleanSource)) {
        const buf = tabBufferMap.get(sourcePath) || tabBufferMap.get(cleanSource);
        tabBufferMap.delete(sourcePath);
        tabBufferMap.delete(cleanSource);
        tabBufferMap.set(cleanNewPath, buf);
      }
      if (fileUndoHistory.has(sourcePath) || fileUndoHistory.has(cleanSource)) {
        const h = fileUndoHistory.get(sourcePath) || fileUndoHistory.get(cleanSource);
        fileUndoHistory.delete(sourcePath);
        fileUndoHistory.delete(cleanSource);
        fileUndoHistory.set(cleanNewPath, h);
      }
      if (fileRedoHistory.has(sourcePath) || fileRedoHistory.has(cleanSource)) {
        const h = fileRedoHistory.get(sourcePath) || fileRedoHistory.get(cleanSource);
        fileRedoHistory.delete(sourcePath);
        fileRedoHistory.delete(cleanSource);
        fileRedoHistory.set(cleanNewPath, h);
      }

      const openIdx = openTabs.findIndex(t => t === sourcePath || t === cleanOldPath);
      if (openIdx !== -1) openTabs[openIdx] = cleanNewPath;

      if (currentActiveFile === sourcePath || currentActiveFile === cleanSource) {
        currentActiveFile = cleanNewPath;
      }
      renderTabs();
      socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
    }
  }

  function buildFileTree(files) {
    const root = { name: '', isFolder: true, path: '', children: [] };
    const nodeMap = { '': root };

    const sorted = [...files].sort();

    sorted.forEach(filePath => {
      const isFolder = filePath.endsWith('/');
      const cleanPath = isFolder ? filePath.slice(0, -1) : filePath;
      const parts = cleanPath.split('/');

      let currentPath = '';
      let parentNode = root;

      parts.forEach((part, idx) => {
        const isLast = idx === parts.length - 1;
        const itemIsFolder = isLast ? isFolder : true;
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const key = itemIsFolder ? `${currentPath}/` : currentPath;

        if (!nodeMap[key]) {
          const newNode = {
            name: part,
            isFolder: itemIsFolder,
            path: key,
            children: []
          };
          nodeMap[key] = newNode;
          parentNode.children.push(newNode);
        }
        parentNode = nodeMap[key];
      });
    });

    return root;
  }

  function renderTreeNodes(node, container, depth = 0) {
    const normalizedTargetParent = (inlineCreatingItem && inlineCreatingItem.parentFolder !== '/') ? (inlineCreatingItem.parentFolder || '') : '';
    if (inlineCreatingItem && normalizedTargetParent === node.path) {
      const inlineEl = document.createElement('div');
      inlineEl.className = 'user-item inline-create-item';
      inlineEl.style.marginBottom = '2px';
      inlineEl.style.display = 'flex';
      inlineEl.style.alignItems = 'center';
      inlineEl.style.padding = '4px 8px';
      inlineEl.style.paddingLeft = `${depth * 14 + 8}px`;
      inlineEl.style.borderRadius = '4px';

      const isFolder = inlineCreatingItem.type === 'folder';
      const iconHtml = isFolder
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #a78bfa;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #94a3b8;"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;

      const placeholder = isFolder ? 'Folder name...' : 'File name...';
      const initialVal = inlineCreatingItem.value !== undefined ? inlineCreatingItem.value : '';

      inlineEl.innerHTML = `
        <span style="display:inline-block; width: 12px; margin-right: 4px;"></span>
        <div style="margin-right: 6px; display: flex; align-items: center;">${iconHtml}</div>
        <div class="inline-input-wrapper" style="position: relative; flex: 1; display: flex; align-items: center; min-width: 0;">
          <input type="text" class="inline-create-input" value="${escapeHtml(initialVal)}" placeholder="${placeholder}" style="font-family: var(--font-mono); font-size: 0.85rem; background: var(--bg-card, #1e293b); color: var(--text-primary); border: 1px solid var(--accent-primary, #6366f1); border-radius: 3px; padding: 1px 4px; width: 100%; outline: none;" />
        </div>
      `;

      container.appendChild(inlineEl);

      const inputEl = inlineEl.querySelector('.inline-create-input');
      if (inputEl) {
        if (localCreating) {
          setTimeout(() => {
            inputEl.focus();
            if (inputEl.value) {
              const len = inputEl.value.length;
              inputEl.setSelectionRange(len, len);
            }
          }, 0);
        } else if (inlineCreatingItem.cursor) {
          updateInputCursorDisplay(inputEl, inlineCreatingItem.cursor);
        }

        const handleCursorChange = () => {
          if (!localCreating) return;
          const cursor = { start: inputEl.selectionStart, end: inputEl.selectionEnd };
          inlineCreatingItem.cursor = cursor;
          socket.emit('tree-create-cursor', { cursor });
        };

        inputEl.addEventListener('click', (e) => {
          e.stopPropagation();
          handleCursorChange();
        });
        inputEl.addEventListener('keyup', handleCursorChange);
        inputEl.addEventListener('mouseup', handleCursorChange);
        inputEl.addEventListener('select', handleCursorChange);

        inputEl.addEventListener('input', () => {
          if (inlineCreatingItem) {
            inlineCreatingItem.value = inputEl.value;
            const cursor = { start: inputEl.selectionStart, end: inputEl.selectionEnd };
            inlineCreatingItem.cursor = cursor;
            socket.emit('tree-create-input', { value: inputEl.value, cursor });
          }
        });

        inputEl.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commitInlineCreate(inputEl.value);
          } else if (e.key === 'Escape') {
            inlineCreatingItem = null;
            localCreating = false;
            socket.emit('tree-create-end');
            renderFilesList();
          }
        });

        inputEl.addEventListener('blur', () => {
          if (localCreating && inlineCreatingItem) {
            commitInlineCreate(inputEl.value);
          }
        });
      }
    }

    const sortedChildren = [...node.children].sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name);
    });

    sortedChildren.forEach(child => {
      const isRenaming = renamingPath === child.path;
      const el = document.createElement('div');
      el.dataset.path = child.path;
      el.className = 'user-item';
      if (syncedHoveredTreePath === child.path) {
        el.classList.add('is-hovered');
      }
      if (syncedDraggingPath === child.path) {
        el.classList.add('is-dragging');
      }
      if (syncedDragOverPath === child.path) {
        el.classList.add('drag-folder-over');
      }
      el.draggable = !isRenaming;
      el.style.cursor = isRenaming ? 'default' : 'pointer';
      el.style.marginBottom = '2px';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.padding = '4px 8px';
      el.style.paddingLeft = `${depth * 14 + 8}px`;
      el.style.borderRadius = '4px';
      el.style.userSelect = isRenaming ? 'text' : 'none';

      const isSelectedFolder = child.isFolder && selectedFolder === child.path;
      const isActiveFile = !child.isFolder && !selectedFolder && (child.path === currentActiveFile || child.name === currentActiveFile);

      if (isSelectedFolder || isActiveFile) {
        el.style.backgroundColor = 'var(--bg-active, rgba(255,255,255,0.15))';
        el.style.borderLeft = '2px solid var(--accent-primary)';
      }

      const isCollapsed = collapsedFolders.has(child.path);

      let chevronHtml = '';
      if (child.isFolder) {
        const arrow = isCollapsed ? '▸' : '▾';
        chevronHtml = `<span style="display:inline-block; width: 12px; margin-right: 4px; font-size: 0.75rem; color: var(--text-muted);">${arrow}</span>`;
      } else {
        chevronHtml = `<span style="display:inline-block; width: 12px; margin-right: 4px;"></span>`;
      }

      const iconHtml = child.isFolder
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #a78bfa;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: #94a3b8;"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;

      let nameContentHtml = '';
      const isItemUnsaved = !child.isFolder && unsavedFiles.has(child.path);
      const unsavedDotHtml = isItemUnsaved ? '<span class="unsaved-dot" title="Unsaved changes" style="margin-left: 4px; color: var(--accent-amber, #f59e0b); font-size: 1.1rem; line-height: 1;">•</span>' : '';
      if (isRenaming) {
        const displayVal = renamingValue !== undefined && renamingValue !== null && renamingValue !== '' ? renamingValue : child.name;
        nameContentHtml = `
          <div class="inline-input-wrapper" style="position: relative; flex: 1; display: flex; align-items: center; min-width: 0;">
            <input type="text" class="inline-rename-input" value="${escapeHtml(displayVal)}" style="font-family: var(--font-mono); font-size: 0.85rem; background: var(--bg-card, #1e293b); color: var(--text-primary); border: 1px solid var(--accent-primary, #6366f1); border-radius: 3px; padding: 1px 4px; width: 100%; outline: none; user-select: text !important; -webkit-user-select: text !important; cursor: text;" />
          </div>
        `;
      } else {
        nameContentHtml = `<div class="tree-node-name" style="font-family: var(--font-mono); font-size: 0.85rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${child.isFolder ? 'var(--text-primary)' : 'var(--text-muted)'}; display: flex; align-items: center;"><span>${child.name}</span>${unsavedDotHtml}</div>`;
      }

      el.innerHTML = `
        ${chevronHtml}
        <div style="margin-right: 6px; display: flex; align-items: center;">
          ${iconHtml}
        </div>
        ${nameContentHtml}
        <div class="tree-item-actions" style="display: ${isRenaming ? 'none' : 'none'}; gap: 4px; align-items: center; margin-left: 4px;">
          <button class="tree-action-btn rename-btn" title="Rename">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
          <button class="tree-action-btn delete-btn" title="Delete">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      `;

      // Live tree hover sync
      el.addEventListener('mouseenter', () => {
        syncedHoveredTreePath = child.path;
        socket.emit('tree-hover', { path: child.path, isHovered: true });
      });
      el.addEventListener('mouseleave', () => {
        if (syncedHoveredTreePath === child.path) syncedHoveredTreePath = null;
        socket.emit('tree-hover', { path: child.path, isHovered: false });
      });

      if (isRenaming) {
        const inputEl = el.querySelector('.inline-rename-input');
        if (inputEl) {
          inputEl.setAttribute('draggable', 'false');
          if (localRenaming) {
            setTimeout(() => {
              inputEl.focus();
              if (inputEl.value) {
                const len = inputEl.value.length;
                inputEl.setSelectionRange(len, len);
              }
            }, 0);
          } else if (renamingCursor) {
            updateInputCursorDisplay(inputEl, renamingCursor);
          }

          const handleRenameCursor = () => {
            if (!localRenaming) return;
            const cursor = { start: inputEl.selectionStart, end: inputEl.selectionEnd };
            renamingCursor = cursor;
            socket.emit('tree-rename-cursor', { path: child.path, cursor });
          };

          inputEl.addEventListener('click', (e) => {
            e.stopPropagation();
            handleRenameCursor();
          });
          inputEl.addEventListener('mousedown', (e) => e.stopPropagation());
          inputEl.addEventListener('mouseup', (e) => {
            e.stopPropagation();
            handleRenameCursor();
          });
          inputEl.addEventListener('dblclick', (e) => e.stopPropagation());
          inputEl.addEventListener('keyup', handleRenameCursor);
          inputEl.addEventListener('select', handleRenameCursor);

          inputEl.addEventListener('input', () => {
            renamingValue = inputEl.value;
            const cursor = { start: inputEl.selectionStart, end: inputEl.selectionEnd };
            renamingCursor = cursor;
            socket.emit('tree-rename-input', { path: child.path, value: inputEl.value, cursor });
          });

          inputEl.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              commitInlineRename(child, inputEl.value);
            } else if (e.key === 'Escape') {
              renamingPath = null;
              renamingValue = '';
              renamingCursor = null;
              localRenaming = false;
              socket.emit('tree-rename-end', { path: child.path });
              renderFilesList();
            }
          });

          inputEl.addEventListener('blur', () => {
            if (localRenaming && renamingPath === child.path) {
              commitInlineRename(child, inputEl.value);
            }
          });
        }
      }

      // Drag and drop event listeners
      el.addEventListener('dragstart', (e) => {
        if (isRenaming || e.target.closest('.inline-rename-input')) {
          e.preventDefault();
          return;
        }
        e.stopPropagation();
        el.classList.add('is-dragging');
        syncedDraggingPath = child.path;
        socket.emit('tree-drag-start', { path: child.path });
        e.dataTransfer.setData('text/plain', child.path);

        const dragGhost = document.createElement('div');
        dragGhost.style.position = 'absolute';
        dragGhost.style.top = '-9999px';
        dragGhost.style.left = '-9999px';
        dragGhost.style.padding = '3px 8px';
        dragGhost.style.background = '#1e293b';
        dragGhost.style.color = '#f8fafc';
        dragGhost.style.fontSize = '0.78rem';
        dragGhost.style.fontFamily = 'monospace';
        dragGhost.style.borderRadius = '4px';
        dragGhost.style.border = '1px solid #6366f1';
        dragGhost.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.4)';
        dragGhost.style.pointerEvents = 'none';
        dragGhost.style.zIndex = '99999';
        dragGhost.innerText = `${child.isFolder ? '📁' : '📄'} ${child.name}`;
        document.body.appendChild(dragGhost);

        if (e.dataTransfer.setDragImage) {
          e.dataTransfer.setDragImage(dragGhost, 10, 10);
        }

        setTimeout(() => {
          if (dragGhost.parentNode) {
            dragGhost.parentNode.removeChild(dragGhost);
          }
        }, 0);
      });

      el.addEventListener('dragend', () => {
        el.classList.remove('is-dragging');
        syncedDraggingPath = null;
        socket.emit('tree-drag-end');
      });

      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const fileListContainer = document.getElementById('fileListContainer');
        if (child.isFolder) {
          if (fileListContainer) fileListContainer.classList.remove('root-drag-over');
          el.classList.add('drag-folder-over');
          socket.emit('tree-drag-over', { targetPath: child.path, isFolder: true, isRoot: false });
        } else if (fileListContainer) {
          fileListContainer.classList.add('root-drag-over');
          socket.emit('tree-drag-over', { targetPath: null, isFolder: false, isRoot: true });
        }
      });

      el.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        el.classList.remove('drag-folder-over');
        socket.emit('tree-drag-leave', { targetPath: child.path, isRoot: false });
      });

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-folder-over');
        socket.emit('tree-drag-end');
        const sourcePath = e.dataTransfer.getData('text/plain');
        handleTreeDrop(sourcePath, child);
      });

      // Item click event listener
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (child.isFolder) {
          selectedFolder = child.path;
          if (collapsedFolders.has(child.path)) {
            collapsedFolders.delete(child.path);
          } else {
            collapsedFolders.add(child.path);
          }
          renderFilesList();
          emitSidebarState();
          socket.emit('tree-select', { path: selectedFolder });
        } else {
          selectedFolder = '';
          openFileInTab(child.path);
          renderFilesList();
          socket.emit('tree-select', { path: '' });
        }
      });

      // Action button click & hover listeners
      const renameBtn = el.querySelector('.rename-btn');
      const deleteBtn = el.querySelector('.delete-btn');
      const nameEl = el.querySelector('.tree-node-name');

      if (syncedHoveredTreeAction && syncedHoveredTreeAction.path === child.path) {
        if (syncedHoveredTreeAction.action === 'rename' && renameBtn) renameBtn.classList.add('is-hovered');
        if (syncedHoveredTreeAction.action === 'delete' && deleteBtn) deleteBtn.classList.add('is-hovered');
      }

      if (nameEl) {
        nameEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          localRenaming = true;
          renamingPath = child.path;
          renamingValue = child.name;
          renamingCursor = { start: child.name.length, end: child.name.length };
          renderFilesList();
          socket.emit('tree-rename-start', { path: child.path, initialName: child.name, cursor: renamingCursor });
        });
      }

      if (renameBtn) {
        renameBtn.addEventListener('mouseenter', () => {
          socket.emit('tree-action-hover', { path: child.path, action: 'rename', isHovered: true });
        });
        renameBtn.addEventListener('mouseleave', () => {
          socket.emit('tree-action-hover', { path: child.path, action: 'rename', isHovered: false });
        });
        renameBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          localRenaming = true;
          renamingPath = child.path;
          renamingValue = child.name;
          renamingCursor = { start: child.name.length, end: child.name.length };
          renderFilesList();
          socket.emit('tree-rename-start', { path: child.path, initialName: child.name, cursor: renamingCursor });
        });
      }

      if (deleteBtn) {
        deleteBtn.addEventListener('mouseenter', () => {
          socket.emit('tree-action-hover', { path: child.path, action: 'delete', isHovered: true });
        });
        deleteBtn.addEventListener('mouseleave', () => {
          socket.emit('tree-action-hover', { path: child.path, action: 'delete', isHovered: false });
        });
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          socket.emit('tree-action-hover', { path: child.path, action: 'delete', isHovered: false });
          deleteTreeItem(child.path, child.isFolder);
        });
      }

      container.appendChild(el);

      const shouldRenderSubtree = child.isFolder && !isCollapsed && (child.children.length > 0 || (inlineCreatingItem && inlineCreatingItem.parentFolder === child.path));
      if (shouldRenderSubtree) {
        renderTreeNodes(child, container, depth + 1);
      }
    });
  }

  let isContainerDragInit = false;

  function renderFilesList() {
    const fileListContainer = document.getElementById('fileListContainer');
    if (!fileListContainer) return;
    fileListContainer.innerHTML = '';
    if (syncedRootDragOver) {
      fileListContainer.classList.add('root-drag-over');
    }

    if (!isContainerDragInit) {
      isContainerDragInit = true;
      fileListContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        fileListContainer.classList.add('root-drag-over');
        socket.emit('tree-drag-over', { targetPath: null, isFolder: false, isRoot: true });
      });
      fileListContainer.addEventListener('dragleave', (e) => {
        if (e.target === fileListContainer) {
          fileListContainer.classList.remove('root-drag-over');
          socket.emit('tree-drag-leave', { targetPath: null, isRoot: true });
        }
      });
      fileListContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        fileListContainer.classList.remove('root-drag-over');
        socket.emit('tree-drag-end');
        const sourcePath = e.dataTransfer.getData('text/plain');
        if (sourcePath) {
          handleTreeDrop(sourcePath, null);
        }
      });
      const sidebarContent = document.querySelector('.sidebar-content');
      const handleEmptyTreeClick = (e) => {
        if (!e.target.closest('.user-item') && !e.target.closest('#createFileBtn') && !e.target.closest('#createFolderBtn')) {
          if (selectedFolder) {
            selectedFolder = '';
            renderFilesList();
            socket.emit('tree-select', { path: '' });
          }
        }
      };

      fileListContainer.addEventListener('click', handleEmptyTreeClick);
      if (sidebarContent) sidebarContent.addEventListener('click', handleEmptyTreeClick);

      window.addEventListener('click', (e) => {
        if (!e.target.closest('#sidebar') && !e.target.closest('#createFileBtn') && !e.target.closest('#createFolderBtn')) {
          if (selectedFolder) {
            selectedFolder = '';
            renderFilesList();
            socket.emit('tree-select', { path: '' });
          }
        }
      });
    }

    if ((!shellFiles || shellFiles.length === 0) && !inlineCreatingItem) {
      fileListContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 4px;">No files</div>';
      return;
    }

    const tree = buildFileTree(shellFiles || []);
    renderTreeNodes(tree, fileListContainer, 0);
  }

  function renderShellInput(buffer) {
    if (!buffer) return '';
    const matchArgs = (str) => {
      const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
      const matches = str.match(regex) || [];
      return matches.map(m => {
        if ((m.startsWith('"') && m.endsWith('"')) || (m.startsWith("'") && m.endsWith("'"))) {
          return m.slice(1, -1);
        }
        return m;
      });
    };
    const parts = matchArgs(buffer);
    const command = parts[0] ? parts[0].trim() : '';
    let result = '';
    
    if (command) {
      if (shellCommands.includes(command)) {
        result += '\x1b[32m' + command + '\x1b[0m'; // Green
      } else {
        result += '\x1b[31m' + command + '\x1b[0m'; // Red
      }
    }
    
    const spaceIndex = buffer.indexOf(' ');
    if (spaceIndex !== -1) {
      result += '\x1b[37m' + buffer.substring(spaceIndex) + '\x1b[0m'; // White
    }
    
    return result;
  }

  function redrawShellLine() {
    if (!terminal) return;
    let displayCwd = currentShellCwd.startsWith('/home/pyodide') 
      ? currentShellCwd.replace('/home/pyodide', '~') 
      : currentShellCwd;
    if (displayCwd === '') displayCwd = '~';
    const promptFormatted = `\x1b[1;34m${displayCwd}\x1b[32m$ \x1b[0m`;
    terminal.write(`\r\x1b[2K${promptFormatted}${renderShellInput(currentTerminalInputBuffer)}`);
  }

  function startShellMode() {
    isShellMode = true;
    isTerminalExpectingInput = true;
    currentTerminalInputBuffer = '';
    
    // Replace /home/pyodide with ~ for aesthetic
    let displayCwd = currentShellCwd.startsWith('/home/pyodide') 
      ? currentShellCwd.replace('/home/pyodide', '~') 
      : currentShellCwd;
    if (displayCwd === '') displayCwd = '~';

    const promptFormatted = `\x1b[1;34m${displayCwd}\x1b[32m$ \x1b[0m`;
    
    if (!terminal) initTerminal();
    terminal.write(promptFormatted);
    
    socket.emit('output-sync', { action: 'shell_prompt', text: `${displayCwd}$ ` });
    showConsoleInput();
  }

  function initTerminal() {
    if (terminal) return;
    consoleOutput.innerHTML = ''; // Clear default HTML
    terminal = new Terminal({
      cursorBlink: true,
      theme: {
        background: '#12151e',
        foreground: '#f8fafc',
        cursor: '#a78bfa'
      },
      fontFamily: "'Fira Code', 'Consolas', monospace",
      fontSize: 14,
      convertEol: true
    });
    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(consoleOutput);
    
    // Slight delay to ensure DOM is fully rendered before fitting
    setTimeout(() => { 
      if (fitAddon) fitAddon.fit(); 
      attachTerminalScrollSync();
    }, 10);
    
    window.addEventListener('resize', () => {
      if (fitAddon) fitAddon.fit();
    });

    terminal.onData((data) => {
      if (!isTerminalExpectingInput) return;
      
      if (data === '\r') {
        const rawText = currentTerminalInputBuffer;
        const text = rawText.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
        isTerminalExpectingInput = false;
        currentTerminalInputBuffer = '';
        
        terminal.write('\r\n');
        
        if (isShellMode) {
          isShellMode = false;
          if (text) {
            shellHistory.push(text);
            shellHistoryIndex = -1;
          }
          if (text === 'clear') {
            terminal.reset();
            socket.emit('output-sync', { action: 'clear', shell: true });
            startShellMode();
            return;
          }
          if (!isPyodideReady && isHost) {
            updateOutputStatus('system', '⚡ Initializing Console...');
          }
          let displayCwd = currentShellCwd.startsWith('/home/pyodide') 
            ? currentShellCwd.replace('/home/pyodide', '~') 
            : currentShellCwd;
          if (displayCwd === '') displayCwd = '~';
          socket.emit('output-sync', { action: 'shell_command', cwd: displayCwd, cmd: text });
          socket.emit('output-sync', { action: 'input_resolved', text: text });
          if (isHost) {
            const worker = getOrInitWorker();
            if (worker) {
              worker.postMessage({ type: 'shell', command: text, currentCode: codeTextarea.value, activeFile: currentActiveFile });
            }
          } else {
            socket.emit('request-shell-command', { command: text, currentCode: codeTextarea.value, activeFile: currentActiveFile });
          }
        } else {
          // Broadcast that input is resolved
          socket.emit('output-sync', { action: 'input_resolved', text: text });
          socket.emit('provide-input', { text: text + '\n' });
        }
      } else if (data === '\u007F') { // Backspace
        if (currentTerminalInputBuffer.length > 0) {
          if (isShellMode) {
            currentTerminalInputBuffer = currentTerminalInputBuffer.slice(0, -1);
            redrawShellLine();
            socket.emit('output-sync', { action: 'terminal_input', buffer: currentTerminalInputBuffer, isShellMode: true, cwd: currentShellCwd });
          } else {
            currentTerminalInputBuffer = currentTerminalInputBuffer.slice(0, -1);
            terminal.write('\b \b');
            socket.emit('output-sync', { action: 'terminal_input', buffer: currentTerminalInputBuffer, isShellMode: false, diff: '\b \b' });
          }
        }
      } else if (data === '\t') { // Tab auto-completion
        if (isShellMode) {
          const buffer = currentTerminalInputBuffer;
          const matchArgs = (str) => {
            const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
            return str.match(regex) || [];
          };
          const rawParts = matchArgs(buffer);
          
          if (rawParts.length === 0 || (!buffer.endsWith(' ') && rawParts.length === 1)) {
            const prefix = rawParts[0] || '';
            const match = shellCommands.find(c => c.startsWith(prefix));
            if (match && match !== prefix) {
              currentTerminalInputBuffer = match + ' ';
              redrawShellLine();
              socket.emit('output-sync', { action: 'terminal_input', buffer: currentTerminalInputBuffer, isShellMode: true, cwd: currentShellCwd });
            }
          } else {
            const endsWithSpace = buffer.endsWith(' ');
            const lastPart = endsWithSpace ? '' : rawParts[rawParts.length - 1].replace(/^["']|["']$/g, '');
            const candidates = (shellFiles || []).map(f => f.endsWith('/') ? f.slice(0, -1) : f);
            const match = candidates.find(f => f.startsWith(lastPart));
            if (match && match !== lastPart) {
              if (endsWithSpace) {
                currentTerminalInputBuffer = buffer + (match.includes(' ') ? `"${match}"` : match);
              } else {
                const prefixBuffer = buffer.slice(0, buffer.lastIndexOf(rawParts[rawParts.length - 1]));
                currentTerminalInputBuffer = prefixBuffer + (match.includes(' ') ? `"${match}"` : match);
              }
              redrawShellLine();
              socket.emit('output-sync', { action: 'terminal_input', buffer: currentTerminalInputBuffer, isShellMode: true, cwd: currentShellCwd });
            }
          }
        }
      } else if (data === '\x1b[A' || data === '\x1b[B') { // Arrow Up / Down
        if (isShellMode && shellHistory.length > 0) {
          if (data === '\x1b[A') { // Up
            shellHistoryIndex = Math.min(shellHistory.length - 1, shellHistoryIndex + 1);
          } else { // Down
            shellHistoryIndex = Math.max(-1, shellHistoryIndex - 1);
          }
          currentTerminalInputBuffer = shellHistoryIndex >= 0 ? shellHistory[shellHistory.length - 1 - shellHistoryIndex] : '';
          redrawShellLine();
          socket.emit('output-sync', { action: 'terminal_input', buffer: currentTerminalInputBuffer, isShellMode: true, cwd: currentShellCwd });
        }
      } else if (data === '\x03') { // Ctrl+C
        if (isShellMode) {
          terminal.write('\x1b[35m^C\x1b[0m\r\n');
          currentTerminalInputBuffer = '';
          redrawShellLine();
          socket.emit('output-sync', { action: 'terminal_input', buffer: '', isShellMode: true, cwd: currentShellCwd, ctrlC: true });
        }
      } else if (data === '\x15') { // Ctrl+U
        if (isShellMode && currentTerminalInputBuffer.length > 0) {
          currentTerminalInputBuffer = '';
          redrawShellLine();
          socket.emit('output-sync', { action: 'terminal_input', buffer: '', isShellMode: true, cwd: currentShellCwd });
        }
      } else {
        if (!data.startsWith('\x1b') && data.charCodeAt(0) >= 32) {
          if (isShellMode) {
            currentTerminalInputBuffer += data;
            redrawShellLine();
            socket.emit('output-sync', { action: 'terminal_input', buffer: currentTerminalInputBuffer, isShellMode: true, cwd: currentShellCwd });
          } else {
            currentTerminalInputBuffer += data;
            terminal.write('\x1b[35m' + data + '\x1b[0m');
            socket.emit('output-sync', { action: 'terminal_input', buffer: currentTerminalInputBuffer, isShellMode: false, char: data });
          }
        }
      }
    });
  }

  function appendConsoleLine(type, text, isRemote = false) {
    if (text === undefined || text === null || text === '') return;
    if (!terminal) initTerminal();
    
    let colorPrefix = '';
    let colorSuffix = '\x1b[0m';
    if (type === 'error') colorPrefix = '\x1b[31m'; // Red
    else if (type === 'system') colorPrefix = '\x1b[36m'; // Cyan
    else if (type === 'warn') colorPrefix = '\x1b[33m'; // Yellow
    else if (type === 'success') colorPrefix = '\x1b[32m'; // Green
    else if (type === 'input-echo') colorPrefix = '\x1b[35m'; // Magenta

    // Add \r\n explicitly because Pyodide stdout was treated as a div block previously
    const formatted = colorPrefix + text.replace(/\n/g, '\r\n') + colorSuffix + '\r\n';
    terminal.write(formatted);

    if (!isRemote) {
      socket.emit('output-sync', { action: 'append', type: type, text: text });
    }
  }

  function hideConsoleInput() {
    isTerminalExpectingInput = false;
    currentTerminalInputBuffer = '';
  }

  function showConsoleInput() {
    if (!terminal) initTerminal();
    
    if (outputDrawer) {
      outputDrawer.classList.remove('collapsed');
      updateConsoleButtonsState();
    }
    if (consoleOutput) consoleOutput.classList.remove('hidden');
    
    isTerminalExpectingInput = true;
    currentTerminalInputBuffer = '';
    
    // Ensure terminal is properly sized when shown
    setTimeout(() => { 
      if (fitAddon) fitAddon.fit(); 
      const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      if (!isTouch && terminal && document.activeElement !== codeTextarea) {
        terminal.focus();
      }
    }, 50);
  }

  // Initialize terminal on boot immediately
  initTerminal();

  const copyConsoleBtn = document.getElementById('copyConsoleBtn');
  let copyConsoleBtnResetTimer = null;
  const originalCopyConsoleHTML = copyConsoleBtn ? copyConsoleBtn.innerHTML : '';

  function triggerConsoleCopyTick(emit = true) {
    if (!copyConsoleBtn) return;
    if (copyConsoleBtnResetTimer) {
      clearTimeout(copyConsoleBtnResetTimer);
    }
    copyConsoleBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    copyConsoleBtn.classList.add('btn-copied');

    copyConsoleBtnResetTimer = setTimeout(() => {
      copyConsoleBtn.innerHTML = originalCopyConsoleHTML;
      copyConsoleBtn.classList.remove('btn-copied');
      copyConsoleBtnResetTimer = null;
    }, 3000);

    if (emit) {
      socket.emit('console-copy-tick');
    }
  }

  if (copyConsoleBtn) {
    copyConsoleBtn.addEventListener('click', () => {
      if (isExamMode && !isHost) {
        showToast('⚠️ Copying console output is disabled during Exam Mode.', 'warning');
        return;
      }
      let outputText = '';
      if (terminal) {
        // Extract plain text from entire terminal active buffer
        const buffer = terminal.buffer.active;
        const lines = [];
        for (let i = 0; i < buffer.length; i++) {
          const line = buffer.getLine(i);
          if (line) {
            lines.push(line.translateToString(true));
          }
        }
        outputText = lines.join('\n').trimEnd();
      }
      if (!outputText && consoleOutput) {
        outputText = (consoleOutput.innerText || consoleOutput.textContent || '').trim();
      }
      if (!outputText) {
        showToast('Console output is empty.', 'warning');
        return;
      }
      navigator.clipboard.writeText(outputText).then(() => {
        triggerConsoleCopyTick(true);
      }).catch(() => {
        showToast('Failed to copy terminal output.', 'warning');
      });
    });
  }

  document.getElementById('clearConsoleBtn').addEventListener('click', () => {
    if (terminal) {
      terminal.reset();
      terminal.write('\x1b[36m[Cleared]\x1b[0m\r\n');
    }
    updateOutputStatus('hidden');
    socket.emit('output-sync', { action: 'clear', message: '[Cleared]' });
  });

  // Expand and Shrink Console Controls
  function updateConsoleButtonsState() {
    if (!outputDrawer) return;
    const isCollapsed = outputDrawer.classList.contains('collapsed');
    const isExpanded = outputDrawer.classList.contains('expanded');

    const expandBtn = document.getElementById('expandConsoleBtn');
    if (expandBtn) {
      const expandIcon = expandBtn.querySelector('.icon-expand');
      const shrinkIcon = expandBtn.querySelector('.icon-shrink');
      if (isExpanded) {
        expandBtn.title = 'Shrink Console';
        if (expandIcon) expandIcon.style.display = 'none';
        if (shrinkIcon) shrinkIcon.style.display = 'block';
      } else {
        expandBtn.title = 'Expand Console';
        if (expandIcon) expandIcon.style.display = 'block';
        if (shrinkIcon) shrinkIcon.style.display = 'none';
      }
    }

    const collapseBtn = document.getElementById('collapseConsoleBtn');
    if (collapseBtn) {
      const collapseIcon = collapseBtn.querySelector('.icon-collapse');
      const uncollapseIcon = collapseBtn.querySelector('.icon-uncollapse');
      if (isCollapsed) {
        collapseBtn.title = 'Expand Console';
        if (collapseIcon) collapseIcon.style.display = 'none';
        if (uncollapseIcon) uncollapseIcon.style.display = 'block';
      } else {
        collapseBtn.title = 'Collapse Console';
        if (collapseIcon) collapseIcon.style.display = 'block';
        if (uncollapseIcon) uncollapseIcon.style.display = 'none';
      }
    }
  }

  const expandConsoleBtn = document.getElementById('expandConsoleBtn');
  if (expandConsoleBtn) {
    expandConsoleBtn.addEventListener('click', () => {
      if (!outputDrawer) return;
      let expanded, collapsed;
      if (outputDrawer.classList.contains('expanded')) {
        // Shrink back to default height
        outputDrawer.classList.remove('expanded');
        outputDrawer.style.height = '';
        expanded = false;
        collapsed = false;
      } else {
        // Expand console
        outputDrawer.classList.remove('collapsed');
        outputDrawer.classList.add('expanded');
        outputDrawer.style.height = '';
        expanded = true;
        collapsed = false;
      }
      updateConsoleButtonsState();
      socket.emit('console-toggle', { collapsed, expanded, height: null });
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
      }, 260);
    });
  }

  const collapseConsoleBtn = document.getElementById('collapseConsoleBtn');
  if (collapseConsoleBtn) {
    collapseConsoleBtn.addEventListener('click', () => {
      if (!outputDrawer) return;
      let collapsed, expanded;
      if (outputDrawer.classList.contains('collapsed')) {
        outputDrawer.classList.remove('collapsed');
        collapsed = false;
        expanded = outputDrawer.classList.contains('expanded');
      } else {
        outputDrawer.classList.remove('expanded');
        outputDrawer.classList.add('collapsed');
        outputDrawer.style.height = '';
        collapsed = true;
        expanded = false;
      }
      updateConsoleButtonsState();
      socket.emit('console-toggle', { collapsed, expanded, height: null });
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
      }, 260);
    });
  }

  const outputTitle = document.querySelector('.output-title');
  if (outputTitle) {
    outputTitle.addEventListener('click', (e) => {
      if (!outputDrawer) return;
      outputDrawer.classList.toggle('collapsed');
      const collapsed = outputDrawer.classList.contains('collapsed');
      let expanded = false;
      if (collapsed) {
        outputDrawer.classList.remove('expanded');
        outputDrawer.style.height = '';
      } else {
        expanded = outputDrawer.classList.contains('expanded');
      }
      updateConsoleButtonsState();
      socket.emit('console-toggle', { collapsed, expanded, height: null });
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
      }, 260);
    });
  }

  // Draggable Resizer to expand and shrink console height
  const consoleResizer = document.getElementById('consoleResizer');
  if (consoleResizer && outputDrawer) {
    let isDraggingResizer = false;
    let startY = 0;
    let startHeight = 0;
    let lastConsoleResizeEmitTime = 0;

    const startConsoleResize = (clientY) => {
      // Dismiss any active keyboard on mobile / touch
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      if (codeTextarea) {
        codeTextarea.blur();
      }
      isDraggingResizer = true;
      startY = clientY;
      startHeight = outputDrawer.offsetHeight;
      outputDrawer.style.transition = 'none';
      if (currentUser?.color) {
        consoleResizer.style.setProperty('--resizer-color', currentUser.color);
      }
      consoleResizer.classList.add('is-dragging');
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      socket.emit('console-drag', { isDragging: true, color: currentUser?.color });
    };

    const updateConsoleResize = (clientY) => {
      if (!isDraggingResizer) return;
      const dy = startY - clientY;
      const editorSection = document.querySelector('.editor-section');
      const maxH = editorSection ? (editorSection.clientHeight - 60) : 600;
      let newH = startHeight + dy;
      if (newH < 32) newH = 32;
      if (newH > maxH) newH = maxH;

      outputDrawer.classList.remove('expanded');
      const isCollapsed = newH <= 40;
      if (isCollapsed) {
        outputDrawer.classList.add('collapsed');
      } else {
        outputDrawer.classList.remove('collapsed');
      }
      outputDrawer.style.height = `${newH}px`;
      updateConsoleButtonsState();
      if (fitAddon) fitAddon.fit();

      const now = Date.now();
      if (now - lastConsoleResizeEmitTime > 35) {
        lastConsoleResizeEmitTime = now;
        socket.emit('console-toggle', {
          collapsed: isCollapsed,
          expanded: false,
          height: newH,
          isDragging: true,
          color: currentUser?.color
        });
      }
    };

    const endConsoleResize = () => {
      if (!isDraggingResizer) return;
      isDraggingResizer = false;
      outputDrawer.style.transition = '';
      consoleResizer.classList.remove('is-dragging');
      consoleResizer.style.removeProperty('--resizer-color');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (fitAddon) fitAddon.fit();

      const isCollapsed = outputDrawer.classList.contains('collapsed');
      const finalH = isCollapsed ? 32 : outputDrawer.offsetHeight;
      socket.emit('console-drag', { isDragging: false, color: currentUser?.color });
      socket.emit('console-toggle', {
        collapsed: isCollapsed,
        expanded: false,
        height: finalH,
        isDragging: false,
        color: currentUser?.color
      });
    };

    // Mouse Events
    consoleResizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startConsoleResize(e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
      updateConsoleResize(e.clientY);
    });

    window.addEventListener('mouseup', () => {
      endConsoleResize();
    });

    // Touch Events for Mobile & Tablet
    consoleResizer.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length > 0) {
        e.preventDefault();
        startConsoleResize(e.touches[0].clientY);
      }
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (!isDraggingResizer) return;
      if (e.touches && e.touches.length > 0) {
        e.preventDefault();
        updateConsoleResize(e.touches[0].clientY);
      }
    }, { passive: false });

    window.addEventListener('touchend', () => {
      endConsoleResize();
    });

    window.addEventListener('touchcancel', () => {
      endConsoleResize();
    });
  }

  updateConsoleButtonsState();

  // On mobile screens, when the user taps on the console/terminal, the virtual keyboard
  // pops up and can obscure the console drawer. Scroll outputDrawer into view smoothly.
  function scrollConsoleIntoViewForKeyboard() {
    const isMobile = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    if (!isMobile || !outputDrawer) return;

    if (outputDrawer.classList.contains('collapsed')) {
      outputDrawer.classList.remove('collapsed');
      updateConsoleButtonsState();
    }

    outputDrawer.classList.add('mobile-focused');

    const doScroll = () => {
      if (!outputDrawer) return;
      try {
        outputDrawer.scrollIntoView({ behavior: 'smooth', block: 'end' });
      } catch (e) {
        outputDrawer.scrollIntoView(false);
      }
      if (fitAddon) {
        try { fitAddon.fit(); } catch(e){}
      }
    };

    // Staggered scroll execution to adapt to mobile virtual keyboard opening animation
    doScroll();
    setTimeout(doScroll, 120);
    setTimeout(doScroll, 300);
    setTimeout(doScroll, 500);
  }

  if (outputDrawer) {
    // Listen for focusin on terminal helper textarea or outputDrawer
    outputDrawer.addEventListener('focusin', (e) => {
      scrollConsoleIntoViewForKeyboard();
    });

    // Touch/pointer on the terminal area
    outputDrawer.addEventListener('pointerup', (e) => {
      // Do not trigger if interacting with header action buttons (copy, clear, collapse, expand)
      if (e.target.closest('.output-actions') || e.target.closest('.console-resizer')) {
        return;
      }
      scrollConsoleIntoViewForKeyboard();
    });
  }

  // VisualViewport resize listener for mobile soft keyboard
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const isMobile = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
      if (!isMobile || !outputDrawer) return;

      const activeEl = document.activeElement;
      const isConsoleFocused = activeEl && outputDrawer.contains(activeEl);
      if (isConsoleFocused) {
        scrollConsoleIntoViewForKeyboard();
      }
    });
  }

  // Remove mobile-focused class when clicking or tapping outside outputDrawer
  document.addEventListener('pointerdown', (e) => {
    if (outputDrawer && !outputDrawer.contains(e.target)) {
      outputDrawer.classList.remove('mobile-focused');
    }
  });

  // Real-time terminal/console output scrolling synchronization
  let isRemoteOutputScroll = false;
  let lastOutputScrollEmitTime = 0;
  let attachedScrollListener = false;

  function attachTerminalScrollSync() {
    if (!consoleOutput) return;
    const viewport = consoleOutput.querySelector('.xterm-viewport');
    if (viewport && !viewport._hasSyncListener) {
      viewport._hasSyncListener = true;
      viewport.addEventListener('scroll', () => {
        if (isRemoteOutputScroll) return;
        const now = Date.now();
        if (now - lastOutputScrollEmitTime < 30) return;
        lastOutputScrollEmitTime = now;
        const line = (terminal && terminal.buffer && terminal.buffer.active) ? terminal.buffer.active.viewportY : 0;
        socket.emit('output-scroll-sync', {
          line: line,
          top: viewport.scrollTop
        });
      }, { passive: true });
    }
  }

  if (consoleOutput) {
    consoleOutput.addEventListener('scroll', () => {
      if (!isRemoteOutputScroll) {
        const now = Date.now();
        if (now - lastOutputScrollEmitTime < 30) return;
        lastOutputScrollEmitTime = now;
        socket.emit('output-scroll-sync', { top: consoleOutput.scrollTop });
      }
    }, { passive: true });
  }

  // --------------------------------------------------------------------------
  // 6. UI Drawers, Share & Chat Logic
  // --------------------------------------------------------------------------

  // Copy Room Link (Allowed even if live code sharing is off)
  let roomCopyResetTimer = null;
  function handleRoomChipCopy(e) {
    const copyIcon = e.target.closest('.copy-icon');
    if (!copyIcon) {
      return;
    }
    const shareUrl = window.location.href;
    navigator.clipboard.writeText(shareUrl).then(() => {
      if (roomCopyResetTimer) {
        clearTimeout(roomCopyResetTimer);
      }
      document.querySelectorAll('.copy-icon').forEach(icon => {
        if (icon.id === 'roomCopyIcon' || icon.id === 'settingsRoomCopyIcon') {
          icon.classList.add('copy-success');
        }
      });
      roomCopyResetTimer = setTimeout(() => {
        document.querySelectorAll('.copy-icon').forEach(icon => {
          if (icon.id === 'roomCopyIcon' || icon.id === 'settingsRoomCopyIcon') {
            icon.classList.remove('copy-success');
          }
        });
        roomCopyResetTimer = null;
      }, 3000);
      showToast('Share link copied to clipboard!');
    }).catch(() => {
      showToast(`Share URL: ${shareUrl}`);
    });
  }

  if (roomShareBtn) {
    roomShareBtn.addEventListener('click', handleRoomChipCopy);
  }
  if (settingsRoomShareBtn) {
    settingsRoomShareBtn.addEventListener('click', handleRoomChipCopy);
  }

  // Sidebar Tabs
  const sidebarTabs = document.querySelectorAll('.sidebar-tab');
  sidebarTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      sidebarTabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      
      tab.classList.add('active');
      const targetPanel = tab.dataset.tab === 'users' ? 'panelUsers' : 'panelUsers';
      const el = document.getElementById(targetPanel);
      if (el) el.classList.add('active');
    });
  });

  // Sidebar Header & Nav Toggle Controls
  const sidebarCollapseBtn = document.getElementById('sidebarCollapseBtn');
  const sidebarExpandBtn = document.getElementById('sidebarExpandBtn');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const workspaceContainer = document.querySelector('.workspace');

  function emitSidebarState() {
    const isCollapsed = sidebar ? sidebar.classList.contains('collapsed') : false;
    socket.emit('sidebar-toggle', {
      collapsed: isCollapsed,
      collapsedFolders: Array.from(collapsedFolders)
    });
  }

  function updateMobileDrawerBackdrop() {
    if (!sidebarBackdrop) return;
    const isMobile = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    const sidebarOpen = sidebar && !sidebar.classList.contains('collapsed');
    const chatOpen = chatDrawer && !chatDrawer.classList.contains('collapsed');
    if (isMobile && (sidebarOpen || chatOpen)) {
      sidebarBackdrop.classList.add('active');
    } else {
      sidebarBackdrop.classList.remove('active');
    }
  }

  function updateSidebarToggleState() {
    const isCollapsed = sidebar ? sidebar.classList.contains('collapsed') : false;
    if (workspaceContainer) {
      if (isCollapsed) workspaceContainer.classList.add('has-collapsed-sidebar');
      else workspaceContainer.classList.remove('has-collapsed-sidebar');
    }
    if (sidebarExpandBtn) {
      if (isCollapsed) {
        sidebarExpandBtn.classList.remove('hidden');
      } else {
        sidebarExpandBtn.classList.add('hidden');
      }
    }
    updateMobileDrawerBackdrop();
  }

  function updateChatDrawerToggleState() {
    const isCollapsed = chatDrawer.classList.contains('collapsed');
    if (workspaceContainer) {
      if (isCollapsed) workspaceContainer.classList.add('has-collapsed-chat');
      else workspaceContainer.classList.remove('has-collapsed-chat');
    }
    if (chatDrawerExpandBtn) {
      if (isCollapsed) {
        chatDrawerExpandBtn.classList.remove('hidden');
      } else {
        chatDrawerExpandBtn.classList.add('hidden');
      }
    }
    updateMobileDrawerBackdrop();
  }

  if (sidebarCollapseBtn) {
    sidebarCollapseBtn.addEventListener('click', () => {
      sidebar.classList.add('collapsed');
      updateSidebarToggleState();
      emitSidebarState();
    });
  }

  if (sidebarExpandBtn) {
    sidebarExpandBtn.addEventListener('click', () => {
      sidebar.classList.remove('collapsed');
      updateSidebarToggleState();
      emitSidebarState();
    });
  }

  // Unified dismiss handler for mobile drawers (sidebar and chat drawer)
  function dismissMobileDrawers(e) {
    const isMobile = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    if (!isMobile) return;

    const sidebarOpen = sidebar && !sidebar.classList.contains('collapsed');
    const chatOpen = chatDrawer && !chatDrawer.classList.contains('collapsed');
    if (!sidebarOpen && !chatOpen) return;

    // Do not dismiss if interacting with a modal dialog, toast, or dropdown menu
    if (e.target.closest('.modal-overlay') || e.target.closest('.modal-card') || e.target.closest('.toast-container') || e.target.closest('.user-menu-dropdown')) {
      return;
    }

    // Do not dismiss if interacting with open sidebar or open chat drawer
    if (sidebarOpen && e.target.closest('#sidebar')) {
      return;
    }
    if (chatOpen && e.target.closest('#chatDrawer')) {
      return;
    }

    // Do not dismiss if clicking drawer toggle buttons
    if (e.target.closest('#sidebarExpandBtn, #sidebarCollapseBtn, #toggleFilesBtn, #toggleUsersBtn, #chatDrawerExpandBtn, #closeChatBtn, #toggleChatBtn')) {
      return;
    }

    // Prevent default and stop propagation to prevent focusing editor or summoning keyboard
    if (e.cancelable) {
      e.preventDefault();
    }
    e.stopPropagation();

    // Blur active elements to guarantee virtual keyboard stays closed
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    if (codeTextarea && typeof codeTextarea.blur === 'function') {
      codeTextarea.blur();
    }

    if (sidebarOpen) {
      sidebar.classList.add('collapsed');
      updateSidebarToggleState();
      emitSidebarState();
    }

    if (chatOpen) {
      chatDrawer.classList.add('collapsed');
      updateChatDrawerToggleState();
      emitChatDrawerState();
    }
  }

  // Close drawers when clicking mobile backdrop
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('pointerdown', dismissMobileDrawers, { passive: false });
    sidebarBackdrop.addEventListener('touchstart', dismissMobileDrawers, { passive: false });
    sidebarBackdrop.addEventListener('click', dismissMobileDrawers);
  }

  // Close drawers on mobile when tapping or clicking outside
  document.addEventListener('pointerdown', dismissMobileDrawers, { passive: false });
  document.addEventListener('touchstart', dismissMobileDrawers, { passive: false });

  if (toggleFilesBtn) {
    toggleFilesBtn.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      updateSidebarToggleState();
      emitSidebarState();
    });
  }

  if (toggleUsersBtn) {
    toggleUsersBtn.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      updateSidebarToggleState();
      emitSidebarState();
    });
  }

  function emitChatDrawerState() {
    const isCollapsed = chatDrawer ? chatDrawer.classList.contains('collapsed') : false;
    socket.emit('chat-drawer-toggle', { collapsed: isCollapsed });
  }

  // Chat Header & Nav Toggle Controls
  if (toggleChatBtn) {
    toggleChatBtn.addEventListener('click', () => {
      chatDrawer.classList.toggle('collapsed');
      updateChatDrawerToggleState();
      emitChatDrawerState();
    });
  }

  const closeChatBtn = document.getElementById('closeChatBtn');
  if (closeChatBtn) {
    closeChatBtn.addEventListener('click', () => {
      chatDrawer.classList.add('collapsed');
      updateChatDrawerToggleState();
      emitChatDrawerState();
    });
  }

  if (chatDrawerExpandBtn) {
    chatDrawerExpandBtn.addEventListener('click', () => {
      chatDrawer.classList.remove('collapsed');
      updateChatDrawerToggleState();
      emitChatDrawerState();
    });
  }
  
  // Add global click listener for dropdowns
  document.addEventListener('click', (e) => {
    if (settingsBtn && settingsDropdown) {
      if (!settingsBtn.contains(e.target) && !settingsDropdown.contains(e.target)) {
        settingsDropdown.classList.add('hidden');
      }
    }
    const timerWidget = document.getElementById('timerWidgetWrapper');
    const timerDropdownEl = document.getElementById('timerDropdown');
    if (timerWidget && timerDropdownEl) {
      if (!timerWidget.contains(e.target) && !timerDropdownEl.classList.contains('hidden')) {
        if (typeof setTimerDropdownOpen === 'function') {
          setTimerDropdownOpen(false, true);
        } else {
          timerDropdownEl.classList.add('hidden');
        }
      }
    }
    if (profileBtn && profileDropdown) {
      if (!profileBtn.contains(e.target) && !profileDropdown.contains(e.target)) {
        profileDropdown.classList.add('hidden');
      }
    }
  });

  if (profileBtn) {
    profileBtn.addEventListener('click', () => {
      profileDropdown.classList.toggle('hidden');
      if (settingsDropdown) settingsDropdown.classList.add('hidden');
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      settingsDropdown.classList.toggle('hidden');
      if (profileDropdown) profileDropdown.classList.add('hidden');
    });
  }

  // Automatically hide sidebars on small screens
  const mql = window.matchMedia('(max-width: 768px)');
  function handleScreenChange(e) {
    if (e.matches) {
      if (sidebar) sidebar.classList.add('collapsed');
      if (chatDrawer) chatDrawer.classList.add('collapsed');
    } else {
      if (sidebar) sidebar.classList.remove('collapsed');
      if (chatDrawer) chatDrawer.classList.remove('collapsed');
      if (protectionPanel) protectionPanel.classList.remove('show');
    }
    updateSidebarToggleState();
    updateChatDrawerToggleState();
  }
  mql.addEventListener('change', handleScreenChange);
  handleScreenChange(mql);

  // Chat Send
  function updateSendChatBtnState() {
    if (sendChatBtn && chatInput) {
      sendChatBtn.disabled = chatInput.value.trim().length === 0;
    }
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (text) {
      socket.emit('send-chat', { text });
      chatInput.value = '';
      updateSendChatBtnState();
    }
  }

  if (sendChatBtn) {
    sendChatBtn.addEventListener('click', sendChatMessage);
  }
  
  // Drawer Tab Switching (Chat & Activity)
  const drawerTabChatBtn = document.getElementById('drawerTabChatBtn');
  const drawerTabActivityBtn = document.getElementById('drawerTabActivityBtn');
  const panelChat = document.getElementById('panelChat');
  const panelActivity = document.getElementById('panelActivity');
  const chatUnreadBadge = document.getElementById('chatUnreadBadge');
  const activityUnreadBadge = document.getElementById('activityUnreadBadge');
  const activityMessages = document.getElementById('activityMessages');

  let activeDrawerTab = 'chat';
  let unreadChatCount = 0;
  let unreadActivityCount = 0;

  function switchDrawerTab(tab, emit = true) {
    activeDrawerTab = tab;
    if (tab === 'chat') {
      if (drawerTabChatBtn) drawerTabChatBtn.classList.add('active');
      if (drawerTabActivityBtn) drawerTabActivityBtn.classList.remove('active');
      if (panelChat) panelChat.classList.add('active');
      if (panelActivity) panelActivity.classList.remove('active');
      unreadChatCount = 0;
      if (chatUnreadBadge) {
        chatUnreadBadge.textContent = '0';
        chatUnreadBadge.classList.add('hidden');
      }
      if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    } else {
      if (drawerTabActivityBtn) drawerTabActivityBtn.classList.add('active');
      if (drawerTabChatBtn) drawerTabChatBtn.classList.remove('active');
      if (panelActivity) panelActivity.classList.add('active');
      if (panelChat) panelChat.classList.remove('active');
      unreadActivityCount = 0;
      if (activityUnreadBadge) {
        activityUnreadBadge.textContent = '0';
        activityUnreadBadge.classList.add('hidden');
      }
      if (activityMessages) activityMessages.scrollTop = activityMessages.scrollHeight;
    }
    if (emit) {
      socket.emit('drawer-tab-switch', { tab });
    }
  }

  if (drawerTabChatBtn) {
    drawerTabChatBtn.addEventListener('click', () => switchDrawerTab('chat', true));
  }
  if (drawerTabActivityBtn) {
    drawerTabActivityBtn.addEventListener('click', () => switchDrawerTab('activity', true));
  }

  if (chatInput) {
    chatInput.addEventListener('input', updateSendChatBtnState);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });
  }

  updateSendChatBtnState();

  function getActivityIcon(text) {
    const t = (text || '').toLowerCase();
    if (t.includes('joined')) return '👋';
    if (t.includes('left')) return '🚪';
    if (t.includes('language')) return '🌐';
    if (t.includes('protection') || t.includes('security')) return '🔒';
    if (t.includes('sharing')) return '📡';
    if (t.includes('copy') || t.includes('paste')) return '🛡️';
    return '⚡';
  }

  function appendActivityMessage(msg) {
    if (!activityMessages) return;
    const div = document.createElement('div');
    div.className = 'activity-item';
    const icon = getActivityIcon(msg.text || '');
    div.innerHTML = `
      <span class="activity-icon">${icon}</span>
      <div class="activity-content">
        <div>${escapeHtml(msg.text || '')}</div>
        <div class="activity-time">${msg.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    `;
    activityMessages.appendChild(div);
    activityMessages.scrollTop = activityMessages.scrollHeight;

    if (activeDrawerTab !== 'activity') {
      unreadActivityCount++;
      if (activityUnreadBadge) {
        activityUnreadBadge.textContent = unreadActivityCount;
        activityUnreadBadge.classList.remove('hidden');
      }
    }
  }

  function appendChatMessage(msg) {
    if (msg.isSystem) {
      appendActivityMessage(msg);
      return;
    }
    const div = document.createElement('div');
    div.className = 'chat-bubble';
    div.innerHTML = `
      <div class="chat-author" style="color: ${msg.color || 'var(--accent-cyan)'}">${escapeHtml(msg.sender || 'User')} <span class="chat-time">${msg.timestamp || ''}</span></div>
      <div>${escapeHtml(msg.text || '')}</div>
    `;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (activeDrawerTab !== 'chat') {
      unreadChatCount++;
      if (chatUnreadBadge) {
        chatUnreadBadge.textContent = unreadChatCount;
        chatUnreadBadge.classList.remove('hidden');
      }
    }
  }

  function renderChat(chatHistory) {
    if (chatMessages) chatMessages.innerHTML = '';
    if (activityMessages) activityMessages.innerHTML = '';
    chatHistory.forEach(msg => {
      if (msg.isSystem) appendActivityMessage(msg);
      else appendChatMessage(msg);
    });
  }



  // Download Code File Handler
  const FILE_EXTENSIONS = {
    javascript: 'js',
    python: 'py',
    html: 'html',
    cpp: 'cpp',
    sql: 'sql'
  };

  downloadCodeBtn.addEventListener('click', () => {
    if ((isCopyDisabled || isExamMode) && !isHost) {
      showToast(isExamMode ? '⚠️ Download is locked during Exam Mode!' : '⚠️ Download is locked because copy protection is enabled by the room host!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'download-attempt' });
      return;
    }

    const ext = FILE_EXTENSIONS[roomLanguage] || 'txt';
    let fileName = currentActiveFile;
    if (!fileName || fileName === 'Untitled' || fileName.startsWith('Untitled')) {
      fileName = `script.${ext}`;
    } else if (fileName.includes('/')) {
      fileName = fileName.split('/').pop();
    }
    const blob = new Blob([codeTextarea.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Copy Code Button Handler
  let copyCodeBtnResetTimer = null;
  const originalCopyCodeBtnHTML = copyCodeBtn.innerHTML;

  copyCodeBtn.addEventListener('click', () => {
    if ((isCopyDisabled || isExamMode) && !isHost) {
      showToast(isExamMode ? '⚠️ Copying is locked during Exam Mode!' : '⚠️ Copying is locked because copy protection is enabled by room host!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'copy-button-attempt' });
      return;
    }

    navigator.clipboard.writeText(codeTextarea.value).then(() => {
      // Show checkmark tick for 3 seconds without toast notification
      if (copyCodeBtnResetTimer) {
        clearTimeout(copyCodeBtnResetTimer);
      }
      copyCodeBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      copyCodeBtn.classList.add('btn-copied');
      
      copyCodeBtnResetTimer = setTimeout(() => {
        copyCodeBtn.innerHTML = originalCopyCodeBtnHTML;
        copyCodeBtn.classList.remove('btn-copied');
        copyCodeBtnResetTimer = null;
      }, 3000);
    }).catch(() => {
      showToast('⚠️ Failed to copy code to clipboard.', 'warning');
    });
  });



  function promptRename() {
    const currentName = currentUser ? currentUser.name : (savedUsername || '');
    const inputName = prompt('Change your username:', currentName);
    if (inputName && inputName.trim() && inputName.trim() !== currentName) {
      const cleanName = inputName.trim();
      savedUsername = cleanName;
      if (currentUser) currentUser.name = cleanName;
      try { localStorage.setItem('livecode_username', cleanName); } catch(e){}
      socket.emit('update-username', { username: cleanName });
      updateRoleBadge();
      renderUsers();
      showToast(`Username updated to ${cleanName}`);
    }
  }

  function updateRoleBadge() {
    const userRoleBadge = document.getElementById('userRoleBadge');
    const name = (currentUser && currentUser.name) ? currentUser.name : (savedUsername || 'You');

    if (userRoleBadge) {
      if (isHost) {
        userRoleBadge.className = 'user-role-badge host';
        userRoleBadge.textContent = 'Host';
        userRoleBadge.title = `Logged in as ${name} (Host)`;
      } else {
        userRoleBadge.className = 'user-role-badge guest';
        userRoleBadge.textContent = 'Guest';
        userRoleBadge.title = `Logged in as ${name} (Guest)`;
      }
    }

    const accountDropdownUsername = document.getElementById('accountDropdownUsername');
    if (accountDropdownUsername) {
      accountDropdownUsername.textContent = name;
    }

    const hostOnlyItems = document.querySelectorAll('.host-only-item');
    hostOnlyItems.forEach(el => {
      if (isHost) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    });
  }

  // Renaming is only accessible via the edit button inside the account dropdown
  const accountRenameBtn = document.getElementById('accountRenameBtn');
  if (accountRenameBtn) {
    accountRenameBtn.addEventListener('click', promptRename);
  }

  function handleKillRoomAction(e) {
    if (e) e.stopPropagation();
    if (confirm('Are you sure you want to permanently kill this room? All participants will be disconnected.')) {
      socket.emit('kill-room');
    }
  }

  const killRoomBtn = document.getElementById('killRoomBtn');
  if (killRoomBtn) {
    killRoomBtn.addEventListener('click', handleKillRoomAction);
  }

  const killRoomNavBtn = document.getElementById('killRoomNavBtn');
  if (killRoomNavBtn) {
    killRoomNavBtn.addEventListener('click', handleKillRoomAction);
  }

  const chipKillRoomBtn = document.getElementById('chipKillRoomBtn');
  if (chipKillRoomBtn) {
    chipKillRoomBtn.addEventListener('click', handleKillRoomAction);
  }

  const settingsChipKillRoomBtn = document.getElementById('settingsChipKillRoomBtn');
  if (settingsChipKillRoomBtn) {
    settingsChipKillRoomBtn.addEventListener('click', handleKillRoomAction);
  }

  const settingsCopyLinkBtn = document.getElementById('settingsCopyLinkBtn');
  if (settingsCopyLinkBtn) {
    let settingsCopyResetTimer = null;
    settingsCopyLinkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const shareUrl = window.location.href;
      const copyIcon = document.getElementById('settingsCopyLinkIcon') || settingsCopyLinkBtn.querySelector('.copy-icon');
      navigator.clipboard.writeText(shareUrl).then(() => {
        if (copyIcon) {
          copyIcon.classList.add('copy-success');
          if (settingsCopyResetTimer) clearTimeout(settingsCopyResetTimer);
          settingsCopyResetTimer = setTimeout(() => {
            copyIcon.classList.remove('copy-success');
            settingsCopyResetTimer = null;
          }, 3000);
        }
        showToast('Share link copied to clipboard!');
      }).catch(() => {
        showToast(`Share URL: ${shareUrl}`);
      });
    });
  }

  // Users List Render
  function renderUsers() {
    if (activeUserCount) activeUserCount.textContent = isLiveSharingEnabled ? usersList.length : 1;
    const userTabCount = document.getElementById('userTabCount');
    if (userTabCount) userTabCount.textContent = isLiveSharingEnabled ? usersList.length : 1;

    userListContainer.innerHTML = '';
    const rawList = isLiveSharingEnabled ? usersList : usersList.filter(u => u.id === socket.id);
    
    // Deduplicate collaborators by token or normalized username
    const seenTokens = new Set();
    const seenNames = new Set();
    const displayList = [];
    rawList.forEach(u => {
      const normName = (u.name || '').trim().toLowerCase();
      const token = u.token;
      if (token && seenTokens.has(token)) return;
      if (normName && seenNames.has(normName)) return;
      if (token) seenTokens.add(token);
      if (normName) seenNames.add(normName);
      displayList.push(u);
    });

    displayList.forEach(u => {
      const card = document.createElement('div');
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';
      card.style.padding = '8px 12px';
      card.style.borderBottom = '1px solid var(--border-light)';
      const displayName = isLiveSharingEnabled ? u.name : (u.id === socket.id ? 'You (Offline Session)' : 'Anonymous');
      const isTypingActive = Date.now() - lastTypingTime < 1500;
      const isTypingNow = isLiveSharingEnabled && isTypingActive && u.id === activeRestingCursorUserId && u.id !== socket.id;
      const statusText = isTypingNow ? '<span style="color: var(--accent-amber); font-weight: 600;">(typing...)</span>' : `Line ${u.cursor ? u.cursor.line : 1}, Col ${u.cursor ? u.cursor.ch : 1}`;
      const v = u.violations;
      const vCount = v && typeof v.count === 'number' ? v.count : 0;
      const violationBadge = (isHost && vCount > 0)
        ? `<button type="button" class="violation-badge-btn" data-userid="${escapeHtml(u.id)}" title="${vCount} anti-cheat infraction(s). Click to view audit log.">⚠️ ${vCount}</button>`
        : '';

      card.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="background-color: ${u.color}; width: 24px; height: 24px; font-size: 12px; font-weight: bold; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white;">
            ${displayName.charAt(0).toUpperCase()}
          </div>
          <div style="display: flex; flex-direction: column;">
            <div style="font-size: 0.85rem; font-weight: 500; color: var(--text-primary);">${escapeHtml(displayName)}</div>
            <div style="font-size: 0.7rem; color: var(--text-muted);">${statusText}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          ${violationBadge}
          <span class="role-pill ${u.isHost ? 'host' : 'editor'}" style="font-size: 0.65rem; padding: 2px 6px;">${u.isHost ? 'Host' : 'Editor'}</span>
          ${getVoiceUserIndicatorHtml(u.id)}
        </div>
      `;
      userListContainer.appendChild(card);
    });

    // Wire up violation audit click triggers for Host
    userListContainer.querySelectorAll('.violation-badge-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const uid = btn.dataset.userid;
        const targetUser = displayList.find(usr => usr.id === uid) || usersList.find(usr => usr.id === uid);
        if (targetUser && typeof openProctorAuditModal === 'function') {
          openProctorAuditModal(targetUser);
        }
      });
    });
  }

  function getVoiceUserIndicatorHtml(userId) {
    if (!voiceParticipantsMap || !voiceParticipantsMap.has(userId)) return '';
    const v = voiceParticipantsMap.get(userId);
    const isSpeaking = activeSpeakingUserIds.has(userId);
    const badgeClass = isSpeaking ? 'speaking' : (v.muted ? 'muted' : '');
    const title = v.muted ? 'Microphone Muted' : (isSpeaking ? 'Speaking...' : 'In Voice Call');
    const iconSvg = v.muted
      ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path></svg>'
      : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path></svg>';
    return `<span class="user-voice-badge ${badgeClass}" title="${title}">${iconSvg}</span>`;
  }

  // Toast System
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'warning' ? 'warning' : ''}`;
    toast.innerHTML = `
      <span>${type === 'warning' ? '🛡️' : '⚡'}</span>
      <span>${escapeHtml(message)}</span>
    `;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // --------------------------------------------------------------------------
  // Voice Call & Real-time WebRTC Audio Collaboration System
  // --------------------------------------------------------------------------
  const voiceCallBtn = document.getElementById('voiceCallBtn');
  const voiceCallCount = document.getElementById('voiceCallCount');
  const voiceCallBanner = document.getElementById('voiceCallBanner');
  const voiceMuteToggleBtn = document.getElementById('voiceMuteToggleBtn');
  const voiceLeaveCallBtn = document.getElementById('voiceLeaveCallBtn');
  const voiceParticipantsGrid = document.getElementById('voiceParticipantsGrid');

  // Incoming Voice Call Modal Dialog Elements
  const incomingCallModal = document.getElementById('incomingCallModal');
  const incomingCallAvatar = document.getElementById('incomingCallAvatar');
  const incomingCallCallerName = document.getElementById('incomingCallCallerName');
  const acceptCallModalBtn = document.getElementById('acceptCallModalBtn');
  const rejectCallModalBtn = document.getElementById('rejectCallModalBtn');

  // Ringtone synthesizer state
  let ringtoneAudioCtx = null;
  let ringtoneInterval = null;
  let isRingtonePlaying = false;

  function stopIncomingRingtone() {
    if (ringtoneInterval) {
      clearInterval(ringtoneInterval);
      ringtoneInterval = null;
    }
    isRingtonePlaying = false;
    try {
      if (ringtoneAudioCtx && ringtoneAudioCtx.state !== 'closed') {
        ringtoneAudioCtx.close().catch(() => {});
      }
    } catch (e) {}
    ringtoneAudioCtx = null;
  }

  function playRingtoneBurst() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!ringtoneAudioCtx || ringtoneAudioCtx.state === 'closed') {
        ringtoneAudioCtx = new AudioCtx();
      }
      if (ringtoneAudioCtx.state === 'suspended') {
        ringtoneAudioCtx.resume().catch(() => {});
      }

      // Elegant melodic digital phone ringtone (dual cadence notes)
      const now = ringtoneAudioCtx.currentTime;
      const notes = [
        { f1: 440, f2: 480, start: 0, dur: 0.28 },
        { f1: 440, f2: 480, start: 0.36, dur: 0.28 },
        { f1: 523.25, f2: 659.25, start: 0.72, dur: 0.4 }
      ];

      notes.forEach(({ f1, f2, start, dur }) => {
        const osc1 = ringtoneAudioCtx.createOscillator();
        const osc2 = ringtoneAudioCtx.createOscillator();
        const gain = ringtoneAudioCtx.createGain();

        osc1.type = 'sine';
        osc2.type = 'triangle';
        osc1.frequency.setValueAtTime(f1, now + start);
        osc2.frequency.setValueAtTime(f2, now + start);

        gain.gain.setValueAtTime(0.0001, now + start);
        gain.gain.exponentialRampToValueAtTime(0.18, now + start + 0.03);
        gain.gain.setValueAtTime(0.18, now + start + dur - 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ringtoneAudioCtx.destination);

        osc1.start(now + start);
        osc2.start(now + start);
        osc1.stop(now + start + dur);
        osc2.stop(now + start + dur);
      });
    } catch (e) {
      console.warn('Ringtone audio playback error:', e);
    }
  }

  function startIncomingRingtone() {
    if (isRingtonePlaying) return;
    isRingtonePlaying = true;
    playRingtoneBurst();
    ringtoneInterval = setInterval(() => {
      if (!isRingtonePlaying) {
        clearInterval(ringtoneInterval);
        ringtoneInterval = null;
        return;
      }
      playRingtoneBurst();
    }, 2400);
  }

  let isInVoiceCall = false;
  let isVoiceMuted = false;
  let localMediaStream = null;
  let voicePeerConnections = new Map(); // targetUserId -> RTCPeerConnection
  let remoteAudioElements = new Map(); // targetUserId -> HTMLAudioElement
  let voiceParticipantsMap = new Map(); // userId -> { id, name, color, isHost, muted }
  let activeSpeakingUserIds = new Set();
  let audioContext = null;
  let localAudioSource = null;
  let localAudioAnalyser = null;
  let audioActivityInterval = null;
  let isLocalSpeaking = false;
  let pendingIceCandidates = new Map(); // targetUserId -> Array of RTCIceCandidateInit
  let pendingVoiceOffers = new Map(); // targetUserId -> RTCSessionDescriptionInit (held until microphone stream is ready)

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ],
    iceCandidatePoolSize: 2,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };

  function updateVoiceParticipants(participantsList) {
    voiceParticipantsMap.clear();
    if (Array.isArray(participantsList)) {
      participantsList.forEach(p => {
        voiceParticipantsMap.set(p.id, p);
      });
    }
    updateVoiceCallUI();
    renderUsers();
  }

  function updateVoiceCallUI() {
    const participantCount = voiceParticipantsMap.size;

    // Header Call button badge & state
    if (voiceCallCount) {
      voiceCallCount.textContent = participantCount;
      if (participantCount > 0) {
        voiceCallCount.classList.remove('hidden');
      } else {
        voiceCallCount.classList.add('hidden');
      }
    }

    if (voiceCallBtn) {
      if (isInVoiceCall) {
        voiceCallBtn.classList.add('in-call');
        if (isVoiceMuted) {
          voiceCallBtn.classList.add('is-muted');
          voiceCallBtn.title = 'Voice Call Active (Microphone Muted) - Click to Leave';
        } else {
          voiceCallBtn.classList.remove('is-muted');
          voiceCallBtn.title = 'Voice Call Active (Microphone Live) - Click to Leave';
        }
      } else {
        voiceCallBtn.classList.remove('in-call', 'is-muted', 'is-speaking');
        voiceCallBtn.title = participantCount > 0 
          ? `Join Voice Call (${participantCount} participant${participantCount > 1 ? 's' : ''})` 
          : 'Start / Join Voice Call';
      }
    }

    // Drawer Banner state
    if (voiceCallBanner) {
      if (isInVoiceCall) {
        voiceCallBanner.classList.remove('hidden');
      } else {
        voiceCallBanner.classList.add('hidden');
      }
    }

    if (voiceLeaveCallBtn) {
      voiceLeaveCallBtn.title = 'Leave Voice Call';
    }

    // Mute button icon & state in banner
    if (voiceMuteToggleBtn) {
      const iconOn = voiceMuteToggleBtn.querySelector('.icon-mic-on');
      const iconOff = voiceMuteToggleBtn.querySelector('.icon-mic-off');
      if (isVoiceMuted) {
        voiceMuteToggleBtn.classList.add('is-muted');
        voiceMuteToggleBtn.title = 'Unmute Microphone';
        if (iconOn) iconOn.classList.add('hidden');
        if (iconOff) iconOff.classList.remove('hidden');
      } else {
        voiceMuteToggleBtn.classList.remove('is-muted');
        voiceMuteToggleBtn.title = 'Mute Microphone';
        if (iconOn) iconOn.classList.remove('hidden');
        if (iconOff) iconOff.classList.add('hidden');
      }
    }

    // Render Participant Avatars in Drawer Banner
    if (voiceParticipantsGrid) {
      voiceParticipantsGrid.innerHTML = '';
      const seenNames = new Set();
      voiceParticipantsMap.forEach(p => {
        const normName = (p.name || '').trim().toLowerCase();
        if (p.id !== socket.id && normName && seenNames.has(normName)) {
          return;
        }
        if (normName) seenNames.add(normName);

        const chip = document.createElement('div');
        const isSpeaking = activeSpeakingUserIds.has(p.id);
        chip.className = `voice-participant-chip ${isSpeaking ? 'is-speaking' : ''}`;
        const initial = (p.name || 'U').charAt(0).toUpperCase();
        const micIcon = p.muted 
          ? '<span class="voice-chip-mic muted" title="Muted"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path></svg></span>'
          : '<span class="voice-chip-mic" title="Active"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path></svg></span>';
        
        chip.innerHTML = `
          <div class="voice-chip-avatar" style="background-color: ${p.color || 'var(--accent-cyan)'};">${initial}</div>
          <span style="font-weight: 500;">${p.id === socket.id ? 'You' : escapeHtml(p.name)}</span>
          ${micIcon}
        `;
        voiceParticipantsGrid.appendChild(chip);
      });
    }
  }

  async function startVoiceCall() {
    if (isInVoiceCall) return;

    try {
      // Request microphone access with ultra-low latency & clean voice processing settings
      localMediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: { ideal: 48000 },
          latency: { ideal: 0.01 }, // Request 10ms low buffer latency
          googEchoCancellation: true,
          googAutoGainControl: true,
          googNoiseSuppression: true,
          googHighpassFilter: true,
          googTypingNoiseDetection: true
        },
        video: false
      });
    } catch (err) {
      console.error('Microphone access denied or unavailable:', err);
      showToast('⚠️ Microphone access was denied or not found. Cannot join voice call.', 'warning');
      return;
    }

    isInVoiceCall = true;
    isVoiceMuted = false;

    // Attach local audio tracks to all existing peer connections
    const localAudioTrack = localMediaStream.getAudioTracks()[0];
    if (localAudioTrack) {
      voicePeerConnections.forEach((pc) => {
        const senders = pc.getSenders();
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
        if (audioSender) {
          audioSender.replaceTrack(localAudioTrack).catch(() => {});
        } else {
          try {
            const sender = pc.addTrack(localAudioTrack, localMediaStream);
            const params = sender.getParameters();
            if (params && params.encodings && params.encodings.length > 0) {
              params.encodings[0].networkPriority = 'high';
              params.encodings[0].priority = 'high';
              params.encodings[0].maxBitrate = 64000;
              sender.setParameters(params).catch(() => {});
            }
          } catch (e) {}
        }
      });
    }

    // Monitor speech volume for local user
    setupAudioActivityMonitor(localMediaStream);

    // Tell server we joined the call
    socket.emit('voice-join', { muted: isVoiceMuted });

    // Process any pending incoming WebRTC offers now that microphone is active
    if (pendingVoiceOffers.size > 0) {
      const offersToProcess = Array.from(pendingVoiceOffers.entries());
      pendingVoiceOffers.clear();
      for (const [fromUserId, signal] of offersToProcess) {
        handleIncomingVoiceOffer(fromUserId, signal).catch(err => {
          console.error('Error processing pending voice offer from', fromUserId, err);
        });
      }
    }

    showToast('🎙️ Joined voice call. Speaking enabled.');
  }

  function leaveVoiceCall(notify = true) {
    if (!isInVoiceCall && !localMediaStream) return;

    // Stop speaking monitor
    stopAudioActivityMonitor();

    // Close all active peer connections
    voicePeerConnections.forEach((pc) => {
      try { pc.close(); } catch (e) {}
    });
    voicePeerConnections.clear();
    pendingIceCandidates.clear();

    // Remove remote audio elements
    remoteAudioElements.forEach((audioEl) => {
      try {
        audioEl.srcObject = null;
        audioEl.remove();
      } catch (e) {}
    });
    remoteAudioElements.clear();

    // Stop microphone tracks
    if (localMediaStream) {
      localMediaStream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      localMediaStream = null;
    }

    pendingVoiceOffers.clear();
    isInVoiceCall = false;
    isVoiceMuted = false;
    activeSpeakingUserIds.delete(socket.id);

    if (notify) {
      socket.emit('voice-leave');
      showToast('📞 Left voice call.');
    }

    // Remove self from local participants map
    voiceParticipantsMap.delete(socket.id);
    updateVoiceCallUI();
    renderUsers();
  }

  function toggleVoiceMute() {
    if (!isInVoiceCall || !localMediaStream) return;

    isVoiceMuted = !isVoiceMuted;
    localMediaStream.getAudioTracks().forEach(track => {
      track.enabled = !isVoiceMuted;
    });

    if (voiceParticipantsMap.has(socket.id)) {
      voiceParticipantsMap.get(socket.id).muted = isVoiceMuted;
    }

    if (isVoiceMuted && isLocalSpeaking) {
      isLocalSpeaking = false;
      activeSpeakingUserIds.delete(socket.id);
      socket.emit('voice-speaking', { isSpeaking: false });
    }

    socket.emit('voice-mute-toggle', { muted: isVoiceMuted });
    updateVoiceCallUI();
    renderUsers();
    showToast(isVoiceMuted ? '🔇 Microphone muted' : '🎙️ Microphone unmuted');
  }

  // Optimize SDP to enforce low-latency, packet-loss-resilient Opus configuration
  function optimizeAudioSdp(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;

    // Ensure Opus parameters include in-band FEC, low frame size (minptime=10), DTX disabled for steady packet stream
    return sdp.replace(/a=fmtp:(\d+) (.*opus.*)/gi, (match, pt, params) => {
      let updatedParams = params;
      if (!/useinbandfec=/i.test(updatedParams)) {
        updatedParams += ';useinbandfec=1';
      }
      if (!/usedtx=/i.test(updatedParams)) {
        updatedParams += ';usedtx=0'; // Keep stream active to prevent dropping on pauses
      }
      if (!/minptime=/i.test(updatedParams)) {
        updatedParams += ';minptime=10'; // 10ms packet intervals for low latency
      }
      if (!/maxptime=/i.test(updatedParams)) {
        updatedParams += ';maxptime=20'; // Max 20ms frames
      }
      if (!/maxaveragebitrate=/i.test(updatedParams)) {
        updatedParams += ';maxaveragebitrate=64000'; // 64kbps high fidelity voice
      }
      return `a=fmtp:${pt} ${updatedParams}`;
    });
  }

  // Drain queued ICE candidates once remote description is set
  async function flushPendingIceCandidates(targetUserId, pc) {
    const queue = pendingIceCandidates.get(targetUserId);
    if (!queue || queue.length === 0) return;
    pendingIceCandidates.delete(targetUserId);
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Error applying queued ICE candidate:', err);
      }
    }
  }

  // WebRTC Peer Connection Helper for Mesh Voice Audio
  function createPeerConnection(targetUserId, isInitiator = false) {
    if (voicePeerConnections.has(targetUserId)) {
      return voicePeerConnections.get(targetUserId);
    }

    const pc = new RTCPeerConnection(rtcConfig);
    voicePeerConnections.set(targetUserId, pc);

    // Add local microphone tracks to peer with DSCP voice priority if available
    if (localMediaStream) {
      localMediaStream.getAudioTracks().forEach(track => {
        const sender = pc.addTrack(track, localMediaStream);
        try {
          const params = sender.getParameters();
          if (params && params.encodings && params.encodings.length > 0) {
            params.encodings[0].networkPriority = 'high';
            params.encodings[0].priority = 'high';
            params.encodings[0].maxBitrate = 64000;
            sender.setParameters(params).catch(() => {});
          }
        } catch (e) {}
      });
    } else {
      // Ensure audio transceiver exists with sendrecv so SDP includes m=audio sendrecv line
      try {
        pc.addTransceiver('audio', { direction: 'sendrecv' });
      } catch (e) {}
    }

    // ICE Candidate generation
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('voice-signal', {
          targetUserId: targetUserId,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    // Remote audio track received
    pc.ontrack = (event) => {
      let audioEl = remoteAudioElements.get(targetUserId);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        document.body.appendChild(audioEl);
        remoteAudioElements.set(targetUserId, audioEl);
      }

      // Configure receiver jitter buffer target if supported for minimal latency & no stutter
      if (event.receiver && 'jitterBufferTarget' in event.receiver) {
        try {
          event.receiver.jitterBufferTarget = 40; // 40ms target jitter buffer
        } catch (e) {}
      }

      if (event.streams && event.streams[0]) {
        audioEl.srcObject = event.streams[0];
      } else if (event.track) {
        const inboundStream = new MediaStream([event.track]);
        audioEl.srcObject = inboundStream;
      }

      // Ensure audio playback plays immediately and is unmuted
      audioEl.muted = false;
      audioEl.volume = 1.0;
      audioEl.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // Attempt ICE restart or clean close
        try {
          if (isInitiator) {
            pc.restartIce();
            return;
          }
        } catch (e) {}
        closePeerConnection(targetUserId);
      } else if (pc.connectionState === 'closed') {
        closePeerConnection(targetUserId);
      }
    };

    // If we are initiating the connection to a newcomer or peer
    if (isInitiator) {
      pc.createOffer({ offerToReceiveAudio: true })
        .then(async (offer) => {
          const optSdp = optimizeAudioSdp(offer.sdp);
          const desc = new RTCSessionDescription({ type: offer.type, sdp: optSdp });
          await pc.setLocalDescription(desc);
          socket.emit('voice-signal', {
            targetUserId: targetUserId,
            signal: { type: 'offer', sdp: pc.localDescription.sdp || desc.sdp }
          });
        })
        .catch(err => console.error('Error creating WebRTC voice offer:', err));
    }

    return pc;
  }

  function closePeerConnection(targetUserId) {
    if (voicePeerConnections.has(targetUserId)) {
      try {
        voicePeerConnections.get(targetUserId).close();
      } catch (e) {}
      voicePeerConnections.delete(targetUserId);
    }
    pendingIceCandidates.delete(targetUserId);
    if (remoteAudioElements.has(targetUserId)) {
      try {
        const el = remoteAudioElements.get(targetUserId);
        el.srcObject = null;
        el.remove();
      } catch (e) {}
      remoteAudioElements.delete(targetUserId);
    }
    activeSpeakingUserIds.delete(targetUserId);
    updateVoiceCallUI();
    renderUsers();
  }

  // Audio level speaking detector
  function setupAudioActivityMonitor(stream) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      audioContext = new AudioContextClass();
      localAudioSource = audioContext.createMediaStreamSource(stream);
      localAudioAnalyser = audioContext.createAnalyser();
      localAudioAnalyser.fftSize = 512;
      localAudioAnalyser.smoothingTimeConstant = 0.3;
      localAudioSource.connect(localAudioAnalyser);

      const bufferLength = localAudioAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      audioActivityInterval = setInterval(() => {
        if (!isInVoiceCall || isVoiceMuted || !localAudioAnalyser) return;
        localAudioAnalyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const nowSpeaking = average > 14;

        if (nowSpeaking !== isLocalSpeaking) {
          isLocalSpeaking = nowSpeaking;
          if (nowSpeaking) {
            activeSpeakingUserIds.add(socket.id);
            if (voiceCallBtn) voiceCallBtn.classList.add('is-speaking');
          } else {
            activeSpeakingUserIds.delete(socket.id);
            if (voiceCallBtn) voiceCallBtn.classList.remove('is-speaking');
          }
          socket.emit('voice-speaking', { isSpeaking: nowSpeaking });
          updateVoiceCallUI();
          renderUsers();
        }
      }, 150);
    } catch (e) {
      console.warn('Audio monitor init warning:', e);
    }
  }

  function stopAudioActivityMonitor() {
    if (audioActivityInterval) {
      clearInterval(audioActivityInterval);
      audioActivityInterval = null;
    }
    if (voiceCallBtn) voiceCallBtn.classList.remove('is-speaking');
    isLocalSpeaking = false;
    try {
      if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
      }
    } catch (e) {}
    audioContext = null;
    localAudioSource = null;
    localAudioAnalyser = null;
  }

  // Voice Call UI Event Listeners
  if (voiceCallBtn) {
    voiceCallBtn.addEventListener('click', () => {
      if (isInVoiceCall) {
        leaveVoiceCall(true);
      } else {
        startVoiceCall();
      }
    });
  }

  if (voiceMuteToggleBtn) {
    voiceMuteToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVoiceMute();
    });
  }

  if (voiceLeaveCallBtn) {
    voiceLeaveCallBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      leaveVoiceCall(true);
    });
  }

  function showIncomingCallModal(callerName, callerColor) {
    if (!incomingCallModal) return;
    const name = callerName || 'A collaborator';
    if (incomingCallCallerName) {
      incomingCallCallerName.textContent = name;
    }
    if (incomingCallAvatar) {
      incomingCallAvatar.textContent = name.charAt(0).toUpperCase();
      if (callerColor) {
        incomingCallAvatar.style.backgroundColor = callerColor;
      }
    }
    incomingCallModal.classList.remove('hidden');
    // Play incoming call ringtone
    startIncomingRingtone();
  }

  function hideIncomingCallModal() {
    stopIncomingRingtone();
    if (incomingCallModal) {
      incomingCallModal.classList.add('hidden');
    }
  }

  if (acceptCallModalBtn) {
    acceptCallModalBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      hideIncomingCallModal();
      await startVoiceCall();
    });
  }

  if (rejectCallModalBtn) {
    rejectCallModalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideIncomingCallModal();
      showToast('Declined incoming call.');
    });
  }

  // Socket.io Voice Call Signaling Listeners
  socket.on('voice-state', ({ inCall, participants }) => {
    isInVoiceCall = Boolean(inCall);
    if (isInVoiceCall) {
      hideIncomingCallModal();
    }
    updateVoiceParticipants(participants);
    
    // Connect to existing participants in call who aren't self
    if (isInVoiceCall && Array.isArray(participants)) {
      participants.forEach(p => {
        if (p.id !== socket.id && !voicePeerConnections.has(p.id)) {
          createPeerConnection(p.id, true);
        }
      });
    }
  });

  // Host ended the voice call - automatically ends call for all guest participants
  socket.on('voice-call-ended', ({ endedByHost, hostName, participants }) => {
    hideIncomingCallModal();
    if (isInVoiceCall) {
      leaveVoiceCall(false); // Clean up WebRTC peer connections and microphone tracks without notifying server again
      showToast(`📞 Voice call ended by host (${hostName || 'Host'}).`);
    } else {
      showToast(`📞 Voice call was ended by host (${hostName || 'Host'}).`);
    }
    updateVoiceParticipants(participants || []);
  });

  socket.on('voice-user-joined', ({ userId, name, color, isHost, muted, participants }) => {
    updateVoiceParticipants(participants);
    showToast(`🎙️ ${name} joined the voice call`);

    // If local user is not yet in voice call, show centered incoming call modal dialog with ringtone
    if (!isInVoiceCall && userId !== socket.id) {
      showIncomingCallModal(name, color);
    }

    // If we are already connected to voice call, initiate WebRTC offer to new caller
    if (isInVoiceCall && userId !== socket.id && !voicePeerConnections.has(userId)) {
      createPeerConnection(userId, true);
    }
  });

  socket.on('voice-user-left', ({ userId, participants }) => {
    const user = voiceParticipantsMap.get(userId);
    closePeerConnection(userId);
    updateVoiceParticipants(participants);
    if (user) {
      showToast(`📞 ${user.name} left the voice call`);
    }

    // If no other participants are currently in the call, dismiss incoming call modal and ringtone
    if (!participants || participants.length === 0 || (participants.length === 1 && participants[0].id === socket.id)) {
      hideIncomingCallModal();
    }
  });

  socket.on('voice-mute-update', ({ userId, muted }) => {
    if (voiceParticipantsMap.has(userId)) {
      voiceParticipantsMap.get(userId).muted = muted;
    }
    if (muted) {
      activeSpeakingUserIds.delete(userId);
    }
    updateVoiceCallUI();
    renderUsers();
  });

  socket.on('voice-speaking-update', ({ userId, isSpeaking }) => {
    if (isSpeaking) {
      activeSpeakingUserIds.add(userId);
    } else {
      activeSpeakingUserIds.delete(userId);
    }
    updateVoiceCallUI();
    renderUsers();
  });

  async function handleIncomingVoiceOffer(fromUserId, signal) {
    let pc = voicePeerConnections.get(fromUserId);
    if (!pc) {
      pc = createPeerConnection(fromUserId, false);
    }

    // Ensure local audio track is attached to pc before creating answer
    if (localMediaStream) {
      const localAudioTrack = localMediaStream.getAudioTracks()[0];
      if (localAudioTrack) {
        const senders = pc.getSenders();
        const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
        if (audioSender) {
          audioSender.replaceTrack(localAudioTrack).catch(() => {});
        } else {
          try {
            const sender = pc.addTrack(localAudioTrack, localMediaStream);
            const params = sender.getParameters();
            if (params && params.encodings && params.encodings.length > 0) {
              params.encodings[0].networkPriority = 'high';
              params.encodings[0].priority = 'high';
              params.encodings[0].maxBitrate = 64000;
              sender.setParameters(params).catch(() => {});
            }
          } catch (e) {}
        }
      }
    }

    const optSdp = optimizeAudioSdp(signal.sdp);
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: optSdp }));
    await flushPendingIceCandidates(fromUserId, pc);

    const answer = await pc.createAnswer();
    const optAnswerSdp = optimizeAudioSdp(answer.sdp);
    const desc = new RTCSessionDescription({ type: 'answer', sdp: optAnswerSdp });
    await pc.setLocalDescription(desc);

    socket.emit('voice-signal', {
      targetUserId: fromUserId,
      signal: { type: 'answer', sdp: pc.localDescription.sdp || desc.sdp }
    });
  }

  socket.on('voice-signal', async ({ fromUserId, signal }) => {
    if (!signal) return;

    // If an offer arrives before microphone is initialized (e.g. while accept call modal is open or joining),
    // buffer the offer until startVoiceCall completes to guarantee bidirectional audio.
    if (signal.type === 'offer') {
      if (!isInVoiceCall || !localMediaStream) {
        pendingVoiceOffers.set(fromUserId, signal);
        return;
      }
      try {
        await handleIncomingVoiceOffer(fromUserId, signal);
      } catch (err) {
        console.error('Error handling WebRTC voice offer from user', fromUserId, err);
      }
      return;
    }

    if (!isInVoiceCall) return;

    let pc = voicePeerConnections.get(fromUserId);
    if (!pc) {
      pc = createPeerConnection(fromUserId, false);
    }

    try {
      if (signal.type === 'answer') {
        const optSdp = optimizeAudioSdp(signal.sdp);
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: optSdp }));
        await flushPendingIceCandidates(fromUserId, pc);
      } else if (signal.type === 'candidate' && signal.candidate) {
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          // Buffer candidate until remote description is applied
          if (!pendingIceCandidates.has(fromUserId)) {
            pendingIceCandidates.set(fromUserId, []);
          }
          pendingIceCandidates.get(fromUserId).push(signal.candidate);
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      }
    } catch (err) {
      console.error('Error handling WebRTC voice signal from user', fromUserId, err);
    }
  });

  // --------------------------------------------------------------------------
  // 8. Collaborative Shared Timer & Stopwatch Module
  // --------------------------------------------------------------------------

  const timerBtn = document.getElementById('timerBtn');
  const timerDropdown = document.getElementById('timerDropdown');
  const timerDisplayChip = document.getElementById('timerDisplayChip');
  const timerClockMinutes = document.getElementById('timerClockMinutes');
  const timerClockSeconds = document.getElementById('timerClockSeconds');
  const timerTabCountdown = document.getElementById('timerTabCountdown');
  const timerTabStopwatch = document.getElementById('timerTabStopwatch');
  const timerPresets = document.getElementById('timerPresets');
  const timerCustomRow = document.getElementById('timerCustomRow');
  const timerCustomMinutes = document.getElementById('timerCustomMinutes');
  const timerApplyCustomBtn = document.getElementById('timerApplyCustomBtn');
  const timerStartPauseBtn = document.getElementById('timerStartPauseBtn');
  const timerStartPauseText = document.getElementById('timerStartPauseText');
  const timerPlayIcon = document.getElementById('timerPlayIcon');
  const timerPauseIcon = document.getElementById('timerPauseIcon');
  const timerResetBtn = document.getElementById('timerResetBtn');
  const timerCloseBtn = document.getElementById('timerCloseBtn');
  const timerSoundToggle = document.getElementById('timerSoundToggle');
  const timerSoundLabel = document.getElementById('timerSoundLabel');

  // Time's Up Modal Elements
  const timesUpModal = document.getElementById('timesUpModal');
  const timesUpModalDesc = document.getElementById('timesUpModalDesc');
  const timesUpDismissBtn = document.getElementById('timesUpDismissBtn');

  let localTimerInterval = null;
  let alarmAudioCtx = null;
  let alarmRingtoneInterval = null;

  function formatTime(totalSec) {
    const sec = Math.max(0, Math.floor(totalSec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return { mm, ss, text: `${mm}:${ss}` };
  }

  function playSingleBellChime() {
    if (!timerSoundToggle || !timerSoundToggle.checked) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!alarmAudioCtx) {
        alarmAudioCtx = new AudioCtx();
      }
      if (alarmAudioCtx.state === 'suspended') {
        alarmAudioCtx.resume();
      }

      // Ringing alarm bell burst: two-tone harmonic chime
      const burstNotes = [
        { freq: 880, start: 0, dur: 0.28 },
        { freq: 1760, start: 0, dur: 0.18 },
        { freq: 659.25, start: 0.18, dur: 0.35 },
        { freq: 1318.5, start: 0.18, dur: 0.22 },
        { freq: 880, start: 0.42, dur: 0.4 },
        { freq: 1760, start: 0.42, dur: 0.25 }
      ];

      burstNotes.forEach(({ freq, start, dur }) => {
        const osc = alarmAudioCtx.createOscillator();
        const gain = alarmAudioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, alarmAudioCtx.currentTime + start);
        gain.gain.setValueAtTime(0.22, alarmAudioCtx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.001, alarmAudioCtx.currentTime + start + dur);
        osc.connect(gain);
        gain.connect(alarmAudioCtx.destination);
        osc.start(alarmAudioCtx.currentTime + start);
        osc.stop(alarmAudioCtx.currentTime + start + dur + 0.05);
      });
    } catch (e) {
      console.warn('Alarm sound error:', e);
    }
  }

  function startAlarmRinging() {
    if (alarmRingtoneInterval) return; // already ringing
    playSingleBellChime();
    alarmRingtoneInterval = setInterval(() => {
      playSingleBellChime();
    }, 1100);
  }

  function stopAlarmRinging() {
    if (alarmRingtoneInterval) {
      clearInterval(alarmRingtoneInterval);
      alarmRingtoneInterval = null;
    }
  }

  function renderTimerUI() {
    let displaySec = 0;
    const now = Date.now() + serverTimeOffset;

    if (currentTimerState.mode === 'countdown') {
      if (currentTimerState.isRunning && currentTimerState.targetEndTime) {
        displaySec = Math.max(0, Math.round((currentTimerState.targetEndTime - now) / 1000));
      } else {
        displaySec = (typeof currentTimerState.remaining === 'number' && currentTimerState.remaining > 0)
          ? currentTimerState.remaining
          : (currentTimerState.duration || 300);
      }
    } else {
      // Stopwatch
      if (currentTimerState.isRunning && currentTimerState.startedAt) {
        displaySec = Math.max(0, (currentTimerState.elapsed || 0) + Math.round((now - currentTimerState.startedAt) / 1000));
      } else {
        displaySec = currentTimerState.elapsed || 0;
      }
    }

    const { mm, ss, text } = formatTime(displaySec);
    if (timerDisplayChip) timerDisplayChip.textContent = text;
    if (timerClockMinutes) timerClockMinutes.textContent = mm;
    if (timerClockSeconds) timerClockSeconds.textContent = ss;
    if (examFullscreenTimerVal) examFullscreenTimerVal.textContent = text;

    // Button status styling
    if (timerBtn) {
      timerBtn.classList.remove('timer-running', 'timer-paused', 'timer-alarm');
      if (currentTimerState.isRunning) {
        timerBtn.classList.add('timer-running');
      } else if (currentTimerState.mode === 'countdown' && displaySec === 0 && currentTimerState.duration > 0 && isReadOnly) {
        timerBtn.classList.add('timer-alarm');
      } else if (!currentTimerState.isRunning && ((currentTimerState.mode === 'countdown' && displaySec < (currentTimerState.duration || 300)) || (currentTimerState.mode === 'stopwatch' && displaySec > 0))) {
        timerBtn.classList.add('timer-paused');
      }
    }

    // Popover controls state
    if (timerStartPauseBtn) {
      if (currentTimerState.isRunning) {
        timerStartPauseBtn.classList.add('is-paused');
        if (timerStartPauseText) timerStartPauseText.textContent = 'Pause';
        if (timerPlayIcon) timerPlayIcon.classList.add('hidden');
        if (timerPauseIcon) timerPauseIcon.classList.remove('hidden');
      } else {
        timerStartPauseBtn.classList.remove('is-paused');
        if (timerStartPauseText) timerStartPauseText.textContent = 'Start';
        if (timerPlayIcon) timerPlayIcon.classList.remove('hidden');
        if (timerPauseIcon) timerPauseIcon.classList.add('hidden');
      }
    }

    // Active tab and visibility of presets & custom input
    if (currentTimerState.mode === 'countdown') {
      if (timerTabCountdown) timerTabCountdown.classList.add('active');
      if (timerTabStopwatch) timerTabStopwatch.classList.remove('active');
      if (timerPresets) timerPresets.style.display = 'grid';
      if (timerCustomRow) timerCustomRow.style.display = 'flex';

      // Highlight active preset button if matches current duration
      const presetBtns = timerPresets?.querySelectorAll('.timer-preset-btn');
      if (presetBtns) {
        presetBtns.forEach(btn => {
          const s = parseInt(btn.dataset.seconds, 10);
          btn.classList.toggle('active', s === (currentTimerState.duration || 300));
        });
      }
    } else {
      if (timerTabCountdown) timerTabCountdown.classList.remove('active');
      if (timerTabStopwatch) timerTabStopwatch.classList.add('active');
      if (timerPresets) timerPresets.style.display = 'none';
      if (timerCustomRow) timerCustomRow.style.display = 'none';
    }
  }

  function startLocalTicker() {
    if (localTimerInterval) clearInterval(localTimerInterval);
    localTimerInterval = setInterval(() => {
      if (!currentTimerState.isRunning) {
        clearInterval(localTimerInterval);
        localTimerInterval = null;
        renderTimerUI();
        return;
      }

      const now = Date.now() + serverTimeOffset;
      if (currentTimerState.mode === 'countdown') {
        const remaining = Math.max(0, Math.round((currentTimerState.targetEndTime - now) / 1000));
        if (remaining <= 0) {
          currentTimerState.isRunning = false;
          currentTimerState.remaining = 0;
          clearInterval(localTimerInterval);
          localTimerInterval = null;
          renderTimerUI();
          startAlarmRinging();
          showToast('⏰ Countdown timer completed!');
          socket.emit('timer-action', { action: 'complete' });
          return;
        }
      }
      renderTimerUI();
    }, 250);
  }

  function applyTimerState(newState) {
    if (!newState) return;
    currentTimerState = { ...currentTimerState, ...newState };
    renderTimerUI();
    if (currentTimerState.isRunning) {
      startLocalTicker();
    } else {
      if (localTimerInterval) {
        clearInterval(localTimerInterval);
        localTimerInterval = null;
      }
    }
  }

  function showTimesUpModal() {
    if (!timesUpModal) return;
    startAlarmRinging();
    if (isHost) {
      if (timesUpModalDesc) {
        timesUpModalDesc.textContent = "Guests are view only until you allow. Clicking on the view button in the top bar will allow guests to edit.";
      }
    } else {
      if (timesUpModalDesc) {
        timesUpModalDesc.textContent = "The countdown has ended. Code editing is locked for participants until the host allows editing.";
      }
    }
    timesUpModal.classList.remove('hidden');
  }

  function hideTimesUpModal() {
    stopAlarmRinging();
    if (timesUpModal) {
      timesUpModal.classList.add('hidden');
    }
  }

  // Socket listener for timer updates
  socket.on('timer-update', ({ timer, senderId, senderName, action, serverTime, silent }) => {
    if (typeof serverTime === 'number') {
      serverTimeOffset = serverTime - Date.now();
    }
    applyTimerState(timer);
    if (action === 'complete') {
      showTimesUpModal();
    } else if (action === 'reset' || action === 'start' || action === 'set-duration') {
      stopAlarmRinging();
    }
    if (!silent && action !== 'complete' && senderId !== socket.id) {
      if (action === 'start') {
        showToast(`▶️ ${senderName} started the timer`);
      } else if (action === 'pause') {
        showToast(`⏸️ ${senderName} paused the timer`);
      } else if (action === 'reset') {
        showToast(`🔄 ${senderName} reset the timer`);
      }
    }
  });

  // Time's Up Modal Button Handler
  if (timesUpDismissBtn) {
    timesUpDismissBtn.addEventListener('click', () => {
      stopAlarmRinging();
      hideTimesUpModal();
    });
  }

  // Close Times Up modal and stop blinking when host unlocks readOnly mode
  socket.on('settings-update', ({ settings, updatedBy }) => {
    if (settings && settings.readOnly === false) {
      stopAlarmRinging();
      hideTimesUpModal();
      renderTimerUI();
    }
  });

  // UI Event Listeners
  function setTimerDropdownOpen(open, emit = true) {
    if (!timerDropdown) return;
    if (open) {
      timerDropdown.classList.remove('hidden');
      if (settingsDropdown) settingsDropdown.classList.add('hidden');
      if (profileDropdown) profileDropdown.classList.add('hidden');
    } else {
      timerDropdown.classList.add('hidden');
    }
    if (emit) {
      socket.emit('timer-dropdown-toggle', { isOpen: open });
    }
  }

  if (timerBtn) {
    timerBtn.addEventListener('click', (e) => {
      e.stopPropagation();

      // In Exam Mode, non-hosts cannot open or modify timer controls
      if (isExamMode && !isHost) {
        showToast('⚠️ Exam Mode is active. Timer controls are managed by the host.', 'warning');
        return;
      }

      // If timer is blinking red (alarm state), reset automatically on click
      const isAlarmState = timerBtn.classList.contains('timer-alarm') || 
                           (currentTimerState.mode === 'countdown' && !currentTimerState.isRunning && currentTimerState.remaining === 0);
      if (isAlarmState) {
        stopAlarmRinging();
        hideTimesUpModal();
        socket.emit('timer-action', { action: 'reset' });
        return;
      }

      if (timerDropdown) {
        const willOpen = timerDropdown.classList.contains('hidden');
        setTimerDropdownOpen(willOpen, true);
      }
    });
  }

  if (timerCloseBtn) {
    timerCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setTimerDropdownOpen(false, true);
    });
  }

  if (timerTabCountdown) {
    timerTabCountdown.addEventListener('click', () => {
      if (isExamMode && !isHost) {
        showToast('⚠️ Exam Mode is active. Timer controls are managed by the host.', 'warning');
        return;
      }
      socket.emit('timer-action', { action: 'set-mode', mode: 'countdown' });
    });
  }

  if (timerTabStopwatch) {
    timerTabStopwatch.addEventListener('click', () => {
      if (isExamMode && !isHost) {
        showToast('⚠️ Exam Mode is active. Timer controls are managed by the host.', 'warning');
        return;
      }
      socket.emit('timer-action', { action: 'set-mode', mode: 'stopwatch' });
    });
  }

  if (timerPresets) {
    timerPresets.addEventListener('click', (e) => {
      if (isExamMode && !isHost) {
        showToast('⚠️ Exam Mode is active. Timer controls are managed by the host.', 'warning');
        return;
      }
      const btn = e.target.closest('.timer-preset-btn');
      if (btn && btn.dataset.seconds) {
        const sec = parseInt(btn.dataset.seconds, 10);
        socket.emit('timer-action', { action: 'set-duration', duration: sec });
      }
    });
  }

  if (timerApplyCustomBtn && timerCustomMinutes) {
    timerApplyCustomBtn.addEventListener('click', () => {
      if (isExamMode && !isHost) {
        showToast('⚠️ Exam Mode is active. Timer controls are managed by the host.', 'warning');
        return;
      }
      const val = parseInt(timerCustomMinutes.value, 10);
      if (val && val > 0 && val <= 360) {
        socket.emit('timer-action', { action: 'set-duration', duration: val * 60 });
      }
    });
  }

  if (timerStartPauseBtn) {
    timerStartPauseBtn.addEventListener('click', () => {
      if (isExamMode && !isHost) {
        showToast('⚠️ Exam Mode is active. Timer controls are managed by the host.', 'warning');
        return;
      }
      if (currentTimerState.isRunning) {
        socket.emit('timer-action', { action: 'pause' });
      } else {
        socket.emit('timer-action', { action: 'start' });
      }
    });
  }

  if (timerResetBtn) {
    timerResetBtn.addEventListener('click', () => {
      if (isExamMode && !isHost) {
        showToast('⚠️ Exam Mode is active. Timer controls are managed by the host.', 'warning');
        return;
      }
      socket.emit('timer-action', { action: 'reset' });
    });
  }

  // Timer Dropdown Contents Live Hover Sync
  const timerDropdownHoverItems = [
    { el: timerTabCountdown, id: 'timerTabCountdown' },
    { el: timerTabStopwatch, id: 'timerTabStopwatch' },
    { el: timerCloseBtn, id: 'timerCloseBtn' },
    { el: timerCustomMinutes, id: 'timerCustomMinutes' },
    { el: timerApplyCustomBtn, id: 'timerApplyCustomBtn' },
    { el: timerStartPauseBtn, id: 'timerStartPauseBtn' },
    { el: timerResetBtn, id: 'timerResetBtn' },
    { el: timerSoundLabel, id: 'timerSoundLabel' }
  ];

  timerDropdownHoverItems.forEach(({ el, id }) => {
    if (el) {
      el.addEventListener('mouseenter', () => {
        socket.emit('timer-dropdown-item-hover', { itemId: id, isHovered: true });
      });
      el.addEventListener('mouseleave', () => {
        socket.emit('timer-dropdown-item-hover', { itemId: id, isHovered: false });
      });
    }
  });

  if (timerPresets) {
    timerPresets.querySelectorAll('.timer-preset-btn').forEach(btn => {
      const sec = btn.dataset.seconds;
      btn.addEventListener('mouseenter', () => {
        socket.emit('timer-dropdown-item-hover', { itemId: `preset-${sec}`, isHovered: true });
      });
      btn.addEventListener('mouseleave', () => {
        socket.emit('timer-dropdown-item-hover', { itemId: `preset-${sec}`, isHovered: false });
      });
    });
  }

  // Handle page navigation / window unload to cleanly release audio & inform room
  window.addEventListener('beforeunload', () => {
    if (isInVoiceCall) {
      leaveVoiceCall(true);
    }
  });
});

