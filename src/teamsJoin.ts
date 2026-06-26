import { Page } from '@playwright/test';

const NAME_INPUT_SELECTOR = 'input[placeholder="Type your name"]';

const DENIAL_TEXTS = [
  'Sorry, but you were denied access to the meeting.',
  'We need to verify your info before you can join',
];

// At least this many of these need to be visible for us to consider ourselves "in the meeting".
// A single match is too unreliable (Teams reuses generic button labels in a few different
// screens) - several at once is a much stronger signal.
const IN_MEETING_SELECTORS = [
  'button:has-text("React")',
  'button#raisehands-button:has-text("Raise")',
  'button[aria-label*="chat"]',
  'button[title*="chat"]',
  '[data-tid="roster-button"]',
  'button[id*="hangup"]',
];
const IN_MEETING_THRESHOLD = 2;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clicks a button matched by its exact visible text. Loops a few times since Teams'
 * UI renders progressively and the button you want often isn't there yet on the first check.
 */
async function clickButtonWithText(
  page: Page,
  text: string,
  attempts = 3,
  click = true,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const found = await page.evaluate(
        ({ text, click }) => {
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const el of buttons) {
            if (el.textContent?.trim() === text) {
              if (click) (el as HTMLElement).click();
              return true;
            }
          }
          return false;
        },
        { text, click },
      );
      if (found) return true;
    } catch {
      // page may be navigating - just retry
    }
    await sleep(300);
  }
  return false;
}

async function typeDisplayName(page: Page, name: string, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const input = page.locator(NAME_INPUT_SELECTOR);
      if ((await input.count()) > 0) {
        await input.focus();
        await input.fill(name);
        if ((await input.inputValue()) === name) return;
      }
    } catch {
      // input not ready yet
    }
    await sleep(500);
  }
  throw new Error('Could not find/fill the "Type your name" field - Teams join UI may have changed.');
}

async function isMicMuted(page: Page): Promise<boolean | undefined> {
  if ((await page.locator('button[title="Unmute mic"]').count()) > 0) return true;
  if ((await page.locator('button[title="Mute mic"]').count()) > 0) return false;
  return undefined; // couldn't tell - Teams may be on the "continue without audio" path
}

async function muteMicIfNeeded(page: Page): Promise<void> {
  try {
    const muted = await isMicMuted(page);
    if (muted === false) {
      // Ctrl+Shift+M is Teams' mic-toggle shortcut.
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyM');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await sleep(500);
    }
  } catch (err) {
    console.warn('[teamsJoin] Could not confirm/mute microphone, continuing anyway:', err);
  }
}

async function checkDenied(page: Page): Promise<string | null> {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText);
    for (const text of DENIAL_TEXTS) {
      if (bodyText.includes(text)) return text;
    }
  } catch {
    // ignore - page may be navigating
  }
  return null;
}

async function countInMeetingSignals(page: Page): Promise<number> {
  let count = 0;
  for (const selector of IN_MEETING_SELECTORS) {
    try {
      if ((await page.locator(selector).count()) > 0) count++;
    } catch {
      // selector errors shouldn't abort the whole check
    }
  }
  return count;
}

export type JoinOutcome =
  | { status: 'joined' }
  | { status: 'denied'; reason: string }
  | { status: 'timeout' };

/**
 * Drives the actual Teams join flow: clicks through the pre-join screens, types the guest
 * display name, joins muted/camera-off, then polls until either we're clearly in the meeting
 * or clearly denied/stuck. `joinUrl` should already be the transformed direct-join URL.
 */
export async function joinTeamsMeeting(
  page: Page,
  joinUrl: string,
  displayName: string,
  maxWaitMs = 5 * 60_000,
): Promise<JoinOutcome> {
  await page.goto(joinUrl, { waitUntil: 'load', timeout: 30_000 });

  // Click through whichever pre-join variant Teams shows us. These appear in different orders/
  // combinations depending on Teams' current experiment bucket, so we just keep checking for a
  // while rather than assuming a fixed sequence.
  for (let i = 0; i < 20; i++) {
    if (await clickButtonWithText(page, 'Continue on this browser', 1)) {
      console.log('[teamsJoin] Clicked "Continue on this browser"');
    }
    if (await clickButtonWithText(page, 'Continue without audio or video', 1)) {
      console.log('[teamsJoin] Clicked "Continue without audio or video"');
      await sleep(1000);
    }
    if (await clickButtonWithText(page, 'Join now', 1, false)) {
      // It's present - move on to the name-entry step below rather than clicking it yet
      // (we need to type the display name into the field on this same screen first).
      break;
    }
    await sleep(400);
  }

  try {
    await typeDisplayName(page, displayName);
  } catch (err) {
    console.warn('[teamsJoin]', (err as Error).message);
    // Some join variants skip the name field entirely (e.g. already-authenticated org accounts) -
    // not necessarily fatal, so we continue rather than aborting here.
  }

  await muteMicIfNeeded(page);

  await clickButtonWithText(page, 'Join now', 20);

  // Now wait (this is the lobby/waiting-room period if the organizer has one enabled) until
  // either we're clearly in, clearly denied, or we time out.
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const denialReason = await checkDenied(page);
    if (denialReason) {
      return { status: 'denied', reason: denialReason };
    }

    const signals = await countInMeetingSignals(page);
    if (signals >= IN_MEETING_THRESHOLD) {
      return { status: 'joined' };
    }

    await sleep(2000);
  }

  return { status: 'timeout' };
}

/**
 * Best-effort leave: click the "Leave" button if we can find it, otherwise the caller should
 * just close the browser context.
 */
export async function leaveTeamsMeeting(page: Page): Promise<boolean> {
  try {
    if (await clickButtonWithText(page, 'Leave', 5)) return true;
    const byRole = page.getByRole('button', { name: 'Leave' });
    if ((await byRole.count()) > 0) {
      await byRole.click();
      return true;
    }
  } catch (err) {
    console.warn('[teamsJoin] Error while trying to click Leave:', err);
  }
  return false;
}

/**
 * True once the in-meeting signals disappear (the organizer ended the meeting, or we were
 * removed) - used to auto-stop recording even if nobody calls /leave.
 */
export async function hasMeetingEnded(page: Page): Promise<boolean> {
  try {
    if (page.isClosed()) return true;
    const signals = await countInMeetingSignals(page);
    return signals < IN_MEETING_THRESHOLD;
  } catch {
    // If we can't even evaluate on the page anymore, treat that as "ended".
    return true;
  }
}
