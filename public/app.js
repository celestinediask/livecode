// ==========================================================================
// CodeSync Live — Real-Time Client Application & Protection Engine
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

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
  let snapshotsList = [];

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
  const copyProtectionToggleLabel = document.getElementById('copyProtectionToggleLabel');

  // Actions & Buttons
  const runCodeBtn = document.getElementById('runCodeBtn');
  const snapshotBtn = document.getElementById('snapshotBtn');
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
  const snapshotListContainer = document.getElementById('snapshotListContainer');
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
    socket.emit('join-room', { roomId, username });
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

    // Apply Room Settings
    applyProtectionSettings(state.settings);
    
    // Update Users & History
    usersList = state.users || [];
    snapshotsList = state.snapshots || [];
    renderUsers();
    renderSnapshots();
    renderChat(state.chat || []);

    // Initial Syntax Highlight & Line Count
    updateEditorDisplay();
  });

  socket.on('code-update', ({ code, senderId }) => {
    if (senderId !== socket.id) {
      const cursorPos = codeTextarea.selectionStart;
      codeTextarea.value = code;
      roomCode = code;
      // Preserve cursor position if possible
      codeTextarea.setSelectionRange(cursorPos, cursorPos);
      updateEditorDisplay();
    }
  });

  socket.on('language-update', ({ language }) => {
    roomLanguage = language;
    languageSelect.value = language;
    updateEditorDisplay();
    showToast(`Language updated to ${language.toUpperCase()}`);
  });

  socket.on('settings-update', ({ settings, updatedBy }) => {
    applyProtectionSettings(settings);
    showToast(`Security settings updated by ${updatedBy}`);
  });

  socket.on('users-update', ({ users }) => {
    usersList = users;
    renderUsers();
  });

  socket.on('host-assigned', ({ isHost: newIsHost }) => {
    isHost = newIsHost;
    if (currentUser) currentUser.isHost = isHost;
    applyProtectionSettings({ copyDisabled: isCopyDisabled, pasteDisabled: isPasteDisabled, readOnly: isReadOnly });
    showToast('👑 You are now the Room Host! Security controls unlocked.');
  });

  socket.on('protection-alert', ({ message }) => {
    showToast(message, 'warning');
  });

  socket.on('chat-message', (msg) => {
    appendChatMessage(msg);
  });

  socket.on('snapshot-created', (snapshot) => {
    snapshotsList.push(snapshot);
    renderSnapshots();
    showToast(`Snapshot "${snapshot.label}" saved!`);
  });

  const outputStatusBadge = document.getElementById('outputStatusBadge');

  function updateOutputStatus(status, text, isRemote = false) {
    if (!outputStatusBadge) return;
    if (!status || status === 'hidden') {
      outputStatusBadge.className = 'output-status-badge hidden';
      outputStatusBadge.textContent = '';
    } else {
      outputStatusBadge.className = `output-status-badge ${status}`;
      outputStatusBadge.textContent = text;
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

    // Update UI toggle states
    toggleCopyProtection.checked = isCopyDisabled;
    togglePasteProtection.checked = isPasteDisabled;
    toggleReadOnly.checked = isReadOnly;

    // Control permission for non-hosts (disable switches if not host)
    toggleCopyProtection.disabled = !isHost;
    togglePasteProtection.disabled = !isHost;
    toggleReadOnly.disabled = !isHost;

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
    roomCode = codeTextarea.value;
    updateEditorDisplay();

    // Calculate line & character cursor
    const cursorPos = codeTextarea.selectionStart;
    const textBeforeCursor = roomCode.substring(0, cursorPos);
    const lines = textBeforeCursor.split('\n');
    const line = lines.length;
    const ch = lines[lines.length - 1].length + 1;

    // Emit live changes to server
    socket.emit('code-change', {
      code: roomCode,
      cursor: { line, ch }
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

  // Sync scrolling between textarea and syntax highlight layer / line numbers
  codeTextarea.addEventListener('scroll', () => {
    highlightCode.parentElement.scrollTop = codeTextarea.scrollTop;
    highlightCode.parentElement.scrollLeft = codeTextarea.scrollLeft;
    lineNumbers.scrollTop = codeTextarea.scrollTop;
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
    highlightCode.className = 'language-python';
    let codeContent = codeTextarea.value;
    if (codeContent.endsWith('\n')) {
      codeContent += ' ';
    }
    highlightCode.textContent = codeContent;
    
    if (window.Prism && Prism.languages.python) {
      Prism.highlightElement(highlightCode);
    }

    // 3. Keep scroll perfectly aligned
    highlightCode.parentElement.scrollTop = codeTextarea.scrollTop;
    highlightCode.parentElement.scrollLeft = codeTextarea.scrollLeft;
    lineNumbers.scrollTop = codeTextarea.scrollTop;
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

  // Pre-initialize Python WebAssembly worker in background on page load
  setTimeout(() => {
    getOrInitWorker();
  }, 500);

  function setRunningUIState(running) {
    isExecutionRunning = running;

    if (running) {
      runCodeBtn.classList.add('btn-danger', 'is-running');
      runCodeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>';
      runCodeBtn.title = 'Stop Execution ⏹';
    } else {
      runCodeBtn.classList.remove('btn-danger', 'is-running');
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
    worker.postMessage({ type: 'run', code: codeToRun });
  }

  runCodeBtn.addEventListener('click', () => {
    if (isExecutionRunning) {
      terminateExecution();
    } else {
      const codeToRun = codeTextarea.value;
      runPythonCode(codeToRun);
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
      const targetPanel = tab.dataset.tab === 'users' ? 'panelUsers' : 'panelSnapshots';
      document.getElementById(targetPanel).classList.add('active');
    });
  });

  // In-section Sidebar Toggle Controls
  const sidebarCollapseBtn = document.getElementById('sidebarCollapseBtn');
  const sidebarExpandBtn = document.getElementById('sidebarExpandBtn');

  if (sidebarCollapseBtn) {
    sidebarCollapseBtn.addEventListener('click', () => {
      sidebar.classList.add('collapsed');
      if (sidebarExpandBtn) sidebarExpandBtn.classList.remove('hidden');
    });
  }

  if (sidebarExpandBtn) {
    sidebarExpandBtn.addEventListener('click', () => {
      sidebar.classList.remove('collapsed');
      sidebarExpandBtn.classList.add('hidden');
    });
  }

  toggleChatBtn.addEventListener('click', () => {
    chatDrawer.classList.toggle('collapsed');
  });

  document.getElementById('closeChatBtn').addEventListener('click', () => {
    chatDrawer.classList.add('collapsed');
  });

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

  // Snapshots
  snapshotBtn.addEventListener('click', () => {
    const label = prompt('Enter a label for this code snapshot:', `Version ${snapshotsList.length + 1}`);
    if (label !== null) {
      socket.emit('create-snapshot', { label: label.trim() });
    }
  });

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

  function renderSnapshots() {
    document.getElementById('snapshotTabCount').textContent = snapshotsList.length;
    if (snapshotsList.length === 0) {
      snapshotListContainer.innerHTML = '<div class="empty-state">No saved snapshots yet. Click "Snapshot" to freeze current state.</div>';
      return;
    }

    snapshotListContainer.innerHTML = '';
    snapshotsList.forEach(snap => {
      const card = document.createElement('div');
      card.className = 'user-card';
      card.style.flexDirection = 'column';
      card.style.alignItems = 'flex-start';
      card.style.gap = '4px';
      card.innerHTML = `
        <div style="font-weight: 700; font-size: 0.85rem; color: var(--accent-cyan);">${escapeHtml(snap.label)}</div>
        <div style="font-size: 0.72rem; color: var(--text-muted);">${snap.timestamp}</div>
      `;
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => {
        if (confirm(`Restore snapshot "${snap.label}"?`)) {
          socket.emit('restore-snapshot', { snapshotId: snap.id });
        }
      });
      snapshotListContainer.appendChild(card);
    });
  }

  // Users List Render
  function renderUsers() {
    activeUserCount.textContent = usersList.length;
    document.getElementById('userTabCount').textContent = usersList.length;

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
            <div style="font-size: 0.7rem; color: var(--text-muted);">Line ${u.cursor ? u.cursor.line : 1}</div>
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
