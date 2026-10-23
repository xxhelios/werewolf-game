<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import Button from 'primevue/button';
import Card from 'primevue/card';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Tag from 'primevue/tag';
import AppHeader from './components/AppHeader.vue';
import GameMemo from './components/GameMemo.vue';
import RoomMembers from './components/RoomMembers.vue';
import { parseServerMessage } from './network/protocol';
import type { GamePlayer, RoomPlayer, ServerMessage, WolfIntention } from './network/protocol';
import { ROLE_INFO } from './types';
import type { ActiveGamePhase, ConnectionState, GamePhase, MemoEntry, Player, Role, RoleCounts, VoteResult, WitchPotions } from './types';

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;
const MAX_MEMO_ENTRIES = 200;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const PLAYER_ID_STORAGE_KEY = 'werewolf-player-id';
const PLAYER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FRUIT_NAMES = [
    '苹果', '香蕉', '橙子', '芒果', '草莓', '蓝莓', '樱桃', '桃子', '梨子', '葡萄',
    '柠檬', '西瓜', '菠萝', '椰子', '猕猴桃', '石榴', '柚子', '荔枝', '龙眼', '木瓜',
    '杏子', '李子', '柿子', '枣子', '榴莲', '山竹', '柑橘', '哈密瓜', '百香果', '火龙果',
    '无花果', '杨梅', '桑葚', '枇杷', '橄榄', '牛油果'
];
const ANIMAL_NAMES = [
    '熊猫', '狐狸', '兔子', '老虎', '狮子', '企鹅', '海豚', '鲸鱼', '水獭', '松鼠', '猫咪',
    '小狗', '考拉', '袋鼠', '刺猬', '浣熊', '树懒', '鹿', '河马', '长颈鹿', '斑马',
    '猫头鹰', '鹦鹉', '海豹', '鲸鱼', '青蛙', '乌龟', '仓鼠', '羊驼', '小熊', '小狼',
    '蜜蜂', '蝴蝶', '火烈鸟', '水豚', '猕猴', '小马'
];
const randomNameIndex = (length: number): number =>
    crypto.getRandomValues(new Uint32Array(1))[0] % length;
const generateDefaultPlayerName = (): string =>
    `${FRUIT_NAMES[randomNameIndex(FRUIT_NAMES.length)]}${ANIMAL_NAMES[randomNameIndex(ANIMAL_NAMES.length)]}`;

const playerName = ref(generateDefaultPlayerName());
const createRoomCodeInput = ref('');
const renameName = ref('');
const roomCodeInput = ref('');
const roomCode = ref<string | null>(null);
const isSpectator = ref(false);
const playerId = ref<string | null>(null);
const players = ref<Player[]>([]);
const roleCounts = ref<RoleCounts | null>(null);
const wolfIntentions = ref<WolfIntention[]>([]);
const phase = ref<GamePhase>('LOBBY');
const connectionState = ref<ConnectionState>('connecting');
const roomError = ref('');
const waitingNote = ref('等待房主开始游戏...');
const roomStarted = ref(false);
const countdownSeconds = ref<number | null>(null);
const nightEliminatedPlayerIds = ref<string[]>([]);
const voteResults = ref<VoteResult[]>([]);
const roundWinner = ref<string | null>(null);
const hunterShotPending = ref(false);
const hunterId = ref<string | null>(null);
const hunterShotTargetId = ref<string | null>(null);
const selectedHunterShotTargetId = ref<string | null>(null);
const wolfTargetId = ref<string | null>(null);
const selectedWolfTargetId = ref<string | null>(null);
const selectedSaveTargetId = ref<string | null>(null);
const selectedPoisonTargetId = ref<string | null>(null);
const selectedSeerTargetId = ref<string | null>(null);
const selectedVoteTargetId = ref<string | null>(null);
const runoffCandidateIds = ref<string[]>([]);
const witchPotions = ref<WitchPotions>({ saveUsed: false, poisonUsed: false });
const seerResult = ref<Role | null>(null);
const logs = ref<MemoEntry[]>([{ text: '[系统] 创建房间或输入房间码加入好友的房间。', isOwnAction: false }]);

let roomConnection: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let componentUnmounted = false;

