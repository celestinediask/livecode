const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const compression = require('compression');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.url.endsWith('.zip') || req.url.endsWith('.gz') || req.url.endsWith('.br')) {
      return false;
    }
    return compression.filter(req, res);
  }
}));
app.use(express.json());

// High-speed pre-compressed asset serving for Pyodide WebAssembly engine
const pyodideDir = path.join(__dirname, 'public/vendor/pyodide');
app.get('/vendor/pyodide/:file', (req, res, next) => {
  const fileName = req.params.file;
  if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    return next();
  }
  const filePath = path.join(pyodideDir, fileName);
  if (!fs.existsSync(filePath)) {
    return next();
  }

  const acceptEncoding = req.headers['accept-encoding'] || '';
  const contentTypes = {
    '.wasm': 'application/wasm',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.zip': 'application/zip'
  };
  const ext = path.extname(fileName);
  if (contentTypes[ext]) {
    res.setHeader('Content-Type', contentTypes[ext]);
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');

  if (ext === '.zip') {
    return res.sendFile(filePath);
  }

  if (acceptEncoding.includes('br') && fs.existsSync(filePath + '.br')) {
    res.setHeader('Content-Encoding', 'br');
    return res.sendFile(filePath + '.br');
  } else if (acceptEncoding.includes('gzip') && fs.existsSync(filePath + '.gz')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.sendFile(filePath + '.gz');
  }

  return res.sendFile(filePath);
});

// Cache static vendor libraries (xterm, prism, fonts) aggressively
app.use('/vendor', express.static(path.join(__dirname, 'public/vendor'), {
  maxAge: '1y',
  immutable: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// In-memory Room Storage
const rooms = new Map();

// Map to hold pending synchronous XHR requests for user input
const pendingInputs = new Map();

// Helper to generate clean short IDs
function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// User color palette for collaborators
const USER_COLORS = [
  '#ff4a8d', '#00f0ff', '#7000ff', '#ffb703', '#06d6a0', 
  '#ef476f', '#118ab2', '#ffd166', '#a06cd5', '#e76f51'
];

function getColorForToken(token) {
  if (!token) return USER_COLORS[0];
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = (hash << 5) - hash + token.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % USER_COLORS.length;
  return USER_COLORS[index];
}

function getRandomColor() {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

// Starter code sample for Python
const DEFAULT_CODE = {
  python: `# Simple greeting and calculation program

name = input("What's your name? ")
age = int(input("How old are you? "))

# Calculate approximate birth year
current_year = 2026
birth_year = current_year - age

print(f"Hello, {name}! You were likely born in {birth_year}.")
`
};

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      title: `Session ${roomId.toUpperCase()}`,
      code: DEFAULT_CODE.python,
      activeFile: 'Untitled',
      openTabs: ['Untitled'],
      language: 'python',
      files: [],
      cwd: '/home/pyodide',
      sidebarCollapsed: false,
      chatDrawerCollapsed: false,
      consoleCollapsed: false,
      consoleExpanded: false,
      consoleHeight: null,
      outputScroll: { top: 0, line: 0 },
      activeDrawerTab: 'chat',
      collapsedFolders: [],
      selectedFolder: '',
      hostSocketId: null,
      hostToken: null,
      hostReconnectTimer: null,
      created: Date.now(),
      undoHistory: {}, // fileKey -> Array of snapshots
      redoHistory: {}, // fileKey -> Array of snapshots
      timer: {
        mode: 'countdown', // 'countdown' or 'stopwatch'
        duration: 300, // default 5 minutes (in seconds)
        remaining: 300, // seconds remaining
        elapsed: 0, // seconds elapsed (for stopwatch)
        isRunning: false,
        startedAt: null,
        targetEndTime: null
      },
      settings: {
        copyDisabled: false, // Copy allowed by default
        pasteDisabled: false,
        readOnly: false,
        liveSharingEnabled: false,
        locked: false,
        examMode: false
      },
      users: new Map(), // socketId -> User info
      voiceUsers: new Map(), // socketId -> { muted: boolean }
      joinedTokens: new Set(),
      leaveTimers: new Map(), // userToken -> timerId
      chat: [],
      lastActivity: Date.now()
    });
  }
  return rooms.get(roomId);
}

// Cleanup inactive rooms (1 hour inactivity)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.lastActivity > 60 * 60 * 1000) {
      io.to(roomId).emit('room-error', { message: 'Room has expired due to inactivity.', code: 'ROOM_EXPIRED' });
      rooms.delete(roomId);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

function getActiveRoomUsers(room) {
  if (!room || !room.users) return [];
  const activeList = Array.from(room.users.values()).filter(u => u.isHost || u.hasCustomName);
  
  // Deduplicate by token and lowercase name to prevent duplicates in collaborators list
  const seenTokens = new Set();
  const seenNames = new Set();
  const uniqueUsers = [];

  for (const u of activeList) {
    const normName = (u.name || '').trim().toLowerCase();
    const token = u.token;
    if (token && seenTokens.has(token)) {
      continue;
    }
    if (normName && seenNames.has(normName)) {
      continue;
    }
    if (token) seenTokens.add(token);
    if (normName) seenNames.add(normName);
    uniqueUsers.push(u);
  }

  return uniqueUsers;
}

// REST Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: rooms.size });
});

