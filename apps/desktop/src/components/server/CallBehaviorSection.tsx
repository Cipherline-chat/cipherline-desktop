/**
 * CallBehaviorSection - the "Call behavior" card of a Calls channel's settings
 * (create + edit), between "Call limits" and "Call names". Controlled: the
 * dialog owns the draft, so the switch is part of the dialog's dirty / Save /
 * Cancel flow like every other field.
 *
 * One row today: "End call when the starter leaves" (channel.end_call_when_starter_leaves).
 * Whoever may edit the channel decides it for every call started there; the
 * server enforces it (HuddlesService.tryEndCallForEveryone) and this switch is
 * only where it is edited.
 */
import React from 'react';
import { PhoneOff } from 'lucide-react';
import { ClToggle } from '../cl';
import { Row } from './CallNamingSection';
import { END_WHEN_STARTER_LEAVES_LABEL, END_WHEN_STARTER_LEAVES_HINT } from '../../utils/endCallOnLeave';

interface Props {
    value: boolean;
    onChange: (next: boolean) => void;
    disabled?: boolean;
}

export const CallBehaviorSection: React.FC<Props> = ({ value, onChange, disabled }) => (
    <div className="rounded-xl border border-solid border-cl-border/50 bg-cl-surface/40 divide-y divide-white/[0.05]" data-testid="call-behavior">
        <Row
            icon={<PhoneOff size={13} />}
            label={END_WHEN_STARTER_LEAVES_LABEL}
            sublabel={END_WHEN_STARTER_LEAVES_HINT}
            control={<ClToggle checked={value} onChange={onChange} disabled={disabled} aria-label={END_WHEN_STARTER_LEAVES_LABEL} />}
        />
    </div>
);

export default CallBehaviorSection;