const hostId = ref<string | null>(null);
const isHost = computed(() => !isSpectator.value && Boolean(playerId.value) && hostId.value === playerId.value);
const currentPlayer = computed(() => players.value.find(player => player.isMe));
const roomStatus = computed(() => {
    if (!roomCode.value) return '未加入房间';
    if (isSpectator.value) return '观战中';
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
    return role && role !== 'unassigned' ? ROLE_INFO[role] : { name: '未知', tip: '' };
});
const roleCountTags = computed(() => {
    const counts = roleCounts.value;
    if (!counts) return [];
    return (Object.keys(ROLE_INFO) as Role[])
        .filter(role => counts[role] > 0)
        .map(role => ({
            role,
            label: `${ROLE_INFO[role].name} × ${counts[role]}`
        }));
});
const phaseTitle = computed(() => ({
    LOBBY: '等待玩家',
    ROLE_REVEAL: '查看身份 · 准备开始',
    NIGHT_WEREWOLF: '第一步 · 狼人行动 🐺',
    NIGHT_WITCH: '第二步 · 女巫行动 🧪',
    NIGHT_SEER: '第三步 · 预言家查验 🔮',
    DAY_DEATH_SPEECH: '天亮了 · 昨夜淘汰玩家发言',
    DAY_VOTE: '讨论与投票 ☀️',
    DAY_VOTE_RUNOFF: '平票加赛投票',
    DAY_VOTE_RESULT: '投票结果公示',
    GAME_OVER: '游戏结束'
})[phase.value]);
const phaseDescription = computed(() => {
    if (isSpectator.value) {
        if (phase.value === 'DAY_VOTE_RESULT' && hunterShotPending.value) {
            return '观战模式：猎人正在决定是否开枪，玩家身份与游戏流程均实时公开。';
        }
        return `观战模式：当前为${phaseTitle.value}，可在房间成员列表查看所有玩家身份。`;
    }
    if (phase.value === 'DAY_VOTE_RESULT') {
        if (hunterShotPending.value && currentPlayer.value?.id === hunterId.value) {
            return '你被投票淘汰了。可以选择一名仍存活的玩家开枪带走，或选择不开枪。';
        }
        if (hunterShotPending.value) return '猎人正在决定是否开枪，请稍候。';
        return '请查看本轮投票结果。所有在线玩家确认后，游戏将结束或进入下一轮。';
    }
    if (
        phase.value === 'DAY_DEATH_SPEECH'
        && currentPlayer.value
        && nightEliminatedPlayerIds.value.includes(currentPlayer.value.id)
    ) {
        return '你昨夜被淘汰。请先完成发言，之后点击“入土为安”进入讨论与投票。';
    }
    if (currentPlayer.value && !currentPlayer.value.isAlive) return '你已被淘汰，请等待本局游戏结束。';
    if (['DAY_VOTE', 'DAY_VOTE_RUNOFF'].includes(phase.value) && currentPlayer.value?.isSilenced) {
        return '你已使用免死金牌，继续存活；此后永久失去发言和投票权。';
    }
    if (phase.value === 'ROLE_REVEAL') return '请查看你的角色信息，确认后点击“准备就绪”。';
    if (phase.value === 'DAY_DEATH_SPEECH') return '昨夜淘汰的玩家正在发言，请稍候。';
    if (phase.value === 'NIGHT_WEREWOLF') {
        return currentPlayer.value?.role === 'werewolf'
            ? '可以袭击任意存活玩家（包括狼人伙伴）；所有在线狼人选择同一目标后，才能确认行动。'
            : '狼人行动中，请等待狼人完成行动。';
    }
    if (phase.value === 'NIGHT_WITCH') {
        return currentPlayer.value?.role === 'witch'
            ? '可使用解药救人、使用毒药选择一人，或不使用药剂直接准备。'
            : '女巫行动中，请等待女巫完成行动。';
    }
    if (phase.value === 'NIGHT_SEER') {
        return currentPlayer.value?.role === 'seer'
            ? '每晚只能查验一位玩家，请谨慎选择；查验后点击“准备就绪”。'
            : '预言家查验中，请等待预言家完成行动。';
    }
    if (phase.value === 'DAY_VOTE') return '请选择一位玩家投票，或不选择目标直接确认弃权。投票内容不会公开。';
    if (phase.value === 'DAY_VOTE_RUNOFF') return '最高票出现平票。请仅在下方平票候选人中重新投票，或确认弃权。';
    return '本局游戏已结束。';
});
const aliveTargets = computed(() => players.value.filter(player => player.isAlive && !player.isMe));
const livingWolfTargets = computed(() => players.value.filter(player => player.isAlive));
const voteTargets = computed(() => phase.value === 'DAY_VOTE_RUNOFF'
    ? aliveTargets.value.filter(player => runoffCandidateIds.value.includes(player.id))
    : aliveTargets.value
);
const canStartGame = computed(() =>
    isHost.value && !roomStarted.value && players.value.length >= MIN_PLAYERS
);
const phaseReadyPlayers = computed(() => players.value.filter(player =>
    player.isConnected
    && (phase.value === 'DAY_VOTE_RESULT'
        || (player.isAlive
            && (!['DAY_VOTE', 'DAY_VOTE_RUNOFF'].includes(phase.value) || !player.isSilenced)))
));
const readyPlayerCount = computed(() => phaseReadyPlayers.value.filter(player => player.isReady).length);
const connectedPlayerCount = computed(() => phaseReadyPlayers.value.length);
const wolfTargetName = computed(() => wolfTargetId.value
    ? players.value.find(player => player.id === wolfTargetId.value)?.name ?? '未知玩家'
    : '狼人未形成有效袭击目标');
