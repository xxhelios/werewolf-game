declare const __WEBSOCKET_URL__: string | null;
declare const __APP_VERSION__: string;

declare module '*.vue' {
    import type { DefineComponent } from 'vue';

    const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
    export default component;
}
