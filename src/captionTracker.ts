import { Page } from '@playwright/test';

/**
 * Captures Microsoft Teams' *own* live closed captions, which is the only reliable way to get
 * REAL speaker names (Teams attributes every caption line to a named participant). There is no
 * public Teams/Graph API for "who is speaking by name", and pure acoustic diarization only
 * yields anonymous "Speaker 1/2" labels - so we read Teams' caption DOM instead.
 *
 * Each caption line in the Teams web client lives in a `.fui-ChatMessageCompact` block with:
 *   - the speaker name in `[data-tid="author"]`
 *   - the (live-updating) text in `[data-tid="closed-caption-text"]`
 *
 * Selectors handle both work (teams.microsoft.com) and personal (teams.live.com) Teams, and were
 * taken from a currently-maintained Teams caption-capture userscript rather than guessed. If Teams
 * changes its caption DOM, this file is the single place to fix it - watch over VNC to see whether
 * captions are turning on and where the scrape breaks.
 */

export interface CaptionEntry {
  speaker: string;
  text: string;
  /** Milliseconds from when recording started to when this line first appeared. */
  tStartMs: number;
  /** Milliseconds from recording start to this line's last text update. */
  tEndMs: number;
}

interface RawCaptionEvent {
  id: number;
  speaker: string;
  text: string;
  tMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CaptionTracker {
  private entries = new Map<number, CaptionEntry>();
  private page: Page | null = null;

  /**
   * Begins capturing captions. `startEpochMs` should be the same instant recording started, so
   * caption timestamps line up with the audio (and therefore with a Whisper transcript of it).
   */
  public async start(page: Page, startEpochMs: number): Promise<void> {
    this.page = page;
    this.entries.clear();

    // Must run for EVERY meeting: each /join creates a fresh browser context + page, and an
    // exposed function only lives on the page it was registered on. (A previous version cached
    // this with a flag, which silently broke caption capture on every meeting after the first.)
    // The try/catch covers the rare case of start() being called twice on the same page.
    try {
      await page.exposeFunction('__teamsCaption', (ev: RawCaptionEvent) => {
        const existing = this.entries.get(ev.id);
        if (existing) {
          existing.text = ev.text;
          existing.speaker = ev.speaker || existing.speaker;
          existing.tEndMs = ev.tMs;
        } else {
          this.entries.set(ev.id, {
            speaker: ev.speaker || 'Unknown',
            text: ev.text,
            tStartMs: ev.tMs,
            tEndMs: ev.tMs,
          });
        }
      });
    } catch (err) {
      // Already registered on this page - safe to ignore.
      console.warn('[captionTracker] __teamsCaption already exposed on this page:', (err as Error).message);
    }

    await this.enableCaptions(page);
    await this.installObserver(page, startEpochMs);
  }

  /** Stops the observer and returns captured lines in chronological order. */
  public async stop(): Promise<CaptionEntry[]> {
    if (this.page) {
      try {
        await this.page.evaluate(() => {
          const w = window as unknown as { __teamsCaptionObserver?: MutationObserver | null };
          if (w.__teamsCaptionObserver) {
            w.__teamsCaptionObserver.disconnect();
            w.__teamsCaptionObserver = null;
          }
        });
      } catch {
        // page may already be gone - we still have whatever we buffered
      }
    }
    return Array.from(this.entries.values()).sort((a, b) => a.tStartMs - b.tStartMs);
  }

  /** Best-effort roster scrape. Names come from captions anyway; this is just for reference. */
  public async getParticipants(page: Page): Promise<string[]> {
    try {
      return await page.evaluate(() => {
        const set = new Set<string>();
        document.querySelectorAll('li[data-cid="roster-participant"] span[title]').forEach((node) => {
          const title = (node as HTMLElement).getAttribute('title');
          if (title) set.add(title.replace('(me)', '').trim());
        });
        return Array.from(set);
      });
    } catch {
      return [];
    }
  }

  /**
   * Turns on live captions by opening the "More" menu and clicking the captions item. Teams has a
   * couple of layouts: sometimes captions is a direct menu item, sometimes it's nested under a
   * "Language and speech" submenu - we handle both. No-op-safe if captions are already on.
   */
  private async enableCaptions(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const clickedMore = await page.evaluate(() => {
          const more = document.querySelector(
            '#callingButtons-showMoreBtn, [data-inp="callingButtons-showMoreBtn"], [data-tid="callingButtons-showMoreBtn"]',
          ) as HTMLElement | null;
          if (more) {
            more.click();
            return true;
          }
          return false;
        });

        if (!clickedMore) {
          await sleep(1500);
          continue;
        }

        await sleep(1200);

        const result = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
          const direct = items.find((el) => /caption/i.test(el.textContent || ''));
          if (direct) {
            direct.click();
            return 'caption';
          }
          const submenu = items.find((el) => /language and speech|language|speech/i.test(el.textContent || ''));
          if (submenu) {
            submenu.click();
            return 'submenu';
          }
          return 'none';
        });

        if (result === 'submenu') {
          await sleep(1000);
          const enabled = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
            const target = items.find((el) => /caption/i.test(el.textContent || ''));
            if (target) {
              target.click();
              return true;
            }
            return false;
          });
          if (enabled) {
            console.log('[captionTracker] Enabled live captions (via Language and speech submenu).');
            return;
          }
        } else if (result === 'caption') {
          console.log('[captionTracker] Enabled live captions.');
          return;
        }
      } catch {
        // menu may still be rendering - retry
      }
      await sleep(1500);
    }
    console.warn(
      '[captionTracker] Could not confirm captions were enabled. If the transcript is empty, ' +
        'turn captions on manually over VNC, or the captions menu item moved (update src/captionTracker.ts).',
    );
  }

  /** Injects a MutationObserver that reports every caption line (and its live updates) to Node. */
  private async installObserver(page: Page, startEpochMs: number): Promise<void> {
    await page.evaluate((startEpoch: number) => {
      const w = window as unknown as {
        __teamsCaptionObserver?: MutationObserver | null;
        __teamsCaption?: (ev: RawCaptionEvent) => void;
      };
      if (w.__teamsCaptionObserver) return;

      let counter = 0;
      const seen = new Map<Element, number>();

      const emit = (span: Element): void => {
        const container = span.closest('.fui-ChatMessageCompact');
        const speaker =
          container?.querySelector('[data-tid="author"]')?.textContent?.trim() || 'Unknown';
        const text = (span.textContent || '').trim();
        if (!text) return;
        let id = seen.get(span);
        if (id === undefined) {
          id = counter++;
          seen.set(span, id);
        }
        w.__teamsCaption?.({ id, speaker, text, tMs: Date.now() - startEpoch });
      };

      const scan = (root: ParentNode): void => {
        root.querySelectorAll?.('[data-tid="closed-caption-text"]').forEach(emit);
      };

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'characterData') {
            const parent = (m.target as CharacterData).parentElement;
            if (parent && (parent as HTMLElement).dataset?.tid === 'closed-caption-text') {
              emit(parent);
            }
          } else if (m.addedNodes.length) {
            m.addedNodes.forEach((n) => {
              if (n.nodeType === 1) scan(n as Element);
            });
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      w.__teamsCaptionObserver = observer;
      scan(document.body);
    }, startEpochMs);
  }
}
