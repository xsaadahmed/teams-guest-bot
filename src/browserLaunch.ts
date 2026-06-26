import { chromium, BrowserContext } from '@playwright/test';

/**
 * Chromium flags needed for this to work headed-under-Xvfb with audio routed through
 * PulseAudio's virtual sink. Trimmed down from a production Teams/Meet recording bot's
 * verified flag set to just what Teams needs (dropped Meet-specific anti-bot/stealth flags,
 * proxy/timezone spoofing, and resource-tuning flags that aren't load-bearing for a single
 * personal-use bot).
 */
function buildLaunchArgs(width: number, height: number): string[] {
  return [
    `--window-size=${width},${height}`,
    '--window-position=0,0',

    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--lang=en-US',

    // Audio: force Chromium onto PulseAudio and make sure autoplay isn't blocked
    // (Teams plays remote audio via an actual <audio>/<video> element; if autoplay is
    // blocked, you get a perfectly normal-looking meeting with silent audio).
    '--use-pulseaudio',
    '--enable-audio-service-sandbox=false',
    '--audio-buffer-size=2048',
    '--disable-features=AudioServiceSandbox',
    '--autoplay-policy=no-user-gesture-required',

    // WebRTC tuning - matters for reliable audio in headless/Xvfb environments.
    '--disable-webrtc-hw-decoding',
    '--disable-webrtc-hw-encoding',
    '--enable-webrtc-capture-audio',
    '--force-webrtc-ip-handling-policy=default',

    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ];
}

export interface LaunchedBrowser {
  context: BrowserContext;
}

/**
 * Launches a persistent Chromium context configured to join Teams as a guest.
 * Must run with DISPLAY set to a running Xvfb display (headless:false is intentional -
 * Teams' WebRTC join flow is far less reliable in Chromium's native headless mode).
 */
export async function launchTeamsBrowser(): Promise<LaunchedBrowser> {
  const width = Number(process.env.X11_WIDTH ?? 1280);
  const height = Number(process.env.X11_HEIGHT ?? 720);
  const executablePath = process.env.CHROME_PATH || undefined;

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: { width, height },
    executablePath,
    locale: 'en-US',
    args: buildLaunchArgs(width, height),
    permissions: ['microphone', 'camera'],
    ignoreHTTPSErrors: true,
    timeout: 120_000,
  });

  return { context };
}
