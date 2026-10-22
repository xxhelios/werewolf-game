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
                isReady: false
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
    return room.players.filter(player => {
        const gamePlayer = room.gamePlayers?.find(candidate => candidate.id === player.id);
        return gamePlayer?.isAlive
            && player.socket
            && player.socket.readyState === WebSocket.OPEN;
    });
}

function gameProgressFor(room, client) {
    const gamePlayer = room.gamePlayers.find(player => player.id === client.id);
    const publicPlayers = room.gamePlayers.map(player => {
        const roomPlayer = room.players.find(candidate => candidate.id === player.id);
        return {
            id: player.id,
            name: player.name,
            role: 'unassigned',
            isAlive: player.isAlive,
            isConnected: Boolean(roomPlayer?.socket && roomPlayer.socket.readyState === WebSocket.OPEN),
            isReady: room.phase === 'DAY_VOTE' && room.readyPlayerIds.has(player.id)
        };
    });
    const message = {
        type: 'game-progress',
        phase: room.phase,
        players: publicPlayers,
        readyPlayerIds: room.phase === 'DAY_VOTE' ? [...room.readyPlayerIds] : [],
        countdownSeconds: room.countdownSeconds,
        role: gamePlayer?.role ?? null,
        wolfTargetId: gamePlayer?.role === 'witch' && room.phase === 'NIGHT_WITCH'
            ? room.wolfTargetId
            : null,
        witchPotions: gamePlayer?.role === 'witch'
            ? { saveUsed: room.witchPotions.saveUsed, poisonUsed: room.witchPotions.poisonUsed }
            : null,
        seerResult: gamePlayer?.role === 'seer' ? room.seerResult : null,
        eliminatedPlayerIds: room.eliminatedPlayerIds,
        selectedWolfTargetId: gamePlayer?.role === 'werewolf' ? room.wolfTargets.get(client.id) ?? null : null,
        selectedSaveTargetId: gamePlayer?.role === 'witch' ? room.witchSaveTargetId : null,
        selectedPoisonTargetId: gamePlayer?.role === 'witch' ? room.witchPoisonTargetId : null,
        selectedSeerTargetId: gamePlayer?.role === 'seer' ? room.seerTargetId : null,
        selectedVoteTargetId: room.votes.get(client.id) ?? null
    };
    return message;
}

function broadcastGameProgress(room) {
    room.players.forEach(player => send(player, gameProgressFor(room, player)));
}

function clearReadyCountdown(room) {
    if (room.countdownTimer) clearInterval(room.countdownTimer);
    room.countdownTimer = null;
    room.countdownEndsAt = null;
    room.countdownSeconds = null;
}

function phaseActionsComplete(room) {
    if (room.phase === 'NIGHT_WEREWOLF') {
        return connectedPlayers(room)
            .filter(player => room.gamePlayers.find(candidate => candidate.id === player.id)?.role === 'werewolf')
            .every(player => room.wolfTargets.has(player.id));
    }
    if (room.phase === 'DAY_VOTE') {
        return connectedPlayers(room).every(player => room.votes.has(player.id));
    }
    if (room.phase === 'GAME_OVER') return false;
    return true;
}

function calculateWolfTarget(room) {
    const counts = new Map();
    connectedPlayers(room)
        .filter(player => room.gamePlayers.find(candidate => candidate.id === player.id)?.role === 'werewolf')
        .forEach(player => {
            const targetId = room.wolfTargets.get(player.id);
            if (targetId) counts.set(targetId, (counts.get(targetId) || 0) + 1);
        });
    const highestCount = Math.max(0, ...counts.values());
    const leaders = [...counts.entries()].filter(([, count]) => count === highestCount);
    return leaders.length === 1 && highestCount > 0 ? leaders[0][0] : null;
}

function validLivingTarget(room, targetId) {
    return typeof targetId === 'string'
        && room.gamePlayers.some(player => player.id === targetId && player.isAlive);
}

function winnerFor(room) {
    const living = room.gamePlayers.filter(player => player.isAlive);
    const wolves = living.filter(player => player.role === 'werewolf').length;
    const villagers = living.length - wolves;
    if (wolves === 0) return '好人阵营获胜';
    if (wolves >= villagers) return '狼人阵营获胜';
    return null;
}

