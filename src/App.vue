<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';

type Role = 'werewolf' | 'seer' | 'witch' | 'villager';
type GamePhase = 'LOBBY' | 'NIGHT_WEREWOLF' | 'DAY_DISCUSS';
type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

interface Player {
    id: string;
    name: string;
    role: Role | 'unassigned';
    isAlive: boolean;
    isConnected: boolean;
    isReady: boolean;
    isMe: boolean;
}

interface RoomPlayer {
    id: string;
    name: string;
    isConnected: boolean;
    isReady: boolean;
}

interface GamePlayer {
    id: string;
    name: string;
    role: Role;
    isAlive: boolean;
    isConnected: boolean;
    isReady: boolean;
}

type ServerMessage =
    | { type: 'connected'; playerId: string }
    | { type: 'room-state'; room: { code: string; hostId: string; players: RoomPlayer[] } }
    | { type: 'game-started'; phase: GamePhase; players: GamePlayer[] }
    | { type: 'game-progress'; phase: GamePhase; readyPlayerIds: string[]; countdownSeconds: number | null }
    | { type: 'player-connection'; playerId: string; isConnected: boolean }
    | { type: 'room-event'; playerId: string | null; text: string }
    | { type: 'error'; message: string };

interface MemoEntry {
    text: string;
    isOwnAction: boolean;
}

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const PLAYER_ID_STORAGE_KEY = 'werewolf-player-id';
const PLAYER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const roleInfo: Record<Role, { name: string; tip: string }> = {
    werewolf: { name: '🐺 狼人', tip: '每晚寻找目标并击杀一名好人。' },
    seer: { name: '🔮 预言家', tip: '每晚可以查验一名玩家的真实身份。' },
    witch: { name: '🧪 女巫', tip: '拥有一瓶解药和一瓶毒药（整局各一次）。' },
    villager: { name: '🧑 平民', tip: '认真听取发言，通过投票找出狼人。' }
};

const toast = useToast();
const playerName = ref('Player');
const renameName = ref('');
const roomCodeInput = ref('');
const roomCode = ref<string | null>(null);
const playerId = ref<string | null>(null);
const players = ref<Player[]>([]);
const phase = ref<GamePhase>('LOBBY');
const connectionState = ref<ConnectionState>('connecting');
const roomError = ref('');
const waitingNote = ref('等待房主开始游戏...');
const roomStarted = ref(false);
const countdownSeconds = ref<number | null>(null);
const nightTarget = ref<string | null>(null);
const logs = ref<MemoEntry[]>([{ text: '[系统] 创建房间或输入房间码加入好友的房间。', isOwnAction: false }]);
const logContainer = ref<HTMLDivElement | null>(null);

let roomConnection: WebSocket | null = null;

const hostId = ref<string | null>(null);
const isHost = computed(() => Boolean(playerId.value) && hostId.value === playerId.value);
const currentPlayer = computed(() => players.value.find(player => player.isMe));
const roomStatus = computed(() => {
    if (!roomCode.value) return '未加入房间';
    return phase.value === 'LOBBY' ? '等待玩家' : '游戏进行中';
});
const connectionLabel = computed<Record<ConnectionState, string>>(() => ({
    connecting: '正在连接房间服务...',
    connected: '房间服务已连接',
    disconnected: '房间服务已断开',
    failed: '房间服务连接失败'
}));
const connectionSeverity = computed(() => {
    if (connectionState.value === 'connected') return 'success';
    if (connectionState.value === 'connecting') return 'info';
    return 'danger';
});
const waitingButtonLabel = computed(() => {
    const count = players.value.length;
    if (roomStarted.value) return '本局已开始';
    if (count < MIN_PLAYERS) return `等待玩家 (${count}/${MIN_PLAYERS})`;
    return isHost.value ? `🚀 开始游戏 (${count}/${MAX_PLAYERS})` : '等待房主开始游戏';
});
const waitingDescription = computed(() => {
    if (roomStarted.value) return '本局结束后，请刷新页面创建新房间。';
    return isHost.value
        ? `分享房间码，至少 ${MIN_PLAYERS} 位玩家加入后即可开始。`
        : '已加入房间，等待房主开始游戏...';
});
const roleDetails = computed(() => {
    const role = currentPlayer.value?.role;
    return role && role !== 'unassigned' ? roleInfo[role] : { name: '未知', tip: '' };
});
const phaseTitle = computed(() => phase.value === 'NIGHT_WEREWOLF'
    ? '天黑请闭眼 · 狼人回合 🐺'
    : '天亮了 · 自由讨论与决胜 ☀️');
