// ============================================================
// BACKEND SERVER — Socket.io + Express
// Azure App Service (Node.js 18 LTS)
// Integrates: Azure Table Storage (messages) + Blob Storage (files)
// ============================================================

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { TableClient, AzureNamedKeyCredential } = require("@azure/data-tables");
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
const server = http.createServer(app);

// ============================================================
// SOCKET.IO CONFIG
// ============================================================
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({ origin: "*" }));
app.use(express.json());

// ============================================================
// AZURE STORAGE CLIENTS
// ============================================================
const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING || "";
const TABLE_NAME = process.env.TABLE_NAME || "appdata";
const CONTAINER_NAME = process.env.CONTAINER_NAME || "appfiles";

let tableClient, blobContainerClient;

try {
  tableClient = TableClient.fromConnectionString(CONNECTION_STRING, TABLE_NAME);
  const blobServiceClient = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  blobContainerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  console.log("[Azure] Storage clients initialized");
} catch (err) {
  console.error("[Azure] Storage init failed:", err.message);
}

// In-memory fallback (when running locally without Azure)
const inMemoryMessages = [];
const activeUsers = new Map(); // socketId → { username, room, joinedAt }
const rooms = new Map();       // roomName → Set of socketIds

// ============================================================
// HELPERS
// ============================================================

async function saveMessageToTable(msg) {
  if (!tableClient) {
    inMemoryMessages.push(msg);
    return;
  }
  try {
    await tableClient.createEntity({
      partitionKey: msg.room,
      rowKey: msg.id,
      username: msg.username,
      text: msg.text,
      type: msg.type || "text",
      fileUrl: msg.fileUrl || "",
      timestamp: msg.timestamp,
    });
  } catch (err) {
    console.error("[Azure Table] Save failed:", err.message);
    inMemoryMessages.push(msg);
  }
}

async function getMessagesFromTable(room, limit = 50) {
  if (!tableClient) {
    return inMemoryMessages.filter((m) => m.room === room).slice(-limit);
  }
  try {
    const messages = [];
    const entities = tableClient.listEntities({
      queryOptions: { filter: `PartitionKey eq '${room}'` },
    });
    for await (const entity of entities) {
      messages.push({
        id: entity.rowKey,
        room: entity.partitionKey,
        username: entity.username,
        text: entity.text,
        type: entity.type,
        fileUrl: entity.fileUrl,
        timestamp: entity.timestamp,
      });
    }
    return messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)).slice(-limit);
  } catch (err) {
    console.error("[Azure Table] Fetch failed:", err.message);
    return inMemoryMessages.filter((m) => m.room === room).slice(-limit);
  }
}

async function uploadFileToBlob(buffer, filename, mimeType) {
  if (!blobContainerClient) return null;
  try {
    const blobName = `${uuidv4()}-${filename}`;
    const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: mimeType },
    });
    return blockBlobClient.url;
  } catch (err) {
    console.error("[Azure Blob] Upload failed:", err.message);
    return null;
  }
}

// ============================================================
// REST API ROUTES
// ============================================================

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "chatapp-backend",
    timestamp: new Date().toISOString(),
    azure: {
      tableStorage: !!tableClient,
      blobStorage: !!blobContainerClient,
    },
    activeUsers: activeUsers.size,
    rooms: [...rooms.keys()],
  });
});

// Get chat history for a room
app.get("/api/messages/:room", async (req, res) => {
  const { room } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  try {
    const messages = await getMessagesFromTable(room, limit);
    res.json({ room, messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get active rooms & users
app.get("/api/rooms", (req, res) => {
  const roomList = [];
  for (const [room, sockets] of rooms.entries()) {
    const users = [...sockets].map((sid) => activeUsers.get(sid)?.username).filter(Boolean);
    roomList.push({ room, userCount: sockets.size, users });
  }
  res.json({ rooms: roomList });
});

// Get table data (generic)
app.get("/api/data", async (req, res) => {
  try {
    const messages = await getMessagesFromTable("general", 100);
    res.json({ data: messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post data to table (generic)
app.post("/api/data", async (req, res) => {
  try {
    const { partitionKey = "general", rowKey = uuidv4(), ...rest } = req.body;
    if (tableClient) {
      await tableClient.createEntity({ partitionKey, rowKey, ...rest });
    }
    res.status(201).json({ success: true, rowKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// File upload to Blob
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  try {
    const url = await uploadFileToBlob(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (url) {
      res.json({ success: true, url, filename: req.file.originalname });
    } else {
      res.status(500).json({ error: "Blob upload failed" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List files from Blob
app.get("/api/files", async (req, res) => {
  if (!blobContainerClient) return res.json({ files: [] });
  try {
    const files = [];
    for await (const blob of blobContainerClient.listBlobsFlat()) {
      files.push({
        name: blob.name,
        url: `${blobContainerClient.url}/${blob.name}`,
        size: blob.properties.contentLength,
        lastModified: blob.properties.lastModified,
      });
    }
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SOCKET.IO — REAL-TIME EVENTS
// ============================================================
io.on("connection", (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // JOIN ROOM
  socket.on("join_room", async ({ username, room }) => {
    if (!username || !room) return;

    // Leave previous room
    const prev = activeUsers.get(socket.id);
    if (prev?.room) {
      socket.leave(prev.room);
      rooms.get(prev.room)?.delete(socket.id);
      io.to(prev.room).emit("user_left", {
        username: prev.username,
        room: prev.room,
        userCount: rooms.get(prev.room)?.size || 0,
      });
    }

    // Join new room
    socket.join(room);
    activeUsers.set(socket.id, { username, room, joinedAt: new Date().toISOString() });
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(socket.id);

    // Send chat history
    const history = await getMessagesFromTable(room, 50);
    socket.emit("chat_history", { room, messages: history });

    // Notify room
    io.to(room).emit("user_joined", {
      username,
      room,
      userCount: rooms.get(room).size,
      users: [...rooms.get(room)].map((sid) => activeUsers.get(sid)?.username).filter(Boolean),
    });

    console.log(`[Socket] ${username} joined room: ${room}`);
  });

  // SEND MESSAGE
  socket.on("send_message", async ({ text, type = "text", fileUrl = "" }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    const msg = {
      id: uuidv4(),
      room: user.room,
      username: user.username,
      text,
      type,
      fileUrl,
      timestamp: new Date().toISOString(),
    };

    await saveMessageToTable(msg);
    io.to(user.room).emit("receive_message", msg);
  });

  // TYPING INDICATOR
  socket.on("typing", ({ isTyping }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;
    socket.to(user.room).emit("user_typing", { username: user.username, isTyping });
  });

  // FILE MESSAGE (after upload)
  socket.on("send_file", async ({ fileUrl, filename }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    const msg = {
      id: uuidv4(),
      room: user.room,
      username: user.username,
      text: filename,
      type: "file",
      fileUrl,
      timestamp: new Date().toISOString(),
    };

    await saveMessageToTable(msg);
    io.to(user.room).emit("receive_message", msg);
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      rooms.get(user.room)?.delete(socket.id);
      io.to(user.room).emit("user_left", {
        username: user.username,
        room: user.room,
        userCount: rooms.get(user.room)?.size || 0,
      });
      activeUsers.delete(socket.id);
      console.log(`[Socket] ${user.username} disconnected`);
    }
  });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Health: http://localhost:${PORT}/api/health`);
});