const wolfTargetIsUnanimous = computed(() => {
    const livingConnectedWolves = players.value.filter(player =>
        player.role === 'werewolf' && player.isAlive && player.isConnected
    );
    if (livingConnectedWolves.length === 0 || wolfIntentions.value.length !== livingConnectedWolves.length) {
        return false;
    }
    const targetIds = wolfIntentions.value.map(intention => intention.targetId);
    return Boolean(targetIds[0]) && targetIds.every(targetId => targetId === targetIds[0]);
});
const readyButtonLabel = computed(() => {
    if (phase.value === 'ROLE_REVEAL' && currentPlayer.value?.isReady) return '已准备就绪';
    if (phase.value === 'DAY_DEATH_SPEECH') {
        return currentPlayer.value?.isReady ? '已入土为安' : '入土为安';
    }
    if (phase.value === 'DAY_VOTE_RESULT') {
        return currentPlayer.value?.isReady ? '已确认结果' : '确认结果';
    }
    return currentPlayer.value?.isReady ? '取消准备' : '准备就绪';
});
const canConfirmPhase = computed(() => {
    const player = currentPlayer.value;
    if (phase.value === 'DAY_VOTE_RESULT') return Boolean(player);
    if (
        phase.value === 'DAY_DEATH_SPEECH'
        && player
        && !player.isAlive
        && nightEliminatedPlayerIds.value.includes(player.id)
    ) return true;
    if (!player?.isAlive) return false;
    if (['DAY_VOTE', 'DAY_VOTE_RUNOFF'].includes(phase.value) && player.isSilenced) return false;
    if (phase.value === 'NIGHT_WEREWOLF') return player.role === 'werewolf';
    if (phase.value === 'NIGHT_WITCH') return player.role === 'witch';
    if (phase.value === 'NIGHT_SEER') return player.role === 'seer';
    return phase.value === 'ROLE_REVEAL'
        || phase.value === 'DAY_VOTE'
        || phase.value === 'DAY_VOTE_RUNOFF';
});
const phaseStatusMessages: Partial<Record<GamePhase, string>> = {
    NIGHT_WEREWOLF: '狼人行动中',
    NIGHT_WITCH: '女巫行动中',
    NIGHT_SEER: '预言家行动中'
};
const phaseStatusMessage = computed(() => phaseStatusMessages[phase.value] ?? '');
const canReady = computed(() => {
    const player = currentPlayer.value;
    const canConfirmDeathSpeech = Boolean(
        phase.value === 'DAY_DEATH_SPEECH'
        && player
        && nightEliminatedPlayerIds.value.includes(player.id)
    );
    const canConfirmVoteResult = phase.value === 'DAY_VOTE_RESULT' && Boolean(player);
    if (!player
        || (!player.isAlive && !canConfirmDeathSpeech && !canConfirmVoteResult)
        || !canConfirmPhase.value
        || countdownSeconds.value !== null
        || connectionState.value !== 'connected') {
        return false;
    }
    if (phase.value === 'NIGHT_WEREWOLF' && player.role === 'werewolf' && !selectedWolfTargetId.value) {
        return false;
    }
    if (phase.value === 'NIGHT_WEREWOLF' && player.role === 'werewolf' && !wolfTargetIsUnanimous.value) {
        return false;
    }
    return phase.value !== 'GAME_OVER';
});
const canChooseAction = computed(() =>
    connectionState.value === 'connected'
    && countdownSeconds.value === null
    && Boolean(currentPlayer.value?.isAlive)
    && !currentPlayer.value?.isReady
    && !(phase.value === 'NIGHT_SEER' && selectedSeerTargetId.value)
);

function addLog(text: string, actorId: string | null = null): void {
    logs.value.push({
        text: `[${new Date().toLocaleTimeString()}] ${text}`,
        isOwnAction: actorId !== null && actorId === playerId.value
    });
    if (logs.value.length > MAX_MEMO_ENTRIES) {
        logs.value.splice(0, logs.value.length - MAX_MEMO_ENTRIES);
    }
}

function setRoomError(message: string): void {
    roomError.value = message;
}

