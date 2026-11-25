//! The approval gate (plan D6/D7): Windows Hello (`UserConsentVerifier`) where available, otherwise a native
//! confirm dialog the page cannot click. The page never supplies the answer: `nearApprove` runs the gate
//! inside the host. The Windows implementation lives in `winhello.rs` (cfg(windows)); tests use [`FakeGate`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    Available,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verification {
    Verified,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateKind {
    Hello,
    NativeConfirm,
    /// The account password / authenticator code, verified against the server by the parent app (Electron main).
    Password,
}

impl GateKind {
    pub fn bridge_name(self) -> &'static str {
        match self {
            GateKind::Hello => "hello",
            GateKind::NativeConfirm => "native_confirm",
            GateKind::Password => "password",
        }
    }
}

pub trait ApprovalGate: Send + Sync + 'static {
    fn availability(&self) -> Availability;
    /// Windows Hello prompt. Only called when `availability()` is `Available`.
    fn verify(&self, reason: &str) -> Verification;
    /// Native confirm the page cannot click (the existing `confirm()` of the shell). true = approved.
    fn confirm(&self, title: &str, detail: &str) -> bool;
    /// What [`confirm`](Self::confirm) is, for the bridge (`nearProbe().gate`, `nearApprove().gate`).
    fn confirm_kind(&self) -> GateKind {
        GateKind::NativeConfirm
    }
}

/// What an approval uses, and its result. Hello when available (it needs fresh user presence); else the confirm.
pub fn run_gate(g: &dyn ApprovalGate, title: &str, detail: &str) -> (GateKind, Verification) {
    if g.availability() == Availability::Available {
        (GateKind::Hello, g.verify(detail))
    } else {
        (g.confirm_kind(), if g.confirm(title, detail) { Verification::Verified } else { Verification::Cancelled })
    }
}

pub struct FakeGate {
    pub availability: Availability,
    pub verification: Verification,
    pub confirm_answer: bool,
    pub prompts: std::sync::Mutex<Vec<String>>,
}

impl FakeGate {
    pub fn new(availability: Availability, verification: Verification, confirm_answer: bool) -> Self {
        Self { availability, verification, confirm_answer, prompts: Default::default() }
    }
}

impl ApprovalGate for FakeGate {
    fn availability(&self) -> Availability {
        self.availability
    }
    fn verify(&self, reason: &str) -> Verification {
        self.prompts.lock().unwrap().push(format!("hello:{reason}"));
        self.verification
    }
    fn confirm(&self, title: &str, _detail: &str) -> bool {
        self.prompts.lock().unwrap().push(format!("confirm:{title}"));
        self.confirm_answer
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_is_used_when_available_and_its_answer_is_final() {
        for v in [Verification::Verified, Verification::Cancelled, Verification::Failed] {
            let g = FakeGate::new(Availability::Available, v, true);
            assert_eq!(run_gate(&g, "t", "d"), (GateKind::Hello, v));
            assert_eq!(g.prompts.lock().unwrap().len(), 1, "no second prompt that could override a refusal");
        }
    }

    #[test]
    fn without_hello_the_native_confirm_decides() {
        let yes = FakeGate::new(Availability::Unavailable, Verification::Verified, true);
        assert_eq!(run_gate(&yes, "t", "d"), (GateKind::NativeConfirm, Verification::Verified));
        let no = FakeGate::new(Availability::Unavailable, Verification::Verified, false);
        assert_eq!(run_gate(&no, "t", "d"), (GateKind::NativeConfirm, Verification::Cancelled));
    }
}
