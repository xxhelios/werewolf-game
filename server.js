const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;
const ROOM_CODE_LENGTH = 4;
const READY_COUNTDOWN_SECONDS = 5;
const HIDDEN_ACTION_DELAY_MIN_SECONDS = 5;
const HIDDEN_ACTION_DELAY_MAX_SECONDS = 10;
const CODE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const buildDirectory = path.join(__dirname, 'dist');

function send(client, message) {
    if (client.socket?.readyState === WebSocket.OPEN) {
        client.socket.send(JSON.stringify(message));
    }
}

function availableRoomsMessage() {
    return {
        type: 'available-rooms',
        rooms: [...rooms.values()]
            .map(room => ({
                code: room.code,
                playerCount: room.players.length,
                maxPlayers: MAX_PLAYERS,
                started: Boolean(room.started)
            }))
    };
}

function broadcastAvailableRooms() {
    const message = JSON.stringify(availableRoomsMessage());
    webSocketServer.clients.forEach(socket => {
        if (socket.readyState === WebSocket.OPEN) socket.send(message);
    });
}

function phaseParticipants(room) {
    const livingOnlinePlayers = connectedPlayers(room);
    if (room.phase === 'DAY_VOTE_RESULT') {
        return room.players.filter(player => player.socket?.readyState === WebSocket.OPEN);
    }
    if (room.phase === 'DAY_DEATH_SPEECH') {
        return room.players.filter(player =>
            room.nightEliminatedPlayerIds.includes(player.id)
            && player.socket?.readyState === WebSocket.OPEN
        );
    }
    if (room.phase === 'DAY_VOTE' || room.phase === 'DAY_VOTE_RUNOFF') {
        return livingOnlinePlayers;
    }
    const actingRole = {
        NIGHT_WEREWOLF: 'werewolf',
        NIGHT_WITCH: 'witch',
        NIGHT_SEER: 'seer',
        NIGHT_LOVER: 'lover'
    }[room.phase];
    if (!actingRole) return livingOnlinePlayers;
    return livingOnlinePlayers.filter(player =>
        room.gamePlayers.find(candidate => candidate.id === player.id)?.role === actingRole
    );
}

function sendError(client, message) {
    send(client, { type: 'error', message });
}

function createRoomCode(requestedCode = '') {
    if (requestedCode) {
        const code = requestedCode.trim().toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(code)) {
            return { error: '自定义房间码必须是 4 位字母或数字。' };
        }
        if (rooms.has(code)) {
            return { error: '这个房间码已被使用，请换一个。' };
        }
        return { code };
    }

    let code;
    do {
        code = Array.from({ length: ROOM_CODE_LENGTH }, () =>
            CODE_CHARACTERS[crypto.randomInt(CODE_CHARACTERS.length)]
        ).join('');
    } while (rooms.has(code));
    return { code };
}

function getPlayerName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name.length > 0 && name.length <= 24 ? name : null;
}

function roomFor(client) {
    return client.roomCode ? rooms.get(client.roomCode) : null;
}

function spectatorRoomFor(client) {
    return client.spectatingRoomCode ? rooms.get(client.spectatingRoomCode) : null;
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
    room.spectators?.forEach(spectator => send(spectator, message));
}

function broadcastRoomEvent(room, event) {
    const message = { type: 'room-event', ...event };
    room.players.forEach(player => send(player, message));
    room.spectators?.forEach(spectator => send(spectator, message));
}

function connectedPlayers(room) {
    return room.players.filter(player => {
        const gamePlayer = room.gamePlayers?.find(candidate => candidate.id === player.id);
        return gamePlayer?.isAlive
            && player.socket
            && player.socket.readyState === WebSocket.OPEN;
    });
}

