export type Role = 'werewolf' | 'seer' | 'witch' | 'hunter' | 'lover' | 'villager';

export type GamePhase =
    | 'LOBBY'
    | 'ROLE_REVEAL'
    | 'NIGHT_WEREWOLF'
    | 'NIGHT_WITCH'
    | 'NIGHT_SEER'
    | 'NIGHT_LOVER_PICK'
    | 'NIGHT_LOVER'
    | 'DAY_DEATH_SPEECH'
    | 'DAY_VOTE'
    | 'DAY_VOTE_RUNOFF'
    | 'DAY_VOTE_RESULT'
    | 'GAME_OVER';

export type ActiveGamePhase = Exclude<GamePhase, 'LOBBY'>;
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

export type RoleCounts = Record<Role, number>;

export const ROLE_INFO: Record<Role, { name: string; tip: string }> = {
    werewolf: { name: '🐺 狼人', tip: '每晚寻找目标并击杀一名好人。' },
    seer: { name: '🔮 预言家', tip: '每晚可以查验一名玩家的真实身份。' },
    witch: { name: '🧪 女巫', tip: '拥有一瓶解药和一瓶毒药（整局各一次）。' },
    hunter: { name: '🏹 猎人', tip: '被投票淘汰时，可以开枪带走一名仍存活的玩家，也可以选择不开枪。' },
    lover: { name: '💘 恋爱脑', tip: '好人阵营。第一夜最先行动，选择一名心动对象（不可更改）并得知其身份。之后每晚、以及投票淘汰时，只要尚未使用技能，都可以选择替死或爱的感化狼人，也可保持清醒继续保留选择权。用过技能后若仍存活则变为平民。' },
    villager: { name: '🧑 平民', tip: '认真听取发言，通过投票找出狼人。' }
};

export interface Player {
    id: string;
    name: string;
    role: Role | 'unassigned';
    isAlive: boolean;
    diedForLove: boolean;
    isConnected: boolean;
    isReady: boolean;
    isMe: boolean;
}

export interface WitchPotions {
    saveUsed: boolean;
    poisonUsed: boolean;
}

export interface VoteResult {
    targetId: string;
    targetName: string;
    votes: number;
    voterIds: string[];
    eliminated: boolean;
    hunterShot: boolean;
    loverSubstituted: boolean;
}

export type LoverChoice = 'substitute' | 'convert' | 'abstain';

export interface LoverInfo {
    nightNumber: number;
    targetId: string | null;
    targetRole: Role | null;
    targetAlive: boolean;
    targetInDanger: boolean;
    choice: LoverChoice | null;
}

export interface MemoEntry {
    text: string;
    isOwnAction: boolean;
}
