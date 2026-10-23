import { ROLE_INFO } from '../types';
import type { ActiveGamePhase, Role, RoleCounts, VoteResult, WitchPotions } from '../types';

export interface RoomPlayer {
    id: string;
    name: string;
    isConnected: boolean;
    isReady: boolean;
}

export interface GamePlayer {
    id: string;
    name: string;
    role: Role | 'unassigned';
    isAlive: boolean;
    isConnected: boolean;
    isSilenced: boolean;
    isReady: boolean;
}

export interface WolfIntention {
    playerId: string;
    playerName: string;
    targetId: string | null;
}

export interface AvailableRoom {
    code: string;
    playerCount: number;
    maxPlayers: number;
}

export type ServerMessage =
    | { type: 'connected'; playerId: string }
    | { type: 'available-rooms'; rooms: AvailableRoom[] }
    | { type: 'room-state'; room: { code: string; hostId: string; players: RoomPlayer[] } }
    | { type: 'spectator-joined'; code: string }
    | { type: 'left-room' }
    | { type: 'game-started'; phase: ActiveGamePhase; role: Role | null; players: GamePlayer[] }
    | {
        type: 'game-progress';
        phase: ActiveGamePhase;
        players: GamePlayer[];
        roleCounts: RoleCounts;
        wolfIntentions: WolfIntention[];
        readyPlayerIds: string[];
        countdownSeconds: number | null;
        role: Role | null;
        wolfTargetId: string | null;
        witchPotions: WitchPotions | null;
        seerResult: Role | null;
        eliminatedPlayerIds: string[];
        nightEliminatedPlayerIds: string[];
        voteResults: VoteResult[];
        roundWinner: string | null;
        hunterShotPending: boolean;
        hunterId: string | null;
        hunterShotTargetId: string | null;
        selectedWolfTargetId: string | null;
        selectedSaveTargetId: string | null;
        selectedPoisonTargetId: string | null;
        selectedSeerTargetId: string | null;
        selectedVoteTargetId: string | null;
        runoffCandidateIds: string[];
    }
    | { type: 'player-connection'; playerId: string; isConnected: boolean }
    | { type: 'room-event'; playerId: string | null; text: string }
    | { type: 'error'; message: string };

function isGamePhase(value: unknown): value is ActiveGamePhase {
    return value === 'ROLE_REVEAL'
        || value === 'NIGHT_WEREWOLF'
        || value === 'NIGHT_WITCH'
        || value === 'NIGHT_SEER'
        || value === 'DAY_DEATH_SPEECH'
        || value === 'DAY_VOTE'
        || value === 'DAY_VOTE_RUNOFF'
        || value === 'DAY_VOTE_RESULT'
        || value === 'GAME_OVER';
}