function gameProgressFor(room, client, isSpectator = false) {
    const gamePlayer = room.gamePlayers.find(player => player.id === client.id);
    const wolfIntentions = !isSpectator
        && gamePlayer?.role === 'werewolf'
        && room.phase === 'NIGHT_WEREWOLF'
        ? phaseParticipants(room).map(wolf => ({
            playerId: wolf.id,
            playerName: wolf.name,
            targetId: room.wolfTargets.get(wolf.id) ?? null
        }))
        : [];
    const publicPlayers = room.gamePlayers.map(player => {
        const roomPlayer = room.players.find(candidate => candidate.id === player.id);
        return {
            id: player.id,
            name: player.name,
            role: isSpectator
                || room.phase === 'GAME_OVER'
                || (gamePlayer?.role === 'werewolf' && player.role === 'werewolf')
                ? player.role
                : 'unassigned',
            isAlive: player.isAlive,
            diedForLove: Boolean(player.diedForLove),
            isConnected: Boolean(roomPlayer?.socket && roomPlayer.socket.readyState === WebSocket.OPEN),
            isReady: ['ROLE_REVEAL', 'DAY_DEATH_SPEECH', 'DAY_VOTE', 'DAY_VOTE_RUNOFF', 'DAY_VOTE_RESULT'].includes(room.phase)
                && room.readyPlayerIds.has(player.id)
        };
    });
    const loverTarget = room.gamePlayers.find(player => player.id === room.loverTargetId);
    const message = {
        type: 'game-progress',
        phase: room.phase,
        lover: !isSpectator && gamePlayer?.role === 'lover'
            ? {
                nightNumber: room.nightNumber,
                targetId: room.loverTargetId,
                targetRole: loverTarget?.role ?? null,
                targetAlive: Boolean(loverTarget?.isAlive),
                targetInDanger: room.phase === 'NIGHT_LOVER' && loverTargetInDanger(room),
                choice: room.loverChoice
            }
            : null,
        loverNotice: !isSpectator ? loverNoticeFor(room, client.id) : null,
        loverDecisionPending: Boolean(room.loverDecisionPending),
        loverCanDecide: !isSpectator && canLoverDecide(room, client.id),
        players: publicPlayers,
        roleCounts: room.roleCounts,
        wolfIntentions,
        readyPlayerIds: ['ROLE_REVEAL', 'DAY_DEATH_SPEECH', 'DAY_VOTE', 'DAY_VOTE_RUNOFF', 'DAY_VOTE_RESULT'].includes(room.phase)
            ? [...room.readyPlayerIds]
            : [],
        countdownSeconds: room.countdownSeconds,
        role: isSpectator ? null : gamePlayer?.role ?? null,
        wolfTargetId: !isSpectator && gamePlayer?.role === 'witch' && room.phase === 'NIGHT_WITCH'
            ? room.wolfTargetId
            : null,
        witchPotions: !isSpectator && gamePlayer?.role === 'witch'
            ? { saveUsed: room.witchPotions.saveUsed, poisonUsed: room.witchPotions.poisonUsed }
            : null,
        seerResult: !isSpectator && gamePlayer?.role === 'seer' ? room.seerResult : null,
        eliminatedPlayerIds: room.eliminatedPlayerIds,
        nightEliminatedPlayerIds: room.nightEliminatedPlayerIds,
        voteResults: room.voteResults,
        roundWinner: room.roundWinner,
        hunterShotPending: room.hunterShotPending,
        hunterId: room.hunterShotPending ? room.hunterId : null,
        hunterShotTargetId: room.hunterShotTargetId,
        selectedWolfTargetId: !isSpectator && gamePlayer?.role === 'werewolf' ? room.wolfTargets.get(client.id) ?? null : null,
        selectedSaveTargetId: !isSpectator && gamePlayer?.role === 'witch' ? room.witchSaveTargetId : null,
        selectedPoisonTargetId: !isSpectator && gamePlayer?.role === 'witch' ? room.witchPoisonTargetId : null,
        selectedSeerTargetId: !isSpectator && gamePlayer?.role === 'seer' ? room.seerTargetId : null,
        selectedVoteTargetId: !isSpectator ? room.votes.get(client.id) ?? null : null,
        runoffCandidateIds: room.runoffCandidateIds ?? []
    };
    return message;
}

function broadcastGameProgress(room) {
    room.players.forEach(player => send(player, gameProgressFor(room, player)));
    room.spectators?.forEach(spectator => send(spectator, gameProgressFor(room, spectator, true)));
}

function clearReadyCountdown(room) {
    if (room.countdownTimer) clearInterval(room.countdownTimer);
    room.countdownTimer = null;
    room.countdownEndsAt = null;
    room.countdownSeconds = null;
}

function clearHiddenActionDelay(room) {
    if (room.hiddenActionDelayTimer) clearTimeout(room.hiddenActionDelayTimer);
    room.hiddenActionDelayTimer = null;
}

function startHiddenActionDelay(room) {
    clearHiddenActionDelay(room);
    const delaySeconds = crypto.randomInt(
        HIDDEN_ACTION_DELAY_MIN_SECONDS,
        HIDDEN_ACTION_DELAY_MAX_SECONDS + 1
    );
    room.hiddenActionDelayTimer = setTimeout(() => {
        room.hiddenActionDelayTimer = null;
        startReadyCountdown(room);
    }, delaySeconds * 1000);
    room.hiddenActionDelayTimer.unref();
}

function phaseActionsComplete(room) {
    if (room.phase === 'NIGHT_WEREWOLF') {
        return Boolean(unanimousWolfTarget(room));
    }
    if (room.phase === 'DAY_VOTE' || room.phase === 'DAY_VOTE_RUNOFF') {
        return phaseParticipants(room).every(player => room.votes.has(player.id));
    }
    if (room.phase === 'NIGHT_LOVER') return loverActionComplete(room);
    if (room.phase === 'DAY_VOTE_RESULT') return !room.hunterShotPending && !room.loverDecisionPending;
    if (room.phase === 'GAME_OVER') return false;
    return true;
}

