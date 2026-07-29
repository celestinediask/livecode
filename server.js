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

function getRandomColor() {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

// Starter code sample for Python
const DEFAULT_CODE = {
  python: `# LiveCode — Python Workspace
def is_prime(n):
    if n <= 1:
        return False
    for i in range(2, int(n**0.5) + 1):
        if n % i == 0:
            return False
    return True

primes = [x for x in range(1, 50) if is_prime(x)]
print("Primes up to 50:", primes)
print("🚀 Live Python Workspace synchronized!")`
};

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      title: `Session ${roomId.toUpperCase()}`,
      code: DEFAULT_CODE.python,
      language: 'python',
      hostSocketId: null,
      hostToken: null,
      hostReconnectTimer: null,
      created: Date.now(),
      settings: {
        copyDisabled: true, // Default enabled protection
        pasteDisabled: false,
        readOnly: false,
        locked: false
      },
      users: new Map(), // socketId -> User info
      chat: []
    });
  }
  return rooms.get(roomId);
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

    currentUser = {
      id: socket.id,
      token: userToken,
      name: username || `User-${socket.id.substring(0, 4)}`,
      color: getRandomColor(),
      isHost: isHost,
      cursor: { line: 1, ch: 1 },
      joinedAt: Date.now()
    };

    room.users.set(socket.id, currentUser);

    // Send initial room state to joining user
    socket.emit('room-state', {
      roomId: room.id,
      code: room.code,
      language: room.language,
      settings: room.settings,
      currentUser: currentUser,
      isHost: currentUser.isHost,
      users: Array.from(room.users.values()),
      chat: room.chat
    });

    // Notify room of new user
    io.to(cleanRoomId).emit('users-update', {
      users: Array.from(room.users.values())
    });

    // Send system message in chat
    const sysMessage = {
      id: Date.now().toString(),
      sender: 'System',
      text: `${currentUser.name} joined the room.`,
      isSystem: true,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.chat.push(sysMessage);
    io.to(cleanRoomId).emit('chat-message', sysMessage);
  });

  // Code Change Sync
  socket.on('code-change', ({ code, cursor }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);

    // If read-only mode is active and user is not host
    if (room.settings.readOnly && room.hostSocketId !== socket.id) {
      socket.emit('protection-alert', { message: 'Room is currently in Read-Only mode.' });
      return;
    }

    room.code = code;
    if (currentUser && cursor) {
      currentUser.cursor = cursor;
    }

    // Broadcast updated code to other users in room
    socket.to(currentRoomId).emit('code-update', {
      code: code,
      senderId: socket.id,
      cursor: cursor
    });
  });

  // Cursor position updates
  socket.on('cursor-change', (cursor) => {
    if (!currentRoomId || !currentUser || !rooms.has(currentRoomId)) return;
    currentUser.cursor = cursor;
    socket.to(currentRoomId).emit('cursor-update', {
      userId: socket.id,
      cursor: cursor
    });
  });

  // Real-time mouse movement tracking
  socket.on('mouse-move', ({ x, y }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    socket.to(currentRoomId).emit('mouse-update', {
      userId: socket.id,
      x: x,
      y: y
    });
  });

  // Real-time scrolling sync
  socket.on('scroll-sync', ({ top, left }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
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

  socket.on('request-terminate-code', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('terminate-on-host');
    }
  });

  // Security & Protection Settings Toggle (Copy / Paste / ReadOnly / Lock)
  socket.on('update-settings', (newSettings) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);

    // Merge settings
    room.settings = { ...room.settings, ...newSettings };

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
              const remainingUsers = Array.from(currentRoom.users.values());
              const newHost = remainingUsers[0];
              currentRoom.hostSocketId = newHost.id;
              currentRoom.hostToken = newHost.token;
              newHost.isHost = true;

              io.to(newHost.id).emit('host-assigned', { isHost: true });
              io.to(currentRoomId).emit('users-update', {
                users: Array.from(currentRoom.users.values())
              });
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
          users: Array.from(room.users.values())
        });
        if (currentUser) {
          const sysMsg = {
            id: Date.now().toString(),
            sender: 'System',
            text: `${currentUser.name} left the room.`,
            isSystem: true,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          room.chat.push(sysMsg);
          io.to(currentRoomId).emit('chat-message', sysMsg);
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

