const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
const RECONNECT_GRACE_PERIOD_MS = 5 * 60 * 1000;
const READY_COUNTDOWN_SECONDS = 5;
const CODE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const buildDirectory = path.join(__dirname, 'dist');

function send(client, message) {
    if (client.socket?.readyState === WebSocket.OPEN) {
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
                name: player.name,
                isConnected: Boolean(player.socket && player.socket.readyState === WebSocket.OPEN),
                isReady: room.started && room.readyPlayerIds.has(player.id)
            }))
        }
    };
    room.players.forEach(player => send(player, message));
}

function broadcastRoomEvent(room, event) {
    const message = { type: 'room-event', ...event };
    room.players.forEach(player => send(player, message));
}

function connectedPlayers(room) {
    return room.players.filter(player =>
        player.socket && player.socket.readyState === WebSocket.OPEN
    );
}

function broadcastGameProgress(room) {
    const readyPlayerIds = [...room.readyPlayerIds];
    const message = {
        type: 'game-progress',
        phase: room.phase,
        readyPlayerIds,
        countdownSeconds: room.countdownSeconds
    };
    room.players.forEach(player => send(player, message));
}

function clearReadyCountdown(room) {
    if (room.countdownTimer) clearInterval(room.countdownTimer);
    room.countdownTimer = null;
    room.countdownEndsAt = null;
    room.countdownSeconds = null;
}

function advanceGamePhase(room) {
    clearReadyCountdown(room);
    room.phase = room.phase === 'NIGHT_WEREWOLF' ? 'DAY_DISCUSS' : 'NIGHT_WEREWOLF';
    room.readyPlayerIds.clear();
    room.gamePlayers.forEach(player => {
        player.isReady = false;
    });
    broadcastGameProgress(room);
    broadcastRoomEvent(room, {
        playerId: null,
        text: room.phase === 'DAY_DISCUSS'
            ? '天亮了，进入白天讨论阶段。'
            : '夜幕降临，进入狼人阶段。'
    });
}

function startReadyCountdown(room) {
    if (room.countdownTimer) return;
    const activePlayers = connectedPlayers(room);
    if (activePlayers.length === 0 || activePlayers.some(player =>
        !room.readyPlayerIds.has(player.id)
    )) return;

    room.countdownEndsAt = Date.now() + READY_COUNTDOWN_SECONDS * 1000;
    room.countdownSeconds = READY_COUNTDOWN_SECONDS;
    broadcastGameProgress(room);
    room.countdownTimer = setInterval(() => {
        const secondsRemaining = Math.ceil((room.countdownEndsAt - Date.now()) / 1000);
        if (secondsRemaining <= 0) {
            advanceGamePhase(room);
            return;
        }
        if (room.countdownSeconds !== secondsRemaining) {
            room.countdownSeconds = secondsRemaining;
            broadcastGameProgress(room);
        }
    }, 200);
}

function updateReadiness(room, client, isReady) {
    if (isReady) {
        room.readyPlayerIds.add(client.id);
    } else {
        room.readyPlayerIds.delete(client.id);
        clearReadyCountdown(room);
    }
    const gamePlayer = room.gamePlayers.find(player => player.id === client.id);
    if (gamePlayer) gamePlayer.isReady = isReady;
    broadcastGameProgress(room);
    startReadyCountdown(room);
}

function enterRoom(client, name, room) {
    client.name = name;
    client.roomCode = room.code;
    room.players.push(client);
    broadcastRoomState(room);
    broadcastRoomEvent(room, {
        playerId: client.id,
        text: room.players.length === 1 ? `${name} 创建了房间。` : `${name} 加入了房间。`
    });
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
        const room = { code, hostId: client.id, players: [], started: false, gamePlayers: null };
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

    if (message.type === 'change-name') {
        const room = roomFor(client);
        if (!room) {
            sendError(client, '你不在房间中。');
            return;
        }
        if (room.started) {
            sendError(client, '游戏已经开始，无法修改昵称。');
            return;
        }
        const name = getPlayerName(message.name);
        if (!name) {
            sendError(client, '昵称需为 1-24 个字符。');
            return;
        }
        const previousName = client.name;
        client.name = name;
        broadcastRoomState(room);
        broadcastRoomEvent(room, {
            playerId: client.id,
            text: `${previousName} 将昵称改为 ${name}。`
        });
        return;
    }

    if (message.type === 'memo-entry') {
        const room = roomFor(client);
        if (!room) {
            sendError(client, '你不在房间中。');
            return;
        }
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (!text || text.length > 300) {
            sendError(client, '备忘录内容无效。');
            return;
        }
        broadcastRoomEvent(room, {
            playerId: client.id,
            text
        });
        return;
    }

    if (message.type === 'set-ready') {
        const room = roomFor(client);
        if (!room || !room.started) {
            sendError(client, '游戏尚未开始。');
            return;
        }
        if (room.countdownTimer && message.isReady === false) {
            updateReadiness(room, client, false);
            return;
        }
        if (typeof message.isReady !== 'boolean') {
            sendError(client, '准备状态无效。');
            return;
        }
        if (room.countdownTimer) {
            sendError(client, '倒计时已经开始，无法更改准备状态。');
            return;
        }
        updateReadiness(room, client, message.isReady);
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
        room.phase = 'NIGHT_WEREWOLF';
        room.readyPlayerIds = new Set();
        room.countdownTimer = null;
        room.countdownEndsAt = null;
        room.countdownSeconds = null;
        const roles = shuffledRoles(room.players.length);
        room.gamePlayers = room.players.map((player, index) => ({
            id: player.id,
            name: player.name,
            role: roles[index],
            isAlive: true,
            isReady: false,
            isConnected: Boolean(player.socket && player.socket.readyState === WebSocket.OPEN)
        }));
        room.players.forEach(player => send(player, {
            type: 'game-started',
            phase: room.phase,
            players: room.gamePlayers
        }));
        broadcastGameProgress(room);
        broadcastRoomEvent(room, {
            playerId: client.id,
            text: `${client.name} 开始了游戏。`
        });
        return;
    }

    sendError(client, '不支持的请求类型。');
}

