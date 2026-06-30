import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { Session, Post, BoardEvent } from './src/types';

// Setup paths
const DATA_FILE = path.join(process.cwd(), 'data-store.json');

// Interface for persisted state
interface PersistedState {
  sessions: Record<string, Session>;
  posts: Record<string, Post[]>;
}

// Initial state or load from file
let state: PersistedState = {
  sessions: {},
  posts: {},
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      state = JSON.parse(raw);
      console.log(`[Server] Loaded state: ${Object.keys(state.sessions).length} sessions.`);
    } else {
      saveState();
    }
  } catch (e) {
    console.error('[Server] Error loading state, starting fresh:', e);
  }
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Server] Error saving state:', e);
  }
}

// Keep track of connected SSE clients
interface SSEClient {
  id: string;
  res: express.Response;
}
const sseClients: Record<string, SSEClient[]> = {}; // sessionId -> client array

function broadcastToSession(sessionId: string, event: BoardEvent) {
  const clients = sseClients[sessionId];
  if (!clients) return;

  const payload = `event: message\ndata: ${JSON.stringify(event)}\n\n`;
  clients.forEach((client) => {
    try {
      client.res.write(payload);
    } catch (err) {
      console.error(`[Server] Error writing to client ${client.id}:`, err);
    }
  });
}

function broadcastUserCount(sessionId: string) {
  const count = sseClients[sessionId]?.length || 0;
  broadcastToSession(sessionId, { type: 'users_count', data: { count } });
}