function unanimousWolfTarget(room) {
    const wolves = phaseParticipants(room);
    if (wolves.length === 0) return null;
    const targetIds = wolves.map(player => room.wolfTargets.get(player.id));
    if (targetIds.some(targetId => !targetId)) return null;
    return targetIds.every(targetId => targetId === targetIds[0]) ? targetIds[0] : null;
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

function loverOptions(room) {
    const target = room.gamePlayers.find(player => player.id === room.loverTargetId && player.isAlive);
    if (!target) return { canSubstitute: false, canConvert: false };
    return {
        canSubstitute: loverTargetInDanger(room),
        canConvert: target.role === 'werewolf'
    };
}

function loverTargetInDanger(room) {
    const target = room.gamePlayers.find(player => player.id === room.loverTargetId && player.isAlive);
    if (!target) return false;
    const attacked = room.wolfTargetId === target.id && room.witchSaveTargetId !== target.id;
    return attacked || room.witchPoisonTargetId === target.id;
}

function loverActionComplete(room) {
    if (phaseParticipants(room).length === 0) return true;
    if (room.nightNumber === 1) return room.loverTargetId !== null;
    const { canSubstitute, canConvert } = loverOptions(room);
    return room.loverChoice !== null || (!canSubstitute && !canConvert);
}

function loverNoticeFor(room, clientId) {
    if (clientId === room.loverTargetId && room.loverConvertedId === clientId) {
        return '恋爱脑的爱的感化让你放下了獠牙，你现在是一名平民。';
    }
    if (clientId === room.loverId && room.loverReverted) {
        return '你已不再是恋爱脑，现在是一名普通平民。';
    }
    const lover = room.gamePlayers?.find(player => player.id === room.loverId);
    if (clientId === room.loverTargetId && lover?.isAlive && !room.loverReverted) {
        return '有人对你暗送秋波。';
    }
    return null;
}

function winnerFor(room) {
    const living = room.gamePlayers.filter(player => player.isAlive);
    const wolves = living.filter(player => player.role === 'werewolf').length;
    const villagers = living.length - wolves;
    if (wolves === 0) return '好人阵营获胜';
    if (wolves >= villagers) return '狼人阵营获胜';
    return null;
}

function resolveRound(room, isRunoff = false) {
    const eliminatedIds = new Set(room.nightEliminatedPlayerIds);
    const voteCandidates = room.gamePlayers.filter(player => player.isAlive);
    const votersByTarget = new Map();
    phaseParticipants(room)
        .forEach(player => {
            const targetId = room.votes.get(player.id);
            if (targetId) {
                const voterIds = votersByTarget.get(targetId) || [];
                voterIds.push(player.id);
                votersByTarget.set(targetId, voterIds);
            }
        });
    room.voteResults = voteCandidates.map(player => ({
        targetId: player.id,
        targetName: player.name,
        voterIds: votersByTarget.get(player.id) || [],
        votes: votersByTarget.get(player.id)?.length || 0,
        eliminated: false,
        hunterShot: false,
        loverSubstituted: false
    }));
    const voteCounts = new Map(
        room.voteResults.map(result => [result.targetId, result.votes])
    );
    const highestVoteCount = Math.max(0, ...voteCounts.values());
    const voteWinners = [...voteCounts.entries()].filter(([, count]) => count === highestVoteCount);
    if (!isRunoff && voteWinners.length > 1 && highestVoteCount > 0) {
        room.runoffCandidateIds = voteWinners.map(([playerId]) => playerId);
        room.votes.clear();
        room.readyPlayerIds.clear();
        room.gamePlayers.forEach(player => {
            player.isReady = false;
        });
        room.phase = 'DAY_VOTE_RUNOFF';
        const tiedNames = room.gamePlayers
            .filter(player => room.runoffCandidateIds.includes(player.id))
            .map(player => player.name);
        broadcastRoomEvent(room, {
            playerId: null,
            text: `最高票出现平票（${tiedNames.join('、')}），进入加赛投票。请所有有投票权的存活玩家仅在平票玩家中重新投票。`
        });
        broadcastGameProgress(room);
        return;
    }
    const voteEliminatedIds = new Set();
    if (voteWinners.length === 1 && highestVoteCount > 0) {
        voteEliminatedIds.add(voteWinners[0][0]);
        eliminatedIds.add(voteWinners[0][0]);
    }
    room.voteResults.forEach(result => {
        result.eliminated = voteEliminatedIds.has(result.targetId);
    });

    room.eliminatedPlayerIds = [...eliminatedIds];
    room.gamePlayers.forEach(player => {
        if (voteEliminatedIds.has(player.id)) player.isAlive = false;
    });
    const loverForDecision = room.gamePlayers.find(player => player.id === room.loverId && player.isAlive);
    room.loverDecisionPending = Boolean(
        loverForDecision
        && room.nightNumber === 1
        && !room.loverReverted
        && room.loverTargetId
        && voteEliminatedIds.has(room.loverTargetId)
    );
    const eliminatedHunter = room.gamePlayers.find(player =>
        voteEliminatedIds.has(player.id) && player.role === 'hunter'
    );
    room.hunterId = eliminatedHunter?.id ?? null;
    room.hunterShotPending = Boolean(eliminatedHunter)
        && !(room.loverDecisionPending && eliminatedHunter.id === room.loverTargetId);
    room.hunterShotTargetId = null;
    const voteEliminatedNames = room.gamePlayers
        .filter(player => voteEliminatedIds.has(player.id))
        .map(player => player.name);
    room.roundWinner = room.hunterShotPending || room.loverDecisionPending ? null : winnerFor(room);
    room.phase = 'DAY_VOTE_RESULT';
    clearHiddenActionDelay(room);
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
    const voteSummary = room.voteResults
        .map(result => {
            const voterNames = result.voterIds.map(voterId =>
                room.gamePlayers.find(player => player.id === voterId)?.name ?? '未知玩家'
            );
            return `${result.targetName} ${result.votes} 票（投票玩家：${voterNames.join('、') || '无'}）`;
        })
        .join('，');
    const result = voteEliminatedNames.length > 0
        ? `投票结果公示：${voteSummary}。投票淘汰：${voteEliminatedNames.join('、')}。`
        : `投票结果公示：${voteSummary || '无人得票'}。${isRunoff ? '加赛仍为平票或无人得票，本轮无人因投票淘汰。' : '无人得票，本轮无人因投票淘汰。'}`;
    room.runoffCandidateIds = [];
    broadcastRoomEvent(room, { playerId: null, text: result });
    if (room.loverDecisionPending) {
        broadcastRoomEvent(room, {
            playerId: null,
            text: '恋爱脑正在抉择是否为心动对象赴死。'
        });
    } else if (room.hunterShotPending) {
        broadcastRoomEvent(room, {
            playerId: null,
            text: `${eliminatedHunter.name}（猎人）被投票出局，可以选择开枪带走一名玩家。`
        });
    }
    if (room.roundWinner) broadcastRoomEvent(room, { playerId: null, text: `游戏结束：${room.roundWinner}！` });
    else if (!room.loverDecisionPending) broadcastRoomEvent(room, { playerId: null, text: '确认投票结果后，游戏将继续进入下一轮。' });
    broadcastGameProgress(room);
}

function canLoverDecide(room, clientId) {
    return room.phase === 'DAY_VOTE_RESULT'
        && room.loverDecisionPending === true
        && room.loverId === clientId
        && Boolean(room.gamePlayers.find(player => player.id === clientId)?.isAlive);
}

function resolveLoverDecision(room, client, substitute) {
    const lover = room.gamePlayers.find(player => player.id === client.id);
    const target = room.gamePlayers.find(player => player.id === room.loverTargetId);
    room.loverDecisionPending = false;
    room.readyPlayerIds.clear();
    room.gamePlayers.forEach(player => {
        player.isReady = false;
    });
    const voteResult = room.voteResults.find(result => result.targetId === target.id);
    if (substitute) {
        target.isAlive = true;
        lover.isAlive = false;
        lover.diedForLove = true;
        room.eliminatedPlayerIds = room.eliminatedPlayerIds.filter(id => id !== target.id);
        room.eliminatedPlayerIds.push(lover.id);
        if (voteResult) {
            voteResult.eliminated = false;
            voteResult.loverSubstituted = true;
        }
        if (room.hunterId === target.id) room.hunterId = null;
        broadcastRoomEvent(room, {
            playerId: lover.id,
            text: `恋爱脑 ${lover.name} 为爱赴死，替 ${target.name} 承受了投票淘汰，${target.name} 继续存活${target.role === 'hunter' ? '，且不再有开枪资格' : ''}。`
        });
    } else {
        broadcastRoomEvent(room, {
            playerId: lover.id,
            text: `恋爱脑 ${lover.name} 选择保持清醒，没有替死。`
        });
        if (room.hunterId === target.id) {
            room.hunterShotPending = true;
            broadcastRoomEvent(room, {
                playerId: null,
                text: `${target.name}（猎人）被投票出局，可以选择开枪带走一名玩家。`
            });
        }
    }
    room.roundWinner = room.hunterShotPending ? null : winnerFor(room);
    if (room.roundWinner) broadcastRoomEvent(room, { playerId: null, text: `游戏结束：${room.roundWinner}！` });
    else if (!room.hunterShotPending) broadcastRoomEvent(room, { playerId: null, text: '确认投票结果后，游戏将继续进入下一轮。' });
    broadcastGameProgress(room);
    startReadyCountdown(room);
}

function applyLoverChoice(room, eliminatedIds) {
    if (room.nightNumber !== 2) return;
    const lover = room.gamePlayers.find(player => player.id === room.loverId && player.isAlive);
    if (!lover) return;
    const target = room.gamePlayers.find(player => player.id === room.loverTargetId && player.isAlive);
    const { canSubstitute, canConvert } = loverOptions(room);
    if (target && room.loverChoice === 'substitute' && canSubstitute) {
        eliminatedIds.delete(target.id);
        eliminatedIds.add(lover.id);
    } else if (target && room.loverChoice === 'convert' && canConvert) {
        target.role = 'villager';
        room.loverConvertedId = target.id;
        eliminatedIds.add(lover.id);
    }
    if (!eliminatedIds.has(lover.id)) {
        lover.role = 'villager';
        room.loverReverted = true;
    }
}

function resolveNight(room) {
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

    const eliminatedIds = new Set();
    const wolfAttackWasSaved = Boolean(
        room.wolfTargetId && room.witchSaveTargetId === room.wolfTargetId
    );
    if (room.wolfTargetId && !wolfAttackWasSaved) {
        eliminatedIds.add(room.wolfTargetId);
    }
    if (room.witchPoisonTargetId) eliminatedIds.add(room.witchPoisonTargetId);
    applyLoverChoice(room, eliminatedIds);
    room.nightEliminatedPlayerIds = [...eliminatedIds];
    room.eliminatedPlayerIds = [...eliminatedIds];
    room.gamePlayers.forEach(player => {
        if (eliminatedIds.has(player.id)) player.isAlive = false;
    });

    const names = room.gamePlayers
        .filter(player => eliminatedIds.has(player.id))
        .map(player => player.name);
    broadcastRoomEvent(room, {
        playerId: null,
        text: names.length > 0
            ? `天亮了，昨夜淘汰：${names.join('、')}。`
            : room.wolfTargetId
                ? '天亮了，昨夜无人淘汰。'
                : '天亮了，昨夜无人淘汰（狼人未形成有效袭击目标）。'
    });
    if (room.nightNumber === 2 && room.loverConvertedId) {
        broadcastRoomEvent(room, {
            playerId: null,
            text: '恋爱脑以爱感化了一名狼人，狼人净化为平民，恋爱脑为爱赴死。'
        });
    }
    return winnerFor(room);
}

function advanceGamePhase(room) {
    clearReadyCountdown(room);
    if (room.hunterShotPending && room.hunterId === client.id) {
        room.hunterShotPending = false;
        room.roundWinner = winnerFor(room);
        room.readyPlayerIds.clear();
        room.gamePlayers.forEach(player => {
            player.isReady = false;
        });
        broadcastRoomEvent(room, { playerId: null, text: '猎人离开了房间，放弃开枪。' });
    }
    if (room.phase === 'DAY_VOTE') {
        resolveRound(room);
        return;
    }
    if (room.phase === 'DAY_VOTE_RUNOFF') {
        resolveRound(room, true);
        return;
    }
    if (room.phase === 'DAY_VOTE_RESULT') {
        if (room.roundWinner) {
            room.phase = 'GAME_OVER';
            room.readyPlayerIds.clear();
            room.gamePlayers.forEach(player => {
                player.isReady = false;
            });
            broadcastGameProgress(room);
            return;
        }

        const hadEliminations = room.eliminatedPlayerIds.length > 0;
        room.phase = 'NIGHT_WEREWOLF';
        room.nightNumber += 1;
        room.loverChoice = null;
        room.roundWinner = null;
        room.voteResults = [];
        room.runoffCandidateIds = [];
        room.hunterId = null;
        room.hunterShotPending = false;
        room.hunterShotTargetId = null;
        room.nightEliminatedPlayerIds = [];
        room.readyPlayerIds.clear();
        room.gamePlayers.forEach(player => {
            player.isReady = false;
        });
        broadcastGameProgress(room);
        broadcastRoomEvent(room, { playerId: null, text: '投票结果已确认，天黑请闭眼。' });
        if (hadEliminations) startHiddenActionDelay(room);
        return;
    }
    const nextPhases = {
        ROLE_REVEAL: 'NIGHT_WEREWOLF',
        NIGHT_WEREWOLF: 'NIGHT_WITCH',
        NIGHT_WITCH: 'NIGHT_SEER',
        NIGHT_SEER: 'NIGHT_LOVER',
        NIGHT_LOVER: 'DAY_VOTE',
        DAY_DEATH_SPEECH: 'DAY_VOTE'
    };
    if (!nextPhases[room.phase]) return;
    if (room.phase === 'NIGHT_WITCH') {
        room.witchPotions.saveUsed = room.witchPotions.saveUsed || room.witchSaveTargetId !== null;
        room.witchPotions.poisonUsed = room.witchPotions.poisonUsed || room.witchPoisonTargetId !== null;
    }
    const nightWinner = room.phase === 'NIGHT_LOVER' ? resolveNight(room) : null;
    const hasOnlineNightEliminations = room.phase === 'NIGHT_LOVER'
        && room.nightEliminatedPlayerIds.some(id =>
            room.players.some(player =>
                player.id === id && player.socket?.readyState === WebSocket.OPEN
            )
        );
    room.phase = nightWinner
        ? 'GAME_OVER'
        : hasOnlineNightEliminations ? 'DAY_DEATH_SPEECH' : nextPhases[room.phase];
    room.readyPlayerIds.clear();
    room.gamePlayers.forEach(player => {
        player.isReady = false;
    });
    room.seerResult = null;
    room.seerTargetId = null;
    broadcastGameProgress(room);
    broadcastRoomEvent(room, {
        playerId: null,
        text: nightWinner
            ? `游戏结束：${nightWinner}！`
            : ({
            NIGHT_WITCH: '狼人行动结束，进入女巫行动阶段。',
            NIGHT_SEER: '女巫行动结束，进入预言家查验阶段。',
            NIGHT_LOVER: '预言家行动结束，进入恋爱脑行动阶段。',
            DAY_VOTE: '夜晚行动结束，进入讨论与投票阶段。',
            NIGHT_WEREWOLF: '夜幕降临，进入狼人行动阶段。'
        })[room.phase] || '游戏阶段已更新。'
    });
    startReadyCountdown(room);
}

function startReadyCountdown(room) {
    if (room.countdownTimer || room.hiddenActionDelayTimer || room.phase === 'GAME_OVER') return;
    if (!phaseActionsComplete(room)) return;
    const activePlayers = phaseParticipants(room);
    if (activePlayers.length === 0) {
        if (connectedPlayers(room).length === 0) return;
        advanceGamePhase(room);
        return;
    }
    if (activePlayers.some(player =>
        !room.readyPlayerIds.has(player.id)
    )) return;

    if (room.phase === 'DAY_VOTE_RESULT') {
        advanceGamePhase(room);
        return;
    }

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
    const gamePlayer = room.gamePlayers.find(player => player.id === client.id);
    if (isReady && !phaseParticipants(room).some(player => player.id === client.id)) {
        sendError(client, '当前阶段无需由你确认准备。');
        return;
    }
    if (isReady) {
        room.readyPlayerIds.add(client.id);
    } else {
        room.readyPlayerIds.delete(client.id);
        clearReadyCountdown(room);
    }
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
    broadcastAvailableRooms();
}

function leaveRoom(client) {
    const spectatorRoom = spectatorRoomFor(client);
    if (spectatorRoom) {
        spectatorRoom.spectators = spectatorRoom.spectators.filter(spectator => spectator !== client);
        client.spectatingRoomCode = null;
        send(client, { type: 'left-room' });
        broadcastRoomEvent(spectatorRoom, {
            playerId: null,
            text: '一名游客离开了观战。'
        });
        return;
    }

    const room = roomFor(client);
    if (!room) {
        sendError(client, '你不在房间中。');
        return;
    }
    if (room.started && room.phase !== 'GAME_OVER') {
        client.socket?.close();
        return;
    }
    clearReadyCountdown(room);
    room.readyPlayerIds?.delete(client.id);
    room.votes?.delete(client.id);
    room.wolfTargets?.delete(client.id);
    if (room.seerTargetId === client.id) room.seerTargetId = null;
    if (room.witchSaveTargetId === client.id) room.witchSaveTargetId = null;
    if (room.witchPoisonTargetId === client.id) room.witchPoisonTargetId = null;
    room.eliminatedPlayerIds = (room.eliminatedPlayerIds || []).filter(id => id !== client.id);
    room.nightEliminatedPlayerIds = (room.nightEliminatedPlayerIds || []).filter(id => id !== client.id);
    room.players = room.players.filter(player => player.id !== client.id);
    room.gamePlayers = room.gamePlayers?.filter(player => player.id !== client.id) ?? null;
    if (room.loverDecisionPending && room.loverId === client.id) {
        room.loverDecisionPending = false;
        if (room.hunterId && room.hunterId === room.loverTargetId) room.hunterShotPending = true;
    }
    if (room.hostId === client.id && room.players.length > 0) {
        room.hostId = room.players[0].id;
    }
    client.roomCode = null;
    client.name = null;
    send(client, { type: 'left-room' });

    if (room.players.length === 0 && !room.started) {
        rooms.delete(room.code);
        broadcastAvailableRooms();
        return;
    }

    if (room.started && room.phase !== 'GAME_OVER' && room.phase !== 'DAY_VOTE_RESULT') {
        const winner = winnerFor(room);
        if (winner) {
            clearHiddenActionDelay(room);
            room.phase = 'GAME_OVER';
            room.roundWinner = winner;
            room.readyPlayerIds.clear();
            room.gamePlayers.forEach(player => {
                player.isReady = false;
            });
            broadcastRoomEvent(room, { playerId: null, text: `游戏结束：${winner}！` });
        }
    }
    broadcastRoomState(room);
    if (room.started) broadcastGameProgress(room);
    broadcastRoomEvent(room, { playerId: null, text: '一名玩家退出了房间。' });
    broadcastAvailableRooms();
    startReadyCountdown(room);
}

function shuffledRoles(playerCount) {
    const wolfCount = playerCount >= 12 ? 4 : playerCount >= 8 ? 3 : playerCount >= 6 ? 2 : 1;
    const hasHunter = playerCount >= 7;
    const hasLover = playerCount >= 10;
    const roles = [
        ...Array(wolfCount).fill('werewolf'),
        'seer',
        'witch',
        ...(hasHunter ? ['hunter'] : []),
        ...(hasLover ? ['lover'] : []),
        ...Array(playerCount - wolfCount - 2 - Number(hasHunter) - Number(hasLover)).fill('villager')
    ];
    for (let i = roles.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1);
        [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    return roles;
}

function roleCountsFor(roles) {
    const counts = {
        werewolf: 0,
        seer: 0,
        witch: 0,
        hunter: 0,
        lover: 0,
        villager: 0
    };
    roles.forEach(role => {
        counts[role] += 1;
    });
    return counts;
}

function beginGame(room, initiator) {
    clearReadyCountdown(room);
    clearHiddenActionDelay(room);
    room.started = true;
    room.phase = 'ROLE_REVEAL';
    room.readyPlayerIds = new Set();
    room.witchPotions = { saveUsed: false, poisonUsed: false };
    room.wolfTargets = new Map();
    room.witchSaveTargetId = null;
    room.witchPoisonTargetId = null;
    room.wolfTargetId = null;
    room.seerTargetId = null;
    room.seerResult = null;
    room.votes = new Map();
    room.voteResults = [];
    room.runoffCandidateIds = [];
    room.roundWinner = null;
    room.hunterId = null;
    room.hunterShotPending = false;
    room.hunterShotTargetId = null;
    room.eliminatedPlayerIds = [];
    room.nightEliminatedPlayerIds = [];
    room.nightNumber = 1;
    room.loverTargetId = null;
    room.loverChoice = null;
    room.loverConvertedId = null;
    room.loverReverted = false;
    room.loverDecisionPending = false;
    const roles = shuffledRoles(room.players.length);
    room.roleCounts = roleCountsFor(roles);
    room.gamePlayers = room.players.map((player, index) => ({
        id: player.id,
        name: player.name,
        role: roles[index],
        isAlive: true,
        isReady: false,
        isConnected: Boolean(player.socket && player.socket.readyState === WebSocket.OPEN)
    }));
    room.loverId = room.gamePlayers.find(player => player.role === 'lover')?.id ?? null;
    room.players.forEach(player => send(player, {
        type: 'game-started',
        phase: room.phase,
        role: room.gamePlayers.find(gamePlayer => gamePlayer.id === player.id)?.role ?? null,
        players: room.gamePlayers.map(gamePlayer => ({
            id: gamePlayer.id,
            name: gamePlayer.name,
            role: 'unassigned',
            isAlive: gamePlayer.isAlive,
            diedForLove: false,
            isConnected: gamePlayer.isConnected,
            isReady: false
        }))
    }));
    broadcastGameProgress(room);
    broadcastRoomEvent(room, {
        playerId: initiator.id,
        text: `${initiator.name}${room.round > 1 ? ' 重新' : ' '}开始了游戏。`
    });
    broadcastAvailableRooms();
}

function handleMessage(client, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        sendError(client, '无效的请求。');
        return;
    }

    if (message.type === 'list-rooms') {
        send(client, availableRoomsMessage());
        return;
    }

    if (message.type === 'leave-room') {
        leaveRoom(client);
        return;
    }

    if (message.type === 'spectate-room') {
        if (client.roomCode || client.spectatingRoomCode) {
            sendError(client, '你已经在一个房间里了。');
            return;
        }
        const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{4}$/.test(code)) {
            sendError(client, '请输入有效的 4 位房间码。');
            return;
        }
        const room = rooms.get(code);
        if (!room) {
            sendError(client, '找不到这个房间，请检查房间码。');
            return;
        }
        room.spectators = room.spectators || [];
        room.spectators.push(client);
        client.spectatingRoomCode = room.code;
        send(client, { type: 'spectator-joined', code: room.code });
        send(client, {
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
        });
        if (room.started) send(client, gameProgressFor(room, client, true));
        broadcastRoomEvent(room, { playerId: null, text: '一名游客加入观战。' });
        return;
    }

    if (message.type === 'create-room') {
        if (client.roomCode || client.spectatingRoomCode) {
            sendError(client, '你已经在一个房间里了。');
            return;
        }
        const name = getPlayerName(message.name);
        if (!name) {
            sendError(client, '昵称需为 1-24 个字符。');
            return;
        }
        if (message.code !== undefined && typeof message.code !== 'string') {
            sendError(client, '自定义房间码无效。');
            return;
        }
        const result = createRoomCode(message.code ?? '');
        if (result.error) {
            sendError(client, result.error);
            return;
        }
        const { code } = result;
        const room = { code, hostId: client.id, players: [], spectators: [], started: false, gamePlayers: null };
        rooms.set(code, room);
        enterRoom(client, name, room);
        return;
    }

    if (message.type === 'join-room') {
        if (client.roomCode || client.spectatingRoomCode) {
            sendError(client, '你已经在一个房间里了。');
            return;
        }
        const name = getPlayerName(message.name);
        const code = typeof message.code === 'string' ? message.code.trim().toUpperCase() : '';
        if (!name) {
            sendError(client, '昵称需为 1-24 个字符。');
            return;
        }
        if (!/^[A-Z0-9]{4}$/.test(code)) {
            sendError(client, '请输入有效的 4 位房间码。');
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
        if (['ROLE_REVEAL', 'DAY_DEATH_SPEECH', 'DAY_VOTE_RESULT'].includes(room.phase) && !message.isReady) {
            sendError(client, '当前阶段确认后不能取消准备。');
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
        const isDeathSpeaker = room.phase === 'DAY_DEATH_SPEECH'
            && room.nightEliminatedPlayerIds.includes(client.id);
        const isVoteResultConfirmer = room.phase === 'DAY_VOTE_RESULT';
        if (!gamePlayer || (!gamePlayer.isAlive && !isDeathSpeaker && !isVoteResultConfirmer)) {
            sendError(client, '淘汰玩家不能提交准备状态。');
            return;
        }
        if (message.isReady && !phaseParticipants(room).some(player => player.id === client.id)) {
            sendError(client, '当前阶段无需由你确认准备。');
            return;
        }
        if (message.isReady && room.phase === 'DAY_VOTE_RESULT' && room.loverDecisionPending) {
            sendError(client, '请等待恋爱脑做出抉择。');
            return;
        }
        if (message.isReady && room.phase === 'NIGHT_LOVER' && !loverActionComplete(room)) {
            sendError(client, room.nightNumber === 1 ? '请先选择心动对象。' : '请先做出选择。');
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
        if (
            message.isReady
            && room.phase === 'NIGHT_WEREWOLF'
            && gamePlayer.role === 'werewolf'
            && unanimousWolfTarget(room) !== room.wolfTargets.get(client.id)
        ) {
            sendError(client, '请等待所有在线狼人统一袭击目标后再确认。');
            return;
        }
        if (message.isReady && ['DAY_VOTE', 'DAY_VOTE_RUNOFF'].includes(room.phase) && !room.votes.has(client.id)) {
            room.votes.set(client.id, null);
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
        const { action, targetId } = message;
        if (typeof action !== 'string') {
            sendError(client, '行动类型无效。');
            return;
        }
        if (action === 'lover-decision') {
            if (!canLoverDecide(room, client.id) || typeof message.substitute !== 'boolean') {
                sendError(client, '当前无法做出恋爱脑抉择。');
                return;
            }
            resolveLoverDecision(room, client, message.substitute);
            return;
        }
        if (action === 'hunter-shot') {
            if (
                room.phase !== 'DAY_VOTE_RESULT'
                || !room.hunterShotPending
                || room.hunterId !== client.id
                || gamePlayer?.role !== 'hunter'
                || gamePlayer.isAlive
            ) {
                sendError(client, '当前无法使用猎人技能。');
                return;
            }
            if (targetId !== null && (!validLivingTarget(room, targetId) || targetId === client.id)) {
                sendError(client, '开枪目标无效。');
                return;
            }
            room.hunterShotPending = false;
            room.readyPlayerIds.clear();
            room.gamePlayers.forEach(player => {
                player.isReady = false;
            });
            if (targetId) {
                const target = room.gamePlayers.find(player => player.id === targetId);
                if (!target) {
                    sendError(client, '开枪目标无效。');
                    return;
                }
                target.isAlive = false;
                room.hunterShotTargetId = target.id;
                room.eliminatedPlayerIds.push(target.id);
                const voteResult = room.voteResults.find(result => result.targetId === target.id);
                if (voteResult) voteResult.hunterShot = true;
                broadcastRoomEvent(room, {
                    playerId: client.id,
                    text: `猎人 ${gamePlayer.name} 含冤而死，开枪带走了 ${target.name}。`
                });
            } else {
                broadcastRoomEvent(room, {
                    playerId: client.id,
                    text: `猎人 ${gamePlayer.name} 含冤而死，选择不开枪。`
                });
            }
            room.roundWinner = winnerFor(room);
            if (room.roundWinner) {
                broadcastRoomEvent(room, { playerId: null, text: `游戏结束：${room.roundWinner}！` });
            }
            broadcastGameProgress(room);
            startReadyCountdown(room);
            return;
        }
        if (!gamePlayer?.isAlive) {
            sendError(client, '淘汰玩家不能进行行动。');
            return;
        }
        if (gamePlayer.isReady) {
            sendError(client, '你已准备就绪，请先取消准备再修改行动。');
            return;
        }
        if (action === 'wolf-target') {
            if (room.phase !== 'NIGHT_WEREWOLF' || gamePlayer.role !== 'werewolf') {
                sendError(client, '当前阶段不能选择狼人袭击目标。');
                return;
            }
            const target = room.gamePlayers.find(player => player.id === targetId && player.isAlive);
            if (!target) {
                sendError(client, '袭击目标无效。');
                return;
            }
            if (room.wolfTargets.get(client.id) !== target.id) {
                phaseParticipants(room).forEach(wolf => {
                    room.readyPlayerIds.delete(wolf.id);
                    const wolfPlayer = room.gamePlayers.find(player => player.id === wolf.id);
                    if (wolfPlayer) wolfPlayer.isReady = false;
                });
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
            if (room.seerTargetId !== null) {
                sendError(client, '本晚已查验过一名玩家。');
                return;
            }
            if (!validLivingTarget(room, targetId) || targetId === client.id) {
                sendError(client, '查验目标无效。');
                return;
            }
            room.seerTargetId = targetId;
            room.seerResult = room.gamePlayers.find(player => player.id === targetId)?.role ?? null;
        } else if (action === 'lover-target') {
            if (room.phase !== 'NIGHT_LOVER' || gamePlayer.role !== 'lover' || room.nightNumber !== 1) {
                sendError(client, '当前阶段不能选择心动对象。');
                return;
            }
            if (room.loverTargetId !== null) {
                sendError(client, '心动对象一旦选择便无法更改。');
                return;
            }
            if (!validLivingTarget(room, targetId) || targetId === client.id) {
                sendError(client, '心动对象无效。');
                return;
            }
            room.loverTargetId = targetId;
        } else if (action === 'lover-choice') {
            if (room.phase !== 'NIGHT_LOVER' || gamePlayer.role !== 'lover' || room.nightNumber !== 2) {
                sendError(client, '当前阶段不能做出恋爱脑选择。');
                return;
            }
            if (room.loverChoice !== null) {
                sendError(client, '你已经做出选择，无法更改。');
                return;
            }
            const { canSubstitute, canConvert } = loverOptions(room);
            const choice = message.choice;
            if (
                !['substitute', 'convert', 'abstain'].includes(choice)
                || (choice === 'substitute' && !canSubstitute)
                || (choice === 'convert' && !canConvert)
            ) {
                sendError(client, '该选项当前不可用。');
                return;
            }
            room.loverChoice = choice;
        } else if (action === 'vote') {
            const isVotingPhase = room.phase === 'DAY_VOTE' || room.phase === 'DAY_VOTE_RUNOFF';
            const targetIsEligibleForRunoff = room.phase !== 'DAY_VOTE_RUNOFF'
                || room.runoffCandidateIds?.includes(targetId);
            if (!isVotingPhase || !targetIsEligibleForRunoff
                || !validLivingTarget(room, targetId) || targetId === client.id) {
                sendError(client, room.phase === 'DAY_VOTE_RUNOFF'
                    ? '加赛只能投票给平票候选人。'
                    : '投票目标无效。');
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

        room.round = 1;
        beginGame(room, client);
        return;
    }

    if (message.type === 'restart-game') {
        const room = roomFor(client);
        if (!room || room.phase !== 'GAME_OVER') {
            sendError(client, '只有游戏结束后才能重新开始。');
            return;
        }
        if (room.hostId !== client.id) {
            sendError(client, '只有房主可以重新开始游戏。');
            return;
        }
        if (room.players.length < MIN_PLAYERS) {
            sendError(client, `至少需要 ${MIN_PLAYERS} 位玩家才能重新开始。`);
            return;
        }
        room.round = (room.round || 1) + 1;
        beginGame(room, client);
        return;
    }

    sendError(client, '不支持的请求类型。');
}

function playerInRoom(playerId, roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return null;
    const player = room.players.find(candidate => candidate.id === playerId);
    return player ? { player, room } : null;
}

function playerInAnyRoom(playerId) {
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
    const requestedRoomCode = requestUrl.searchParams.get('roomCode')?.toUpperCase();
    const isValidPlayerId = typeof requestedPlayerId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedPlayerId);
    const isValidRoomCode = typeof requestedRoomCode === 'string'
        && /^[A-Z0-9]{4}$/.test(requestedRoomCode);
    const existingPlayer = isValidPlayerId && isValidRoomCode
        ? playerInRoom(requestedPlayerId, requestedRoomCode)
        : null;
    const playerAlreadyInRoom = isValidPlayerId ? playerInAnyRoom(requestedPlayerId) : null;
    const client = existingPlayer?.player ?? {
        id: isValidPlayerId && !playerAlreadyInRoom ? requestedPlayerId : crypto.randomUUID(),
        name: null,
        roomCode: null,
        socket: null
    };

    const previousSocket = client.socket;
    client.socket = socket;
    if (previousSocket && previousSocket !== socket) previousSocket.close();

    send(client, {
        type: 'connected',
        playerId: client.id,
        resumedRoom: Boolean(existingPlayer)
    });
    if (existingPlayer) {
        broadcastRoomState(existingPlayer.room);
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
                    diedForLove: Boolean(player.diedForLove),
                    isConnected: player.isConnected,
                    isReady: existingPlayer.room.readyPlayerIds.has(player.id)
                }))
            });
            broadcastGameProgress(existingPlayer.room);
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
        const spectatorRoom = spectatorRoomFor(client);
        if (spectatorRoom) {
            spectatorRoom.spectators = spectatorRoom.spectators.filter(spectator => spectator !== client);
            client.spectatingRoomCode = null;
            broadcastRoomEvent(spectatorRoom, {
                playerId: null,
                text: '一名游客离开了观战。'
            });
            return;
        }
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

    });
    socket.on('error', error => {
        console.error(`WebSocket error for player ${client.id}:`, error);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Werewolf game server listening on port ${PORT}`);
});