const phaseDescription = computed(() => {
    if (phase.value === 'NIGHT_WEREWOLF') {
        return currentPlayer.value?.role === 'werewolf'
            ? '轮到你行动：请选择一名玩家进行袭击，完成后点击准备就绪。'
            : '你是好人阵营，正在沉睡中，等待狼人行动...';
    }
    return '请结合语音频道进行讨论与投票；完成后点击准备就绪，等待所有玩家进入下一阶段。';
});
const aliveTargets = computed(() => players.value.filter(player =>
    player.isAlive && player.role !== 'werewolf'
));
const canStartGame = computed(() =>
    isHost.value && !roomStarted.value && players.value.length >= MIN_PLAYERS
);
const readyPlayerCount = computed(() => players.value.filter(player =>
    player.isConnected && player.isReady
).length);
const connectedPlayerCount = computed(() => players.value.filter(player => player.isConnected).length);
const readyButtonLabel = computed(() => currentPlayer.value?.isReady ? '取消准备' : '准备就绪');

function isGamePhase(value: unknown): value is GamePhase {
    return value === 'NIGHT_WEREWOLF' || value === 'DAY_DISCUSS';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is Role {
    return value === 'werewolf' || value === 'seer' || value === 'witch' || value === 'villager';
}

function isRoomPlayerList(value: unknown): value is RoomPlayer[] {
    return Array.isArray(value) && value.every(player =>
        isRecord(player)
        && typeof player.id === 'string'
        && typeof player.name === 'string'
        && typeof player.isConnected === 'boolean'
        && typeof player.isReady === 'boolean'
    );
}

function isGamePlayerList(value: unknown): value is GamePlayer[] {
    return Array.isArray(value) && value.every(player =>
        isRecord(player)
        && typeof player.id === 'string'
        && typeof player.name === 'string'
        && isRole(player.role)
        && typeof player.isAlive === 'boolean'
        && typeof player.isConnected === 'boolean'
        && typeof player.isReady === 'boolean'
    );
}

function parseServerMessage(value: unknown): ServerMessage | null {
    if (!isRecord(value) || typeof value.type !== 'string') return null;

    if (value.type === 'connected' && typeof value.playerId === 'string') {
        return { type: 'connected', playerId: value.playerId };
    }
    if (value.type === 'error' && typeof value.message === 'string') {
        return { type: 'error', message: value.message };
    }
    if (value.type === 'room-state' && isRecord(value.room)) {
        const { code, hostId, players: roomPlayers } = value.room;
        if (typeof code !== 'string' || typeof hostId !== 'string' || !isRoomPlayerList(roomPlayers)) {
            return null;
        }

        return {
            type: 'room-state',
            room: {
                code,
                hostId,
                players: roomPlayers.map(player => ({
                    id: player.id,
                    name: player.name,
                    isConnected: player.isConnected,
                    isReady: player.isReady
                }))
            }
        };
    }
    if (value.type === 'game-started' && isGamePhase(value.phase) && isGamePlayerList(value.players)) {
        return {
            type: 'game-started',
            phase: value.phase,
            players: value.players
        };
    }
    if (
        value.type === 'game-progress'
        && isGamePhase(value.phase)
        && Array.isArray(value.readyPlayerIds)
        && value.readyPlayerIds.every(id => typeof id === 'string')
        && (value.countdownSeconds === null || (
            typeof value.countdownSeconds === 'number'
            && Number.isInteger(value.countdownSeconds)
            && value.countdownSeconds >= 1
        ))
    ) {
        return {
            type: 'game-progress',
            phase: value.phase,
            readyPlayerIds: value.readyPlayerIds,
            countdownSeconds: value.countdownSeconds
        };
    }
    if (
        value.type === 'player-connection'
        && typeof value.playerId === 'string'
        && typeof value.isConnected === 'boolean'
    ) {
        return {
            type: 'player-connection',
            playerId: value.playerId,
            isConnected: value.isConnected
        };
    }
    if (
        value.type === 'room-event'
        && (typeof value.playerId === 'string' || value.playerId === null)
        && typeof value.text === 'string'
    ) {
        return {
            type: 'room-event',
            playerId: value.playerId,
            text: value.text
        };
    }
    return null;
}

async function addLog(text: string, actorId: string | null = null): Promise<void> {
    logs.value.push({
        text: `[${new Date().toLocaleTimeString()}] ${text}`,
        isOwnAction: actorId !== null && actorId === playerId.value
    });
    await nextTick();
    if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight;
}

function setRoomError(message: string): void {
    roomError.value = message;
}

function sendRoomMessage(message: Record<string, string | boolean>): void {
    if (!__WEBSOCKET_URL__ && window.location.hostname.endsWith('.github.io')) {
        setRoomError('GitHub Pages 仅托管静态页面。请配置 WEBSOCKET_URL，指向已部署的 WebSocket 服务，然后重新构建并部署。');
        return;
    }
    if (!roomConnection || roomConnection.readyState !== WebSocket.OPEN) {
        setRoomError('房间服务未连接，请稍后重试。');
        return;
    }
    roomConnection.send(JSON.stringify(message));
}

function broadcastMemo(text: string): void {
    sendRoomMessage({ type: 'memo-entry', text });
}

function validatedPlayerName(): string | null {
    const name = playerName.value.trim();
    if (!name || name.length > 24) {
        setRoomError('昵称需为 1-24 个字符。');
        return null;
    }
    return name;
}

function createRoom(): void {
    const name = validatedPlayerName();
    if (!name) return;
    setRoomError('');
    sendRoomMessage({ type: 'create-room', name });
}

function joinRoom(): void {
    const name = validatedPlayerName();
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!name) return;
    if (!ROOM_CODE_PATTERN.test(code)) {
        setRoomError('请输入有效的 6 位房间码。');
        return;
    }
    setRoomError('');
    sendRoomMessage({ type: 'join-room', name, code });
}

