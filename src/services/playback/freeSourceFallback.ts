import type { SongResult } from '../../types';
import type { OnlineProviderId, ProviderUser } from '../../types/onlineMusic';
import { listOnlineMusicProviders } from '../onlineMusic/providerRegistry';
import { loadProviderAccountSnapshot } from '../onlineMusic/providerAccountCache';

// src/services/playback/freeSourceFallback.ts
//
// 付费墙（这首歌要会员 / 要单曲购买 / 当前账号没有权利）不是网络故障，重试和换音质都没用。
// 这条链路做两件事：先问清这台设备的账号到底有没有会员，再决定「照常报错」还是「悄悄换个源」。
//
//   · 有会员还被拒  → 不是权益问题（多半是凭证没送到，或者要走购买），交给原来的失败提示
//   · 没有会员 / 问不出来 → 去别的源找同一首歌，找到就直接播，用户不必自己动手
//
// 「问不出来」按没有会员处理：换源最坏是换到一首也放不了的，退回来仍然是原来那条失败提示。

export type FreeSourceMatch = {
    song: SongResult;
    providerId: OnlineProviderId;
    providerName: string;
};

/** 去掉括号里的版本说明（(Live)、(伴奏)、【高音质】），再抹掉空白与标点，只留可比较的字。 */
const normalize = (value: unknown): string => String(value ?? '')
    .toLowerCase()
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, ' ')
    .replace(/[\s\-_·.,'"’!?、:：]/g, '');

const artistNames = (song: SongResult | null | undefined): string[] => (
    Array.isArray(song?.artists) ? song.artists.map(artist => normalize(artist?.name)).filter(Boolean) : []
);

const vipTypeOf = (user: ProviderUser | null | undefined): number => {
    const raw = Number((user as { vipType?: unknown } | null | undefined)?.vipType ?? 0);
    return Number.isFinite(raw) ? raw : 0;
};

/**
 * 这台设备上的账号有没有会员。
 * `true` 有、`false` 没有、`null` 问不出来（没登录、账号信息还没缓存、请求失败）。
 */
export const providerHasMembership = async (providerId: OnlineProviderId): Promise<boolean | null> => {
    try {
        const snapshot = await loadProviderAccountSnapshot(providerId);
        if (snapshot?.user) return vipTypeOf(snapshot.user) > 0;
    } catch {
        // 快照读不出来不算结论，继续问 live 状态。
    }
    try {
        const provider = listOnlineMusicProviders().find(item => item.id === providerId);
        const user = await provider?.auth?.getLoginStatus?.();
        if (user) return vipTypeOf(user) > 0;
    } catch {
        // 问不出来就返回 null：调用方按「没有会员」处理，换源失败仍会退回原来的提示。
    }
    return null;
};

const scoreCandidate = (
    original: SongResult,
    wantedTitle: string,
    wantedArtists: string[],
    candidate: SongResult,
): number => {
    const candidateTitle = normalize(candidate?.name);
    if (!candidateTitle) return 0;
    let score = 0;
    if (candidateTitle === wantedTitle) score += 3;
    else if (candidateTitle.includes(wantedTitle) || wantedTitle.includes(candidateTitle)) score += 2;
    else return 0;

    const candidateArtists = artistNames(candidate);
    if (wantedArtists.some(name => candidateArtists.includes(name))) score += 2;
    else if (wantedArtists.some(name => candidateArtists.some(other => other.includes(name) || name.includes(other)))) score += 1;

    // 同名不同歌很常见（翻唱、现场、同名专辑曲目）：时长接近才算同一条。
    const delta = Math.abs(Number(candidate?.durationMs ?? 0) - Number(original?.durationMs ?? 0));
    if (delta > 0 && delta <= 5000) score += 1;
    return score;
};

/**
 * 在除了 `exclude` 之外的在线源里找同一首歌。
 * 只认「标题对得上」的候选，标题之外再看歌手与时长：宁可找不到，也别把别的歌唱出来。
 */
export const findFreeSourceMatch = async (
    song: SongResult,
    exclude: OnlineProviderId,
): Promise<FreeSourceMatch | null> => {
    const wantedTitle = normalize(song?.name);
    if (!wantedTitle) return null;
    const wantedArtists = artistNames(song);
    const query = [song?.name, (song?.artists ?? []).map(artist => artist?.name).filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(' ')
        .trim();
    if (!query) return null;

    let best: { match: FreeSourceMatch; score: number } | null = null;
    for (const provider of listOnlineMusicProviders()) {
        if (provider.id === exclude) continue;
        if (!provider.capabilities?.search || !provider.search?.searchSongs) continue;
        const availability = provider.getAvailability?.();
        if (availability && availability.configured === false) continue;
        try {
            const page = await provider.search.searchSongs(query, 10, 0);
            for (const candidate of page?.items ?? []) {
                const score = scoreCandidate(song, wantedTitle, wantedArtists, candidate);
                if (score < 3) continue;
                if (best && score <= best.score) continue;
                best = {
                    match: {
                        song: candidate,
                        providerId: provider.id,
                        providerName: provider.displayName ?? provider.shortName ?? provider.id,
                    },
                    score,
                };
            }
        } catch {
            // 一个源不可用（没配置、超时、被墙）不影响别的源。
        }
    }
    return best?.match ?? null;
};
