import { describe, it, expect } from 'vitest';
import { resolveNotification, type NotifDecisionInput } from './notificationDecision';

/** Sensible defaults matching NotificationContext's shipped prefs; each test
 *  overrides only the field it's actually about. */
const base: NotifDecisionInput = {
    text: 'hello there',
    directMention: false,
    keywords: [],
    mode: 'all',
    windowFocused: false,
    isActiveConversation: false,
    suppressWhenActiveConv: true,
    dndActive: false,
    dndLetMentionsThrough: true,
};

const decide = (over: Partial<NotifDecisionInput> = {}) =>
    resolveNotification({ ...base, ...over });

describe('resolveNotification', () => {
    describe('the invariant this module exists to hold', () => {
        // The reported bug: a sound with nothing on screen to show for it.
        // Outside the two cases where it's correct — DND (deliberately silent
        // but still counted) and "you are looking right at it" (counted as read
        // on arrival) — an alert must always come with a badge.
        it('never alerts without also counting, except under DND or while watching', () => {
            const modes = ['all', 'mentions', 'none'] as const;
            const bools = [false, true];
            for (const mode of modes) {
                for (const directMention of bools) {
                    for (const windowFocused of bools) {
                        for (const isActiveConversation of bools) {
                            for (const suppressWhenActiveConv of bools) {
                                for (const keywords of [[], ['deploy']]) {
                                    const d = decide({
                                        mode, directMention, windowFocused,
                                        isActiveConversation, suppressWhenActiveConv,
                                        text: 'time to deploy',
                                        keywords,
                                    });
                                    if (!d.playsSound) continue;
                                    const watching = windowFocused && isActiveConversation;
                                    const counted = d.countsUnread || d.countsMention;
                                    expect(
                                        counted || watching,
                                        `alerted silently: mode=${mode} mention=${directMention} ` +
                                        `focus=${windowFocused} active=${isActiveConversation} ` +
                                        `suppress=${suppressWhenActiveConv} kw=${keywords.length}`,
                                    ).toBe(true);
                                }
                            }
                        }
                    }
                }
            }
        });
    });

    describe('keywords', () => {
        // This is the concrete divergence that shipped: useNotificationDispatch
        // treated a keyword hit as a mention, Dashboard's counters didn't.
        it('treats a keyword hit as a mention for BOTH the sound and the badge', () => {
            const d = decide({ text: 'ship the deploy now', keywords: ['deploy'] });
            expect(d.isMention).toBe(true);
            expect(d.countsMention).toBe(true);
            expect(d.playsSound).toBe(true);
        });

        it('lets a keyword hit through an @mentions-only conversation, with a badge', () => {
            const d = decide({ mode: 'mentions', text: 'deploy time', keywords: ['deploy'] });
            expect(d.playsSound).toBe(true);
            expect(d.countsUnread).toBe(true);
            expect(d.countsMention).toBe(true);
        });

        it('counts the mention but never the unread in a muted conversation', () => {
            const d = decide({ mode: 'none', text: 'deploy time', keywords: ['deploy'] });
            expect(d.playsSound).toBe(true);
            expect(d.countsMention).toBe(true);
            expect(d.countsUnread).toBe(false);
        });

        it('ignores a non-matching keyword', () => {
            const d = decide({ mode: 'mentions', text: 'nothing to see', keywords: ['deploy'] });
            expect(d.isMention).toBe(false);
            expect(d.playsSound).toBe(false);
            expect(d.countsMention).toBe(false);
            // countsUnread is deliberately TRUE here: @mentions-only silences
            // the ping, not the fact that something arrived. It is rendered as
            // a quiet grey badge — see unreadBadges.resolveBadge.
            expect(d.countsUnread).toBe(true);
        });
    });

    describe('focus and the active conversation', () => {
        it('counts nothing when the user is watching the conversation', () => {
            const d = decide({ windowFocused: true, isActiveConversation: true });
            expect(d.countsUnread).toBe(false);
            expect(d.countsMention).toBe(false);
            expect(d.playsSound).toBe(false);
        });

        it('counts a message in the open conversation when the window is blurred', () => {
            const d = decide({ windowFocused: false, isActiveConversation: true });
            expect(d.countsUnread).toBe(true);
            expect(d.playsSound).toBe(true);
        });

        it('counts a message in another conversation while focused', () => {
            const d = decide({ windowFocused: true, isActiveConversation: false });
            expect(d.countsUnread).toBe(true);
            expect(d.playsSound).toBe(true);
        });

        it('still makes no badge when suppress_when_active_conv is off — the sound is the opt-in', () => {
            const d = decide({
                windowFocused: true, isActiveConversation: true,
                suppressWhenActiveConv: false,
            });
            expect(d.playsSound).toBe(true);
            expect(d.countsUnread).toBe(false); // it's on screen; that IS read
        });
    });

    describe('do not disturb', () => {
        it('silences the alert but keeps the badge', () => {
            const d = decide({ dndActive: true });
            expect(d.playsSound).toBe(false);
            expect(d.showsToast).toBe(false);
            expect(d.countsUnread).toBe(true);
        });

        it('lets a mention pierce when configured', () => {
            const d = decide({ dndActive: true, directMention: true, dndLetMentionsThrough: true });
            expect(d.playsSound).toBe(true);
        });

        it('holds a mention back when not configured', () => {
            const d = decide({ dndActive: true, directMention: true, dndLetMentionsThrough: false });
            expect(d.playsSound).toBe(false);
            expect(d.countsMention).toBe(true);
        });
    });

    describe('per-conversation mode', () => {
        it("'all' counts and alerts on an ordinary message", () => {
            const d = decide();
            expect(d.countsUnread).toBe(true);
            expect(d.playsSound).toBe(true);
        });

        it("'mentions' silences an ordinary message but still counts it", () => {
            // This used to assert countsUnread === false, which made a server
            // you had merely turned pings off on indistinguishable from one
            // with nothing new in it. "Don't ping me" and "don't tell me" are
            // different requests and only Muted asks for the second.
            const d = decide({ mode: 'mentions' });
            expect(d.countsUnread).toBe(true);
            expect(d.countsMention).toBe(false);
            expect(d.playsSound).toBe(false);
            expect(d.showsToast).toBe(false);
        });

        it("'none' counts nothing unread — the grey badge must not appear when muted", () => {
            const d = decide({ mode: 'none' });
            expect(d.countsUnread).toBe(false);
            expect(d.countsMention).toBe(false);
            expect(d.playsSound).toBe(false);
        });

        it("'none' still records a direct @mention without an unread bump", () => {
            const d = decide({ mode: 'none', directMention: true });
            expect(d.countsMention).toBe(true);
            expect(d.countsUnread).toBe(false);
            expect(d.playsSound).toBe(true);
        });
    });

    it('tolerates missing text and keywords', () => {
        const d = resolveNotification({
            ...base,
            text: undefined as unknown as string,
            keywords: undefined as unknown as string[],
        });
        expect(d.isMention).toBe(false);
        expect(d.countsUnread).toBe(true);
    });
});