function handleRoomMessage(message: ServerMessage): void {
    if (message.type === 'connected') {
        playerId.value = message.playerId;
        try {
            localStorage.setItem(PLAYER_ID_STORAGE_KEY, message.playerId);
        } catch (error) {
            console.error('Unable to persist player identity.', error);
            setRoomError('无法保存玩家身份，刷新后将无法自动返回房间。');
        }
        connectionState.value = 'connected';
        return;
    }
    if (message.type === 'error') {
        setRoomError(message.message);
        return;
    }
    if (message.type === 'room-state') {
        roomCode.value = message.room.code;
        hostId.value = message.room.hostId;
        players.value = message.room.players.map(player => ({
            ...player,
            role: 'unassigned',
            isAlive: true,
            isMe: player.id === playerId.value
        }));
        if (!renameName.value) {
            renameName.value = players.value.find(player => player.isMe)?.name ?? '';
        } else {
            const currentOwnName = players.value.find(player => player.isMe)?.name;
            if (currentOwnName) {
                renameName.value = currentOwnName;
            }
        }
        return;
    }

    if (message.type === 'room-event') {
        void addLog(message.text, message.playerId);
        return;
    }

    if (message.type === 'player-connection') {
        const player = players.value.find(candidate => candidate.id === message.playerId);
        if (player) player.isConnected = message.isConnected;
        return;
    }

    if (message.type === 'game-progress') {
        const previousPhase = phase.value;
        phase.value = message.phase;
        countdownSeconds.value = message.countdownSeconds;
        players.value.forEach(player => {
            player.isReady = message.readyPlayerIds.includes(player.id);
        });
        if (previousPhase !== message.phase) {
            nightTarget.value = null;
            void addLog(message.phase === 'DAY_DISCUSS'
                ? '天亮了，进入白天讨论阶段。'
                : '夜幕降临，进入狼人阶段。');
        }
        return;
    }

    roomStarted.value = true;
    players.value = message.players.map(player => ({
        ...player,
        isMe: player.id === playerId.value
    }));
    phase.value = message.phase;
    countdownSeconds.value = null;
    void addLog(message.phase === 'NIGHT_WEREWOLF'
        ? '【夜晚阶段】狼人请睁眼，选择今晚要袭击的目标。'
        : '天亮了，进入白天讨论阶段。');
}