app.post('/api/rooms', (req, res) => {
  const roomId = generateRoomId();
  const room = getOrCreateRoom(roomId);
  if (req.body.language && DEFAULT_CODE[req.body.language]) {
    room.language = req.body.language;
    room.code = DEFAULT_CODE[req.body.language];
  }
  if (typeof req.body.copyDisabled === 'boolean') {
    room.settings.copyDisabled = req.body.copyDisabled;
  }
  if (req.body.userToken && typeof req.body.userToken === 'string') {
    room.hostToken = req.body.userToken.trim();
  }
  res.json({ roomId, roomUrl: `/room/${roomId}` });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const roomId = (req.params.roomId || '').trim().toLowerCase();
  if (!rooms.has(roomId)) {
    return res.status(404).json({ error: 'Room not found' });
  }
  const room = rooms.get(roomId);
  res.json({
    id: room.id,
    title: room.title,
    language: room.language,
    settings: room.settings,
    userCount: room.users.size,
    created: room.created
  });
});

// Synchronous Web Worker Input Endpoint
app.post('/api/sync-input', (req, res) => {
  const { roomId, promptText } = req.body;
  if (!roomId) {
    return res.status(400).send('');
  }

  const cleanRoomId = (roomId || 'default').trim().toLowerCase();
  
  // Forward the prompt text to all clients in the room to trigger input UI
  io.to(cleanRoomId).emit('output-update', { action: 'input_request', text: promptText || '' });
  
  if (rooms.has(cleanRoomId)) {
    rooms.get(cleanRoomId).lastActivity = Date.now();
  }

  const timeoutId = setTimeout(() => {
    if (pendingInputs.has(cleanRoomId) && pendingInputs.get(cleanRoomId).res === res) {
      pendingInputs.delete(cleanRoomId);
      res.send('');
    }
  }, 5 * 60 * 1000); // 5 minute timeout
  
  pendingInputs.set(cleanRoomId, { res, timeoutId });
});

