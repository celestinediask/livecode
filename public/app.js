// ==========================================================================
// LiveCode — Real-Time Client Application & Protection Engine
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // Persistent Client Session Token (Maintains Host Identity on Browser Refresh)
  let userToken = sessionStorage.getItem('livecode_user_token');
  if (!userToken) {
    userToken = 'usr_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
    sessionStorage.setItem('livecode_user_token', userToken);
  }

  // URL Parsing to extract Room ID
  const pathParts = window.location.pathname.split('/');
  let currentRoomId = pathParts[2] || null;

  // Local State
  let currentUser = null;
  let isHost = false;
  let isCopyDisabled = true;
  let isPasteDisabled = false;
  let isReadOnly = false;
  let isLiveSharingEnabled = false;
  let roomCode = '';
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
  const codeTextarea = document.getElementById('codeTextarea');
  const highlightCode = document.getElementById('highlightCode');
  const lineNumbers = document.getElementById('lineNumbers');
  const languageSelect = document.getElementById('languageSelect');
  const protectionBanner = document.getElementById('protectionBanner');
  const watermarkOverlay = document.getElementById('watermarkOverlay');

  // Protection Toggles
  const toggleCopyProtection = document.getElementById('toggleCopyProtection');
  const togglePasteProtection = document.getElementById('togglePasteProtection');
  const toggleReadOnly = document.getElementById('toggleReadOnly');
  const toggleLiveSharing = document.getElementById('toggleLiveSharing');
  const toggleSyntaxHighlight = document.getElementById('toggleSyntaxHighlight');
  const copyProtectionToggleLabel = document.getElementById('copyProtectionToggleLabel');

  // Actions & Buttons
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

  // Modal
  const roomModal = document.getElementById('roomModal');
  const usernameInput = document.getElementById('usernameInput');
  const createRoomModalBtn = document.getElementById('createRoomModalBtn');
  const newRoomLanguage = document.getElementById('newRoomLanguage');
  const modalCopyDisabled = document.getElementById('modalCopyDisabled');

  // Retrieve saved username from localStorage
  let savedUsername = '';
  try { savedUsername = (localStorage.getItem('livecode_username') || '').trim(); } catch(e){}

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
          copyDisabled: true
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

  function joinRoom(roomId, username) {
    displayRoomId.textContent = roomId.toUpperCase();
    socket.emit('join-room', { roomId, username, userToken });
  }

  // --------------------------------------------------------------------------
  // 2. Socket.io Event Handlers (Real-Time Synchronization)
  // --------------------------------------------------------------------------

  socket.on('room-state', (state) => {
    currentRoomId = state.roomId;
    if (displayRoomId) displayRoomId.textContent = state.roomId.toUpperCase();
    
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
    if (state.sidebarCollapsed !== undefined) {
      if (state.sidebarCollapsed) {
        sidebar.classList.add('collapsed');
      } else {
        sidebar.classList.remove('collapsed');
      }
      updateSidebarToggleState();
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
    
    roomLanguage = state.language;
    languageSelect.value = roomLanguage;

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

    // Apply Room Settings
    applyProtectionSettings(state.settings);
    
    // Update Users & History
    usersList = state.users || [];
    renderUsers();
    renderChat(state.chat || []);

    // Initial Syntax Highlight & Line Count
    updateEditorDisplay();

    // Auto-show terminal on fresh start if python
    if (roomLanguage === 'python') {
      outputDrawer.classList.remove('collapsed');
      htmlPreviewContainer.classList.add('hidden');
      consoleOutput.classList.remove('hidden');
      if (isHost && !isExecutionRunning) {
        startShellMode();
      }
    }
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
    renderTabs();
    if (senderId !== socket.id) {
      const cursorPos = codeTextarea.selectionStart;
      codeTextarea.value = code;
      roomCode = code;
      if (currentActiveFile) {
        tabBufferMap.set(currentActiveFile, code);
      }
      codeTextarea.setSelectionRange(cursorPos, cursorPos);
      
      if (senderId && cursor) {
        const user = usersList.find(u => u.id === senderId);
        if (user) {
          activeRestingCursorUserId = senderId;
          lastTypingTime = Date.now();
          user.cursor = cursor;
          remoteCursors.set(senderId, { cursor: cursor, name: user.name, color: user.color, isInsideEditor: true });
          
          if (window._remoteTypingTimer) clearTimeout(window._remoteTypingTimer);
          window._remoteTypingTimer = setTimeout(() => {
            activeRestingCursorUserId = null;
            renderCollaboratorCursors();
            renderUsers();
          }, 1500);
        }
      }
      
      updateEditorDisplay();
      renderUsers();
    }
  });

  socket.on('users-update', ({ users }) => {
    usersList = users;
    const currentIds = new Set(users.map(u => u.id));
    for (let id of remoteCursors.keys()) {
      if (!currentIds.has(id)) {
        remoteCursors.delete(id);
      }
    }
    if (activeSelection && !currentIds.has(activeSelection.userId)) {
      activeSelection = null;
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

  // UI Button Hover Sync
  socket.on('btn-hover-update', ({ btnId, isHovered }) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      if (isHovered) btn.classList.add('is-hovered');
      else btn.classList.remove('is-hovered');
    }
  });

  // Tab Hover Sync
  socket.on('tab-hover-update', ({ tabName, isHovered }) => {
    if (isHovered) syncedHoveredTabName = tabName;
    else if (syncedHoveredTabName === tabName) syncedHoveredTabName = null;
    const tabsContainer = document.getElementById('editorTabs');
    if (tabsContainer) {
      const tabs = tabsContainer.querySelectorAll('.editor-tab');
      tabs.forEach(t => {
        const titleSpan = t.querySelector('span[title]');
        if (titleSpan && titleSpan.getAttribute('title') === tabName) {
          if (isHovered) t.classList.add('is-hovered');
          else t.classList.remove('is-hovered');
        }
      });
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

  socket.on('cursor-update', ({ userId, cursor }) => {
    if (userId === socket.id) return;
    const user = usersList.find(u => u.id === userId);
    if (user) {
      activeRestingCursorUserId = userId;
      user.cursor = cursor;
      remoteCursors.set(userId, { cursor: cursor, name: user.name, color: user.color, isInsideEditor: true });

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

  socket.on('mouse-update', ({ userId, x, y }) => {
    if (userId === socket.id) return;
    const user = usersList.find(u => u.id === userId);
    if (user) {
      const inside = isPosInsideElement(x, y, 'codeEditorArea');
      const existing = remoteCursors.get(userId) || { cursor: user.cursor, name: user.name, color: user.color };
      existing.mouseX = x;
      existing.mouseY = y;
      existing.isInsideEditor = inside;
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

  socket.on('output-scroll-update', ({ userId, top }) => {
    if (userId === socket.id || !consoleOutput) return;
    isRemoteOutputScroll = true;
    consoleOutput.scrollTop = top;
    setTimeout(() => { isRemoteOutputScroll = false; }, 50);
  });

  socket.on('host-assigned', ({ isHost: newIsHost }) => {
    isHost = newIsHost;
    if (currentUser) currentUser.isHost = isHost;
    updateRoleBadge();
    applyProtectionSettings({ copyDisabled: isCopyDisabled, pasteDisabled: isPasteDisabled, readOnly: isReadOnly });
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
    if (code === 'LIVE_SHARING_OFF') {
      const guestUsernameModal = document.getElementById('guestUsernameModal');
      if (guestUsernameModal) {
        guestUsernameModal.classList.remove('hidden');
        guestUsernameModal.innerHTML = `
          <div style="background: var(--bg-card, #12151e); border: 1px solid var(--border-color, #272d3d); border-radius: 8px; padding: 24px; max-width: 440px; width: 90%; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
            <h3 style="margin-top: 0; color: #ef4444; font-size: 1.25rem;">🔒 Access Denied</h3>
            <p style="color: var(--text-muted, #94a3b8); font-size: 0.95rem; margin-bottom: 0; line-height: 1.5;">${message}</p>
          </div>
        `;
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
    if (displayRoomId) displayRoomId.textContent = state.roomId.toUpperCase();
    
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
    if (state.sidebarCollapsed !== undefined) {
      if (state.sidebarCollapsed) {
        sidebar.classList.add('collapsed');
      } else {
        sidebar.classList.remove('collapsed');
      }
      updateSidebarToggleState();
    }
    if (state.collapsedFolders && Array.isArray(state.collapsedFolders)) {
      collapsedFolders.clear();
      state.collapsedFolders.forEach(f => collapsedFolders.add(f));
    }
    renderFilesList();
    renderTabs();
    
    roomLanguage = state.language;
    languageSelect.value = roomLanguage;

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
    if (outputDrawer) outputDrawer.classList.remove('collapsed');
    if (consoleOutput) consoleOutput.classList.remove('hidden');
    if (htmlPreviewContainer) htmlPreviewContainer.classList.add('hidden');

    if (data.action === 'clear') {
      if (!terminal) initTerminal();
      if (terminal) {
        terminal.reset();
        if (data.message) {
          terminal.write(`\x1b[36m${data.message}\x1b[0m\r\n`);
        }
      }
    } else if (data.action === 'append') {
      appendConsoleLine(data.type, data.text, true);
    } else if (data.action === 'status') {
      updateOutputStatus(data.status, data.text, true);
    } else if (data.action === 'input_request') {
      if (!terminal) initTerminal();
      if (data.text && terminal) {
        terminal.write(`\x1b[36m${data.text}\x1b[0m`);
      }
      showConsoleInput();
    } else if (data.action === 'shell_command') {
      if (!terminal) initTerminal();
      if (terminal) {
        const cwd = data.cwd !== undefined ? data.cwd : '~';
        terminal.write(`\r\x1b[2K\x1b[1;34m${cwd}\x1b[32m$ \x1b[0m${data.cmd}\r\n`);
      }
    } else if (data.action === 'shell_prompt') {
      if (!terminal) initTerminal();
      if (terminal) {
        const cwd = data.cwd !== undefined ? data.cwd : (data.text ? data.text.replace(/\$\s*$/, '') : '~');
        terminal.write(`\r\x1b[2K\x1b[1;34m${cwd}\x1b[32m$ \x1b[0m`);
      }
      isShellMode = true;
      showConsoleInput();
    } else if (data.action === 'input_resolved') {
      hideConsoleInput();
    }
  });

  // --------------------------------------------------------------------------
  // 3. Security & Copy/Paste Protection Engine
  // --------------------------------------------------------------------------

  function applyProtectionSettings(settings) {
    if (settings.copyDisabled !== undefined) isCopyDisabled = settings.copyDisabled;
    if (settings.pasteDisabled !== undefined) isPasteDisabled = settings.pasteDisabled;
    if (settings.readOnly !== undefined) isReadOnly = settings.readOnly;
    if (settings.liveSharingEnabled !== undefined) isLiveSharingEnabled = settings.liveSharingEnabled;
    if (settings.syntaxHighlight !== undefined) {
      isSyntaxHighlightEnabled = settings.syntaxHighlight;
      updateEditorDisplay();
    }

    // Update UI toggle states
    toggleCopyProtection.checked = isCopyDisabled;
    togglePasteProtection.checked = isPasteDisabled;
    toggleReadOnly.checked = isReadOnly;
    if (toggleLiveSharing) {
      toggleLiveSharing.checked = isLiveSharingEnabled;
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
    if (toggleSyntaxHighlight) {
      toggleSyntaxHighlight.disabled = !isHost;
    }

    // Apply Copy Protection CSS classes & Banners (Exempt Host)
    if (isCopyDisabled && !isHost) {
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

    // Apply Live Code Sharing UI states
    const pulseDot = document.querySelector('.pulse-dot');
    if (displayRoomId && currentRoomId) {
      displayRoomId.textContent = currentRoomId.toUpperCase();
    }
    if (isLiveSharingEnabled) {
      if (pulseDot) pulseDot.classList.remove('off');
      if (roomShareBtn) roomShareBtn.classList.remove('live-sharing-off');
    } else {
      if (pulseDot) pulseDot.classList.add('off');
      if (roomShareBtn) roomShareBtn.classList.add('live-sharing-off');
    }

    // Apply Read-Only mode
    if (isReadOnly) {
      document.body.classList.add('read-only-mode');
      codeTextarea.readOnly = !isHost; // Host can edit even if read-only
    } else {
      document.body.classList.remove('read-only-mode');
      codeTextarea.readOnly = false;
    }

    renderUsers();

    // Update Download Button State (Only enabled if host allowed copying or user is host)
    // Update Download & Copy Buttons State (Only enabled if host allowed copying or user is host)
    updateDownloadButtonState();
    updateCopyButtonState();
  }

  function updateDownloadButtonState() {
    const isDownloadAllowed = !isCopyDisabled || isHost;
    if (downloadCodeBtn) {
      downloadCodeBtn.disabled = !isDownloadAllowed;
      if (!isDownloadAllowed) {
        downloadCodeBtn.title = '🔒 Downloading is locked because copy protection is enabled';
      } else {
        downloadCodeBtn.title = 'Download Code File';
      }
    }
  }

  function updateCopyButtonState() {
    const isCopyAllowed = !isCopyDisabled || isHost;
    if (copyCodeBtn) {
      copyCodeBtn.disabled = !isCopyAllowed;
      if (!isCopyAllowed) {
        copyCodeBtn.title = '🔒 Copying is locked because copy protection is enabled';
      } else {
        copyCodeBtn.title = 'Copy Code to Clipboard';
      }
    }
  }

  // Security Toggles Event Listeners (Host Action)
  toggleCopyProtection.addEventListener('change', () => {
    if (!isHost) return;
    socket.emit('update-settings', { copyDisabled: toggleCopyProtection.checked });
  });

  togglePasteProtection.addEventListener('change', () => {
    if (!isHost) return;
    socket.emit('update-settings', { pasteDisabled: togglePasteProtection.checked });
  });

  toggleReadOnly.addEventListener('change', () => {
    if (!isHost) return;
    socket.emit('update-settings', { readOnly: toggleReadOnly.checked });
  });

  let hasPromptedUsernameOnLiveShare = false;

  if (toggleLiveSharing) {
    toggleLiveSharing.addEventListener('change', () => {
      if (!isHost) return;
      if (toggleLiveSharing.checked) {
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
            toggleLiveSharing.checked = false;
            showToast('⚠️ Live Code Sharing requires a username.', 'warning');
            return;
          }
        }
      }
      socket.emit('update-settings', { liveSharingEnabled: toggleLiveSharing.checked });
    });
  }

  if (toggleSyntaxHighlight) {
    toggleSyntaxHighlight.addEventListener('change', () => {
      if (!isHost) return;
      socket.emit('update-settings', { syntaxHighlight: toggleSyntaxHighlight.checked });
      // Remove local toast because the server sends a chat message now, but we can keep local apply
      isSyntaxHighlightEnabled = toggleSyntaxHighlight.checked;
      updateEditorDisplay();
    });
  }

  // Strict Copy Prevention Listener (Exempt Host)
  document.addEventListener('copy', (e) => {
    if (isCopyDisabled && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', '');
      }
      showToast('⚠️ Copying code is disabled in this room by the host!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'copy' });
    }
  }, true);

  // Cut Prevention Listener (Exempt Host)
  document.addEventListener('cut', (e) => {
    if (isCopyDisabled && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Cut/Copy is disabled in this room!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'cut' });
    }
  }, true);

  // Paste Prevention Listener (Exempt Host)
  document.addEventListener('paste', (e) => {
    if (isPasteDisabled && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Pasting into editor is disabled in this room!', 'warning');
    }
  }, true);

  // Drag-and-Drop Text Prevention Listener (Exempt Host)
  document.addEventListener('dragstart', (e) => {
    if (isCopyDisabled && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.clearData();
      }
      showToast('⚠️ Dragging text is disabled while copy protection is active!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'dragstart-attempt' });
    }
  }, true);

  document.addEventListener('drag', (e) => {
    if (isCopyDisabled && !isHost) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  document.addEventListener('drop', (e) => {
    if (isCopyDisabled && !isHost) {
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

    // Prevent Save (Ctrl+S / Cmd+S for all)
    if (isCmdOrCtrl && key === 's') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Prevent Copy
    if (isCmdOrCtrl && (key === 'c' || key === 'insert') && isCopyDisabled && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Clipboard Copy (Ctrl+C / Cmd+C) is disabled by room policy.', 'warning');
      socket.emit('copy-violation-attempt', { type: 'shortcut-copy' });
    }

    // Prevent Cut
    if (isCmdOrCtrl && key === 'x' && isCopyDisabled && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Cut (Ctrl+X / Cmd+X) is disabled by room policy.', 'warning');
    }

    // Prevent Paste
    if (isCmdOrCtrl && (key === 'v' || (e.shiftKey && key === 'insert')) && isPasteDisabled && !isHost) {
      e.preventDefault();
      e.stopPropagation();
      showToast('⚠️ Paste is disabled in this room.', 'warning');
    }

    // Intercept Save Page / File (Ctrl+S / Cmd+S)
    if (isCmdOrCtrl && key === 's') {
      e.preventDefault();
      e.stopPropagation();
      if (isCopyDisabled && !isHost) {
        showToast('⚠️ Saving webpage / code file (Ctrl+S) is disabled by room policy.', 'warning');
        socket.emit('copy-violation-attempt', { type: 'shortcut-save' });
      } else {
        if (downloadCodeBtn && !downloadCodeBtn.disabled) {
          downloadCodeBtn.click();
        } else {
          showToast('⚠️ Downloading files is locked while copy protection is active!', 'warning');
        }
      }
    }
  }, true);

  // Context Menu Interception on Document / Editor Area (Exempt Host)
  document.addEventListener('contextmenu', (e) => {
    if (isCopyDisabled && !isHost) {
      const target = e.target;
      if (target && (target.closest('#codeEditorArea') || target.closest('#codeTextarea') || target.closest('.editor-section'))) {
        e.preventDefault();
        e.stopPropagation();
        showToast('⚠️ Context menu disabled to prevent copying.', 'warning');
      }
    }
  }, true);

  // --------------------------------------------------------------------------
  // 4. Editor Highlighting & Real-Time Sync Logic
  // --------------------------------------------------------------------------
  codeTextarea.addEventListener('input', () => {
    activeRestingCursorUserId = socket.id;
    roomCode = codeTextarea.value;
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
  });

  function formatCode() {
    if (isReadOnly && !isHost) {
      showToast('⚠️ Editor is currently in read-only mode.', 'warning');
      return;
    }
    const raw = codeTextarea.value;
    if (!raw.trim()) return;

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

  if (formatCodeBtn) {
    formatCodeBtn.addEventListener('click', () => {
      formatCode();
    });
  }

  // Tab key indent, Ctrl+S save, and formatting shortcuts inside textarea
  codeTextarea.addEventListener('keydown', (e) => {
    const isCmdOrCtrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

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
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = codeTextarea.selectionStart;
      const end = codeTextarea.selectionEnd;
      codeTextarea.value = codeTextarea.value.substring(0, start) + '  ' + codeTextarea.value.substring(end);
      codeTextarea.selectionStart = codeTextarea.selectionEnd = start + 2;
      codeTextarea.dispatchEvent(new Event('input'));
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

  // Track real-time selection while dragging before mouse release
  let isMouseDownInTextarea = false;
  codeTextarea.addEventListener('mousedown', () => {
    isMouseDownInTextarea = true;
    socket.emit('clear-selections');
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
      if (window.Prism && Prism.languages.python) {
        try {
          highlightCode.innerHTML = Prism.highlight(codeContent, Prism.languages.python, 'python');
        } catch (e) {
          highlightCode.textContent = "PRISM ERROR: " + e.message + " | " + e.stack;
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
      if (editorTabs) editorTabs.style.display = 'none';
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
    if (mousePointerContainer) mousePointerContainer.innerHTML = '';

    const { charWidth, lineHeight } = getMonospaceMetrics();
    const paddingTop = 12;
    const paddingLeft = 12;
    const currentCode = codeTextarea.value || '';

    // If the active user is remote, hide the local native blinking cursor so there's only one.
    if (activeRestingCursorUserId !== socket.id && activeRestingCursorUserId !== null) {
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

      if (isActivelyMoving && data.mouseX !== undefined && data.mouseY !== undefined) {
        const el = document.createElement('div');
        el.className = 'remote-mouse-pointer';
        el.style.transform = `translate3d(${data.mouseX}px, ${data.mouseY}px, 0)`;
        
        if (data.isInsideEditor) {
          // Inside editor: Text I-beam cursor icon
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
        mousePointerContainer.appendChild(el);
      }
      
      // RESTING CURSOR at specific line/column (ONLY for the LAST active cursor)
      const isTypingActive = Date.now() - lastTypingTime < 1500;
      if (isTypingActive && userId === activeRestingCursorUserId && data.cursor && data.cursor.line) {
        const top = (data.cursor.line - 1) * lineHeight + paddingTop - codeTextarea.scrollTop;
        const left = (data.cursor.ch - 1) * charWidth + paddingLeft - codeTextarea.scrollLeft;

        if (top >= -25 && top <= codeTextarea.clientHeight + 25) {
          persistentCursorEl.style.display = 'flex';
          persistentCursorEl.style.transform = `translate(${left}px, ${top}px)`;
          persistentCaret.style.backgroundColor = userColor;
          persistentFlag.style.backgroundColor = userColor;
          persistentFlag.textContent = `${userName} (typing...)`;
        } else {
          persistentCursorEl.style.display = 'none';
        }
      }
    });
    
    // If typing timed out, active user disconnected, no active user, or active user is local
    const isTypingActive = Date.now() - lastTypingTime < 1500;
    if (!isTypingActive || !activeRestingCursorUserId || activeRestingCursorUserId === socket.id || !remoteCursors.has(activeRestingCursorUserId)) {
      persistentCursorEl.style.display = 'none';
    }
  }


  // Real-Time Floating Mouse Pointers Tracking
  let lastMouseMoveTime = 0;
  window.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMouseMoveTime > 30) {
      lastMouseMoveTime = now;
      socket.emit('mouse-move', { x: e.clientX, y: e.clientY });
    }
  });

  function updateRemoteMousePointer(userId, x, y, name, color) {
    if (!mousePointerContainer) return;

    let pointerData = remoteMousePointers.get(userId);
    if (!pointerData) {
      const el = document.createElement('div');
      el.className = 'remote-mouse-pointer';
      el.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="${color}" stroke="#ffffff" stroke-width="1.5">
          <path d="M3 3l7 18 3-7 7-3L3 3z"/>
        </svg>
        <div class="mouse-pointer-label" style="background-color: ${color};">${escapeHtml(name)}</div>
      `;
      mousePointerContainer.appendChild(el);
      pointerData = { element: el, timeout: null };
      remoteMousePointers.set(userId, pointerData);
    }

    pointerData.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    pointerData.element.style.opacity = '1';

    if (pointerData.timeout) clearTimeout(pointerData.timeout);
    pointerData.timeout = setTimeout(() => {
      if (pointerData.element) {
        pointerData.element.style.opacity = '0';
      }
    }, 3000);
  }

  // Language Change Listener
  languageSelect.addEventListener('change', () => {
    roomLanguage = 'python';
    updateEditorDisplay();
    socket.emit('language-change', { language: roomLanguage });
  });

  // --------------------------------------------------------------------------
  // 5. Code Execution Engine (Pyodide Persistent WebAssembly Worker Engine)
  // --------------------------------------------------------------------------

  let activeExecutionWorker = null;
  let isExecutionRunning = false;
  const stopConsoleBtn = document.getElementById('stopConsoleBtn');

  function createPyodideWorkerBlob() {
    const workerScript = `
      importScripts('https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js');
      let pyodide = null;

      self.onmessage = async function(e) {
        const { type, code, roomId, origin } = e.data;
        if (roomId) self.currentRoomId = roomId;
        if (origin) self.originUrl = origin;
        const initPyodide = async () => {
          self.postMessage({ type: 'status', text: 'initializing' });
          pyodide = await loadPyodide({
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

          try {
            if (e.data && e.data.activeFile && e.data.activeFile !== 'Untitled' && !e.data.activeFile.startsWith('Untitled')) {
              if (!pyodide.FS.analyzePath(e.data.activeFile).exists) {
                pyodide.FS.writeFile(e.data.activeFile, e.data.currentCode || '');
              }
            }
          } catch(err){}

          let files = [];
          let cwd = '/';
          try { 
            files = pyodide.runPython("import os\\ndef scan_files():\\n    res = []\\n    base = '/home/pyodide'\\n    if not os.path.exists(base):\\n        base = '.'\\n    for root, dirs, filenames in os.walk(base):\\n        rel = os.path.relpath(root, base)\\n        prefix = '' if rel == '.' else rel.replace('\\\\\\\\', '/') + '/'\\n        for d in sorted(dirs):\\n            if not d.startswith('.'):\\n                res.append(prefix + d + '/')\\n        for f in sorted(filenames):\\n            if not f.startswith('.'):\\n                res.append(prefix + f)\\n    return res\\nscan_files()").toJs(); 
            cwd = pyodide.runPython("import os\\nos.getcwd()");
          } catch(e){}
          
          self.postMessage({ type: 'status', text: 'ready', files: Array.from(files), cwd: cwd });
        };

        if (type === 'init') {
          if (!pyodide) {
            try {
              await initPyodide();
            } catch (err) {
              self.postMessage({ type: 'error', error: 'Failed to initialize Python engine.' });
            }
          }
          if (e.data.files && Array.isArray(e.data.files)) {
            try {
              e.data.files.forEach(f => {
                if (f.endsWith('/')) {
                  const d = f.slice(0, -1);
                  pyodide.runPython("import os\\ntry:\\n    os.makedirs('" + d + "', exist_ok=True)\\nexcept Exception:\\n    pass");
                } else if (f.includes('/')) {
                  const d = f.split('/').slice(0, -1).join('/');
                  pyodide.runPython("import os\\ntry:\\n    os.makedirs('" + d + "', exist_ok=True)\\n    if not os.path.exists('" + f + "'):\\n        open('" + f + "', 'a').close()\\nexcept Exception:\\n    pass");
                } else {
                  pyodide.runPython("import os\\ntry:\\n    if not os.path.exists('" + f + "'):\\n        open('" + f + "', 'a').close()\\nexcept Exception:\\n    pass");
                }
              });
            } catch (err) {}
          }
        } else if (type === 'run') {
          try {
            if (!pyodide) {
              await initPyodide();
            }
            if (code !== undefined && e.data.activeFile && e.data.activeFile !== 'Untitled' && !e.data.activeFile.startsWith('Untitled')) {
              pyodide.FS.writeFile(e.data.activeFile, code);
            }
            await pyodide.runPythonAsync(code);
            self.postMessage({ type: 'done' });
          } catch (err) {
            self.postMessage({ type: 'error', error: err.message });
          }
        } else if (type === 'shell') {
          try {
            if (!pyodide) await initPyodide();
            
            const cmd = e.data.command.trim();
            if (!cmd) {
              self.postMessage({ type: 'shell_done' });
              return;
            }
            const matchArgs = (str) => {
              const regex = /(?:[^\\s"']+|"[^"]*"|'[^']*')+/g;
              const matches = str.match(regex) || [];
              return matches.map(m => {
                if ((m.startsWith('"') && m.endsWith('"')) || (m.startsWith("'") && m.endsWith("'"))) {
                  return m.slice(1, -1);
                }
                return m;
              });
            };
            const rawParts = cmd.match(/(?:[^\\s"']+|"[^"]*"|'[^']*')+/g) || [cmd];
            let action = rawParts[0] ? rawParts[0].trim().replace(/^["']|["']$/g, '').replace(/:$/, '') : '';
            const parts = rawParts.map(m => (m.startsWith('"') && m.endsWith('"')) || (m.startsWith("'") && m.endsWith("'")) ? m.slice(1, -1) : m);
            let pyCode = '';
            if (action === 'ls') {
              const target = parts[1] || '.';
              if (!e.data.skipPrompt) {
                pyCode = "import os\\ntry:\\n    target = " + JSON.stringify(target) + "\\n    items = sorted(os.listdir(target))\\n    res = []\\n    for f in items:\\n        full = os.path.join(target, f)\\n        if os.path.isdir(full):\\n            res.append('\\x1b[1;34m' + f + '/\\x1b[0m')\\n        else:\\n            res.append(f)\\n    print('  '.join(res) if res else '')\\nexcept Exception as err:\\n    print(err)";
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
              let files = [];
              let cwd = '/';
              try { 
                files = pyodide.runPython("import os\\ndef scan_files():\\n    res = []\\n    base = '/home/pyodide'\\n    if not os.path.exists(base):\\n        base = '.'\\n    for root, dirs, filenames in os.walk(base):\\n        rel = os.path.relpath(root, base)\\n        prefix = '' if rel == '.' else rel.replace('\\\\\\\\', '/') + '/'\\n        for d in sorted(dirs):\\n            if not d.startswith('.'):\\n                res.append(prefix + d + '/')\\n        for f in sorted(filenames):\\n            if not f.startswith('.'):\\n                res.append(prefix + f)\\n    return res\\nscan_files()").toJs(); 
                cwd = pyodide.runPython("import os\\nos.getcwd()");
              } catch(e){}
              self.postMessage({ type: 'shell_done', files: Array.from(files), cwd: cwd, skipPrompt: true });
              return;
            } else if (action === 'mkdir') {
              const dir = parts[1];
              if (dir) pyCode = "import os\\ntry:\\n    os.makedirs(" + JSON.stringify(dir) + ", exist_ok=True)\\nexcept Exception as err:\\n    print(err)";
            } else if (action === 'touch') {
              const file = parts[1];
              if (file) pyCode = "import os\\ntry:\\n    d = os.path.dirname(" + JSON.stringify(file) + ")\\n    if d:\\n        os.makedirs(d, exist_ok=True)\\n    open(" + JSON.stringify(file) + ", 'a').close()\\nexcept Exception as err:\\n    print(err)";
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
            } else if (action === 'clear') {
              self.postMessage({ type: 'shell_clear' });
              return;
            } else {
              self.postMessage({ type: 'stderr', text: "bash: " + action + ": command not found" });
            }
            if (pyCode) {
              await pyodide.runPythonAsync(pyCode);
            }
            let files = [];
            let cwd = '/';
            try { 
              files = pyodide.runPython("import os\\ndef scan_files():\\n    res = []\\n    base = '/home/pyodide'\\n    if not os.path.exists(base):\\n        base = '.'\\n    for root, dirs, filenames in os.walk(base):\\n        rel = os.path.relpath(root, base)\\n        prefix = '' if rel == '.' else rel.replace('\\\\\\\\', '/') + '/'\\n        for d in sorted(dirs):\\n            if not d.startswith('.'):\\n                res.append(prefix + d + '/')\\n        for f in sorted(filenames):\\n            if not f.startswith('.'):\\n                res.append(prefix + f)\\n    return res\\nscan_files()").toJs(); 
              cwd = pyodide.runPython("import os\\nos.getcwd()");
            } catch(e){}
            self.postMessage({ type: 'shell_done', files: Array.from(files), cwd: cwd, skipPrompt: e.data.skipPrompt || false });
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
          if (text === 'initializing' && isExecutionRunning) {
            updateOutputStatus('running', 'Initializing...');
          } else if (text === 'ready') {
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
            
            if (!isExecutionRunning) updateOutputStatus('hidden');
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
          startShellMode();
        } else if (e.data.type === 'open_file') {
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
          renderTabs();
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

  // Pre-initialize Python WebAssembly worker in background on page load if Host
  setTimeout(() => {
    if (isHost) {
      getOrInitWorker();
    }
  }, 500);

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

    const worker = getOrInitWorker();
    if (worker) {
      worker.postMessage({ type: 'run', code: codeToRun, activeFile: currentActiveFile, roomId: currentRoomId, origin: window.location.origin });
    }
  }

  runCodeBtn.addEventListener('click', () => {
    const codeToRun = codeTextarea.value;
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

  // Live Sync Hover on sidebar header buttons
  ['createFileBtn', 'createFolderBtn', 'collapseFoldersBtn', 'refreshFilesBtn'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('mouseenter', () => {
        socket.emit('btn-hover', { btnId, isHovered: true });
      });
      btn.addEventListener('mouseleave', () => {
        socket.emit('btn-hover', { btnId, isHovered: false });
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

  function openFileInTab(filename, customTabs = null) {
    if (customTabs && Array.isArray(customTabs)) {
      openTabs = [...customTabs];
    }
    if (currentActiveFile && codeTextarea) {
      tabBufferMap.set(currentActiveFile, codeTextarea.value);
    }
    if (filename && !openTabs.includes(filename)) {
      openTabs.push(filename);
    }
    renderTabs();
    if (filename !== currentActiveFile) {
      if (isHost) {
        const worker = getOrInitWorker();
        if (worker) worker.postMessage({ type: 'shell', command: 'open ' + filename, activeFile: currentActiveFile, skipPrompt: true });
      } else {
        socket.emit('request-shell-command', { command: 'open ' + filename, activeFile: currentActiveFile, openTabs: openTabs, skipPrompt: true });
      }
    } else {
      renderFilesList();
      socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
    }
  }

  function renderTabs() {
    const tabsContainer = document.getElementById('editorTabs');
    if (!tabsContainer) return;
    tabsContainer.innerHTML = '';
    
    openTabs.forEach(tabName => {
      const tabEl = document.createElement('div');
      const isUnsaved = unsavedFiles.has(tabName);
      const isHovered = syncedHoveredTabName === tabName;
      tabEl.className = `editor-tab ${tabName === currentActiveFile ? 'active' : ''} ${isUnsaved ? 'unsaved' : ''} ${isHovered ? 'is-hovered' : ''}`;
      tabEl.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;" title="${tabName}">${tabName}</span>
        ${isUnsaved ? '<span class="unsaved-dot" title="Unsaved changes" style="flex-shrink: 0;">•</span>' : ''}
        <div class="editor-tab-close" title="Close Tab" style="flex-shrink: 0;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </div>
      `;
      
      tabEl.addEventListener('mouseenter', () => {
        socket.emit('tab-hover', { tabName, isHovered: true });
      });
      tabEl.addEventListener('mouseleave', () => {
        socket.emit('tab-hover', { tabName, isHovered: false });
      });

      tabEl.addEventListener('click', (e) => {
        if (e.target.closest('.editor-tab-close')) return;
        if (tabName !== currentActiveFile) {
          openFileInTab(tabName);
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
            renderTabs();
            socket.emit('code-change', { code: roomCode, cursor: null, activeFile: currentActiveFile, openTabs: openTabs });
          }
        });
      }
      
      tabsContainer.appendChild(tabEl);
    });
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
      sendShellCommand(cmd);

      if (!shellFiles.includes(folderPath)) {
        shellFiles.push(folderPath);
      }
      selectedFolder = folderPath;
      renderFilesList();
      socket.emit('tree-select', { path: selectedFolder });
    } else {
      const cmd = `touch "${fullPath}"`;
      sendShellCommand(cmd);

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
        setTimeout(() => {
          codeTextarea.focus();
          codeTextarea.setSelectionRange(0, 0);
        }, 50);
      }
    }
  }

  function sendShellCommand(cmd) {
    let displayCwd = currentShellCwd.startsWith('/home/pyodide') 
      ? currentShellCwd.replace('/home/pyodide', '~') 
      : currentShellCwd;
    if (displayCwd === '') displayCwd = '~';

    if (!terminal) initTerminal();
    if (terminal) {
      terminal.write(`\r\x1b[2K\x1b[1;34m${displayCwd}\x1b[32m$ \x1b[0m${cmd}\r\n`);
    }
    socket.emit('output-sync', { action: 'shell_command', cwd: displayCwd, cmd: cmd });

    if (isHost) {
      const worker = getOrInitWorker();
      if (worker) worker.postMessage({ type: 'shell', command: cmd, currentCode: codeTextarea.value, activeFile: currentActiveFile, skipPrompt: false });
    } else {
      socket.emit('request-shell-command', { command: cmd, currentCode: codeTextarea.value, activeFile: currentActiveFile, skipPrompt: false });
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
    sendShellCommand(cmd);

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
    sendShellCommand(cmd);

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
          type: 'shell',
          command: 'touch ' + filename,
          currentCode: content,
          activeFile: filename,
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
    sendShellCommand(cmd);

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
    setTimeout(() => { if (fitAddon) fitAddon.fit(); }, 10);
    
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
          } else {
            currentTerminalInputBuffer = currentTerminalInputBuffer.slice(0, -1);
            terminal.write('\b \b');
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
        }
      } else if (data === '\x03') { // Ctrl+C
        if (isShellMode) {
          terminal.write('\x1b[35m^C\x1b[0m\r\n');
          currentTerminalInputBuffer = '';
          redrawShellLine();
        }
      } else if (data === '\x15') { // Ctrl+U
        if (isShellMode && currentTerminalInputBuffer.length > 0) {
          currentTerminalInputBuffer = '';
          redrawShellLine();
        }
      } else {
        if (!data.startsWith('\x1b') && data.charCodeAt(0) >= 32) {
          if (isShellMode) {
            currentTerminalInputBuffer += data;
            redrawShellLine();
          } else {
            currentTerminalInputBuffer += data;
            terminal.write('\x1b[35m' + data + '\x1b[0m');
          }
        }
      }
    });
  }

  function appendConsoleLine(type, text, isRemote = false) {
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
    
    if (outputDrawer) outputDrawer.classList.remove('collapsed');
    if (consoleOutput) consoleOutput.classList.remove('hidden');
    
    isTerminalExpectingInput = true;
    currentTerminalInputBuffer = '';
    
    // Ensure terminal is properly sized when shown
    setTimeout(() => { 
      if (fitAddon) fitAddon.fit(); 
      terminal.focus();
    }, 50);
  }

  // Initialize terminal on boot
  document.addEventListener('DOMContentLoaded', () => {
    initTerminal();
  });

  const copyConsoleBtn = document.getElementById('copyConsoleBtn');
  if (copyConsoleBtn) {
    copyConsoleBtn.addEventListener('click', () => {
      if (terminal && terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection()).then(() => {
          showToast('📋 Terminal selection copied to clipboard!');
        });
      } else {
        showToast('Highlight text in the terminal first to copy it.', 'warning');
      }
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

  // The scroll listener isn't perfectly mapped to xterm.js natively without addon-scroll, 
  // but we can omit it or leave as is.
  let isRemoteOutputScroll = false;
  if (consoleOutput) {
    consoleOutput.addEventListener('scroll', () => {
      if (!isRemoteOutputScroll) {
        socket.emit('output-scroll-sync', { top: consoleOutput.scrollTop });
      }
    });
  }

  // --------------------------------------------------------------------------
  // 6. UI Drawers, Share & Chat Logic
  // --------------------------------------------------------------------------

  // Copy Room Link (Only triggered when clicking the link icon)
  roomShareBtn.addEventListener('click', (e) => {
    if (!e.target.closest('.copy-icon')) {
      return;
    }
    if (!isLiveSharingEnabled) {
      showToast('⚠️ Sharing is disabled. Enable Live Code Sharing to copy room link!', 'warning');
      return;
    }
    const shareUrl = window.location.href;
    navigator.clipboard.writeText(shareUrl).then(() => {
      showToast('🔗 Room share link copied to clipboard!');
    }).catch(() => {
      showToast(`Share URL: ${shareUrl}`);
    });
  });

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
  const workspaceContainer = document.querySelector('.workspace');

  function emitSidebarState() {
    const isCollapsed = sidebar ? sidebar.classList.contains('collapsed') : false;
    socket.emit('sidebar-toggle', {
      collapsed: isCollapsed,
      collapsedFolders: Array.from(collapsedFolders)
    });
  }

  function updateSidebarToggleState() {
    const isCollapsed = sidebar.classList.contains('collapsed');
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

  // Chat Header & Nav Toggle Controls
  if (toggleChatBtn) {
    toggleChatBtn.addEventListener('click', () => {
      chatDrawer.classList.toggle('collapsed');
      updateChatDrawerToggleState();
    });
  }

  const closeChatBtn = document.getElementById('closeChatBtn');
  if (closeChatBtn) {
    closeChatBtn.addEventListener('click', () => {
      chatDrawer.classList.add('collapsed');
      updateChatDrawerToggleState();
    });
  }

  if (chatDrawerExpandBtn) {
    chatDrawerExpandBtn.addEventListener('click', () => {
      chatDrawer.classList.remove('collapsed');
      updateChatDrawerToggleState();
    });
  }
  
  // Add global click listener for dropdowns
  document.addEventListener('click', (e) => {
    if (settingsBtn && settingsDropdown) {
      if (!settingsBtn.contains(e.target) && !settingsDropdown.contains(e.target)) {
        settingsDropdown.classList.add('hidden');
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
  
  if (chatInput) {
    chatInput.addEventListener('input', updateSendChatBtnState);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });
  }

  updateSendChatBtnState();

  function appendChatMessage(msg) {
    const div = document.createElement('div');
    if (msg.isSystem) {
      div.className = 'chat-bubble system';
      div.innerHTML = `<span>${msg.text}</span>`;
    } else {
      div.className = 'chat-bubble';
      div.innerHTML = `
        <div class="chat-author" style="color: ${msg.color}">${msg.sender} <span class="chat-time">${msg.timestamp}</span></div>
        <div>${escapeHtml(msg.text)}</div>
      `;
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function renderChat(chatHistory) {
    chatMessages.innerHTML = '';
    chatHistory.forEach(msg => appendChatMessage(msg));
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
    if (isCopyDisabled && !isHost) {
      showToast('⚠️ Download is locked because copy protection is enabled by the room host!', 'warning');
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

    showToast(`📥 Downloaded ${fileName}`);
  });

  // Copy Code Button Handler
  let copyCodeBtnResetTimer = null;
  const originalCopyCodeBtnHTML = copyCodeBtn.innerHTML;

  copyCodeBtn.addEventListener('click', () => {
    if (isCopyDisabled && !isHost) {
      showToast('⚠️ Copying is locked because copy protection is enabled by room host!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'copy-button-attempt' });
      return;
    }

    navigator.clipboard.writeText(codeTextarea.value).then(() => {
      showToast('📋 Code copied to clipboard!');

      // Show checkmark tick for 3 seconds
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



  function updateRoleBadge() {
    const userRoleBadge = document.getElementById('userRoleBadge');
    if (!userRoleBadge) return;
    const name = (currentUser && currentUser.name) ? currentUser.name : (savedUsername || 'You');
    if (isHost) {
      userRoleBadge.className = 'user-role-badge host';
      userRoleBadge.textContent = `${name} (Host)`;
    } else {
      userRoleBadge.className = 'user-role-badge guest';
      userRoleBadge.textContent = `${name} (Guest)`;
    }
  }

  const userRoleBadgeEl = document.getElementById('userRoleBadge');
  if (userRoleBadgeEl) {
    userRoleBadgeEl.addEventListener('click', () => {
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
    });
  }

  // Users List Render
  function renderUsers() {
    if (activeUserCount) activeUserCount.textContent = isLiveSharingEnabled ? usersList.length : 1;
    const userTabCount = document.getElementById('userTabCount');
    if (userTabCount) userTabCount.textContent = isLiveSharingEnabled ? usersList.length : 1;

    userListContainer.innerHTML = '';
    const displayList = isLiveSharingEnabled ? usersList : usersList.filter(u => u.id === socket.id);
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
        <span class="role-pill ${u.isHost ? 'host' : 'editor'}" style="font-size: 0.65rem; padding: 2px 6px;">${u.isHost ? 'Host' : 'Editor'}</span>
      `;
      userListContainer.appendChild(card);
    });
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
});