function resolveRound(room) {
    const eliminatedIds = new Set();
    const wolfCounts = new Map();
    connectedPlayers(room)
        .filter(player => room.gamePlayers.find(candidate => candidate.id === player.id)?.role === 'werewolf')
        .forEach(player => {
            const targetId = room.wolfTargets.get(player.id);
            if (targetId) wolfCounts.set(targetId, (wolfCounts.get(targetId) || 0) + 1);
        });
    const highestWolfVotes = Math.max(0, ...wolfCounts.values());
    const wolfWinners = [...wolfCounts.entries()].filter(([, count]) => count === highestWolfVotes);
    room.wolfTargetId = wolfWinners.length === 1 && highestWolfVotes > 0 ? wolfWinners[0][0] : null;

    if (room.wolfTargetId && room.witchSaveTargetId !== room.wolfTargetId) {
        eliminatedIds.add(room.wolfTargetId);
    }
    if (room.witchPoisonTargetId) eliminatedIds.add(room.witchPoisonTargetId);

    const voteCounts = new Map();
    connectedPlayers(room)
        .filter(player => room.gamePlayers.find(candidate => candidate.id === player.id)?.isAlive)
        .forEach(player => {
            const targetId = room.votes.get(player.id);
            if (targetId) voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
        });
    const highestVoteCount = Math.max(0, ...voteCounts.values());
    const voteWinners = [...voteCounts.entries()].filter(([, count]) => count === highestVoteCount);
    if (voteWinners.length === 1 && highestVoteCount > 0) eliminatedIds.add(voteWinners[0][0]);

    room.eliminatedPlayerIds = [...eliminatedIds];
    room.gamePlayers.forEach(player => {
        if (eliminatedIds.has(player.id)) player.isAlive = false;
    });
    const names = room.gamePlayers
        .filter(player => eliminatedIds.has(player.id))
        .map(player => player.name);
    const winner = winnerFor(room);
    const usedSavePotion = room.witchSaveTargetId !== null;
    const usedPoisonPotion = room.witchPoisonTargetId !== null;
    room.phase = winner ? 'GAME_OVER' : 'NIGHT_WEREWOLF';
    room.readyPlayerIds.clear();
    room.gamePlayers.forEach(player => {
        player.isReady = false;
    });
    room.wolfTargets.clear();
    room.witchSaveTargetId = null;
    room.witchPoisonTargetId = null;
    room.votes.clear();
    room.seerResult = null;
    room.wolfTargetId = null;
    if (room.phase === 'NIGHT_WEREWOLF') {
        room.witchPotions.saveUsed = room.witchPotions.saveUsed || usedSavePotion;
        room.witchPotions.poisonUsed = room.witchPotions.poisonUsed || usedPoisonPotion;
    }
    const result = names.length > 0
        ? `本轮淘汰：${names.join('、')}。`
        : '本轮无人淘汰。';
    broadcastRoomEvent(room, { playerId: null, text: result });
    if (winner) broadcastRoomEvent(room, { playerId: null, text: `游戏结束：${winner}！` });
    else broadcastRoomEvent(room, { playerId: null, text: '游戏继续，进入下一轮。' });
    broadcastGameProgress(room);
}

function advanceGamePhase(room) {
    clearReadyCountdown(room);
    if (room.phase === 'DAY_VOTE') {
        resolveRound(room);
        startReadyCountdown(room);
        return;
    }
    const nextPhases = {
        ROLE_REVEAL: 'NIGHT_WEREWOLF',
        NIGHT_WEREWOLF: 'NIGHT_WITCH',
        NIGHT_WITCH: 'NIGHT_SEER',
        NIGHT_SEER: 'DAY_VOTE'
    };
    if (!nextPhases[room.phase]) return;
    if (room.phase === 'NIGHT_WITCH') {
        room.witchPotions.saveUsed = room.witchPotions.saveUsed || room.witchSaveTargetId !== null;
        room.witchPotions.poisonUsed = room.witchPotions.poisonUsed || room.witchPoisonTargetId !== null;
    }
    room.phase = nextPhases[room.phase];
    room.readyPlayerIds.clear();
    room.gamePlayers.forEach(player => {
        player.isReady = false;
    });
    room.seerResult = null;
    room.seerTargetId = null;
    broadcastGameProgress(room);
    broadcastRoomEvent(room, {
        playerId: null,
        text: ({
            NIGHT_WITCH: '狼人行动结束，进入女巫行动阶段。',
            NIGHT_SEER: '女巫行动结束，进入预言家查验阶段。',
            DAY_VOTE: '夜晚行动结束，进入讨论与投票阶段。',
            NIGHT_WEREWOLF: '夜幕降临，进入狼人行动阶段。'
        })[room.phase] || '游戏阶段已更新。'
    });
}