function connectToRoomService(): void {
    const isGitHubPages = window.location.hostname.endsWith('.github.io');
    if (!__WEBSOCKET_URL__ && isGitHubPages) {
        connectionState.value = 'failed';
        setRoomError('GitHub Pages 仅托管静态页面。请配置 WEBSOCKET_URL，指向已部署的 WebSocket 服务，然后重新构建并部署。');
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const websocketUrl = new URL(__WEBSOCKET_URL__ || `${protocol}//${window.location.host}`);
    if (!playerId.value) {
        connectionState.value = 'failed';
        setRoomError('无法识别玩家身份，请刷新页面重试。');
        return;
    }
    websocketUrl.searchParams.set('playerId', playerId.value);
    roomConnection = new WebSocket(websocketUrl);
    roomConnection.addEventListener('open', () => {
        connectionState.value = 'connected';
    });
    roomConnection.addEventListener('message', event => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(String(event.data));
        } catch (error) {
            console.error('Unable to parse room service message.', error);
            setRoomError('收到无法处理的房间服务消息，请刷新页面重试。');
            return;
        }
        const message = parseServerMessage(parsed);
        if (!message) {
            setRoomError('收到无法处理的房间服务消息，请刷新页面重试。');
            return;
        }
        handleRoomMessage(message);
    });
    roomConnection.addEventListener('close', () => {
        connectionState.value = 'disconnected';
        if (!roomCode.value) {
            setRoomError('无法连接房间服务，请确认服务已启动后刷新页面。');
        } else {
            waitingNote.value = '与房间服务断开，请刷新页面重新加入。';
        }
    });
    roomConnection.addEventListener('error', () => {
        connectionState.value = 'failed';
    });
}

async function copyRoomCode(): Promise<void> {
    if (!roomCode.value) return;
    try {
        await navigator.clipboard.writeText(roomCode.value);
        waitingNote.value = '房间码已复制，可以分享给好友。';
    } catch (error) {
        console.error('Unable to copy room code.', error);
        waitingNote.value = '复制失败，请手动选择房间码。';
    }
}

function startGame(): void {
    if (isHost.value) sendRoomMessage({ type: 'start-game' });
}

function changePlayerName(): void {
    const name = renameName.value.trim();
    if (!name || name.length > 24) {
        setRoomError('昵称需为 1-24 个字符。');
        return;
    }
    if (name === currentPlayer.value?.name) {
        setRoomError('');
        return;
    }
    setRoomError('');
    sendRoomMessage({ type: 'change-name', name });
}

function attackPlayer(player: Player): void {
    nightTarget.value = player.id;
    broadcastMemo(`你（狼人）锁定了袭击目标：${player.name}`);
}

function toggleReady(): void {
    const player = currentPlayer.value;
    if (!player || countdownSeconds.value !== null) return;
    sendRoomMessage({ type: 'set-ready', isReady: String(!player.isReady) });
}

function voteOutPlayer(): void {
    const alivePlayers = players.value.filter(player => player.isAlive);
    if (alivePlayers.length === 0) return;

    const victim = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
    victim.isAlive = false;
    const roleName = victim.role === 'unassigned' ? '未知' : roleInfo[victim.role].name;
    broadcastMemo(`[投票结果] 大家投票将 ${victim.name} 逐出了局！其身份是：${roleName}`);

    const aliveWolves = players.value.filter(player =>
        player.role === 'werewolf' && player.isAlive
    );
    const aliveGood = players.value.filter(player =>
        player.role !== 'werewolf' && player.isAlive
    );
    if (aliveWolves.length === 0) {
        endGame('🎉 游戏结束！好人阵营获胜！', '游戏结束：好人阵营获胜！');
    } else if (aliveWolves.length >= aliveGood.length) {
        endGame('🎉 游戏结束！狼人阵营获胜！', '游戏结束：狼人阵营获胜！');
    } else {
        void addLog('等待所有玩家准备就绪后进入下一阶段。');
    }
}

function endGame(logMessage: string, toastMessage: string): void {
    void addLog(logMessage);
    toast.add({ severity: 'success', summary: '游戏结束', detail: toastMessage, life: 5000 });
}

watch(roomCodeInput, value => {
    roomCodeInput.value = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});