// Serve frontend for /room/:id routes
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io Real-time Event Handling
io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentUser = null;

  socket.use((packet, next) => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      rooms.get(currentRoomId).lastActivity = Date.now();
    }
    next();
  });

  socket.on('kill-room', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      if (room.hostSocketId === socket.id || (currentUser && room.hostToken === currentUser.token)) {
        io.to(currentRoomId).emit('room-error', { message: 'The host has killed this room.', code: 'ROOM_KILLED' });
        rooms.delete(currentRoomId);
      }
    }
  });

  // Join Room
  socket.on('join-room', ({ roomId, username, userToken }) => {
    const cleanRoomId = (roomId || 'default').toLowerCase();
    const cleanUserToken = (typeof userToken === 'string' && userToken.trim()) ? userToken.trim() : ('usr_' + socket.id);
    const room = getOrCreateRoom(cleanRoomId);

    if (room.settings.locked && room.hostToken && room.hostToken !== cleanUserToken) {
      socket.emit('room-error', { message: 'This room is currently locked by the host.' });
      return;
    }

    currentRoomId = cleanRoomId;
    socket.join(cleanRoomId);

    // Cancel any pending leave timer if user is reconnecting
    if (cleanUserToken && room.leaveTimers && room.leaveTimers.has(cleanUserToken)) {
      clearTimeout(room.leaveTimers.get(cleanUserToken));
      room.leaveTimers.delete(cleanUserToken);
    }

    // Check if reconnecting user is the original Host
    if (room.hostToken && room.hostToken === cleanUserToken) {
      if (room.hostReconnectTimer) {
        clearTimeout(room.hostReconnectTimer);
        room.hostReconnectTimer = null;
      }
      room.hostSocketId = socket.id;
    } else if (!room.hostToken) {
      // First user or unclaimed room becomes Host
      room.hostSocketId = socket.id;
      room.hostToken = cleanUserToken;
    }

    const isHost = room.hostSocketId === socket.id;

    // Check if user has already joined this room (e.g., page refresh)
    const hasAlreadyJoined = cleanUserToken ? room.joinedTokens.has(cleanUserToken) : false;
    if (cleanUserToken) {
      room.joinedTokens.add(cleanUserToken);
    }

    currentUser = {
      id: socket.id,
      token: cleanUserToken,
      name: username || `User-${socket.id.substring(0, 4)}`,
      hasCustomName: Boolean(username && username.trim()),
      color: getColorForToken(cleanUserToken),
      isHost: isHost,
      cursor: { line: 1, ch: 1 },
      joinedAt: Date.now(),
      violations: { count: 0, tabSwitches: 0, blurCount: 0, fullscreenExits: 0, totalAwayMs: 0, logs: [] }
    };

    // Purge any stale socket entry for this userToken to avoid duplicate users
    if (cleanUserToken) {
      for (const [existingSocketId, existingUser] of room.users.entries()) {
        if (existingSocketId !== socket.id && existingUser.token === cleanUserToken) {
          if (existingUser.violations) {
            currentUser.violations = existingUser.violations;
          }
          room.users.delete(existingSocketId);
          if (room.voiceUsers) {
            room.voiceUsers.delete(existingSocketId);
          }
        }
      }
    }

    room.users.set(socket.id, currentUser);

    // Security check: If live code sharing is disabled, notify guest and hold in standby
    if (!isHost && !room.settings.liveSharingEnabled) {
      socket.emit('room-error', { 
        message: 'Live Code Sharing is currently turned OFF by the host. Access is paused.',
        code: 'LIVE_SHARING_OFF'
      });
      return;
    }

    // Send initial room state to joining user
    socket.emit('room-state', {
      roomId: room.id,
      code: room.code,
      activeFile: room.activeFile,
      openTabs: room.openTabs || (room.activeFile ? [room.activeFile] : ['Untitled']),
      language: room.language,
      files: room.files || [],
      cwd: room.cwd || '/home/pyodide',
      sidebarCollapsed: room.sidebarCollapsed ?? false,
      chatDrawerCollapsed: room.chatDrawerCollapsed ?? false,
      consoleCollapsed: room.consoleCollapsed ?? false,
      consoleExpanded: room.consoleExpanded ?? false,
      consoleHeight: room.consoleHeight ?? null,
      outputScroll: room.outputScroll || { top: 0, line: 0 },
      activeDrawerTab: room.activeDrawerTab || 'chat',
      collapsedFolders: room.collapsedFolders || [],
      selectedFolder: room.selectedFolder || '',
      settings: room.settings,
      currentUser: currentUser,
      isHost: currentUser.isHost,
      users: getActiveRoomUsers(room),
      voiceParticipants: Array.from((room.voiceUsers || new Map()).entries()).map(([sid, vState]) => {
        const u = room.users.get(sid);
        return {
          id: sid,
          name: u ? u.name : 'User',
          color: u ? u.color : '#00f0ff',
          isHost: u ? u.isHost : false,
          muted: vState.muted
        };
      }),
      timer: room.timer,
      serverTime: Date.now(),
      undoHistory: room.undoHistory || {},
      redoHistory: room.redoHistory || {},
      chat: room.chat
    });

    // Notify room of user list update
    io.to(cleanRoomId).emit('users-update', {
      users: getActiveRoomUsers(room)
    });

    // Send system message in chat:
    // Only send join message if user is host or if a custom username was already supplied (and user hasn't already joined)
    if (room.settings.liveSharingEnabled && !hasAlreadyJoined && (isHost || (username && username.trim()))) {
      const sysMessage = {
        id: Date.now().toString(),
        sender: 'System',
        text: `${currentUser.name} joined the room.`,
        isSystem: true,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      room.chat.push(sysMessage);
      socket.to(cleanRoomId).emit('chat-message', sysMessage);
    }
  });

  // Code Change Sync
  const handleCodeChange = ({ code, cursor, activeFile, openTabs }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);

    // Stop live code sharing if host turned it OFF
    if (!room.settings.liveSharingEnabled) return;

    // If read-only mode is active and user is not host
    if (room.settings.readOnly && room.hostSocketId !== socket.id) {
      socket.emit('protection-alert', { message: 'Room is currently in Read-Only mode.' });
      return;
    }

    if (code !== undefined) {
      room.code = code;
    }
    if (activeFile !== undefined) {
      room.activeFile = activeFile;
    }
    if (Array.isArray(openTabs)) {
      room.openTabs = openTabs;
    }
    
    if (currentUser && cursor) {
      currentUser.cursor = cursor;
    }

    // Broadcast updated code to other users in room
    socket.to(currentRoomId).emit('code-update', {
      code: room.code,
      senderId: socket.id,
      cursor: cursor,
      activeFile: room.activeFile,
      openTabs: room.openTabs
    });
  };

  socket.on('code-change', handleCodeChange);
  socket.on('code-update', handleCodeChange);

  socket.on('file-system-sync', ({ files, cwd, sidebarCollapsed, collapsedFolders }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (files !== undefined) room.files = files;
    if (cwd !== undefined) room.cwd = cwd;
    if (sidebarCollapsed !== undefined) room.sidebarCollapsed = sidebarCollapsed;
    if (Array.isArray(collapsedFolders)) room.collapsedFolders = collapsedFolders;
    socket.to(currentRoomId).emit('file-system-update', {
      files: room.files,
      cwd: room.cwd,
      sidebarCollapsed: room.sidebarCollapsed,
      collapsedFolders: room.collapsedFolders
    });
  });

  socket.on('sidebar-toggle', ({ collapsed, collapsedFolders }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (collapsed !== undefined) room.sidebarCollapsed = collapsed;
    if (Array.isArray(collapsedFolders)) room.collapsedFolders = collapsedFolders;
    socket.to(currentRoomId).emit('sidebar-update', {
      collapsed: room.sidebarCollapsed,
      collapsedFolders: room.collapsedFolders
    });
  });

  socket.on('chat-drawer-toggle', ({ collapsed }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (collapsed !== undefined) room.chatDrawerCollapsed = collapsed;
    socket.to(currentRoomId).emit('chat-drawer-update', {
      collapsed: room.chatDrawerCollapsed
    });
  });

  socket.on('drawer-tab-switch', ({ tab }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (tab) room.activeDrawerTab = tab;
    socket.to(currentRoomId).emit('drawer-tab-update', {
      tab: room.activeDrawerTab
    });
  });

  socket.on('console-toggle', ({ collapsed, expanded, height, isDragging, color }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (collapsed !== undefined) room.consoleCollapsed = collapsed;
    if (expanded !== undefined) room.consoleExpanded = expanded;
    if (height !== undefined) room.consoleHeight = height;
    const userColor = color || (room.users.get(socket.id) ? room.users.get(socket.id).color : null);
    socket.to(currentRoomId).emit('console-update', {
      collapsed: room.consoleCollapsed,
      expanded: room.consoleExpanded,
      height: room.consoleHeight,
      isDragging,
      color: userColor
    });
  });

  socket.on('console-drag', ({ isDragging, color }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    const userColor = color || (room.users.get(socket.id) ? room.users.get(socket.id).color : null);
    socket.to(currentRoomId).emit('console-drag-update', { isDragging, color: userColor });
  });

  // Real-time UI & Button Hover Sync
  socket.on('btn-hover', ({ btnId, isHovered, color }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    const userColor = color || (room.users.get(socket.id) ? room.users.get(socket.id).color : null);
    socket.to(currentRoomId).emit('btn-hover-update', { btnId, isHovered, color: userColor });
  });

  socket.on('tab-close-hover', ({ tabName, isHovered }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tab-close-hover-update', { tabName, isHovered });
  });

  socket.on('tab-hover', ({ tabName, isHovered, color }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    const userColor = color || (room.users.get(socket.id) ? room.users.get(socket.id).color : null);
    socket.to(currentRoomId).emit('tab-hover-update', { tabName, isHovered, color: userColor });
  });

  // Real-time File Tree Hover & Typing Interactions
  socket.on('tree-hover', ({ path, isHovered }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-hover-update', { path, isHovered, userId: socket.id });
  });

  socket.on('tree-action-hover', ({ path, action, isHovered }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-action-hover-update', { path, action, isHovered, userId: socket.id });
  });

  socket.on('tree-rename-start', ({ path, initialName, cursor }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-rename-start', { path, initialName, cursor, senderId: socket.id });
  });

  socket.on('tree-rename-input', ({ path, value, cursor }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-rename-input', { path, value, cursor, senderId: socket.id });
  });

  socket.on('tree-rename-cursor', ({ path, cursor }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-rename-cursor-update', { path, cursor, senderId: socket.id });
  });

  socket.on('tree-rename-end', ({ path }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-rename-end', { path, senderId: socket.id });
  });

  socket.on('tree-create-start', ({ type, parentFolder, cursor }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-create-start', { type, parentFolder, cursor, senderId: socket.id });
  });

  socket.on('tree-create-input', ({ value, cursor }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-create-input', { value, cursor, senderId: socket.id });
  });

  socket.on('tree-create-cursor', ({ cursor }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-create-cursor-update', { cursor, senderId: socket.id });
  });

  socket.on('tree-create-end', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-create-end', { senderId: socket.id });
  });

  socket.on('tree-select', ({ path }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    room.selectedFolder = path || '';
    socket.to(currentRoomId).emit('tree-select-update', {
      path: room.selectedFolder,
      userId: socket.id
    });
  });

  // Real-time Tree Drag & Drop Sync
  socket.on('tree-drag-start', ({ path }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-drag-start-update', {
      path: path,
      userId: socket.id
    });
  });

  socket.on('tree-drag-over', ({ targetPath, isFolder, isRoot }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-drag-over-update', {
      targetPath,
      isFolder,
      isRoot,
      userId: socket.id
    });
  });

  socket.on('tree-drag-leave', ({ targetPath, isRoot }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-drag-leave-update', {
      targetPath,
      isRoot,
      userId: socket.id
    });
  });

  socket.on('tree-drag-end', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('tree-drag-end-update', {
      userId: socket.id
    });
  });

  // Cursor position updates
  socket.on('cursor-change', (cursor) => {
    if (!currentRoomId || !currentUser || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    currentUser.cursor = cursor;
    socket.to(currentRoomId).emit('cursor-update', {
      userId: socket.id,
      cursor: cursor
    });
  });

  socket.on('clear-selections', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('clear-selections');
  });

  // Real-time mouse movement tracking
  socket.on('mouse-move', (data) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('mouse-update', {
      ...data,
      userId: socket.id
    });
  });

  // Real-time scrolling sync
  socket.on('scroll-sync', ({ top, left }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('scroll-update', {
      userId: socket.id,
      top: top,
      left: left
    });
  });

  // Real-time output scrolling sync
  socket.on('output-scroll-sync', ({ top, line }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (top !== undefined || line !== undefined) {
      room.outputScroll = {
        top: top !== undefined ? top : (room.outputScroll ? room.outputScroll.top : 0),
        line: line !== undefined ? line : (room.outputScroll ? room.outputScroll.line : 0)
      };
    }
    socket.to(currentRoomId).emit('output-scroll-update', {
      userId: socket.id,
      top: top,
      line: line
    });
  });

  // Language Change Sync
  socket.on('language-change', ({ language }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!language || room.language === language) return;
    room.language = language;

    // Default snippet if empty or template
    if (DEFAULT_CODE[language] && (room.code === '' || Object.values(DEFAULT_CODE).includes(room.code))) {
      room.code = DEFAULT_CODE[language];
      io.to(currentRoomId).emit('code-update', { code: room.code, senderId: null });
    }

    io.to(currentRoomId).emit('language-update', { language });

    const sysMessage = {
      id: Date.now().toString(),
      sender: 'System',
      text: `Language changed to ${language.toUpperCase()} by ${currentUser ? currentUser.name : 'user'}.`,
      isSystem: true,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.chat.push(sysMessage);
    io.to(currentRoomId).emit('chat-message', sysMessage);
  });

  // Dropdown Focus Sync
  socket.on('dropdown-focus', ({ isFocused }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('dropdown-focus-update', { isFocused });
  });

  // Language Dropdown Open/Close Sync
  socket.on('language-dropdown-toggle', ({ isOpen }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('language-dropdown-update', { isOpen });
  });

  // Language Dropdown Item Hover Sync
  socket.on('language-dropdown-item-hover', ({ value, isHovered }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('language-dropdown-item-hover-update', { value, isHovered });
  });

  // Timer Dropdown Open/Close Sync
  socket.on('timer-dropdown-toggle', ({ isOpen }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('timer-dropdown-update', { isOpen, userId: socket.id });
  });

  // Timer Dropdown Item Hover Sync
  socket.on('timer-dropdown-item-hover', ({ itemId, isHovered }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('timer-dropdown-item-hover-update', { itemId, isHovered, userId: socket.id });
  });

  // Editor Context Menu Open/Close & Position Sync
  socket.on('context-menu-toggle', ({ isOpen, x, y }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('context-menu-update', { isOpen, x, y, userId: socket.id });
  });

  // Context Menu Item Hover Sync
  socket.on('context-menu-item-hover', ({ itemId, isHovered }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('context-menu-item-hover-update', { itemId, isHovered, userId: socket.id });
  });

  // Console Copy Tick Mark Sync
  socket.on('console-copy-tick', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('console-copy-tick-update', { userId: socket.id });
  });

  // Shared Common Room Undo / Redo State Sync
  socket.on('undo-redo-sync', ({ fileKey, undoStack, redoStack, action, code, cursor }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.undoHistory) room.undoHistory = {};
    if (!room.redoHistory) room.redoHistory = {};

    const key = fileKey || room.activeFile || 'Untitled';
    if (Array.isArray(undoStack)) {
      room.undoHistory[key] = undoStack.slice(-150);
    }
    if (Array.isArray(redoStack)) {
      room.redoHistory[key] = redoStack.slice(-150);
    }

    if (code !== undefined) {
      room.code = code;
    }

    socket.to(currentRoomId).emit('undo-redo-update', {
      fileKey: key,
      undoStack: room.undoHistory[key] || [],
      redoStack: room.redoHistory[key] || [],
      action,
      code,
      cursor,
      senderId: socket.id,
      senderName: currentUser ? currentUser.name : 'Collaborator'
    });
  });

  // Real-Time Output Sync Listener
  socket.on('output-sync', (data) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('output-update', {
      ...data,
      senderId: socket.id,
      senderName: currentUser ? currentUser.name : 'User'
    });
  });

  // Execution Request Listeners (Routing execution requests to Room Host)
  socket.on('request-run-code', ({ code }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('execute-on-host', { code });
    } else {
      socket.emit('protection-alert', { message: 'Host is currently offline. Cannot execute code.' });
    }
  });

  socket.on('update-username', ({ username }) => {
    if (!currentRoomId || !rooms.has(currentRoomId) || !currentUser) return;
    const room = rooms.get(currentRoomId);
    const cleanName = (username || '').trim();
    if (cleanName) {
      const wasCustomSet = currentUser.hasCustomName;
      currentUser.name = cleanName;
      currentUser.hasCustomName = true;
      io.to(currentRoomId).emit('users-update', {
        users: getActiveRoomUsers(room)
      });

      // If guest just gave their custom username for the first time in an active live session, announce in chat
      if (!wasCustomSet && !currentUser.isHost && room.settings.liveSharingEnabled) {
        const sysMessage = {
          id: Date.now().toString(),
          sender: 'System',
          text: `${currentUser.name} joined the room.`,
          isSystem: true,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        room.chat.push(sysMessage);
        io.to(currentRoomId).emit('chat-message', sysMessage);
      }
    }
  });

  socket.on('request-terminate-code', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    
    // Unblock any pending inputs for this room if execution is terminated
    if (pendingInputs.has(currentRoomId)) {
      const pending = pendingInputs.get(currentRoomId);
      clearTimeout(pending.timeoutId);
      pendingInputs.delete(currentRoomId);
      pending.res.send('\n');
    }
    
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('terminate-on-host');
    }
  });

  socket.on('request-shell-command', ({ command, currentCode, activeFile, openTabs, skipPrompt }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (Array.isArray(openTabs)) {
      room.openTabs = openTabs;
    }
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('execute-shell', { command, currentCode, activeFile, openTabs, skipPrompt });
    }
  });

  socket.on('provide-input', ({ text }) => {
    if (!currentRoomId) return;
    if (pendingInputs.has(currentRoomId)) {
      const pending = pendingInputs.get(currentRoomId);
      clearTimeout(pending.timeoutId);
      pendingInputs.delete(currentRoomId);
      pending.res.send(text);
    }
  });

  // Security & Protection Settings Toggle (Copy / Paste / ReadOnly / Lock)
  socket.on('update-settings', (newSettings) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);

    if (socket.id !== room.hostSocketId) {
      socket.emit('protection-alert', { message: '⚠️ Only the room host can modify security controls.' });
      return;
    }

    // Merge settings
    room.settings = { ...room.settings, ...newSettings };

    // If host disabled live sharing, send notice to guests
    if (newSettings.liveSharingEnabled === false) {
      for (const [sockId, usr] of room.users.entries()) {
        if (!usr.isHost && sockId !== room.hostSocketId) {
          const guestSock = io.sockets.sockets.get(sockId);
          if (guestSock) {
            guestSock.emit('room-error', { 
              message: 'The host has turned OFF Live Code Sharing. Access is paused.',
              code: 'LIVE_SHARING_OFF'
            });
          }
        }
      }
    } else if (newSettings.liveSharingEnabled === true) {
      // If host re-enabled live sharing, re-admit all connected guest sockets with full room state
      for (const [sockId, usr] of room.users.entries()) {
        if (!usr.isHost && sockId !== room.hostSocketId) {
          const guestSock = io.sockets.sockets.get(sockId);
          if (guestSock) {
            guestSock.emit('live-sharing-resumed', {
              roomId: room.id,
              code: room.code,
              activeFile: room.activeFile,
              openTabs: room.openTabs || (room.activeFile ? [room.activeFile] : ['Untitled']),
              language: room.language,
              files: room.files || [],
              cwd: room.cwd || '/home/pyodide',
              sidebarCollapsed: room.sidebarCollapsed ?? false,
              chatDrawerCollapsed: room.chatDrawerCollapsed ?? false,
              consoleCollapsed: room.consoleCollapsed ?? false,
              consoleExpanded: room.consoleExpanded ?? false,
              consoleHeight: room.consoleHeight ?? null,
              outputScroll: room.outputScroll || { top: 0, line: 0 },
              activeDrawerTab: room.activeDrawerTab || 'chat',
              collapsedFolders: room.collapsedFolders || [],
              selectedFolder: room.selectedFolder || '',
              settings: room.settings,
              currentUser: usr,
              isHost: false,
              users: getActiveRoomUsers(room),
              timer: room.timer,
              serverTime: Date.now(),
              chat: room.chat
            });
          }
        }
      }
    }

    // If host enabled exam mode, configure room timer atomically to exact exam duration
    if (newSettings.examMode === true) {
      if (!room.timer) {
        room.timer = {
          mode: 'countdown',
          duration: 300,
          remaining: 300,
          elapsed: 0,
          isRunning: false,
          startedAt: null,
          targetEndTime: null
        };
      }
      const dur = Math.max(1, parseInt(newSettings.examDuration || room.timer.duration || 300, 10));
      room.timer.mode = 'countdown';
      room.timer.duration = dur;
      room.timer.remaining = dur;
      room.timer.isRunning = false;
      room.timer.startedAt = null;
      room.timer.targetEndTime = null;
      io.to(currentRoomId).emit('timer-update', {
        timer: room.timer,
        senderId: socket.id,
        senderName: currentUser ? currentUser.name : 'Host',
        action: 'set-duration',
        serverTime: Date.now()
      });
    } else if (newSettings.examMode === false && room.timer) {
      // If host disabled exam mode, reset room timer
      room.timer.isRunning = false;
      room.timer.startedAt = null;
      room.timer.targetEndTime = null;
      if (room.timer.mode === 'countdown') {
        room.timer.remaining = room.timer.duration || 300;
      } else {
        room.timer.elapsed = 0;
      }
      io.to(currentRoomId).emit('timer-update', {
        timer: room.timer,
        senderId: socket.id,
        senderName: currentUser ? currentUser.name : 'Host',
        action: 'reset',
        silent: true,
        serverTime: Date.now()
      });
    }

    // Broadcast settings update to everyone in room
    io.to(currentRoomId).emit('settings-update', {
      settings: room.settings,
      updatedBy: currentUser ? currentUser.name : 'Host'
    });
  });

  // Copy Violation Report (When user attempts to copy while copy protection is enabled)
  socket.on('copy-violation-attempt', ({ type }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    
    // Broadcast notification or log attempt if desired
    const noticeMsg = {
      id: Date.now().toString(),
      sender: 'Security Shield',
      text: `⚠️ Copy attempt blocked for user ${currentUser ? currentUser.name : 'Unknown'}.`,
      isSystem: true,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    // Emit to host only or all users for audit
    socket.emit('protection-alert', { message: 'Copying code is disabled in this room by the owner.' });
  });

  // Anti-Cheat & Exam Proctor Violation Report (Tab switch, window blur, fullscreen exit)
  socket.on('proctor-violation', ({ type, details, awayMs }) => {
    if (!currentRoomId || !rooms.has(currentRoomId) || !currentUser) return;
    const room = rooms.get(currentRoomId);

    // Hosts do not log proctor violations
    if (currentUser.isHost || socket.id === room.hostSocketId) return;

    if (!currentUser.violations) {
      currentUser.violations = { count: 0, tabSwitches: 0, blurCount: 0, fullscreenExits: 0, totalAwayMs: 0, logs: [] };
    }

    currentUser.violations.count += 1;
    const validAwayMs = typeof awayMs === 'number' && !isNaN(awayMs) ? Math.max(0, awayMs) : 0;

    if (type === 'TAB_SWITCH') {
      currentUser.violations.tabSwitches += 1;
      currentUser.violations.totalAwayMs += validAwayMs;
    } else if (type === 'WINDOW_BLUR') {
      currentUser.violations.blurCount += 1;
      currentUser.violations.totalAwayMs += validAwayMs;
    } else if (type === 'FULLSCREEN_EXIT') {
      currentUser.violations.fullscreenExits += 1;
    }

    const logEntry = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
      type: type || 'UNKNOWN',
      details: details || 'Proctor policy violation',
      awayMs: validAwayMs,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };

    if (!Array.isArray(currentUser.violations.logs)) {
      currentUser.violations.logs = [];
    }
    currentUser.violations.logs.push(logEntry);
    if (currentUser.violations.logs.length > 50) {
      currentUser.violations.logs.shift();
    }

    // Direct alert to Room Host
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('proctor-alert', {
        user: {
          id: socket.id,
          name: currentUser.name,
          token: currentUser.token,
          violations: currentUser.violations
        },
        violation: logEntry
      });
    }

    // Broadcast updated users list with violation counters
    io.to(currentRoomId).emit('users-update', {
      users: getActiveRoomUsers(room)
    });
  });

  // Host Action: Clear violations for a specific candidate
  socket.on('clear-user-violations', ({ targetUserId }) => {
    if (!currentRoomId || !rooms.has(currentRoomId) || !currentUser) return;
    const room = rooms.get(currentRoomId);
    if (!currentUser.isHost && socket.id !== room.hostSocketId) return;

    const targetUser = room.users.get(targetUserId);
    if (targetUser) {
      targetUser.violations = { count: 0, tabSwitches: 0, blurCount: 0, fullscreenExits: 0, totalAwayMs: 0, logs: [] };
      io.to(currentRoomId).emit('users-update', {
        users: getActiveRoomUsers(room)
      });
    }
  });

  // Chat message
  socket.on('send-chat', ({ text }) => {
    if (!currentRoomId || !rooms.has(currentRoomId) || !text.trim()) return;
    const room = rooms.get(currentRoomId);
    const msg = {
      id: Date.now().toString(),
      sender: currentUser ? currentUser.name : 'User',
      color: currentUser ? currentUser.color : '#ff4a8d',
      text: text.trim(),
      isSystem: false,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.chat.push(msg);
    // Keep last 100 messages
    if (room.chat.length > 100) room.chat.shift();
    io.to(currentRoomId).emit('chat-message', msg);
  });

  // Real-time Voice Call WebRTC Signaling & State
  socket.on('voice-join', ({ muted = false } = {}) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.voiceUsers) room.voiceUsers = new Map();

    room.voiceUsers.set(socket.id, { muted: Boolean(muted) });

    const voiceParticipants = Array.from(room.voiceUsers.entries()).map(([sid, vState]) => {
      const u = room.users.get(sid);
      return {
        id: sid,
        name: u ? u.name : 'User',
        color: u ? u.color : '#00f0ff',
        isHost: u ? u.isHost : false,
        muted: vState.muted
      };
    });

    // Notify others in the room
    const selfUser = room.users.get(socket.id);
    socket.to(currentRoomId).emit('voice-user-joined', {
      userId: socket.id,
      name: selfUser ? selfUser.name : 'User',
      color: selfUser ? selfUser.color : '#00f0ff',
      isHost: selfUser ? selfUser.isHost : false,
      muted: Boolean(muted),
      participants: voiceParticipants
    });

    // Send the current active voice participants back to the joining socket
    socket.emit('voice-state', {
      inCall: true,
      participants: voiceParticipants
    });
  });

  socket.on('voice-leave', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.voiceUsers) return;

    if (room.voiceUsers.has(socket.id)) {
      room.voiceUsers.delete(socket.id);
      const remainingParticipants = Array.from(room.voiceUsers.entries()).map(([sid, vState]) => {
        const u = room.users.get(sid);
        return {
          id: sid,
          name: u ? u.name : 'User',
          color: u ? u.color : '#00f0ff',
          isHost: u ? u.isHost : false,
          muted: vState.muted
        };
      });

      socket.to(currentRoomId).emit('voice-user-left', {
        userId: socket.id,
        participants: remainingParticipants
      });
      socket.emit('voice-state', {
        inCall: false,
        participants: remainingParticipants
      });
    }
  });

  socket.on('voice-mute-toggle', ({ muted }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.voiceUsers || !room.voiceUsers.has(socket.id)) return;

    room.voiceUsers.get(socket.id).muted = Boolean(muted);
    io.to(currentRoomId).emit('voice-mute-update', {
      userId: socket.id,
      muted: Boolean(muted)
    });
  });

  // WebRTC 1-to-1 peer signaling
  socket.on('voice-signal', ({ targetUserId, signal }) => {
    if (!currentRoomId || !targetUserId || !signal) return;
    io.to(targetUserId).emit('voice-signal', {
      fromUserId: socket.id,
      signal
    });
  });

  // Timer Actions (Start, Pause, Reset, Finish, Switch Mode, Set Preset)
  socket.on('timer-action', ({ action, mode, duration, customSeconds }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.timer) {
      room.timer = {
        mode: 'countdown',
        duration: 300,
        remaining: 300,
        elapsed: 0,
        isRunning: false,
        startedAt: null,
        targetEndTime: null
      };
    }

    // In Exam Mode, non-hosts cannot modify the timer (except starting the initial countdown via Start Test)
    if (room.settings && room.settings.examMode && socket.id !== room.hostSocketId) {
      if (action !== 'start' || (room.timer && room.timer.isRunning)) {
        socket.emit('protection-alert', { message: '⚠️ Timer controls are restricted to the host during Exam Mode.' });
        return;
      }
    }

    const t = room.timer;
    const now = Date.now();

    if (action === 'start') {
      if (!t.isRunning) {
        t.isRunning = true;
        t.startedAt = now;
        if (t.mode === 'countdown') {
          // If already has remaining seconds, targetEndTime is now + remaining * 1000
          const rem = (typeof t.remaining === 'number' && t.remaining > 0) ? t.remaining : (t.duration || 300);
          t.remaining = rem;
          t.targetEndTime = now + (rem * 1000);
        } else {
          // Stopwatch
          t.targetEndTime = null;
        }
      }
    } else if (action === 'pause') {
      if (t.isRunning) {
        t.isRunning = false;
        if (t.mode === 'countdown') {
          if (t.targetEndTime) {
            t.remaining = Math.max(0, Math.round((t.targetEndTime - now) / 1000));
          }
          t.targetEndTime = null;
        } else {
          if (t.startedAt) {
            t.elapsed = Math.max(0, (t.elapsed || 0) + Math.round((now - t.startedAt) / 1000));
          }
          t.startedAt = null;
        }
      }
    } else if (action === 'reset') {
      t.isRunning = false;
      t.startedAt = null;
      t.targetEndTime = null;
      if (t.mode === 'countdown') {
        t.remaining = t.duration || 300;
      } else {
        t.elapsed = 0;
      }
    } else if (action === 'set-mode') {
      const newMode = (mode === 'stopwatch') ? 'stopwatch' : 'countdown';
      t.mode = newMode;
      t.isRunning = false;
      t.startedAt = null;
      t.targetEndTime = null;
      if (newMode === 'countdown') {
        if (duration) t.duration = Math.max(1, parseInt(duration, 10));
        t.remaining = t.duration;
      } else {
        t.elapsed = 0;
      }
    } else if (action === 'set-duration') {
      const newDur = Math.max(1, parseInt(duration || customSeconds || 300, 10));
      t.duration = newDur;
      t.remaining = newDur;
      t.isRunning = false;
      t.startedAt = null;
      t.targetEndTime = null;
      t.mode = 'countdown';
    } else if (action === 'complete') {
      // Alarm reached 0: Countdown finished
      t.isRunning = false;
      t.remaining = 0;
      t.startedAt = null;
      t.targetEndTime = null;

      // Lock code editing for guests by enabling readOnly mode
      room.settings.readOnly = true;

      // Broadcast settings-update so all clients lock their editors
      io.to(currentRoomId).emit('settings-update', {
        settings: room.settings,
        updatedBy: 'Countdown Timer'
      });
    }

    io.to(currentRoomId).emit('timer-update', {
      timer: t,
      senderId: socket.id,
      senderName: currentUser ? currentUser.name : 'Collaborator',
      action: action,
      serverTime: Date.now()
    });
  });

  socket.on('disconnect', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      room.users.delete(socket.id);

      // Clean up voice call state if active
      if (room.voiceUsers && room.voiceUsers.has(socket.id)) {
        room.voiceUsers.delete(socket.id);
        const remainingVoiceParticipants = Array.from(room.voiceUsers.entries()).map(([sid, vState]) => {
          const u = room.users.get(sid);
          return {
            id: sid,
            name: u ? u.name : 'User',
            color: u ? u.color : '#00f0ff',
            isHost: u ? u.isHost : false,
            muted: vState.muted
          };
        });
        socket.to(currentRoomId).emit('voice-user-left', {
          userId: socket.id,
          participants: remainingVoiceParticipants
        });
      }

      // Handle Host disconnect with grace period for page refresh
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = null;
        if (room.hostReconnectTimer) {
          clearTimeout(room.hostReconnectTimer);
        }

        room.hostReconnectTimer = setTimeout(() => {
          if (rooms.has(currentRoomId)) {
            const currentRoom = rooms.get(currentRoomId);
            if (currentRoom.hostSocketId === null) {
              const remainingUsers = Array.from(currentRoom.users.values());
              if (remainingUsers.length > 0) {
                const newHost = remainingUsers[0];
                currentRoom.hostSocketId = newHost.id;
                currentRoom.hostToken = newHost.token;
                newHost.isHost = true;

                io.to(newHost.id).emit('host-assigned', { isHost: true });
                io.to(currentRoomId).emit('users-update', {
                  users: getActiveRoomUsers(currentRoom)
                });
              } else {
                currentRoom.hostToken = null;
                currentRoom.hostReconnectTimer = null;
              }
            }
          }
        }, 15000);
      }

      // If room is empty, set cleanup timer (1 hour)
      if (room.users.size === 0) {
        setTimeout(() => {
          if (rooms.has(currentRoomId) && rooms.get(currentRoomId).users.size === 0) {
            rooms.delete(currentRoomId);
          }
        }, 3600000);
      } else {
        io.to(currentRoomId).emit('users-update', {
          users: getActiveRoomUsers(room)
        });
        if (currentUser && currentUser.token && (currentUser.isHost || currentUser.hasCustomName) && room.settings.liveSharingEnabled) {
          const departingUserToken = currentUser.token;
          const departingUserName = currentUser.name;
          const targetRoomId = currentRoomId;

          // Clear previous timer for this user token if any exists
          if (room.leaveTimers && room.leaveTimers.has(departingUserToken)) {
            clearTimeout(room.leaveTimers.get(departingUserToken));
            room.leaveTimers.delete(departingUserToken);
          }

          // Grace period to check if user simply refreshed the browser
          const timerId = setTimeout(() => {
            if (rooms.has(targetRoomId)) {
              const currentRoom = rooms.get(targetRoomId);
              if (currentRoom.leaveTimers) {
                currentRoom.leaveTimers.delete(departingUserToken);
              }
              const isStillPresent = Array.from(currentRoom.users.values()).some(u => u.token === departingUserToken);
              if (!isStillPresent && currentRoom.settings.liveSharingEnabled) {
                const sysMsg = {
                  id: Date.now().toString(),
                  sender: 'System',
                  text: `${departingUserName} left the room.`,
                  isSystem: true,
                  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                };
                currentRoom.chat.push(sysMsg);
                io.to(targetRoomId).emit('chat-message', sysMsg);
              }
            }
          }, 2500);

          if (room.leaveTimers) {
            room.leaveTimers.set(departingUserToken, timerId);
          }
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`⚡ LiveCode Service running on http://localhost:${PORT}`);
  });
}

module.exports = app;