function sendRoomMessage(message: Record<string, string | boolean | null>): void {
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
    const code = createRoomCodeInput.value.trim().toUpperCase();
    if (code && !ROOM_CODE_PATTERN.test(code)) {
        setRoomError('自定义房间码需为 6 位字母或数字；留空则自动生成。');
        return;
    }
    setRoomError('');
    sendRoomMessage({ type: 'create-room', name, code });
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

function spectateRoom(): void {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(code)) {
        setRoomError('请输入有效的 6 位房间码。');
        return;
    }
    setRoomError('');
    sendRoomMessage({ type: 'spectate-room', code });
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
        if (isSpectator.value && roomCode.value) {
            sendRoomMessage({ type: 'spectate-room', code: roomCode.value });
        }
        return;
    }
    if (message.type === 'error') {
        setRoomError(message.message);
        return;
    }
    if (message.type === 'left-room') {
        isSpectator.value = false;
        roomCode.value = null;
        hostId.value = null;
        players.value = [];
        roleCounts.value = null;
        wolfIntentions.value = [];
        roomStarted.value = false;
        phase.value = 'LOBBY';
        countdownSeconds.value = null;
        nightEliminatedPlayerIds.value = [];
        voteResults.value = [];
        hunterShotPending.value = false;
        hunterId.value = null;
        hunterShotTargetId.value = null;
        selectedHunterShotTargetId.value = null;
        roundWinner.value = null;
        selectedWolfTargetId.value = null;
        selectedSaveTargetId.value = null;
        selectedPoisonTargetId.value = null;
        selectedSeerTargetId.value = null;
        selectedVoteTargetId.value = null;
        runoffCandidateIds.value = [];
        roomError.value = '';
        addLog('你已退出房间。');
        return;
    }
    if (message.type === 'spectator-joined') {
        isSpectator.value = true;
        roomCode.value = message.code;
        roomError.value = '';
        addLog('已进入观战模式，可以查看所有玩家身份与游戏流程。');
        return;
    }
    if (message.type === 'room-state') {
        roomCode.value = message.room.code;
        hostId.value = message.room.hostId;
        players.value = message.room.players.map(player => ({
            ...player,
            role: 'unassigned',
            isAlive: true,
            isSilenced: false,
            isMe: !isSpectator.value && player.id === playerId.value
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
        addLog(message.text, message.playerId);
        return;
    }

    if (message.type === 'player-connection') {
        const player = players.value.find(candidate => candidate.id === message.playerId);
        if (player) player.isConnected = message.isConnected;
        return;
    }

    if (message.type === 'game-progress') {
        const previousPhase = phase.value;
        roomStarted.value = true;
        nightEliminatedPlayerIds.value = [];
        phase.value = message.phase;
        roleCounts.value = message.roleCounts;
        wolfIntentions.value = message.wolfIntentions;
        countdownSeconds.value = message.countdownSeconds;
        nightEliminatedPlayerIds.value = message.nightEliminatedPlayerIds;
        updateGamePlayers(message.players, message.phase, message.role);
        wolfTargetId.value = message.wolfTargetId;
        witchPotions.value = message.witchPotions ?? { saveUsed: false, poisonUsed: false };
        seerResult.value = message.seerResult;
        selectedWolfTargetId.value = message.selectedWolfTargetId;
        selectedSaveTargetId.value = message.selectedSaveTargetId;
        selectedPoisonTargetId.value = message.selectedPoisonTargetId;
        selectedSeerTargetId.value = message.selectedSeerTargetId;
        selectedVoteTargetId.value = message.selectedVoteTargetId;
        runoffCandidateIds.value = message.runoffCandidateIds;
        voteResults.value = message.voteResults;
        roundWinner.value = message.roundWinner;
        hunterShotPending.value = message.hunterShotPending;
        hunterId.value = message.hunterId;
        hunterShotTargetId.value = message.hunterShotTargetId;
        if (!message.hunterShotPending) selectedHunterShotTargetId.value = null;
        if (previousPhase !== message.phase) {
            addLog(({
                ROLE_REVEAL: '游戏开始，请查看各自身份。',
                NIGHT_WEREWOLF: '进入狼人行动阶段。',
                NIGHT_WITCH: '进入女巫行动阶段。',
                NIGHT_SEER: '进入预言家查验阶段。',
                DAY_DEATH_SPEECH: '天亮了，昨夜淘汰的玩家开始发言。',
                DAY_VOTE: '进入讨论与投票阶段。',
                DAY_VOTE_RUNOFF: '最高票出现平票，进入加赛投票。',
                DAY_VOTE_RESULT: '本轮投票结束，现公布投票结果。',
                GAME_OVER: '本局游戏结束。'
            })[message.phase]);
        }
        return;
    }

    roomStarted.value = true;
    updateGamePlayers(message.players, message.phase, message.role);
    phase.value = message.phase;
    countdownSeconds.value = null;
    addLog('游戏开始，请查看各自身份。');
}

function updateGamePlayers(
    gamePlayers: GamePlayer[],
    gamePhase: ActiveGamePhase,
    ownRole: Role | null
): void {
    const unchanged = players.value.length === gamePlayers.length
        && gamePlayers.every((player, index) => {
            const existing = players.value[index];
            const role = isSpectator.value || gamePhase === 'GAME_OVER'
                ? player.role
                : ownRole === 'werewolf' && player.role === 'werewolf'
                    ? player.role
                : player.id === playerId.value ? ownRole ?? 'unassigned' : 'unassigned';
            return existing.id === player.id
                && existing.name === player.name
                && existing.role === role
                && existing.isAlive === player.isAlive
                && existing.isConnected === player.isConnected
                && existing.isSilenced === player.isSilenced
                && existing.isReady === player.isReady
                && existing.isMe === (!isSpectator.value && player.id === playerId.value);
        });
    if (unchanged) return;

    players.value = gamePlayers.map(player => ({
        ...player,
        role: isSpectator.value || gamePhase === 'GAME_OVER'
            ? player.role
            : ownRole === 'werewolf' && player.role === 'werewolf'
                ? player.role
            : player.id === playerId.value ? ownRole ?? 'unassigned' : 'unassigned',
        isMe: !isSpectator.value && player.id === playerId.value
    }));
}

function connectToRoomService(): void {
    if (componentUnmounted) return;
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
    const connection = new WebSocket(websocketUrl);
    roomConnection = connection;
    connection.addEventListener('open', () => {
        reconnectAttempts = 0;
        connectionState.value = 'connected';
    });
    connection.addEventListener('message', event => {
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
    connection.addEventListener('close', () => {
        if (roomConnection !== connection) return;
        roomConnection = null;
        if (componentUnmounted) return;
        connectionState.value = 'disconnected';
        if (!roomCode.value) {
            setRoomError('无法连接房间服务，正在尝试重新连接。');
        } else {
            waitingNote.value = '连接已断开，正在使用当前玩家身份重新连接并恢复游戏...';
        }
        if (reconnectTimer) clearTimeout(reconnectTimer);
        const delay = Math.min(1000 * (2 ** reconnectAttempts), 15000);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectToRoomService();
        }, delay);
    });
    connection.addEventListener('error', () => {
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

function leaveRoom(): void {
    if (roomCode.value) sendRoomMessage({ type: 'leave-room' });
}

function restartGame(): void {
    if (isHost.value && phase.value === 'GAME_OVER') {
        sendRoomMessage({ type: 'restart-game' });
    }
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

function selectWolfTarget(player: Player): void {
    if (!canChooseAction.value || currentPlayer.value?.role !== 'werewolf') return;
    selectedWolfTargetId.value = player.id;
    sendRoomMessage({ type: 'game-action', action: 'wolf-target', targetId: player.id });
}

function wolfPartnerIntentions(targetId: string): string[] {
    return wolfIntentions.value
        .filter(intention => intention.playerId !== playerId.value && intention.targetId === targetId)
        .map(intention => intention.playerName);
}

function voterNames(result: VoteResult): string {
    const names = result.voterIds.map(voterId =>
        players.value.find(player => player.id === voterId)?.name ?? '未知玩家'
    );
    return names.length ? names.join('、') : '无';
}

function selectWitchTarget(action: 'witch-save' | 'witch-poison', player: Player): void {
    if (!canChooseAction.value || currentPlayer.value?.role !== 'witch') return;
    const selectedTarget = action === 'witch-save' ? selectedSaveTargetId : selectedPoisonTargetId;
    const nextTargetId = selectedTarget.value === player.id ? null : player.id;
    selectedTarget.value = nextTargetId;
    sendRoomMessage({ type: 'game-action', action, targetId: nextTargetId });
}

function selectSeerTarget(player: Player): void {
    if (!canChooseAction.value || currentPlayer.value?.role !== 'seer') return;
    selectedSeerTargetId.value = player.id;
    seerResult.value = null;
    sendRoomMessage({ type: 'game-action', action: 'seer-check', targetId: player.id });
}

function selectVoteTarget(player: Player): void {
    if (!canChooseAction.value
        || !['DAY_VOTE', 'DAY_VOTE_RUNOFF'].includes(phase.value)
        || currentPlayer.value?.isSilenced) return;
    selectedVoteTargetId.value = player.id;
    sendRoomMessage({ type: 'game-action', action: 'vote', targetId: player.id });
}

function shootHunterTarget(): void {
    if (!selectedHunterShotTargetId.value || !hunterShotPending.value) return;
    sendRoomMessage({
        type: 'game-action',
        action: 'hunter-shot',
        targetId: selectedHunterShotTargetId.value
    });
}

function passHunterShot(): void {
    if (!hunterShotPending.value) return;
    sendRoomMessage({ type: 'game-action', action: 'hunter-shot', targetId: null });
}

function toggleReady(): void {
    const player = currentPlayer.value;
    if (['ROLE_REVEAL', 'DAY_DEATH_SPEECH', 'DAY_VOTE_RESULT'].includes(phase.value) && player?.isReady) return;
    if (!player || (!player.isReady && !canReady.value) || countdownSeconds.value !== null) return;
    sendRoomMessage({ type: 'set-ready', isReady: !player.isReady });
}

watch(roomCodeInput, value => {
    roomCodeInput.value = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});
watch(createRoomCodeInput, value => {
    createRoomCodeInput.value = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
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
    componentUnmounted = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    roomConnection?.close();
});
</script>

<template>
    <div class="app-shell">
        <AppHeader
            :room-code="roomCode"
            :room-status="roomStatus"
            :connection-label="connectionLabel[connectionState]"
            :connection-severity="connectionSeverity"
            :can-leave-room="connectionState === 'connected'"
            @leave-room="leaveRoom"
        />
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
                                    placeholder="已随机生成水果+动物昵称，可自行修改"
                                    class="full-width"
                                    @keyup.enter="createRoom"
                                />
                            </div>
                            <div class="name-field">
                                <label class="field-label" for="create-room-code">自定义房间码（可选）</label>
                                <InputText
                                    id="create-room-code"
                                    v-model="createRoomCodeInput"
                                    maxlength="6"
                                    placeholder="留空则自动生成"
                                    class="full-width room-code-input"
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
                            <Button label="观战" icon="pi pi-eye" severity="help" outlined @click="spectateRoom" />
                        </div>
                        <Message v-if="roomError" severity="error" :closable="false" class="room-message">
                            {{ roomError }}
                        </Message>
                    </template>
                </Card>

                <Card v-else-if="isSpectator && phase === 'LOBBY'" class="game-card lobby-card">
                    <template #title>房间观战</template>
                    <template #subtitle>你正在以游客身份观战，不会占用玩家席位或参与游戏操作。</template>
                    <template #content>
                        <div class="room-code">{{ roomCode }}</div>
                        <Message severity="info" :closable="false">
                            游戏开始后，你可以查看所有玩家的身份和实时流程。
                        </Message>
                    </template>
                </Card>

                <Card v-else-if="phase === 'LOBBY'" class="game-card lobby-card">
                    <template #title>等待玩家加入</template>
                    <template #subtitle>分享房间码给好友。4-12 位玩家可以开始游戏。</template>
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
                        <Message v-if="roomError" severity="error" :closable="false" class="room-message">
                            {{ roomError }}
                        </Message>
                        <Message v-if="connectionState !== 'connected'" severity="warn" :closable="false" class="room-message">
                            房间连接已断开，正在使用当前玩家 ID 自动重连；游戏进度会在重连后恢复。
                        </Message>
                        <Message v-if="isSpectator" severity="info" :closable="false">
                            观战模式 · 你可以查看全部玩家身份和实时游戏进度。
                        </Message>
                        <div v-else class="role-card">
                            <span class="eyebrow">你的底牌身份</span>
                            <strong>{{ roleDetails.name }}</strong>
                            <span>{{ roleDetails.tip }}</span>
                        </div>
                        <section v-if="roleCountTags.length" class="role-configuration" aria-label="本局身份配置">
                            <h3>本局配置</h3>
                            <div class="role-count-list">
                                <Tag
                                    v-for="item in roleCountTags"
                                    :key="item.role"
                                    :value="item.label"
                                    severity="info"
                                />
                            </div>
                        </section>
                        <Message v-if="phase === 'GAME_OVER'" severity="success" :closable="false">
                            本局结束，请查看游戏备忘录中的淘汰结果与胜负公告。
                        </Message>
                        <div v-if="phase === 'GAME_OVER'" class="action-row">
                            <Button
                                v-if="isHost"
                                label="重新开始"
                                icon="pi pi-refresh"
                                @click="restartGame"
                            />
                            <p v-else class="waiting-note">等待房主重新开始游戏。</p>
                        </div>
                        <div v-else-if="phase === 'DAY_VOTE_RESULT'" class="vote-results">
                            <Message :severity="roundWinner ? 'success' : 'info'" :closable="false">
                                <template v-if="roundWinner">
                                    游戏结束：{{ roundWinner }}。所有在线玩家确认后结束本局。
                                </template>
                                <template v-else>
                                    {{ voteResults.some(result => result.eliminated)
                                        ? `投票淘汰：${voteResults.filter(result => result.eliminated).map(result => result.targetName).join('、')}。`
                                        : '平票或无人得票，本轮无人因投票淘汰。' }}
                                    确认结果后进入下一轮。
                                </template>
                            </Message>
                            <Message v-if="hunterShotPending" severity="warn" :closable="false">
                                猎人正在决定是否开枪，确认后才会完成本轮结果。
                            </Message>
                            <Message v-else-if="hunterShotTargetId" severity="danger" :closable="false">
                                猎人已开枪，{{ players.find(player => player.id === hunterShotTargetId)?.name ?? '一名玩家' }} 被带走。
                            </Message>
                            <h3>投票统计</h3>
                            <ul class="vote-result-list">
                                <li v-for="result in voteResults" :key="result.targetId">
                                    <div class="vote-result-details">
                                        <span>{{ result.targetName }}</span>
                                        <small>
                                            投票玩家：{{ voterNames(result) }}
                                        </small>
                                        <small v-if="result.idiotSaved">免死金牌：继续存活，之后禁言禁票</small>
                                    </div>
                                    <Tag
                                        :value="`${result.votes} 票${result.eliminated ? ' · 淘汰' : ''}${result.hunterShot ? ' · 猎人带走' : ''}${result.idiotSaved ? ' · 免死' : ''}`"
                                        :severity="result.eliminated || result.hunterShot ? 'danger' : result.idiotSaved ? 'warn' : 'info'"
                                    />
                                </li>
                            </ul>
                        </div>
                        <div
                            v-if="phase === 'DAY_VOTE_RESULT'
                                && hunterShotPending
                                && currentPlayer?.id === hunterId"
                            class="hunter-panel"
                        >
                            <h3>猎人反击</h3>
                            <p>你已被投票出局，可开枪带走一名存活玩家。</p>
                            <div class="action-row">
                                <Button
                                    v-for="player in aliveTargets"
                                    :key="player.id"
                                    :label="`开枪带走 [${player.name}]`"
                                    icon="pi pi-bolt"
                                    severity="danger"
                                    :outlined="selectedHunterShotTargetId !== player.id"
                                    :disabled="connectionState !== 'connected' || countdownSeconds !== null"
                                    @click="selectedHunterShotTargetId = player.id"
                                />
                            </div>
                            <div class="action-row">
                                <Button
                                    label="开枪"
                                    icon="pi pi-check"
                                    severity="danger"
                                    :disabled="!selectedHunterShotTargetId
                                        || connectionState !== 'connected'
                                        || countdownSeconds !== null"
                                    @click="shootHunterTarget"
                                />
                                <Button
                                    label="不开枪"
                                    severity="secondary"
                                    :disabled="connectionState !== 'connected' || countdownSeconds !== null"
                                    @click="passHunterShot"
                                />
                            </div>
                        </div>
                        <div v-else-if="phase === 'NIGHT_WEREWOLF' && currentPlayer?.role === 'werewolf' && currentPlayer.isAlive" class="action-row">
                            <div
                                v-for="player in livingWolfTargets"
                                :key="player.id"
                                class="wolf-target-option"
                            >
                                <Button
                                    :label="player.isMe ? '袭击自己' : `袭击 [${player.name}]`"
                                    icon="pi pi-bolt"
                                    severity="danger"
                                    :outlined="selectedWolfTargetId !== player.id"
                                    :disabled="!canChooseAction"
                                    @click="selectWolfTarget(player)"
                                />
                                <small v-if="wolfPartnerIntentions(player.id).length">
                                    狼人伙伴意向：{{ wolfPartnerIntentions(player.id).join('、') }}
                                </small>
                            </div>
                            <Message :severity="wolfTargetIsUnanimous ? 'success' : 'warn'" :closable="false">
                                {{ wolfTargetIsUnanimous
                                    ? '在线狼人已统一袭击目标，可以确认。'
                                    : '等待所有在线狼人选择相同的袭击目标后，才能确认。' }}
                            </Message>
                        </div>
                        <div v-else-if="phase === 'NIGHT_WITCH' && currentPlayer?.role === 'witch' && currentPlayer.isAlive" class="witch-panel">
                            <Message severity="warn" :closable="false">
                                今晚狼人袭击目标：{{ wolfTargetName }}
                            </Message>
                            <p class="potion-status">
                                解药：{{ witchPotions.saveUsed ? '已用' : '可用' }}
                                · 毒药：{{ witchPotions.poisonUsed ? '已用' : '可用' }}
                            </p>
                            <div v-for="player in players" :key="player.id" class="witch-player-row">
                                <span>{{ player.name }}{{ player.isAlive ? '' : '（已淘汰）' }}</span>
                                <div class="witch-actions">
                                    <Button
                                        label="解药"
                                        size="small"
                                        severity="success"
                                        :outlined="selectedSaveTargetId !== player.id"
                                        :disabled="!canChooseAction || witchPotions.saveUsed || player.id !== wolfTargetId"
                                        @click="selectWitchTarget('witch-save', player)"
                                    />
                                    <Button
                                        label="毒药"
                                        size="small"
                                        severity="danger"
                                        :outlined="selectedPoisonTargetId !== player.id"
                                        :disabled="!canChooseAction || witchPotions.poisonUsed || !player.isAlive"
                                        @click="selectWitchTarget('witch-poison', player)"
                                    />
                                </div>
                            </div>
                        </div>
                        <div v-else-if="phase === 'NIGHT_SEER' && currentPlayer?.role === 'seer' && currentPlayer.isAlive" class="action-row">
                            <Button
                                v-for="player in aliveTargets"
                                :key="player.id"
                                :label="`查验 [${player.name}]`"
                                icon="pi pi-search"
                                :outlined="selectedSeerTargetId !== player.id"
                                :disabled="!canChooseAction"
                                @click="selectSeerTarget(player)"
                            />
                            <Message v-if="seerResult" severity="info" :closable="false" class="action-result">
                                查验结果：{{ ROLE_INFO[seerResult].name }}
                            </Message>
                        </div>
                        <Message
                            v-else-if="['DAY_VOTE', 'DAY_VOTE_RUNOFF'].includes(phase) && currentPlayer?.isAlive && currentPlayer.isSilenced"
                            severity="warn"
                            :closable="false"
                        >
                            你已使用免死金牌，继续存活；此后永久失去发言和投票权。
                        </Message>
                        <Message
                            v-else-if="phase === 'DAY_VOTE_RUNOFF' && currentPlayer?.isAlive"
                            severity="warn"
                            :closable="false"
                        >
                            平票加赛：本轮只能在平票候选人中选择。
                        </Message>
                        <div v-if="['DAY_VOTE', 'DAY_VOTE_RUNOFF'].includes(phase) && currentPlayer?.isAlive && !currentPlayer.isSilenced" class="action-row">
                            <Button
                                v-for="player in voteTargets"
                                :key="player.id"
                                :label="`投票给 [${player.name}]`"
                                icon="pi pi-check"
                                severity="danger"
                                :outlined="selectedVoteTargetId !== player.id"
                                :disabled="!canChooseAction"
                                @click="selectVoteTarget(player)"
                            />
                            <span v-if="selectedVoteTargetId" class="private-vote-note">已投票，内容仅自己可见</span>
                            <span v-else class="private-vote-note">不选择目标并确认，将视为弃权</span>
                        </div>
                        <Message v-if="countdownSeconds !== null" severity="info" :closable="false" class="countdown-message">
                            {{ countdownSeconds }} 秒后进入下一阶段
                        </Message>
                        <div v-else-if="!canConfirmPhase && phaseStatusMessage" class="ready-check phase-status">
                            {{ phaseStatusMessage }}
                        </div>
                        <div v-else-if="['DAY_VOTE', 'DAY_VOTE_RUNOFF', 'DAY_VOTE_RESULT'].includes(phase)" class="ready-check">
                            已准备 {{ readyPlayerCount }} / {{ connectedPlayerCount }} 位在线玩家
                        </div>
                        <div v-if="phase !== 'GAME_OVER' && canConfirmPhase" class="action-row">
                            <Button
                                :label="['DAY_VOTE', 'DAY_VOTE_RUNOFF'].includes(phase) && !selectedVoteTargetId && !currentPlayer?.isReady
                                    ? '确认弃权'
                                    : readyButtonLabel"
                                :icon="phase === 'DAY_DEATH_SPEECH'
                                    ? 'pi pi-check'
                                    : currentPlayer?.isReady ? 'pi pi-times' : 'pi pi-check'"
                                :severity="currentPlayer?.isReady ? 'secondary' : 'success'"
                                :class="{ 'ready-selected': currentPlayer?.isReady }"
                                :disabled="countdownSeconds !== null
                                    || (!canReady && !currentPlayer?.isReady)
                                    || (['ROLE_REVEAL', 'DAY_DEATH_SPEECH', 'DAY_VOTE_RESULT'].includes(phase) && currentPlayer?.isReady)"
                                @click="toggleReady"
                            />
                        </div>
                    </template>
                </Card>

                <GameMemo :entries="logs" />
            </section>

            <aside class="sidebar">
                <RoomMembers
                    :players="players"
                    :host-id="hostId"
                    :phase="phase"
                    :night-eliminated-player-ids="nightEliminatedPlayerIds"
                    :max-players="MAX_PLAYERS"
                    :show-roles="isSpectator"
                    :show-werewolf-roles="currentPlayer?.role === 'werewolf'"
                />
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

.room-code-input {
    text-transform: uppercase;
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
    grid-template-columns: minmax(0, 1fr) 150px 120px;
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

.witch-panel {
    display: grid;
    gap: 10px;
    margin: 16px 0;
}

.wolf-target-option {
    display: grid;
    justify-items: stretch;
    gap: 5px;
}

.wolf-target-option small {
    color: var(--p-surface-300);
    font-size: 0.75rem;
    text-align: center;
}

.potion-status,
.private-vote-note {
    color: var(--p-surface-300);
    text-align: center;
}

.witch-player-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--p-surface-800);
    border-radius: var(--p-border-radius-md);
    background: var(--p-surface-900);
}

.witch-actions {
    display: flex;
    gap: 8px;
}

.countdown-message,
.action-result {
    margin-top: 14px;
    text-align: center;
}

.ready-check strong {
    color: var(--p-primary-200);
}

.vote-results {
    display: grid;
    gap: 12px;
    margin: 12px 0;
}

.vote-results h3 {
    margin: 4px 0 0;
    color: var(--p-surface-100);
    font-size: 1rem;
}

.vote-result-list {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
}

.vote-result-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--p-surface-800);
    border-radius: var(--p-border-radius-md);
    background: var(--p-surface-900);
}

.vote-result-details {
    display: grid;
    min-width: 0;
    gap: 5px;
}

.vote-result-details small {
    color: var(--p-surface-400);
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.75rem;
    overflow-wrap: anywhere;
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

.role-configuration {
    margin: 0 0 24px;
    padding: 14px 16px;
    border: 1px solid var(--p-surface-800);
    border-radius: var(--p-border-radius-lg);
    background: var(--p-surface-900);
}

.role-configuration h3 {
    margin: 0 0 12px;
    color: var(--p-surface-200);
    font-size: 0.95rem;
}

.role-count-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
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

.role-tag {
    flex-shrink: 0;
    font-size: 0.7rem;
}

.phase-status {
    color: var(--p-primary-200);
    font-weight: 700;
}

.ready-selected,
.ready-selected:hover {
    border-color: #14532d !important;
    background: #14532d !important;
    color: #dcfce7 !important;
}

.ready-selected:enabled:active {
    background: #052e16 !important;
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

    .witch-player-row {
        align-items: flex-start;
        flex-direction: column;
    }

    .role-card {
        padding: 18px;
    }
}
</style>
