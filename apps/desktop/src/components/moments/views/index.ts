import type React from 'react';
import type { MomentId, CeremonyId } from '../../../utils/moments';
import { SelfFriendMoment } from './SelfFriendMoment';
import { NoteToSelfMoment } from './NoteToSelfMoment';
import { EchoEveryoneMoment } from './EchoEveryoneMoment';
import { SelfPingMoment } from './SelfPingMoment';
import { WishMoment } from './WishMoment';
import { EmptyPartyMoment } from './EmptyPartyMoment';
import { VolumeCeilingMoment } from './VolumeCeilingMoment';
import { SchoolMoment } from './SchoolMoment';
import { ReefMoment } from './ReefMoment';
import { CoffeeMoment } from './CoffeeMoment';
import { NewYearMoment } from './NewYearMoment';
import { AnniversaryMoment } from './AnniversaryMoment';
import { SelfFanMoment } from './SelfFanMoment';
import { DoubleGeneralMoment } from './DoubleGeneralMoment';
import { RevolvingDoorMoment } from './RevolvingDoorMoment';
import { FirstBanMoment } from './FirstBanMoment';
import { FirstMessageMoment } from './FirstMessageMoment';
import { FirstCallMoment } from './FirstCallMoment';
import { FirstServerMoment } from './FirstServerMoment';
import { Call100Moment } from './Call100Moment';
import { PiDayMoment } from './PiDayMoment';
import { LeapDayMoment } from './LeapDayMoment';
import { NyeCallMoment } from './NyeCallMoment';
import { SafetyVerifiedMoment, type CeremonyViewProps } from './SafetyVerifiedMoment';

/** One view per moment. The Record type makes a registry entry without a view a compile error. */
export const MOMENT_VIEWS: Record<MomentId, React.FC> = {
    'self-friend': SelfFriendMoment,
    'note-to-self': NoteToSelfMoment,
    'echo-everyone': EchoEveryoneMoment,
    'self-ping': SelfPingMoment,
    'wish': WishMoment,
    'empty-party': EmptyPartyMoment,
    'volume-ceiling': VolumeCeilingMoment,
    'friends-100': SchoolMoment,
    'servers-10': ReefMoment,
    'coffee': CoffeeMoment,
    'new-year': NewYearMoment,
    'anniversary': AnniversaryMoment,
    'self-fan': SelfFanMoment,
    'double-general': DoubleGeneralMoment,
    'revolving-door': RevolvingDoorMoment,
    'first-ban': FirstBanMoment,
    'first-message': FirstMessageMoment,
    'first-call': FirstCallMoment,
    'first-server': FirstServerMoment,
    'call-100': Call100Moment,
    'pi-day': PiDayMoment,
    'leap-day': LeapDayMoment,
    'nye-call': NyeCallMoment,
};

/**
 * One view per ceremony (utils/moments.ts CEREMONIES: not eggs, so they are not in the
 * registry above or in EGG_IDS). A ceremony view also gets the text it shows, with the
 * other person's name filled in.
 */
export const CEREMONY_VIEWS: Record<CeremonyId, React.FC<CeremonyViewProps>> = {
    'safety-verified': SafetyVerifiedMoment,
};
