const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
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
  python: ``
};

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      title: `Session ${roomId.toUpperCase()}`,
      code: DEFAULT_CODE.python,
      activeFile: 'Untitled',
      language: 'python',
      files: [],
      cwd: '/home/pyodide',
      hostSocketId: null,
      hostToken: null,
      hostReconnectTimer: null,
      created: Date.now(),
      settings: {
        copyDisabled: true, // Default enabled protection
        pasteDisabled: false,
        readOnly: false,
        liveSharingEnabled: false,
        locked: false
      },
      users: new Map(), // socketId -> User info
      joinedTokens: new Set(),
      leaveTimers: new Map(), // userToken -> timerId
      chat: []
    });
  }
  return rooms.get(roomId);
}

function getActiveRoomUsers(room) {
  if (!room || !room.users) return [];
  return Array.from(room.users.values()).filter(u => u.isHost || u.hasCustomName);
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
  res.json({ roomId, roomUrl: `/room/${roomId}` });
});

app.get('/api/rooms/:roomId', (req, res) => {
  const roomId = req.params.roomId;
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
  
  // Forward the prompt text to all clients in the room to trigger input UI
  io.to(roomId).emit('output-update', { action: 'input_request', text: promptText || '' });

  const timeoutId = setTimeout(() => {
    if (pendingInputs.has(roomId) && pendingInputs.get(roomId).res === res) {
      pendingInputs.delete(roomId);
      res.send('');
    }
  }, 5 * 60 * 1000); // 5 minute timeout
  
  pendingInputs.set(roomId, { res, timeoutId });
});

