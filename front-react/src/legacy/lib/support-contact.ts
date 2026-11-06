// The operations contact the screens name, kept in one place (2026-11-05). The beta notice lists these addresses, and
// every aggregation-failure notice names them: the user asked for failures to say plainly that they failed and whom to
// tell. A neutral module (no "use client"): server components format the notices with it too, and a "use client"
// module's constant reaches a server component as a reference, not its value.
// The addresses are the external-review snapshot's placeholders (example.com) until the real ones are set here.
export const FEEDBACK_EMAILS = ["feedback-hmg@example.com", "feedback-partner@example.com"] as const;
export const FEEDBACK_EMAIL_TEXT = FEEDBACK_EMAILS.join(", ");
/** The values a failure notice is formatted with (`{contact}` in the message). */
export const SUPPORT = { contact: FEEDBACK_EMAIL_TEXT } as const;