// Generate secure keys and short codes
function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function startServer() {
  loadState();

  const app = express();
  app.use(express.json());

  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // API: Healthcheck
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', sessions: Object.keys(state.sessions).length });
  });

  // API: Create a new session
  app.post('/api/sessions', (req, res) => {
    const { title, type } = req.body;
    if (!title || !type) {
      res.status(400).json({ error: 'Missing title or type' });
      return;
    }

    const id = generateId();
    let code = generateCode();

    // Ensure code uniqueness
    let attempts = 0;
    while (Object.values(state.sessions).some((s) => s.code === code) && attempts < 100) {
      code = generateCode();
      attempts++;
    }

    const moderatorKey = generateId();

    const newSession: Session = {
      id,
      code,
      title: title.trim(),
      type: type === 'whiteboard' ? 'whiteboard' : 'wall',
      moderatorKey,
      isLocked: false,
      onlyModCanMove: false,
      createdAt: Date.now(),
    };

    state.sessions[id] = newSession;
    state.posts[id] = [];
    saveState();

    res.status(201).json(newSession);
  });

  // API: Get session by code or ID
  app.get('/api/sessions/:codeOrId', (req, res) => {
    const search = req.params.codeOrId.toUpperCase();
    
    // Find by code first, then fallback to id
    let session = Object.values(state.sessions).find((s) => s.code === search);
    if (!session) {
      session = state.sessions[req.params.codeOrId];
    }

    if (!session) {
      res.status(404).json({ error: 'Session nicht gefunden' });
      return;
    }

    // Exclude moderator key in public searches unless explicitly requested
    const { moderatorKey, ...publicSession } = session;

    res.json({
      ...publicSession,
      // Include moderator flag if user provided correct moderator key
      isModerator: req.query.modKey === moderatorKey,
    });
  });

  // API: Verify moderator key
  app.post('/api/sessions/:id/verify-mod', (req, res) => {
    const { id } = req.params;
    const { moderatorKey } = req.body;

    const session = state.sessions[id];
    if (!session) {
      res.status(404).json({ error: 'Session nicht gefunden' });
      return;
    }

    const isMatch = session.moderatorKey === moderatorKey;
    res.json({ isValid: isMatch });
  });

  // API: Update session config (Requires Moderator Key)
  app.put('/api/sessions/:id/config', (req, res) => {
    const { id } = req.params;
    const { moderatorKey, title, type, isLocked, onlyModCanMove } = req.body;

    const session = state.sessions[id];
    if (!session) {
      res.status(404).json({ error: 'Session nicht gefunden' });
      return;
    }

    if (session.moderatorKey !== moderatorKey) {
      res.status(403).json({ error: 'Nicht autorisiert' });
      return;
    }

    if (title !== undefined) session.title = title.trim();
    if (type !== undefined) session.type = type === 'whiteboard' ? 'whiteboard' : 'wall';
    if (isLocked !== undefined) session.isLocked = !!isLocked;
    if (onlyModCanMove !== undefined) session.onlyModCanMove = !!onlyModCanMove;

    saveState();

    broadcastToSession(id, { type: 'session_updated', data: session });
    res.json(session);
  });

  // API: Clear board (Requires Moderator Key)
  app.post('/api/sessions/:id/clear', (req, res) => {
    const { id } = req.params;
    const { moderatorKey } = req.body;

    const session = state.sessions[id];
    if (!session) {
      res.status(404).json({ error: 'Session nicht gefunden' });
      return;
    }

    if (session.moderatorKey !== moderatorKey) {
      res.status(403).json({ error: 'Nicht autorisiert' });
      return;
    }

    state.posts[id] = [];
    saveState();

    broadcastToSession(id, { type: 'clear_board' });
    res.json({ success: true });
  });

  // API: Create post
  app.post('/api/sessions/:id/posts', (req, res) => {
    const { id } = req.params;
    const { text, color, author, tag, x, y } = req.body;

    const session = state.sessions[id];
    if (!session) {
      res.status(404).json({ error: 'Session nicht gefunden' });
      return;
    }

    if (session.isLocked) {
      res.status(403).json({ error: 'Das Board ist gesperrt. Keine neuen Beiträge möglich.' });
      return;
    }

    const postText = (text || '').trim();
    if (!postText) {
      res.status(400).json({ error: 'Beitrag darf nicht leer sein' });
      return;
    }

    const post: Post = {
      id: generateId(),
      sessionId: id,
      text: postText,
      color: color || '#fef08a',
      author: (author || 'Anonym').trim(),
      likes: 0,
      x: typeof x === 'number' ? Math.max(-500, Math.min(500, x)) : Math.random() * 60 + 10,
      y: typeof y === 'number' ? Math.max(-500, Math.min(500, y)) : Math.random() * 60 + 10,
      tag: tag ? tag.trim() : undefined,
      createdAt: Date.now(),
    };

    if (!state.posts[id]) {
      state.posts[id] = [];
    }

    state.posts[id].push(post);
    saveState();

    broadcastToSession(id, { type: 'post_created', data: post });
    res.status(201).json(post);
  });

  // API: Update post (Likes, positions, text, colors)
  app.put('/api/sessions/:id/posts/:postId', (req, res) => {
    const { id, postId } = req.params;
    const { text, color, x, y, tag, likes, moderatorKey } = req.body;

    const session = state.sessions[id];
    if (!session) {
      res.status(404).json({ error: 'Session nicht gefunden' });
      return;
    }

    const posts = state.posts[id] || [];
    const postIndex = posts.findIndex((p) => p.id === postId);
    if (postIndex === -1) {
      res.status(404).json({ error: 'Beitrag nicht gefunden' });
      return;
    }

    const post = posts[postIndex];

    // Auth validation for coordinate movement
    const isMod = session.moderatorKey === moderatorKey;
    if ((x !== undefined || y !== undefined) && session.onlyModCanMove && !isMod) {
      res.status(403).json({ error: 'Nur Moderatoren dürfen Beiträge verschieben' });
      return;
    }

    // Apply updates
    if (text !== undefined) post.text = text.trim();
    if (color !== undefined) post.color = color;
    if (x !== undefined) post.x = Math.max(-500, Math.min(500, x));
    if (y !== undefined) post.y = Math.max(-500, Math.min(500, y));
    if (tag !== undefined) post.tag = tag ? tag.trim() : undefined;
    if (likes !== undefined) post.likes = Math.max(0, likes);

    saveState();

    broadcastToSession(id, { type: 'post_updated', data: post });
    res.json(post);
  });

  // API: Delete post (Requires Moderator Key or being the author)
  // To keep it simple, we let anyone delete with their local author verification, or the moderator.
  app.delete('/api/sessions/:id/posts/:postId', (req, res) => {
    const { id, postId } = req.params;
    const { moderatorKey, authorName } = req.body; // client can send authorName to prove they own it

    const session = state.sessions[id];
    if (!session) {
      res.status(404).json({ error: 'Session nicht gefunden' });
      return;
    }

    const posts = state.posts[id] || [];
    const postIndex = posts.findIndex((p) => p.id === postId);
    if (postIndex === -1) {
      res.status(404).json({ error: 'Beitrag nicht gefunden' });
      return;
    }

    const post = posts[postIndex];
    const isMod = session.moderatorKey === moderatorKey;
    const isAuthor = authorName && post.author === authorName;

    if (!isMod && !isAuthor) {
      res.status(403).json({ error: 'Keine Berechtigung zum Löschen' });
      return;
    }

    posts.splice(postIndex, 1);
    saveState();

    broadcastToSession(id, { type: 'post_deleted', data: { id: postId } });
    res.json({ success: true });
  });

  // API: Real-time SSE Stream
  app.get('/api/sessions/:id/events', (req, res) => {
    const { id } = req.params;
    
    // Check if session exists
    const session = state.sessions[id];
    if (!session) {
      res.status(404).json({ error: 'Session nicht gefunden' });
      return;
    }

    // Set SSE headers with compression & buffering disabled for proxy servers like Nginx
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders(); // Establish connection

    const clientId = generateId();
    const newClient: SSEClient = { id: clientId, res };

    if (!sseClients[id]) {
      sseClients[id] = [];
    }
    sseClients[id].push(newClient);

    console.log(`[SSE] Client ${clientId} connected to session ${id}. Total clients: ${sseClients[id].length}`);

    // Immediately send the initial state of the board
    const posts = state.posts[id] || [];
    const initEvent: BoardEvent = {
      type: 'init',
      data: {
        session,
        posts,
        activeUsersCount: sseClients[id].length,
      },
    };
    res.write(`event: message\ndata: ${JSON.stringify(initEvent)}\n\n`);

    // Broadcast updated user count to everyone in the room
    broadcastUserCount(id);

    // Keep connection alive with pings
    const pingInterval = setInterval(() => {
      try {
        res.write(`event: message\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
      } catch (err) {
        // Handled in client cleanup
      }
    }, 15000);

    // Clean up on close
    req.on('close', () => {
      clearInterval(pingInterval);
      if (sseClients[id]) {
        sseClients[id] = sseClients[id].filter((c) => c.id !== clientId);
        console.log(`[SSE] Client ${clientId} disconnected from session ${id}. Remaining: ${sseClients[id].length}`);
        broadcastUserCount(id);
        if (sseClients[id].length === 0) {
          delete sseClients[id];
        }
      }
    });
  });

  // Vite Integration & Static files
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Collaboration board server running at http://localhost:${PORT}`);
  });
}

startServer();