function isNullableRole(value: unknown): value is Role | null {
    return value === null || isRole(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAvailableRoom(value: unknown): value is AvailableRoom {
    return isRecord(value)
        && typeof value.code === 'string'
        && /^[A-Z0-9]{4}$/.test(value.code)
        && typeof value.playerCount === 'number'
        && Number.isInteger(value.playerCount)
        && value.playerCount >= 0
        && typeof value.maxPlayers === 'number'
        && Number.isInteger(value.maxPlayers)
        && value.maxPlayers > 0
        && value.playerCount < value.maxPlayers;
}

function isRole(value: unknown): value is Role {
    return value === 'werewolf'
        || value === 'seer'
        || value === 'witch'
        || value === 'hunter'
        || value === 'idiot'
        || value === 'villager';
}

function isWitchPotions(value: unknown): value is WitchPotions {
    return isRecord(value)
        && typeof value.saveUsed === 'boolean'
        && typeof value.poisonUsed === 'boolean';
}

function isRoleCounts(value: unknown): value is RoleCounts {
    return isRecord(value)
        && (Object.keys(ROLE_INFO) as Role[]).every(role => {
            const count = value[role];
            return typeof count === 'number' && Number.isInteger(count) && count >= 0;
        });
}

function isVoteResultList(value: unknown): value is VoteResult[] {
    return Array.isArray(value) && value.every(result =>
        isRecord(result)
        && typeof result.targetId === 'string'
        && typeof result.targetName === 'string'
        && typeof result.votes === 'number'
        && Number.isInteger(result.votes)
        && result.votes >= 0
        && Array.isArray(result.voterIds)
        && result.voterIds.every(id => typeof id === 'string')
        && typeof result.eliminated === 'boolean'
        && typeof result.hunterShot === 'boolean'
        && typeof result.idiotSaved === 'boolean'
    );
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
        && (player.role === 'unassigned' || isRole(player.role))
        && typeof player.isAlive === 'boolean'
        && typeof player.isConnected === 'boolean'
        && typeof player.isSilenced === 'boolean'
        && typeof player.isReady === 'boolean'
    );
}

export function parseServerMessage(value: unknown): ServerMessage | null {
    if (!isRecord(value) || typeof value.type !== 'string') return null;

    if (value.type === 'connected' && typeof value.playerId === 'string') {
        return { type: 'connected', playerId: value.playerId };
    }
    if (
        value.type === 'available-rooms'
        && Array.isArray(value.rooms)
        && value.rooms.every(isAvailableRoom)
    ) {
        return {
            type: 'available-rooms',
            rooms: value.rooms
        };
    }
    if (value.type === 'left-room') return { type: 'left-room' };
    if (value.type === 'spectator-joined' && typeof value.code === 'string') {
        return { type: 'spectator-joined', code: value.code };
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
    if (
        value.type === 'game-started'
        && isGamePhase(value.phase)
        && isNullableRole(value.role)
        && isGamePlayerList(value.players)
    ) {
        return {
            type: 'game-started',
            phase: value.phase,
            role: value.role,
            players: value.players
        };
    }
    if (
        value.type === 'game-progress'
        && isGamePhase(value.phase)
        && isGamePlayerList(value.players)
        && isRoleCounts(value.roleCounts)
        && Array.isArray(value.wolfIntentions)
        && value.wolfIntentions.every(intention =>
            isRecord(intention)
            && typeof intention.playerId === 'string'
            && typeof intention.playerName === 'string'
            && (intention.targetId === null || typeof intention.targetId === 'string')
        )
        && Array.isArray(value.readyPlayerIds)
        && value.readyPlayerIds.every(id => typeof id === 'string')
        && (value.countdownSeconds === null || (
            typeof value.countdownSeconds === 'number'
            && Number.isInteger(value.countdownSeconds)
            && value.countdownSeconds >= 1
        ))
        && isNullableRole(value.role)
        && (value.wolfTargetId === null || typeof value.wolfTargetId === 'string')
        && (value.witchPotions === null || isWitchPotions(value.witchPotions))
        && isNullableRole(value.seerResult)
        && Array.isArray(value.eliminatedPlayerIds)
        && value.eliminatedPlayerIds.every(id => typeof id === 'string')
        && Array.isArray(value.nightEliminatedPlayerIds)
        && value.nightEliminatedPlayerIds.every(id => typeof id === 'string')
        && isVoteResultList(value.voteResults)
        && (value.roundWinner === null || typeof value.roundWinner === 'string')
        && typeof value.hunterShotPending === 'boolean'
        && (value.hunterId === null || typeof value.hunterId === 'string')
        && (value.hunterShotTargetId === null || typeof value.hunterShotTargetId === 'string')
        && (value.selectedWolfTargetId === null || typeof value.selectedWolfTargetId === 'string')
        && (value.selectedSaveTargetId === null || typeof value.selectedSaveTargetId === 'string')
        && (value.selectedPoisonTargetId === null || typeof value.selectedPoisonTargetId === 'string')
        && (value.selectedSeerTargetId === null || typeof value.selectedSeerTargetId === 'string')
        && (value.selectedVoteTargetId === null || typeof value.selectedVoteTargetId === 'string')
        && Array.isArray(value.runoffCandidateIds)
        && value.runoffCandidateIds.every(id => typeof id === 'string')
    ) {
        return {
            type: 'game-progress',
            phase: value.phase,
            players: value.players,
            roleCounts: value.roleCounts,
            wolfIntentions: value.wolfIntentions,
            readyPlayerIds: value.readyPlayerIds,
            countdownSeconds: value.countdownSeconds,
            role: value.role,
            wolfTargetId: value.wolfTargetId,
            witchPotions: value.witchPotions,
            seerResult: value.seerResult,
            eliminatedPlayerIds: value.eliminatedPlayerIds,
            nightEliminatedPlayerIds: value.nightEliminatedPlayerIds,
            voteResults: value.voteResults,
            roundWinner: value.roundWinner,
            hunterShotPending: value.hunterShotPending,
            hunterId: value.hunterId,
            hunterShotTargetId: value.hunterShotTargetId,
            selectedWolfTargetId: value.selectedWolfTargetId,
            selectedSaveTargetId: value.selectedSaveTargetId,
            selectedPoisonTargetId: value.selectedPoisonTargetId,
            selectedSeerTargetId: value.selectedSeerTargetId,
            selectedVoteTargetId: value.selectedVoteTargetId,
            runoffCandidateIds: value.runoffCandidateIds
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
