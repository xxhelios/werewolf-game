<script setup lang="ts">
import Card from 'primevue/card';
import Tag from 'primevue/tag';
import { ROLE_INFO } from '../types';
import type { GamePhase, Player } from '../types';

defineProps<{
    players: Player[];
    hostId: string | null;
    phase: GamePhase;
    nightEliminatedPlayerIds: string[];
    maxPlayers: number;
    showRoles?: boolean;
    showWerewolfRoles?: boolean;
}>();

</script>

<template>
    <Card class="players-card">
        <template #title>房间成员</template>
        <template #subtitle>{{ players.length }} / {{ maxPlayers }} 位玩家</template>
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
                            v-if="showRoles || phase === 'GAME_OVER' || (showWerewolfRoles && player.role === 'werewolf')"
                            :value="player.role === 'unassigned' ? '身份未知' : ROLE_INFO[player.role].name"
                            severity="info"
                            class="role-tag"
                        />
                        <Tag
                            v-if="player.isSilenced"
                            value="禁言·禁票"
                            severity="warn"
                            class="role-tag"
                        />
                        <Tag
                            v-if="(
                                ['ROLE_REVEAL', 'DAY_DEATH_SPEECH', 'DAY_VOTE', 'DAY_VOTE_RUNOFF', 'DAY_VOTE_RESULT'].includes(phase)
                                && (player.isAlive || phase === 'DAY_VOTE_RESULT' || (
                                    phase === 'DAY_DEATH_SPEECH' && nightEliminatedPlayerIds.includes(player.id)
                                ))
                            )"
                            :value="player.isReady ? '已准备' : '未准备'"
                            :severity="player.isReady ? 'success' : 'secondary'"
                            class="ready-tag"
                        />
                    </span>
                    <Tag
                        :value="!player.isAlive
                            ? nightEliminatedPlayerIds.includes(player.id) ? '昨夜淘汰' : '淘汰'
                            : !player.isConnected ? '离线' : player.isMe ? '你' : '在线'"
                        :severity="!player.isAlive ? 'danger' : !player.isConnected ? 'secondary' : 'success'"
                    />
                </li>
                <li v-if="players.length === 0" class="empty-state">加入房间后，玩家会显示在这里。</li>
            </ul>
        </template>
    </Card>
</template>
