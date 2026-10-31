// Decides what an implicit dismiss attempt (backdrop press, Esc, an external
// `visible=false`) does to the global confirm dialog. Dialogs opened with
// `dismissible: false` (AI tool confirmations) are modal: only the explicit
// Confirm / Cancel buttons resolve them.
export type DialogDismissSource = 'backdrop' | 'escape' | 'external';

export const resolveDismissAttempt = (dismissible: boolean | undefined, _source: DialogDismissSource): 'cancel' | 'ignore' => (
  dismissible === false ? 'ignore' : 'cancel'
);
