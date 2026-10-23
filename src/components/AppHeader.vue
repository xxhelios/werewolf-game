<script setup lang="ts">
import Button from 'primevue/button';
import Tag from 'primevue/tag';

defineProps<{
    roomCode: string | null;
    roomStatus: string;
    connectionLabel: string;
    connectionSeverity: string;
    canLeaveRoom: boolean;
    appVersion: string;
}>();

defineEmits<{
    leaveRoom: [];
}>();
</script>

<template>
    <header class="topbar">
        <div class="brand">
            <div class="brand-title">
                <h1>🐺 宇宙狼人杀</h1>
                <small>版本 {{ appVersion }}</small>
            </div>
            <Tag v-if="roomCode" :value="`房间号 ${roomCode}`" severity="info" />
            <Button
                v-if="roomCode"
                label="退出房间"
                icon="pi pi-sign-out"
                severity="secondary"
                size="small"
                outlined
                :disabled="!canLeaveRoom"
                @click="$emit('leaveRoom')"
            />
            <Tag :value="roomStatus" :severity="roomCode ? 'info' : 'secondary'" />
        </div>
        <Tag :value="connectionLabel" :severity="connectionSeverity" />
    </header>
</template>

<style scoped>
.brand-title {
    display: grid;
    gap: 2px;
}

.brand-title small {
    color: var(--p-surface-400);
    font-size: 0.7rem;
    line-height: 1;
}
</style>
