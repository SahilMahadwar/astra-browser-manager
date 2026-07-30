/**
 * Chromium flags every new profile starts with. Edit this array to change the
 * defaults — they are only a starting point: each one lands in the profile's
 * launch_args on save and can be removed per profile in the form.
 *
 * Existing profiles are unaffected; this applies to newly created ones only.
 *
 * Keep additions **additive**. cloakbrowser merges args by flag name, so a
 * default like `--disable-blink-features=X` replaces the value Playwright
 * already sets (`--disable-blink-features=AutomationControlled`) rather than
 * adding to it. Also don't repeat what buildFingerprintArgs already emits
 * server-side (`--disable-infobars`, `--test-type`, `--use-angle=swiftshader`,
 * `--fingerprint*`).
 *
 * Deliberately NOT defaulted: `--fingerprint-windows-font-metrics`. It only
 * does anything when the full Windows font set is installed (see the README's
 * "Windows fonts on Linux"), so defaulting it on would imply a guarantee the
 * image cannot make. Add it per profile once the startup log reports the set
 * complete.
 */
export const DEFAULT_LAUNCH_ARGS: readonly string[] = [
  "--mute-audio",
  "--disable-notifications",
];
