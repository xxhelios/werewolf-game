<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import Card from 'primevue/card';
import type { MemoEntry } from '../types';

const props = defineProps<{ entries: MemoEntry[] }>();
const logContainer = ref<HTMLDivElement | null>(null);

watch(() => props.entries[props.entries.length - 1], async () => {
    await nextTick();
    if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight;
});
</script>

<template>
    <Card class="logs-card">
        <template #title>游戏备忘录</template>
        <template #content>
            <div ref="logContainer" class="log-list" aria-live="polite">
                <div
                    v-for="(entry, index) in entries"
                    :key="index"
                    class="log-entry"
                    :class="{ 'own-action': entry.isOwnAction }"
                >{{ entry.text }}</div>
            </div>
        </template>
    </Card>
</template>
