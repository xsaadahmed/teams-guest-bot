/**
 * A normal Teams meeting link (the one from a calendar invite) opens an "Open Microsoft Teams?"
 * app-launcher dialog that a headless/automated browser can't interact with - it's not a real
 * link to the meeting lobby. The fix (confirmed by multiple independent open-source Teams bots)
 * is to rewrite it into Teams' own "v2" deep-link format with `&anon=true`, which goes straight
 * to the browser join lobby and skips the native-app prompt entirely.
 *
 * Handles:
 *  - Standard work/school links: https://teams.microsoft.com/l/meetup-join/<thread>/<ts>?context=...
 *  - Personal "Teams Free" links: https://teams.live.com/meet/<id>?p=<passcode>
 * Anything else is passed through unchanged (with a warning) - Playwright will likely hit the
 * app-launcher dialog and fail to find the join button, which shows up clearly in the logs.
 */
export function toDirectJoinUrl(originalLink: string): string {
  try {
    if (originalLink.includes('/v2/?meetingjoin=true')) {
      // Already in the directly-joinable format.
      return originalLink;
    }

    const url = new URL(originalLink);

    if (url.hostname.includes('teams.live.com')) {
      // Personal/free Teams links are already directly joinable, just make sure anon=true is set.
      url.searchParams.set('anon', 'true');
      return url.toString();
    }

    if (url.hostname.includes('teams.microsoft.com')) {
      const match = originalLink.match(
        /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/(.*?)\/(\d+)\?context=(.*?)(?:$|&)/,
      );

      if (match) {
        const [, threadId, timestamp, context] = match;
        return `https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/${threadId}/${timestamp}?context=${context}&anon=true`;
      }
    }

    console.warn(
      `[teamsUrl] Could not recognize this link's format, passing it through unchanged: ${originalLink}`,
    );
    return originalLink;
  } catch (err) {
    console.error('[teamsUrl] Failed to parse meeting URL, passing it through unchanged:', err);
    return originalLink;
  }
}