onMounted(() => {
    if (window.location.protocol === 'file:') {
        connectionState.value = 'failed';
        setRoomError('请先运行 npm start，再通过 http://localhost:3000 打开游戏。');
        return;
    }
    try {
        const savedPlayerId = localStorage.getItem(PLAYER_ID_STORAGE_KEY);
        playerId.value = savedPlayerId && PLAYER_ID_PATTERN.test(savedPlayerId)
            ? savedPlayerId
            : crypto.randomUUID();
    } catch (error) {
        console.error('Unable to access saved player identity.', error);
        connectionState.value = 'failed';
        setRoomError('无法读取玩家身份，浏览器存储不可用。');
        return;
    }
    connectToRoomService();
});
onUnmounted(() => {
    roomConnection?.close();
});
</script>

<template>
    <div class="app-shell">
        <Toast position="top-right" />
        <header class="topbar">
            <div class="brand">
                <h1>🐺 空间狼人杀</h1>
                <Tag :value="roomStatus" :severity="roomCode ? 'info' : 'secondary'" />
            </div>
            <Tag :value="connectionLabel[connectionState]" :severity="connectionSeverity" />
        </header>

        <main class="game-layout">
            <section class="game-column">
                <Card v-if="!roomCode" class="game-card room-entry">
                    <template #title>加入狼人杀房间</template>
                    <template #subtitle>创建一个房间并分享房间码，或输入好友分享给你的房间码。</template>
                    <template #content>
                        <div class="name-form">
                            <div class="name-field">
                                <label class="field-label" for="player-name">你的昵称</label>
                                <InputText
                                    id="player-name"
                                    v-model="playerName"
                                    maxlength="24"
                                    placeholder="输入昵称"
                                    class="full-width"
                                    @keyup.enter="createRoom"
                                />
                            </div>
                            <Button label="创建房间" icon="pi pi-plus" @click="createRoom" />
                        </div>
                        <div class="form-divider"><span>或者</span></div>
                        <div class="join-form">
                            <InputText
                                v-model="roomCodeInput"
                                maxlength="6"
                                placeholder="输入 6 位房间码"
                                aria-label="房间码"
                                @keyup.enter="joinRoom"
                            />
                            <Button label="加入房间" icon="pi pi-sign-in" severity="secondary" @click="joinRoom" />
                        </div>
                        <Message v-if="roomError" severity="error" :closable="false" class="room-message">
                            {{ roomError }}
                        </Message>
                    </template>
                </Card>

                <Card v-else-if="phase === 'LOBBY'" class="game-card lobby-card">
                    <template #title>等待玩家加入</template>
                    <template #subtitle>分享房间码给好友。4-8 位玩家可以开始游戏。</template>
                    <template #content>
                        <div class="room-code">{{ roomCode }}</div>
                        <div class="rename-form">
                            <InputText
                                v-model="renameName"
                                maxlength="24"
                                placeholder="输入新昵称"
                                aria-label="修改昵称"
                                @keyup.enter="changePlayerName"
                            />
                            <Button label="修改昵称" icon="pi pi-user-edit" severity="secondary" @click="changePlayerName" />
                        </div>
                        <div class="action-row">
                            <Button label="复制房间码" icon="pi pi-copy" severity="secondary" @click="copyRoomCode" />
                            <Button
                                :label="waitingButtonLabel"
                                icon="pi pi-play"
                                :disabled="!canStartGame"
                                @click="startGame"
                            />
                        </div>
                        <p class="waiting-note">{{ waitingNote !== '等待房主开始游戏...' ? waitingNote : waitingDescription }}</p>
                        <Message v-if="roomError" severity="error" :closable="false" class="room-message">
                            {{ roomError }}
                        </Message>
                    </template>
                </Card>

                <Card v-else class="game-card active-game">
                    <template #title>{{ phaseTitle }}</template>
                    <template #subtitle>{{ phaseDescription }}</template>
                    <template #content>
                        <div class="ready-check">
                            <strong v-if="countdownSeconds !== null">
                                {{ countdownSeconds }} 秒后进入下一阶段
                            </strong>
                            <span v-else>
                                已准备 {{ readyPlayerCount }} / {{ connectedPlayerCount }} 位在线玩家
                            </span>
                            <Button
                                :label="readyButtonLabel"
                                :icon="currentPlayer?.isReady ? 'pi pi-times' : 'pi pi-check'"
                                :severity="currentPlayer?.isReady ? 'secondary' : 'success'"
                                :disabled="countdownSeconds !== null || connectionState !== 'connected'"
                                @click="toggleReady"
                            />
                        </div>
                        <div class="role-card">
                            <span class="eyebrow">你的底牌身份</span>
                            <strong>{{ roleDetails.name }}</strong>
                            <span>{{ roleDetails.tip }}</span>
                        </div>
                        <div v-if="phase === 'NIGHT_WEREWOLF' && currentPlayer?.role === 'werewolf' && currentPlayer.isAlive" class="action-row">
                            <Button
                                v-for="player in aliveTargets"
                                :key="player.id"
                                :label="`袭击 [${player.name}]`"
                                icon="pi pi-bolt"
                                severity="danger"
                                :outlined="nightTarget === player.id"
                                @click="attackPlayer(player)"
                            />
                        </div>
                        <div v-else-if="phase === 'DAY_DISCUSS'" class="action-row">
                            <Button label="发起投票（逐出可疑人员）" icon="pi pi-check" severity="danger" @click="voteOutPlayer" />
                        </div>
                    </template>
                </Card>

                <Card class="logs-card">
                    <template #title>游戏备忘录</template>
                    <template #content>
                        <div ref="logContainer" class="log-list" aria-live="polite">
                            <div
                                v-for="(entry, index) in logs"
                                :key="index"
                                class="log-entry"
                                :class="{ 'own-action': entry.isOwnAction }"
                            >{{ entry.text }}</div>
                        </div>
                    </template>
                </Card>
            </section>

            <aside class="sidebar">
                <Card class="players-card">
                    <template #title>房间成员</template>
                    <template #subtitle>{{ players.length }} / {{ MAX_PLAYERS }} 位玩家</template>
                    <template #content>
                        <ul class="player-list">
                            <li
                                v-for="player in players"
                                :key="player.id"
                                class="player-item"
                                :class="{ 'is-dead': !player.isAlive }"
                            >
                                <span class="player-identity">
                                    <span class="player-name">{{ player.name }}</span>
                                    <Tag v-if="player.id === hostId" value="房主" severity="warn" class="host-tag" />
                                    <Tag
                                        v-if="roomStarted"
                                        :value="player.isReady ? '已准备' : '未准备'"
                                        :severity="player.isReady ? 'success' : 'secondary'"
                                        class="ready-tag"
                                    />
                                </span>
                                <Tag
                                    :value="!player.isAlive ? '淘汰' : !player.isConnected ? '离线' : player.isMe ? '你' : '在线'"
                                    :severity="!player.isAlive ? 'danger' : !player.isConnected ? 'secondary' : 'success'"
                                />
                            </li>
                            <li v-if="players.length === 0" class="empty-state">加入房间后，玩家会显示在这里。</li>
                        </ul>
                    </template>
                </Card>
            </aside>
        </main>
    </div>