function leaveRoom(client) {
    const room = roomFor(client);
    if (!room) return;

    const leavingName = client.name;
    if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
    client.reconnectTimer = null;
    if (room.started) {
        clearReadyCountdown(room);
        room.readyPlayerIds.delete(client.id);
    }
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
    else {
        room.gamePlayers = room.gamePlayers.filter(player => player.id !== client.id);
        broadcastGameProgress(room);
        startReadyCountdown(room);
    }
    broadcastRoomEvent(room, {
        playerId: client.id,
        text: `${leavingName} 离开了房间。`
    });
}

function playerInRoom(playerId) {
    for (const room of rooms.values()) {
        const player = room.players.find(candidate => candidate.id === playerId);
        if (player) return { player, room };
    }
    return null;
}

const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method !== 'GET') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
    }

    let decodedPathname;
    try {
        decodedPathname = decodeURIComponent(pathname);
    } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Invalid path');
        return;
    }

    const relativePath = decodedPathname === '/' ? 'index.html' : decodedPathname.slice(1);
    const filePath = path.resolve(buildDirectory, relativePath);
    const resolvedRelativePath = path.relative(buildDirectory, filePath);
    const isOutsideBuildDirectory = resolvedRelativePath === '..'
        || resolvedRelativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(resolvedRelativePath);
    if (isOutsideBuildDirectory) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code !== 'ENOENT') {
                console.error(`Unable to read ${filePath}:`, error);
            }
            response.writeHead(error.code === 'ENOENT' ? 404 : 500, {
                'Content-Type': 'text/plain; charset=utf-8'
            });
            response.end(error.code === 'ENOENT' ? 'Not found' : 'Unable to load the requested file.');
            return;
        }

        const extension = path.extname(filePath);
        const contentTypes = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.eot': 'application/vnd.ms-fontobject',
            '.svg': 'image/svg+xml',
            '.ttf': 'font/ttf',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2'
        };
        response.writeHead(200, {
            'Content-Type': contentTypes[extension] || 'application/octet-stream',
            'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable'
        });
        response.end(content);
    });
});

const webSocketServer = new WebSocketServer({ server, maxPayload: 1024 });

webSocketServer.on('connection', (socket, request) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const requestedPlayerId = requestUrl.searchParams.get('playerId');
    const isValidPlayerId = typeof requestedPlayerId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedPlayerId);
    const existingPlayer = isValidPlayerId ? playerInRoom(requestedPlayerId) : null;
    const client = existingPlayer?.player ?? {
        id: isValidPlayerId ? requestedPlayerId : crypto.randomUUID(),
        name: null,
        roomCode: null,
        socket: null,
        reconnectTimer: null
    };

    if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
    client.reconnectTimer = null;
    const previousSocket = client.socket;
    client.socket = socket;
    if (previousSocket && previousSocket !== socket) previousSocket.close();

    send(client, { type: 'connected', playerId: client.id });
    if (existingPlayer) {
        if (existingPlayer.room.started) {
            const gamePlayer = existingPlayer.room.gamePlayers?.find(player => player.id === client.id);
            if (gamePlayer) {
                gamePlayer.isConnected = true;
                gamePlayer.isReady = existingPlayer.room.readyPlayerIds.has(client.id);
            }
            existingPlayer.room.players.forEach(player => send(player, {
                type: 'player-connection',
                playerId: client.id,
                isConnected: true
            }));
            send(client, {
                type: 'game-started',
                phase: existingPlayer.room.phase,
                players: existingPlayer.room.gamePlayers
            });
            broadcastGameProgress(existingPlayer.room);
        } else {
            broadcastRoomState(existingPlayer.room);
        }
        broadcastRoomEvent(existingPlayer.room, {
            playerId: client.id,
            text: `${client.name} 重新连接了房间。`
        });
    }

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

    socket.on('close', () => {
        if (client.socket !== socket) return;
        client.socket = null;
        const room = roomFor(client);
        if (!room) return;

        if (room.started) {
            clearReadyCountdown(room);
            room.readyPlayerIds.delete(client.id);
            const gamePlayer = room.gamePlayers?.find(player => player.id === client.id);
            if (gamePlayer) {
                gamePlayer.isConnected = false;
                gamePlayer.isReady = false;
            }
            room.players.forEach(player => send(player, {
                type: 'player-connection',
                playerId: client.id,
                isConnected: false
            }));
            broadcastGameProgress(room);
        } else {
            broadcastRoomState(room);
        }
        broadcastRoomEvent(room, {
            playerId: client.id,
            text: `${client.name} 暂时离线。`
        });

        client.reconnectTimer = setTimeout(() => leaveRoom(client), RECONNECT_GRACE_PERIOD_MS);
        client.reconnectTimer.unref();
    });
    socket.on('error', error => {
        console.error(`WebSocket error for player ${client.id}:`, error);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Werewolf game server listening on port ${PORT}`);
});
