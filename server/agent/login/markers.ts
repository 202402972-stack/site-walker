// Challenge page markers — shared by classification and detection.
//
// Two distinct situations, deliberately separated:
// - BLOCKER: the page itself IS a bot challenge (Cloudflare interstitial
//   "Just a moment…", "Attention Required", unusual-traffic walls). Strong,
//   mostly structural signals. Nothing useful can happen on such a page
//   except a bounded self-clear wait and an honest report.
// - EMBEDDED: a challenge widget (reCAPTCHA/hCaptcha/Turnstile box) inside an
//   otherwise normal page — usually the site's own login form. An embedded
//   widget never stops the run: the agent fills the SITE's fields and presses
//   the SITE's submit button; the provider alone decides the outcome. The
//   widget itself is never ticked, solved, or bypassed.
//
// "Verify you are human" and "I'm not a robot" are widget LABELS, so they are
// embedded signals, not blockers — an interstitial is identified by its own
// strong markers instead.
export const BLOCKER_MARKERS: RegExp[] = [
  /just a moment/i,
  /attention required/i,
  /checking your browser/i,
  /cdn-cgi\/challenge-platform/i,
  /cf-chl/i,
  /cf_chl_/i,
  /unusual traffic/i,
];

// Weak/generic signals — page TEXT or vendor widget markup anywhere on it.
export const EMBEDDED_MARKERS: RegExp[] = [
  /captcha/i,
  /recaptcha/i,
  /g-recaptcha/i,
  /hcaptcha/i,
  /turnstile/i,
  /challenges\.cloudflare\.com/i,
  /cloudflare/i,
  /verify you are human/i,
  /verifying you are human/i,
  /i'?m not a robot/i,
  /are you a robot/i,
];

/** True only for full-page challenge interstitials. */
export function detectBlocker(html: string, title: string): boolean {
  const hay = `${title}\n${html.slice(0, 200_000)}`;
  return BLOCKER_MARKERS.some((re) => re.test(hay));
}

/** True when a challenge widget or marker is present anywhere on the page. */
export function detectEmbeddedWidget(html: string, title: string): boolean {
  const hay = `${title}\n${html.slice(0, 200_000)}`;
  return EMBEDDED_MARKERS.some((re) => re.test(hay));
}

/** Union kept for callers that only want a boolean "is challenge-ish". */
export function detectChallenge(html: string, title: string): boolean {
  return detectBlocker(html, title) || detectEmbeddedWidget(html, title);
}