</template>

<style>
:root {
    color-scheme: dark;
    font-family: Inter, "Noto Sans SC", "Microsoft YaHei", sans-serif;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
    background: #09090b;
}

* {
    box-sizing: border-box;
}

body {
    min-width: 320px;
    min-height: 100vh;
    margin: 0;
    background:
        radial-gradient(ellipse at 15% 0%, rgba(99, 102, 241, 0.14), transparent 42%),
        #09090b;
    color: var(--p-surface-100);
}

button, input {
    font: inherit;
}

.app-shell {
    min-height: 100vh;
}

.topbar {
    display: flex;
    min-height: 76px;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px clamp(18px, 4vw, 56px);
    border-bottom: 1px solid var(--p-surface-800);
    background: rgba(9, 9, 11, 0.72);
    backdrop-filter: blur(14px);
}

.brand {
    display: flex;
    align-items: center;
    gap: 14px;
}

.brand h1 {
    margin: 0;
    color: var(--p-surface-0);
    font-size: 1.15rem;
    letter-spacing: 0.02em;
}

.game-layout {
    display: grid;
    width: min(1320px, 100%);
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 24px;
    margin: 0 auto;
    padding: clamp(20px, 4vw, 48px);
}

.game-column {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 20px;
}

.game-card,
.logs-card,
.players-card {
    border: 1px solid var(--p-surface-800);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.2);
}

.room-entry,
.lobby-card,
.active-game {
    width: 100%;
}

.room-entry {
    margin: auto 0;
}

.field-label {
    display: block;
    margin: 4px 0 8px;
    color: var(--p-surface-200);
    font-size: 0.9rem;
}