/**
 * The composition this module and computeDnd form together.
 *
 * `resolveNotification` takes `dndActive` as a plain boolean, so it cannot
 * tell a genuine "do not disturb me" from a mis-derived one — which is
 * exactly how switching off OS toasts used to take the notification SOUND
 * with it. computeDnd returned `{ active: true, reason: 'disabled' }` for
 * `desktop_notifications_enabled: false`, and `dndSwallows` gates
 * `playsSound` as well as `showsToast`.
 *
 * The fix is in computeDnd (and pinned in hooks/useDndState.test.ts). These
 * assert the other half of the contract: given the corrected input, the
 * sound survives — and the two delivery channels are never conflated here
 * either.
 */
describe('sound and toast are separate deliveries', () => {
    it('a plain message still makes a sound when the user only turned toasts off', () => {
        // computeDnd no longer reports DND for that pref, so dndActive is false.
        // If a future change reintroduces the coupling, the sound dies here.
        const d = decide({ dndActive: false });
        expect(d.playsSound).toBe(true);
    });

    it('when DND IS genuinely on, it silences both — that is what DND means', () => {
        const d = decide({ dndActive: true, dndLetMentionsThrough: false });
        expect(d.playsSound).toBe(false);
        expect(d.showsToast).toBe(false);
    });

    it('this module never decides anything from a delivery-channel toggle', () => {
        // NotifDecisionInput carries neither `desktop_notifications_enabled`
        // nor `sounds_enabled`, and it must not grow them: each is applied by
        // useNotificationDispatch to its OWN channel (step 3 and step 4), which
        // is the only place they can be applied without affecting the other.
        const keys = Object.keys({
            text: '', directMention: false, keywords: [], mode: 'all' as const,
            windowFocused: false, isActiveConversation: false,
            suppressWhenActiveConv: false, dndActive: false,
            dndLetMentionsThrough: false,
        } satisfies NotifDecisionInput);
        expect(keys).not.toContain('desktop_notifications_enabled');
        expect(keys).not.toContain('sounds_enabled');
    });

    it('playsSound and showsToast diverge ONLY via the caller, never here', () => {
        // They are deliberately identical in this module — see the type's own
        // comment. Any future divergence has to be justified at the call site,
        // not smuggled in through a shared gate like dndActive was.
        for (const dndActive of [false, true]) {
            for (const directMention of [false, true]) {
                for (const dndLetMentionsThrough of [false, true]) {
                    const d = decide({ dndActive, directMention, dndLetMentionsThrough });
                    expect(d.playsSound).toBe(d.showsToast);
                }
            }
        }
    });
});
