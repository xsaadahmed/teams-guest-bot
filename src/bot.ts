import { BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchTeamsBrowser } from './browserLaunch';
import { toDirectJoinUrl } from './teamsUrl';
import { joinTeamsMeeting, leaveTeamsMeeting, hasMeetingEnded } from './teamsJoin';
import { AudioRecorder } from './audioRecorder';
import { CaptionTracker, CaptionEntry } from './captionTracker';

export type BotState = 'idle' | 'joining' | 'in_meeting' | 'leaving' | 'error';

export interface JoinRequest {
  meetingUrl: string;
  displayName?: string;
}

export interface BotStatus {
  state: BotState;
  meetingUrl?: string;
  displayName?: string;
  recordingFile?: string;
  joinedAt?: string;
  lastError?: string;
}

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'Recordings');
const DEFAULT_DISPLAY_NAME = process.env.DEFAULT_DISPLAY_NAME || 'Meeting Recorder';

/**
 * Owns a single guest "session" in a Teams meeting: one browser context, one page,
 * one audio recording. Supporting more than one concurrent meeting would mean running
 * one of these per meeting (each needs its own Xvfb display / Pulse sink) - straightforward
 * to add later, intentionally left out here to keep this readable.
 */
export class TeamsGuestBot {
  private state: BotState = 'idle';
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private recorder = new AudioRecorder();
  private captions = new CaptionTracker();
  private pollHandle: NodeJS.Timeout | null = null;
  private status: BotStatus = { state: 'idle' };
  private recordingFilePath: string | null = null;
  private captionsActive = false;

  public getStatus(): BotStatus {
    return { ...this.status, state: this.state };
  }

  public async join(req: JoinRequest): Promise<BotStatus> {
    if (this.state !== 'idle' && this.state !== 'error') {
      throw new Error(`Bot is already busy (state=${this.state}). Call /leave first.`);
    }

    const displayName = req.displayName?.trim() || DEFAULT_DISPLAY_NAME;
    this.state = 'joining';
    this.status = { state: 'joining', meetingUrl: req.meetingUrl, displayName };

    try {
      const { context } = await launchTeamsBrowser();
      this.context = context;
      this.page = await context.newPage();

      const directUrl = toDirectJoinUrl(req.meetingUrl);
      const outcome = await joinTeamsMeeting(this.page, directUrl, displayName);

      if (outcome.status === 'denied') {
        throw new Error(`Teams denied entry: ${outcome.reason}`);
      }
      if (outcome.status === 'timeout') {
        throw new Error(
          'Timed out waiting to be let into the meeting (organizer may not have admitted the bot from the lobby).',
        );
      }

      const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
      const filePath = path.join(RECORDINGS_DIR, fileName);
      this.recordingFilePath = filePath;
      this.recorder.start(filePath);

      // Start caption capture against the SAME instant the recording started, so caption
      // timestamps line up with the audio (and with a Whisper transcript of it).
      const recordingStartEpoch = Date.now();
      this.captionsActive = false;
      if (this.page) {
        try {
          await this.captions.start(this.page, recordingStartEpoch);
          this.captionsActive = true;
        } catch (err) {
          console.warn('[bot] caption tracker failed to start (recording continues):', err);
        }
      }

      this.state = 'in_meeting';
      this.status = {
        state: 'in_meeting',
        meetingUrl: req.meetingUrl,
        displayName,
        recordingFile: fileName,
        joinedAt: new Date().toISOString(),
      };

      this.startEndOfMeetingWatcher();

      return this.getStatus();
    } catch (err) {
      const message = (err as Error).message;
      console.error('[bot] join failed:', message);
      this.status = { ...this.status, state: 'error', lastError: message };
      this.state = 'error';
      await this.cleanupBrowser();
      throw err;
    }
  }

  public async leave(): Promise<BotStatus> {
    if (this.state === 'idle') {
      return this.getStatus();
    }

    this.state = 'leaving';
    this.stopEndOfMeetingWatcher();

    // Finalize the captions transcript while the page is still alive (the speaker names live in
    // the page DOM - once we close the browser they're gone).
    await this.finalizeTranscript().catch((err) =>
      console.warn('[bot] error writing transcript (continuing anyway):', err),
    );

    if (this.page) {
      await leaveTeamsMeeting(this.page).catch((err) =>
        console.warn('[bot] error while clicking Leave (continuing anyway):', err),
      );
    }

    await this.recorder.stop();
    await this.cleanupBrowser();

    this.recordingFilePath = null;
    this.state = 'idle';
    this.status = { state: 'idle' };
    return this.getStatus();
  }

  /**
   * Pulls the captured caption lines (with real speaker names) and writes two sidecar files next
   * to the recording: a machine-readable `.captions.json` (used by the transcription/merge script)
   * and a human-readable `.transcript.txt`.
   */
  private async finalizeTranscript(): Promise<void> {
    if (!this.captionsActive || !this.recordingFilePath) return;

    const entries = await this.captions.stop();
    const participants = this.page ? await this.captions.getParticipants(this.page) : [];
    this.captionsActive = false;

    const base = this.recordingFilePath.replace(/\.wav$/i, '');
    const jsonPath = `${base}.captions.json`;
    const txtPath = `${base}.transcript.txt`;

    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ recordingFile: path.basename(this.recordingFilePath), participants, captions: entries }, null, 2),
    );
    fs.writeFileSync(txtPath, this.formatTranscript(entries, participants));

    console.log(
      `[bot] Wrote transcript: ${entries.length} caption line(s) from ${participants.length} known participant(s) -> ${path.basename(txtPath)}`,
    );
    if (entries.length === 0) {
      console.warn(
        '[bot] No captions were captured. Live captions may not have turned on - watch the next ' +
          'run over VNC, or enable captions manually.',
      );
    }
  }

  private formatTranscript(entries: CaptionEntry[], participants: string[]): string {
    const fmt = (ms: number): string => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const m = String(Math.floor(total / 60)).padStart(2, '0');
      const s = String(total % 60).padStart(2, '0');
      return `${m}:${s}`;
    };

    let out = '--- Meeting Transcript (Teams live captions) ---\n\n';
    out +=
      entries.length > 0
        ? entries.map((e) => `[${fmt(e.tStartMs)}] ${e.speaker}: ${e.text}`).join('\n')
        : 'No captions were captured.';
    out += '\n\n--- Participants ---\n\n';
    out += participants.length > 0 ? participants.join('\n') : 'Not captured.';
    out += '\n';
    return out;
  }

  private async cleanupBrowser(): Promise<void> {
    try {
      await this.context?.close();
    } catch (err) {
      console.warn('[bot] error closing browser context:', err);
    }
    this.context = null;
    this.page = null;
  }

  /** Auto-stops the recording if the meeting ends without anyone calling /leave. */
  private startEndOfMeetingWatcher(): void {
    this.pollHandle = setInterval(async () => {
      if (!this.page || this.state !== 'in_meeting') return;
      const ended = await hasMeetingEnded(this.page);
      if (ended) {
        console.log('[bot] Detected the meeting has ended - auto-stopping recording');
        this.stopEndOfMeetingWatcher();
        await this.leave().catch((err) => console.error('[bot] error during auto-leave:', err));
      }
    }, 10_000);
  }

  private stopEndOfMeetingWatcher(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }
}
