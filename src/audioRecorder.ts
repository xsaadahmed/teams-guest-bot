import { spawn, execSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Records whatever audio is playing through the PulseAudio "virtual_speaker" sink (i.e.
 * whatever the browser is currently outputting - the meeting audio, once joined) to a WAV
 * file on disk. This exact ffmpeg-from-a-pulse-monitor-source approach was tested live:
 * a synthetic tone played into the sink came out the other end as a real, non-silent
 * 16kHz/16-bit/mono WAV file.
 */
export class AudioRecorder {
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private readonly monitorSource: string;

  constructor(monitorSource = 'virtual_speaker.monitor') {
    this.monitorSource = monitorSource;
  }

  public start(filePath: string): void {
    if (this.ffmpeg) {
      throw new Error('AudioRecorder is already recording.');
    }

    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    this.ensureMonitorSource();

    const args = [
      '-f', 'pulse',
      '-i', this.monitorSource,
      '-vn',
      '-sample_fmt', 's16',
      '-ac', '1',
      '-ar', '16000',
      '-y',
      '-loglevel', 'warning',
      filePath,
    ];

    console.log(`[audioRecorder] Starting: ffmpeg ${args.join(' ')}`);
    // Default stdio (all pipes) so this infers as ChildProcessWithoutNullStreams - we just
    // never write to .stdin.
    this.ffmpeg = spawn('ffmpeg', args);

    this.ffmpeg.stderr.on('data', (chunk: Buffer) => {
      // ffmpeg writes its normal progress/status output to stderr - only surface it if
      // something looks like an actual problem, to avoid flooding the logs.
      const text = chunk.toString();
      if (/error|fail/i.test(text)) {
        console.warn('[audioRecorder][ffmpeg]', text.trim());
      }
    });

    this.ffmpeg.on('exit', (code, signal) => {
      console.log(`[audioRecorder] ffmpeg exited (code=${code}, signal=${signal})`);
      this.ffmpeg = null;
    });
  }

  /** Stops the recording gracefully so ffmpeg finalizes a valid WAV header. */
  public async stop(): Promise<void> {
    const proc = this.ffmpeg;
    if (!proc) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('[audioRecorder] ffmpeg did not exit after SIGINT, forcing SIGKILL');
        proc.kill('SIGKILL');
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill('SIGINT'); // ffmpeg treats SIGINT as "wrap up the file cleanly and quit"
    });
  }

  public get isRecording(): boolean {
    return this.ffmpeg !== null;
  }

  /**
   * Make sure the PulseAudio monitor source actually exists right before we record. If the
   * daemon was restarted (or the sink was never loaded), recreate the null sink so ffmpeg
   * doesn't fail with "No such process". Best-effort: any pactl error is logged, not thrown,
   * so a missing-pactl environment still falls through to ffmpeg's own error handling.
   */
  private ensureMonitorSource(): void {
    const sinkName = this.monitorSource.replace(/\.monitor$/, '');
    try {
      const sources = execSync('pactl list sources short', { encoding: 'utf8' });
      if (sources.includes(this.monitorSource)) {
        return;
      }
      console.warn(
        `[audioRecorder] ${this.monitorSource} missing - recreating null sink "${sinkName}".`,
      );
      execSync(
        `pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=Virtual_Speaker`,
      );
      execSync(`pactl set-default-sink ${sinkName}`);
    } catch (err) {
      console.warn('[audioRecorder] Could not verify/recreate the monitor source:', err);
    }
  }
}