// Serve frontend for /room/:id routes
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io Real-time Event Handling
io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentUser = null;

  // Join Room
  socket.on('join-room', ({ roomId, username, userToken }) => {
    const cleanRoomId = (roomId || 'default').toLowerCase();
    const room = getOrCreateRoom(cleanRoomId);

    if (room.settings.locked && room.users.size > 0 && room.hostToken !== userToken) {
      socket.emit('room-error', { message: 'This room is currently locked by the host.' });
      return;
    }

    currentRoomId = cleanRoomId;
    socket.join(cleanRoomId);

    // Cancel any pending leave timer if user is reconnecting
    if (userToken && room.leaveTimers && room.leaveTimers.has(userToken)) {
      clearTimeout(room.leaveTimers.get(userToken));
      room.leaveTimers.delete(userToken);
    }

    // Check if reconnecting user is the original Host
    if (room.hostToken && room.hostToken === userToken) {
      if (room.hostReconnectTimer) {
        clearTimeout(room.hostReconnectTimer);
        room.hostReconnectTimer = null;
      }
      room.hostSocketId = socket.id;
    } else if (room.users.size === 0 || room.hostSocketId === null || !room.hostToken) {
      // First user or unclaimed room becomes Host
      room.hostSocketId = socket.id;
      room.hostToken = userToken;
    }

    const isHost = room.hostSocketId === socket.id;

    // Check if user has already joined this room (e.g., page refresh)
    const hasAlreadyJoined = userToken ? room.joinedTokens.has(userToken) : false;
    if (userToken) {
      room.joinedTokens.add(userToken);
    }

    currentUser = {
      id: socket.id,
      token: userToken,
      name: username || `User-${socket.id.substring(0, 4)}`,
      hasCustomName: Boolean(username && username.trim()),
      color: getColorForToken(userToken),
      isHost: isHost,
      cursor: { line: 1, ch: 1 },
      joinedAt: Date.now()
    };

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
      language: room.language,
      files: room.files || [],
      cwd: room.cwd || '/home/pyodide',
      settings: room.settings,
      currentUser: currentUser,
      isHost: currentUser.isHost,
      users: getActiveRoomUsers(room),
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
  socket.on('code-change', ({ code, cursor, activeFile }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);

    // Stop live code sharing if host turned it OFF
    if (!room.settings.liveSharingEnabled) return;

    // If read-only mode is active and user is not host
    if (room.settings.readOnly && room.hostSocketId !== socket.id) {
      socket.emit('protection-alert', { message: 'Room is currently in Read-Only mode.' });
      return;
    }

    room.code = code;
    if (activeFile) {
      room.activeFile = activeFile;
    }
    
    if (currentUser && cursor) {
      currentUser.cursor = cursor;
    }

    // Broadcast updated code to other users in room
    socket.to(currentRoomId).emit('code-update', {
      code: code,
      senderId: socket.id,
      cursor: cursor,
      activeFile: room.activeFile
    });
  });

  socket.on('file-system-sync', ({ files, cwd }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    room.files = files;
    room.cwd = cwd;
    socket.to(currentRoomId).emit('file-system-update', { files, cwd });
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
  socket.on('mouse-move', ({ x, y }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (!room.settings.liveSharingEnabled) return;
    socket.to(currentRoomId).emit('mouse-update', {
      userId: socket.id,
      x: x,
      y: y
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
  socket.on('output-scroll-sync', ({ top }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('output-scroll-update', {
      userId: socket.id,
      top: top
    });
  });

  // Language Change Sync
  socket.on('language-change', ({ language }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
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

  socket.on('request-shell-command', ({ command, currentCode, activeFile, skipPrompt }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('execute-shell', { command, currentCode, activeFile, skipPrompt });
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
              language: room.language,
              files: room.files || [],
              cwd: room.cwd || '/home/pyodide',
              settings: room.settings,
              currentUser: usr,
              isHost: false,
              users: getActiveRoomUsers(room),
              chat: room.chat
            });
          }
        }
      }
    }

    // Broadcast settings update to everyone in room
    io.to(currentRoomId).emit('settings-update', {
      settings: room.settings,
      updatedBy: currentUser ? currentUser.name : 'Host'
    });

    // Notify in chat of security toggle
    let changeDesc = [];
    if (newSettings.copyDisabled !== undefined) {
      changeDesc.push(`Copy protection ${newSettings.copyDisabled ? 'ENABLED 🔒' : 'DISABLED 🔓'}`);
    }
    if (newSettings.pasteDisabled !== undefined) {
      changeDesc.push(`Paste protection ${newSettings.pasteDisabled ? 'ENABLED 🚫' : 'DISABLED 🔓'}`);
    }
    if (newSettings.readOnly !== undefined) {
      changeDesc.push(`Read-only mode ${newSettings.readOnly ? 'ENABLED 👁️' : 'DISABLED ✏️'}`);
    }
    if (newSettings.syntaxHighlight !== undefined) {
      changeDesc.push(`Syntax highlighting ${newSettings.syntaxHighlight ? 'ENABLED 🎨' : 'DISABLED ⚪'}`);
    }

    if (changeDesc.length > 0) {
      const sysMsg = {
        id: Date.now().toString(),
        sender: 'Security',
        text: `Security update: ${changeDesc.join(', ')}`,
        isSystem: true,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      room.chat.push(sysMsg);
      io.to(currentRoomId).emit('chat-message', sysMsg);
    }
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



  // Disconnect
  socket.on('disconnect', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      room.users.delete(socket.id);

      // Handle Host disconnect with 15-second grace period for page refresh
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = null;
        if (room.hostReconnectTimer) {
          clearTimeout(room.hostReconnectTimer);
        }

        room.hostReconnectTimer = setTimeout(() => {
          if (rooms.has(currentRoomId)) {
            const currentRoom = rooms.get(currentRoomId);
            if (currentRoom.hostSocketId === null && currentRoom.users.size > 0) {
              const remainingUsers = getActiveRoomUsers(currentRoom);
              if (remainingUsers.length > 0) {
                const newHost = remainingUsers[0];
                currentRoom.hostSocketId = newHost.id;
                currentRoom.hostToken = newHost.token;
                newHost.isHost = true;

                io.to(newHost.id).emit('host-assigned', { isHost: true });
                io.to(currentRoomId).emit('users-update', {
                  users: getActiveRoomUsers(currentRoom)
                });
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