function startReadyCountdown(room) {
    if (room.countdownTimer || room.phase === 'GAME_OVER') return;
    if (!phaseActionsComplete(room)) return;
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
        if (room.phase === 'GAME_OVER') {
            sendError(client, '本局游戏已经结束。');
            return;
        }
        if (typeof message.isReady !== 'boolean') {
            sendError(client, '准备状态无效。');
            return;
        }
        if (room.countdownTimer && message.isReady === false) {
            updateReadiness(room, client, false);
            return;
        }
        if (room.countdownTimer) {
            sendError(client, '倒计时已经开始，无法更改准备状态。');
            return;
        }
        const gamePlayer = room.gamePlayers.find(player => player.id === client.id);
        if (!gamePlayer?.isAlive) {
            sendError(client, '淘汰玩家不能提交准备状态。');
            return;
        }
        if (
            message.isReady
            && room.phase === 'NIGHT_WEREWOLF'
            && gamePlayer.role === 'werewolf'
            && !room.wolfTargets.has(client.id)
        ) {
            sendError(client, '请先选择狼人袭击目标。');
            return;
        }
        if (message.isReady && room.phase === 'DAY_VOTE' && !room.votes.has(client.id)) {
            sendError(client, '请先提交投票。');
            return;
        }
        updateReadiness(room, client, message.isReady);
        return;
    }

    if (message.type === 'game-action') {
        const room = roomFor(client);
        if (!room || !room.started || room.phase === 'GAME_OVER') {
            sendError(client, '当前无法进行游戏行动。');
            return;
        }
        if (room.countdownTimer) {
            sendError(client, '倒计时已经开始，无法更改行动。');
            return;
        }
        const gamePlayer = room.gamePlayers.find(player => player.id === client.id);
        if (!gamePlayer?.isAlive) {
            sendError(client, '淘汰玩家不能进行行动。');
            return;
        }
        if (gamePlayer.isReady) {
            sendError(client, '你已准备就绪，请先取消准备再修改行动。');
            return;
        }
        const { action, targetId } = message;
        if (typeof action !== 'string') {
            sendError(client, '行动类型无效。');
            return;
        }
        if (action === 'wolf-target') {
            if (room.phase !== 'NIGHT_WEREWOLF' || gamePlayer.role !== 'werewolf') {
                sendError(client, '当前阶段不能选择狼人袭击目标。');
                return;
            }
            const target = room.gamePlayers.find(player => player.id === targetId && player.isAlive);
            if (!target || target.role === 'werewolf') {
                sendError(client, '袭击目标无效。');
                return;
            }
            room.wolfTargets.set(client.id, target.id);
        } else if (action === 'witch-save' || action === 'witch-poison') {
            if (room.phase !== 'NIGHT_WITCH' || gamePlayer.role !== 'witch') {
                sendError(client, '当前阶段不能使用女巫药剂。');
                return;
            }
            const potion = action === 'witch-save' ? 'save' : 'poison';
            const potionUsed = potion === 'save'
                ? room.witchPotions.saveUsed
                : room.witchPotions.poisonUsed;
            if (potionUsed && targetId !== null) {
                sendError(client, '这瓶药剂本局已经使用过。');
                return;
            }
            if (targetId === null) {
                if (potion === 'save') room.witchSaveTargetId = null;
                else room.witchPoisonTargetId = null;
            } else if (!validLivingTarget(room, targetId)) {
                sendError(client, '药剂目标无效。');
                return;
            } else if (potion === 'save') {
                if (targetId !== room.wolfTargetId) {
                    sendError(client, '解药只能救助今晚被狼人袭击的玩家。');
                    return;
                }
                room.witchSaveTargetId = targetId;
            } else {
                room.witchPoisonTargetId = targetId;
            }
        } else if (action === 'seer-check') {
            if (room.phase !== 'NIGHT_SEER' || gamePlayer.role !== 'seer') {
                sendError(client, '当前阶段不能进行预言家查验。');
                return;
            }
            if (!validLivingTarget(room, targetId) || targetId === client.id) {
                sendError(client, '查验目标无效。');
                return;
            }
            room.seerTargetId = targetId;
            room.seerResult = room.gamePlayers.find(player => player.id === targetId)?.role ?? null;
        } else if (action === 'vote') {
            if (room.phase !== 'DAY_VOTE' || !validLivingTarget(room, targetId) || targetId === client.id) {
                sendError(client, '投票目标无效。');
                return;
            }
            room.votes.set(client.id, targetId);
            room.readyPlayerIds.delete(client.id);
            gamePlayer.isReady = false;
        } else {
            sendError(client, '不支持的游戏行动。');
            return;
        }
        room.wolfTargetId = calculateWolfTarget(room);
        broadcastGameProgress(room);
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
        room.phase = 'ROLE_REVEAL';
        room.readyPlayerIds = new Set();
        room.countdownTimer = null;
        room.countdownEndsAt = null;
        room.countdownSeconds = null;
        room.witchPotions = { saveUsed: false, poisonUsed: false };
        room.wolfTargets = new Map();
        room.witchSaveTargetId = null;
        room.witchPoisonTargetId = null;
        room.wolfTargetId = null;
        room.seerTargetId = null;
        room.seerResult = null;
        room.votes = new Map();
        room.eliminatedPlayerIds = [];
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
            role: room.gamePlayers.find(gamePlayer => gamePlayer.id === player.id)?.role ?? null,
            players: room.gamePlayers.map(gamePlayer => ({
                id: gamePlayer.id,
                name: gamePlayer.name,
                role: 'unassigned',
                isAlive: gamePlayer.isAlive,
                isConnected: gamePlayer.isConnected,
                isReady: false
            }))
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
        room.wolfTargets.delete(client.id);
        room.votes.delete(client.id);
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
                role: gamePlayer?.role ?? null,
                players: existingPlayer.room.gamePlayers.map(player => ({
                    id: player.id,
                    name: player.name,
                    role: 'unassigned',
                    isAlive: player.isAlive,
                    isConnected: player.isConnected,
                    isReady: existingPlayer.room.readyPlayerIds.has(player.id)
                }))
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
            startReadyCountdown(room);
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
