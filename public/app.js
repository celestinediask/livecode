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
  let roomCode = '';
  let roomLanguage = 'python';
  let usersList = [];
  let isSyntaxHighlightEnabled = true;
  let activeSelection = null;
  let activeRestingCursorUserId = null;
  const remoteCursors = new Map();

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
  const toggleSyntaxHighlight = document.getElementById('toggleSyntaxHighlight');
  const copyProtectionToggleLabel = document.getElementById('copyProtectionToggleLabel');

  // Actions & Buttons
  const runCodeBtn = document.getElementById('runCodeBtn');
  const downloadCodeBtn = document.getElementById('downloadCodeBtn');
  const copyCodeBtn = document.getElementById('copyCodeBtn');
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
  persistentCursorEl.appendChild(persistentCaret);
  
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

  // Generate random username if blank
  const defaultNames = ['Coder', 'Dev', 'Hacker', 'Ninja', 'Byte', 'Pixel', 'Architect'];
  const randomName = `${defaultNames[Math.floor(Math.random() * defaultNames.length)]}_${Math.floor(Math.random() * 899 + 100)}`;

  // --------------------------------------------------------------------------
  // 1. Initial Room Joining (Direct Website Access without Modal Popup)
  // --------------------------------------------------------------------------

  // Initial display setup
  updateEditorDisplay();

  if (!currentRoomId) {
    autoCreateAndJoinRoom(randomName);
  } else {
    joinRoom(currentRoomId, randomName);
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
    displayRoomId.textContent = state.roomId.toUpperCase();
    
    roomCode = state.code;
    codeTextarea.value = roomCode;
    
    roomLanguage = state.language;
    languageSelect.value = roomLanguage;

    currentUser = state.currentUser;
    isHost = state.isHost;
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
  });

  socket.on('settings-update', ({ settings, updatedBy }) => {
    applyProtectionSettings(settings);
  });

  socket.on('code-update', ({ code, senderId, cursor }) => {
    if (senderId !== socket.id) {
      const cursorPos = codeTextarea.selectionStart;
      codeTextarea.value = code;
      roomCode = code;
      codeTextarea.setSelectionRange(cursorPos, cursorPos);
      
      if (senderId && cursor) {
        const user = usersList.find(u => u.id === senderId);
        if (user) {
          activeRestingCursorUserId = senderId;
          user.cursor = cursor;
          remoteCursors.set(senderId, { cursor: cursor, name: user.name, color: user.color, isInsideEditor: true });
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

  socket.on('terminate-on-host', () => {
    if (isHost && isExecutionRunning) {
      terminateExecution();
    }
  });

  socket.on('protection-alert', ({ message }) => {
    showToast(message, 'warning');
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
      if (data.message) {
        consoleOutput.innerHTML = `<div class="console-line system">${data.message}</div>`;
      } else {
        consoleOutput.innerHTML = '';
      }
    } else if (data.action === 'append') {
      appendConsoleLine(data.type, data.text, true);
    } else if (data.action === 'status') {
      updateOutputStatus(data.status, data.text, true);
    }
  });

  // --------------------------------------------------------------------------
  // 3. Security & Copy/Paste Protection Engine
  // --------------------------------------------------------------------------

  function applyProtectionSettings(settings) {
    if (settings.copyDisabled !== undefined) isCopyDisabled = settings.copyDisabled;
    if (settings.pasteDisabled !== undefined) isPasteDisabled = settings.pasteDisabled;
    if (settings.readOnly !== undefined) isReadOnly = settings.readOnly;
    if (settings.syntaxHighlight !== undefined) {
      isSyntaxHighlightEnabled = settings.syntaxHighlight;
      updateEditorDisplay();
    }

    // Update UI toggle states
    toggleCopyProtection.checked = isCopyDisabled;
    togglePasteProtection.checked = isPasteDisabled;
    toggleReadOnly.checked = isReadOnly;
    if (toggleSyntaxHighlight) {
      toggleSyntaxHighlight.checked = isSyntaxHighlightEnabled;
    }

    // Control permission for non-hosts (disable switches if not host)
    toggleCopyProtection.disabled = !isHost;
    togglePasteProtection.disabled = !isHost;
    toggleReadOnly.disabled = !isHost;
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
    
    if (isCopyDisabled) {
      protectionBanner.classList.remove('hidden');
    } else {
      protectionBanner.classList.add('hidden');
    }

    // Apply Read-Only mode
    if (isReadOnly) {
      document.body.classList.add('read-only-mode');
      codeTextarea.readOnly = !isHost; // Host can edit even if read-only
    } else {
      document.body.classList.remove('read-only-mode');
      codeTextarea.readOnly = false;
    }

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
      cursor: { line, ch, selection }
    });
  });

  // Tab key indent support inside textarea
  codeTextarea.addEventListener('keydown', (e) => {
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
      highlightCode.className = 'language-python';
      highlightCode.textContent = codeContent;
      if (window.Prism && Prism.languages.python) {
        Prism.highlightElement(highlightCode);
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
          `;
        } else {
          // Outside editor: Standard arrow cursor icon
          el.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="${userColor}" stroke="#ffffff" stroke-width="1.5">
              <path d="M3 3l7 18 3-7 7-3L3 3z"/>
            </svg>
          `;
        }
        mousePointerContainer.appendChild(el);
      }
      
      // RESTING CURSOR at specific line/column (ONLY for the LAST active cursor)
      if (userId === activeRestingCursorUserId && data.cursor && data.cursor.line) {
        const top = (data.cursor.line - 1) * lineHeight + paddingTop - codeTextarea.scrollTop;
        const left = (data.cursor.ch - 1) * charWidth + paddingLeft - codeTextarea.scrollLeft;

        if (top >= -25 && top <= codeTextarea.clientHeight + 25) {
          persistentCursorEl.style.display = 'flex';
          persistentCursorEl.style.transform = `translate(${left}px, ${top}px)`;
          persistentCaret.style.backgroundColor = userColor;
        } else {
          persistentCursorEl.style.display = 'none';
        }
      }
    });
    
    // If active user disconnected, no active user, or active user is local
    if (!activeRestingCursorUserId || activeRestingCursorUserId === socket.id || !remoteCursors.has(activeRestingCursorUserId)) {
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
        const { type, code } = e.data;
        if (type === 'init') {
          if (!pyodide) {
            try {
              self.postMessage({ type: 'status', text: 'initializing' });
              pyodide = await loadPyodide({
                stdout: (text) => self.postMessage({ type: 'stdout', text: text }),
                stderr: (text) => self.postMessage({ type: 'stderr', text: text })
              });
              self.postMessage({ type: 'status', text: 'ready' });
            } catch (err) {
              self.postMessage({ type: 'error', error: 'Failed to initialize Python engine.' });
            }
          }
        } else if (type === 'run') {
          try {
            if (!pyodide) {
              self.postMessage({ type: 'status', text: 'initializing' });
              pyodide = await loadPyodide({
                stdout: (text) => self.postMessage({ type: 'stdout', text: text }),
                stderr: (text) => self.postMessage({ type: 'stderr', text: text })
              });
              self.postMessage({ type: 'status', text: 'ready' });
            }
            await pyodide.runPythonAsync(code);
            self.postMessage({ type: 'done' });
          } catch (err) {
            self.postMessage({ type: 'error', error: err.message });
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
        const { type, text, error } = e.data;
        if (type === 'status') {
          if (text === 'initializing' && isExecutionRunning) {
            updateOutputStatus('running', 'Initializing...');
          } else if (text === 'ready') {
            if (!isExecutionRunning) updateOutputStatus('hidden');
          }
        } else if (type === 'stdout') {
          appendConsoleLine('normal', text);
        } else if (type === 'stderr') {
          appendConsoleLine('error', text);
        } else if (type === 'done') {
          setRunningUIState(false);
          updateOutputStatus('completed', '✔');
        } else if (type === 'error') {
          setRunningUIState(false);
          updateOutputStatus('error', '❌ Error');
          appendConsoleLine('error', `Python Traceback:\n${error}`);
        }
      };

      activeExecutionWorker.onerror = (err) => {
        setRunningUIState(false);
        updateOutputStatus('error', '❌ Error');
        appendConsoleLine('error', `Worker Error: ${err.message}`);
      };

      // Pre-warm Python runtime
      activeExecutionWorker.postMessage({ type: 'init' });
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
  }

  function runPythonCode(codeToRun) {
    if (!isHost) return;

    if (isExecutionRunning) {
      terminateExecution();
      return;
    }

    outputDrawer.classList.remove('collapsed');
    consoleOutput.innerHTML = '';
    htmlPreviewContainer.classList.add('hidden');
    consoleOutput.classList.remove('hidden');

    socket.emit('output-sync', { action: 'clear' });
    updateOutputStatus('running', 'Running...');
    setRunningUIState(true);

    const worker = getOrInitWorker();
    if (worker) {
      worker.postMessage({ type: 'run', code: codeToRun });
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

  function appendConsoleLine(type, text, isRemote = false) {
    const div = document.createElement('div');
    div.className = `console-line ${type}`;
    div.textContent = text;
    consoleOutput.appendChild(div);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;

    if (!isRemote) {
      socket.emit('output-sync', { action: 'append', type: type, text: text });
    }
  }

  const copyConsoleBtn = document.getElementById('copyConsoleBtn');
  if (copyConsoleBtn) {
    copyConsoleBtn.addEventListener('click', () => {
      const outputText = consoleOutput.innerText || consoleOutput.textContent;
      if (!outputText.trim()) {
        showToast('Console output is empty.', 'warning');
        return;
      }
      navigator.clipboard.writeText(outputText).then(() => {
        showToast('📋 Console output copied to clipboard!');
      }).catch(() => {
        showToast('Failed to copy console output.', 'warning');
      });
    });
  }

  document.getElementById('clearConsoleBtn').addEventListener('click', () => {
    consoleOutput.innerHTML = '<div class="console-line system">[Cleared]</div>';
    updateOutputStatus('hidden');
    socket.emit('output-sync', { action: 'clear', message: '[Cleared]' });
  });

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

  // Copy Room Link
  roomShareBtn.addEventListener('click', () => {
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

  if (sidebarCollapseBtn) {
    sidebarCollapseBtn.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
    });
  }

  if (toggleUsersBtn) {
    toggleUsersBtn.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
    });
  }

  // Chat Header & Nav Toggle Controls
  if (toggleChatBtn) {
    toggleChatBtn.addEventListener('click', () => {
      chatDrawer.classList.toggle('collapsed');
    });
  }

  const closeChatBtn = document.getElementById('closeChatBtn');
  if (closeChatBtn) {
    closeChatBtn.addEventListener('click', () => {
      chatDrawer.classList.toggle('collapsed');
    });
  }
  // Settings Dropdown Toggle
  const settingsBtn = document.getElementById('settingsBtn');
  const protectionPanel = document.getElementById('protectionPanel');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      alert("not implemented yet");
    });
  }

  // Automatically hide sidebars on small screens
  const mql = window.matchMedia('(max-width: 1250px)');
  function handleScreenChange(e) {
    if (e.matches) {
      if (sidebar) sidebar.classList.add('collapsed');
      if (chatDrawer) chatDrawer.classList.add('collapsed');
    } else {
      if (sidebar) sidebar.classList.remove('collapsed');
      if (chatDrawer) chatDrawer.classList.remove('collapsed');
      if (protectionPanel) protectionPanel.classList.remove('show');
    }
  }
  mql.addEventListener('change', handleScreenChange);
  handleScreenChange(mql);

  // Chat Send
  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (text) {
      socket.emit('send-chat', { text });
      chatInput.value = '';
    }
  }

  sendChatBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

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
    const fileName = `codesync_${currentRoomId || 'share'}.${ext}`;
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
  copyCodeBtn.addEventListener('click', () => {
    if (isCopyDisabled && !isHost) {
      showToast('⚠️ Copying is locked because copy protection is enabled by room host!', 'warning');
      socket.emit('copy-violation-attempt', { type: 'copy-button-attempt' });
      return;
    }

    navigator.clipboard.writeText(codeTextarea.value).then(() => {
      showToast('📋 Code copied to clipboard!');
    }).catch(() => {
      showToast('⚠️ Failed to copy code to clipboard.', 'warning');
    });
  });



  function updateRoleBadge() {
    const userRoleBadge = document.getElementById('userRoleBadge');
    if (!userRoleBadge) return;
    if (isHost) {
      userRoleBadge.className = 'user-role-badge host';
      userRoleBadge.textContent = 'Host';
    } else {
      userRoleBadge.className = 'user-role-badge guest';
      userRoleBadge.textContent = 'Guest';
    }
  }

  // Users List Render
  function renderUsers() {
    if (activeUserCount) activeUserCount.textContent = usersList.length;
    const userTabCount = document.getElementById('userTabCount');
    if (userTabCount) userTabCount.textContent = usersList.length;

    userListContainer.innerHTML = '';
    usersList.forEach(u => {
      const card = document.createElement('div');
      card.className = 'user-card';
      card.innerHTML = `
        <div class="user-info">
          <div class="user-avatar" style="background-color: ${u.color}">
            ${u.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div class="user-name">${escapeHtml(u.name)} ${u.id === socket.id ? '(You)' : ''}</div>
            <div style="font-size: 0.7rem; color: var(--text-muted);">Line ${u.cursor ? u.cursor.line : 1}, Col ${u.cursor ? u.cursor.ch : 1}</div>
          </div>
        </div>
        <span class="role-pill ${u.isHost ? 'host' : 'editor'}">${u.isHost ? 'Host' : 'Editor'}</span>
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
