const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
const CODE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const indexPath = path.join(__dirname, 'index.html');

function send(client, message) {
    if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(JSON.stringify(message));
    }
}

function sendError(client, message) {
    send(client, { type: 'error', message });
}

function createRoomCode() {
    let code;
    do {
        code = Array.from({ length: 6 }, () =>
            CODE_CHARACTERS[crypto.randomInt(CODE_CHARACTERS.length)]
        ).join('');
    } while (rooms.has(code));
    return code;
}

function getPlayerName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name.length > 0 && name.length <= 24 ? name : null;
}

function roomFor(client) {
    return client.roomCode ? rooms.get(client.roomCode) : null;
}

function broadcastRoomState(room) {
    const message = {
        type: 'room-state',
        room: {
            code: room.code,
            hostId: room.hostId,
            players: room.players.map(player => ({
                id: player.id,
                name: player.name
            }))
        }
    };
    room.players.forEach(player => send(player, message));
}

function enterRoom(client, name, room) {
    client.name = name;
    client.roomCode = room.code;
    room.players.push(client);
    broadcastRoomState(room);
}

function shuffledRoles(playerCount) {
    const wolfCount = playerCount >= 7 ? 2 : 1;
    const roles = [
        ...Array(wolfCount).fill('werewolf'),
        'seer',
        'witch',
        ...Array(playerCount - wolfCount - 2).fill('villager')
    ];
    for (let i = roles.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1);
        [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    return roles;
}

function handleMessage(client, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        sendError(client, '无效的请求。');
        return;
    }

    if (message.type === 'create-room') {
        if (client.roomCode) {
            sendError(client, '你已经在一个房间里了。');
            return;
        }
        const name = getPlayerName(message.name);
        if (!name) {
            sendError(client, '昵称需为 1-24 个字符。');
            return;
        }
        const code = createRoomCode();
        const room = { code, hostId: client.id, players: [], started: false };
        rooms.set(code, room);
        enterRoom(client, name, room);
        return;
    }

    if (message.type === 'join-room') {
        if (client.roomCode) {
            sendError(client, '你已经在一个房间里了。');
            return;
        }
        const name = getPlayerName(message.name);
        const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
        if (!name) {
            sendError(client, '昵称需为 1-24 个字符。');
            return;
        }
        if (!/^[A-Z0-9]{6}$/.test(code)) {
            sendError(client, '请输入有效的 6 位房间码。');
            return;
        }
        const room = rooms.get(code);
        if (!room) {
            sendError(client, '找不到这个房间，请检查房间码。');
            return;
        }
        if (room.started) {
            sendError(client, '游戏已经开始，无法加入。');
            return;
        }
        if (room.players.length >= MAX_PLAYERS) {
            sendError(client, '房间人数已满。');
            return;
        }
        enterRoom(client, name, room);
        return;
    }

    if (message.type === 'start-game') {
        const room = roomFor(client);
        if (!room) {
            sendError(client, '你不在房间中。');
            return;
        }
        if (room.hostId !== client.id) {
            sendError(client, '只有房主可以开始游戏。');
            return;
        }
        if (room.started) {
            sendError(client, '游戏已经开始。');
            return;
        }
        if (room.players.length < MIN_PLAYERS) {
            sendError(client, `至少需要 ${MIN_PLAYERS} 位玩家才能开始。`);
            return;
        }

        room.started = true;
        const roles = shuffledRoles(room.players.length);
        const players = room.players.map((player, index) => ({
            id: player.id,
            name: player.name,
            role: roles[index],
            isAlive: true
        }));
        room.players.forEach(player => send(player, { type: 'game-started', players }));
        return;
    }

    sendError(client, '不支持的请求类型。');
}

function leaveRoom(client) {
    const room = roomFor(client);
    if (!room) return;

    room.players = room.players.filter(player => player.id !== client.id);
    client.roomCode = null;
    if (room.players.length === 0) {
        rooms.delete(room.code);
        return;
    }
    if (room.hostId === client.id) {
        room.hostId = room.players[0].id;
    }
    if (!room.started) broadcastRoomState(room);
}

const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method !== 'GET' || (pathname !== '/' && pathname !== '/index.html')) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
    }

    fs.readFile(indexPath, (error, content) => {
        if (error) {
            console.error('Unable to read index.html:', error);
            response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Unable to load the game page.');
            return;
        }
        response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        response.end(content);
    });
});

const webSocketServer = new WebSocketServer({ server, maxPayload: 1024 });

webSocketServer.on('connection', socket => {
    const client = {
        id: crypto.randomUUID(),
        name: null,
        roomCode: null,
        socket
    };
    send(client, { type: 'connected', playerId: client.id });

    socket.on('message', rawMessage => {
        let message;
        try {
            message = JSON.parse(rawMessage.toString());
        } catch (error) {
            sendError(client, '请求格式无效。');
            return;
        }
        handleMessage(client, message);
    });

    socket.on('close', () => leaveRoom(client));
    socket.on('error', error => {
        console.error(`WebSocket error for player ${client.id}:`, error);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Werewolf game server listening on port ${PORT}`);
});