.name-form {
    display: grid;
    width: 100%;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
}

.name-field {
    min-width: 0;
}

.full-width {
    width: 100%;
}

.form-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 24px 0 16px;
    color: var(--p-surface-400);
    font-size: 0.85rem;
}

.form-divider::before,
.form-divider::after {
    flex: 1;
    border-top: 1px solid var(--p-surface-700);
    content: "";
}

.join-form {
    display: grid;
    width: 100%;
    grid-template-columns: minmax(0, 1fr) 150px;
    align-items: end;
    gap: 10px;
    margin-top: 0;
}

.name-form > .p-button,
.join-form > .p-button {
    width: 100%;
}

.action-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-top: 16px;
}

.ready-check {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    margin: 4px 0 18px;
    color: var(--p-surface-200);
}

.ready-check strong {
    color: var(--p-primary-200);
}

.join-form > .p-inputtext {
    flex: 1 1 180px;
    min-width: 0;
    text-transform: uppercase;
}

.room-message {
    margin-top: 16px;
}

.room-code {
    width: fit-content;
    margin: 12px auto 20px;
    padding: 12px 20px;
    border: 1px dashed var(--p-primary-400);
    border-radius: var(--p-border-radius-lg);
    background: var(--p-surface-900);
    color: var(--p-primary-200);
    font-family: ui-monospace, Consolas, monospace;
    font-size: clamp(1.6rem, 5vw, 2.2rem);
    font-weight: 700;
    letter-spacing: 0.3em;
}

.rename-form {
    display: grid;
    width: min(100%, 420px);
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    margin: 0 auto 16px;
}

.waiting-note {
    margin: 18px 0 0;
    color: var(--p-surface-300);
    text-align: center;
}

.role-card {
    display: grid;
    justify-items: center;
    gap: 9px;
    width: fit-content;
    max-width: 100%;
    margin: 8px auto 20px;
    padding: 22px 32px;
    border: 1px solid var(--p-primary-700);
    border-radius: var(--p-border-radius-xl);
    background: linear-gradient(145deg, var(--p-surface-900), var(--p-surface-950));
    text-align: center;
}

.role-card .eyebrow {
    color: var(--p-surface-400);
    font-size: 0.8rem;
}

.role-card strong {
    color: var(--p-amber-300);
    font-size: 1.6rem;
}

.role-card > span:last-child {
    color: var(--p-surface-300);
    font-size: 0.9rem;
}

.logs-card .p-card-body,
.players-card .p-card-body {
    min-width: 0;
}

.log-list {
    display: flex;
    max-height: 260px;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
    color: var(--p-surface-300);
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.83rem;
}

.log-entry {
    padding-left: 10px;
    border-left: 2px solid var(--p-primary-500);
    overflow-wrap: anywhere;
}

.log-entry.own-action {
    border-left-color: var(--p-blue-400);
    color: var(--p-blue-300);
}

.player-list {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin: 0;
    padding: 0;
    list-style: none;
}

.player-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--p-surface-800);
    border-radius: var(--p-border-radius-md);
    background: var(--p-surface-900);
}

.player-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.player-identity {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
}

.host-tag {
    flex-shrink: 0;
    font-size: 0.7rem;
}

.ready-tag {
    flex-shrink: 0;
    font-size: 0.7rem;
}

.player-item.is-dead {
    opacity: 0.55;
    text-decoration: line-through;
}

.empty-state {
    padding: 12px 4px;
    color: var(--p-surface-400);
    font-size: 0.9rem;
}

@media (max-width: 760px) {
    .game-layout {
        grid-template-columns: minmax(0, 1fr);
    }

    .sidebar {
        grid-row: 1;
    }

    .topbar {
        align-items: flex-start;
    }

    .brand {
        flex-wrap: wrap;
    }
}

@media (max-width: 480px) {
    .topbar {
        flex-direction: column;
    }

    .join-form,
    .name-form {
        align-items: stretch;
        grid-template-columns: minmax(0, 1fr);
    }

    .join-form .p-button,
    .name-form .p-button {
        width: 100%;
    }

    .rename-form {
        grid-template-columns: minmax(0, 1fr);
    }

    .ready-check {
        flex-direction: column;
        text-align: center;
    }

    .role-card {
        padding: 18px;
    }
}
</style>
