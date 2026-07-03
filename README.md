# Teams Guest Bot

Joins a Microsoft Teams meeting the same way a human guest would — by opening the meeting
link in a real browser, typing a display name, and clicking "Join now" — and records whatever
audio plays through that browser to a `.wav` file. This is the same general approach used by
most commercial "notetaker" bots (Otter, Fireflies, Read.ai, etc.) and several open-source
projects, rather than Microsoft's official Graph Calling SDK.

## Repository branches

| Branch | Contents | Approx. clone size |
|---|---|---|
| **`main`** (default) | Core app + `transcribe/` scripts (install deps via pip) | ~110 KB |
| **`with-whisper`** | Same + pre-vendored offline wheels in `transcribe/vendor/` | ~90 MB |

**Clone core app (live captions; optional Whisper via pip):**

```bash
git clone https://github.com/xsaadahmed/teams-guest-bot
```

Or explicitly:

```bash
git clone -b main https://github.com/xsaadahmed/teams-guest-bot
```

**Clone with pre-vendored offline faster-whisper wheels** (for networks that block PyPI):

```bash
git clone -b with-whisper https://github.com/xsaadahmed/teams-guest-bot
```

## How this differs from the Graph Calling SDK approach

| | Graph Calling SDK (Approach A) | This (guest browser join) |
|---|---|---|
| Needs Azure AD app + admin-consented permissions? | Yes | No |
| Needs a Windows VM with public IP/cert/DNS? | Yes | No — runs anywhere Docker runs |
| Subject to the Media Access API's "no persisting media" restriction? | Yes | No — it's not using that API at all |
| How it joins | Authenticated as a registered bot via Graph | As an anonymous/guest participant, like any visitor |
| Robustness | Stable (official API) | Depends on Teams' web UI not changing |
| Visible to other participants | As whatever name you registered | As a guest in the participant list with the display name you gave it |

The tradeoff: this is browser automation against Teams' actual web client, not an official API.
**Microsoft can change the join screen's HTML/button text at any time and break this** — every
selector and click target in this project was pulled from currently-working, actively-maintained
open-source Teams bots as of June 2026, not guessed from memory, but "currently working" is the
operative phrase. If Teams changes its UI, the join flow in `src/teamsJoin.ts` is exactly where
you'd go to fix it.

**One thing this doesn't dodge**: joining and recording a meeting still has consent and
recording-law implications, regardless of which technical approach gets you the audio. The bot
shows up by name in the participant list (more visible than nothing, less visible than Teams'
own "Recording started" banner), and it doesn't display a record indicator to other attendees.
Worth squaring with whoever else is in the meeting and with your jurisdiction's recording laws
before relying on this for anything beyond your own testing.

## How it actually gets the audio

There's no special "audio API" being used here — it's the same trick most of these bots use:

1. A real (visible, not headless) Chromium browser runs inside the container against a virtual
   X11 display (Xvfb), because Teams' WebRTC join flow is unreliable in Chromium's native
   headless mode.
2. The container's default audio output is a **PulseAudio virtual sink** (`virtual_speaker`) —
   not real speakers, just an in-memory audio device.
3. When Chromium plays the other meeting participants' audio (which it does automatically once
   joined, the same way it would on your own laptop), that audio goes into the virtual sink.
4. `ffmpeg` records from that sink's **monitor source** (`virtual_speaker.monitor`, which is
   PulseAudio's term for "whatever's playing through this sink, as a recordable input") straight
   to a 16kHz/16-bit/mono `.wav` file.

I tested this exact pipeline (Xvfb + PulseAudio null sink + `ffmpeg -f pulse -i
virtual_speaker.monitor`) live before writing this README: played a synthetic tone into the sink
and confirmed `ffmpeg` recorded a valid, non-silent WAV file from it. The join-flow code
(`src/teamsJoin.ts`) is grounded in real, currently-maintained open-source Teams bots' selectors,
but I could not test an actual live Teams join end-to-end in my sandbox — it has no route to
Playwright's browser-download CDN and obviously no real meeting to join. Please treat the first
real run as a test, ideally watched over VNC (see below).

## Project layout

```
src/
  server.ts         HTTP API: POST /join, POST /leave, GET /status, GET /recordings(/:file)
  bot.ts             TeamsGuestBot - owns the browser/recording lifecycle, one meeting at a time
  browserLaunch.ts   Chromium launch flags (PulseAudio routing, autoplay, WebRTC tuning)
  teamsUrl.ts        Rewrites a normal Teams join link into the direct-to-browser-lobby format
  teamsJoin.ts       The actual click-through join flow + in-meeting/denied detection
  audioRecorder.ts   ffmpeg wrapper - starts/stops the PulseAudio capture, verified above
Dockerfile           mcr.microsoft.com/playwright base (ships a tested Chromium) + Xvfb/Pulse/ffmpeg
start.sh             container entrypoint: brings up Xvfb, PulseAudio, the virtual sink, then the bot
docker-compose.yml    convenience wrapper (also exposes a VNC port for watching the bot join)
```

## Running it

```bash
docker compose up --build
```

That starts the API on `http://localhost:3000` and a VNC server on port `5900` — connect with
any VNC client (password `debug`) to **watch the bot join the meeting live**, which is the
fastest way to tell whether a selector broke vs. something else going wrong.

### Quick reference (Windows / PowerShell)

These are the exact commands that work on Windows PowerShell. Run them from this project folder.

**Start / rebuild the bot:**

```powershell
docker compose down
docker compose up --build
```

**Join a meeting** (replace the URL with your own; `displayName` is what others see):

```powershell
Invoke-RestMethod -Uri http://localhost:3000/join -Method POST -ContentType "application/json" -Body '{"meetingUrl": "https://teams.live.com/meet/XXXXXXXXXX?p=XXXXXX", "displayName": "Meeting Recorder"}'
```

**Check status** (`idle` / `joining` / `in_meeting` / `error`):

```powershell
Invoke-RestMethod http://localhost:3000/status
```

**Leave / stop recording:**

```powershell
Invoke-RestMethod -Uri http://localhost:3000/leave -Method POST
```

**Where the recording goes:** the `.wav` is written straight into the `Recordings\` folder in
this project (it's bind-mounted into the container), so it appears on your PC automatically once
the bot leaves — no download step needed. Do **not** use `curl -o` to save into `Recordings\`;
because that folder is the same one the container writes to, it can overwrite a recording.

---

The original cross-platform (bash/curl) instructions follow.

**Join a meeting:**

```bash
curl -X POST http://localhost:3000/join \
  -H "Content-Type: application/json" \
  -d '{"meetingUrl": "https://teams.microsoft.com/l/meetup-join/...", "displayName": "Meeting Recorder"}'
```

`displayName` is optional (defaults to "Meeting Recorder"). The response comes back once the
join attempt starts; poll status to see when it actually succeeds:

```bash
curl http://localhost:3000/status
```

States: `idle` → `joining` → `in_meeting` (recording) → `idle` again after `/leave`, or `error`
if the join failed (the `lastError` field will say why — denied, login required, lobby timeout,
etc).

**Leave / stop recording:**

```bash
curl -X POST http://localhost:3000/leave
```

The bot also auto-detects when the meeting itself ends (organizer ends it, bot gets removed) and
stops recording on its own — `/leave` isn't strictly required, just the explicit way to end it.

**Get the audio:**

```bash
curl http://localhost:3000/recordings
curl -O http://localhost:3000/recordings/<fileName>.wav
```

## Speaker-attributed transcripts (real names)

The bot doesn't just record audio — it also captures **Teams' own live closed captions**, which is
the only reliable way to get **real speaker names** ("Jane Doe said…", not "Speaker 1 said…").
There is no public Teams/Graph API for active-speaker-by-name, and pure acoustic diarization only
produces anonymous labels, so we read Teams' caption DOM instead (see `src/captionTracker.ts`).

**What happens automatically:** when the bot joins, it turns on live captions and watches the
caption stream. Each line carries the speaker's real name (`[data-tid="author"]`) and text. When
the meeting ends (or you call `/leave`), it writes two files next to the `.wav` in `Recordings\`:

- `<name>.transcript.txt` — readable, e.g. `[00:12] Jane Doe: Let's get started.`
- `<name>.captions.json` — the structured speaker timeline (names + timestamps)

That `.transcript.txt` already gives you a named transcript with **zero extra steps**. Its text is
Teams' caption quality (good, occasionally paraphrased).

### Optional: verbatim Whisper text + real names

> **Note:** `main` includes the `transcribe/` scripts — install deps with pip (see below). If PyPI
> is blocked on your network, use the **`with-whisper`** branch instead; it ships pre-downloaded
> wheels in `transcribe/vendor/` for offline `pip install --no-index`.

If you want higher-fidelity, verbatim text while keeping the real names, run the merge script. It
transcribes the `.wav` with faster-whisper and labels each segment with the speaker from the
caption timeline (matched by timestamp overlap, since recording and captions share the same t=0).

faster-whisper runs in its **own isolated virtual environment** (`transcribe/.venv`) so it never
disturbs your system/Anaconda Python — earlier it upgraded `protobuf` in the base env and broke
other tools, so it's deliberately sandboxed now.

**One-time setup:**

```powershell
cd transcribe
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

**Every run** (use the wrapper — it calls the venv's Python for you):

```powershell
cd transcribe
.\transcribe.ps1 ..\Recordings\<name>.wav
```

This writes `<name>.named_transcript.txt` (verbatim text, real names) next to the recording. The
default model is `small`. For better **English** accuracy at the same cost use `--model small.en`;
for higher accuracy use a bigger model, e.g. `.\transcribe.ps1 ..\Recordings\<name>.wav --model large-v3-turbo`,
or `--device cuda --compute-type float16` if you have an NVIDIA GPU.

> The OpenMP workaround (`KMP_DUPLICATE_LIB_OK`) needed on Anaconda is baked into the script, so
> no manual environment setup is required.

**If a transcript comes back empty:** live captions didn't turn on. Watch a run over VNC — the
captions menu item occasionally moves between Teams versions; `enableCaptions()` in
`src/captionTracker.ts` is the one place to adjust.

## Complete command reference (first-time setup → transcription)

All commands below are for **Windows PowerShell**. Run them from the project folder unless noted
otherwise:

`C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot`

(Adjust the path if you copied the project somewhere else, e.g. your Documents backup.)

### Prerequisites (install once on your PC)

1. **Docker Desktop** — download and install from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/). After install, open Docker Desktop and wait until it says it is running.
2. **Python 3** — only needed if you want the optional faster-whisper step. You likely already have it if you use Anaconda; otherwise install from [python.org](https://www.python.org/downloads/).

### First-time setup (bot)

Open PowerShell, go to the project folder, then build and start the bot:

```powershell
cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot
docker compose up --build
```

Leave this window open while the bot is running. When you see `teams-guest-bot listening on :3000`,
the bot is ready.

**Open a second PowerShell window** for the join/leave commands below (keep the first window running).

### First-time setup (optional faster-whisper transcription)

Do this once. It creates an isolated Python environment so transcription does not interfere with
other tools on your PC:

```powershell
cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot\transcribe
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The first transcription run also downloads the Whisper model (~480 MB for `small`, ~1.6 GB for
`large-v3-turbo`). That happens automatically — no account needed.

### Start the bot (each day / after a reboot)

If Docker was stopped or your PC restarted:

```powershell
cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot
docker compose up --build
```

If the bot was already built and you just want to start it without rebuilding:

```powershell
cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot
docker compose up
```

### Add the bot to a meeting (join)

Replace the meeting URL with yours. The bot appears as **Meeting Recorder** (or whatever name you
set in `displayName`):

```powershell
Invoke-RestMethod -Uri http://localhost:3000/join -Method POST -ContentType "application/json" -Body '{"meetingUrl": "https://teams.live.com/meet/XXXXXXXXXX?p=XXXXXX", "displayName": "Meeting Recorder"}'
```

**Work / enterprise links:** if your link contains something like
`teams.microsoft.com.rproxy.goskope.com`, remove the `.rproxy.goskope.com` part before sending it
to the bot. Example:

- ❌ `https://teams.microsoft.com.rproxy.goskope.com/meet/...`
- ✅ `https://teams.microsoft.com/meet/...`

**Check whether the bot is in the meeting:**

```powershell
Invoke-RestMethod http://localhost:3000/status
```

Look for `state: in_meeting` — that means it is recording. If it is stuck on `joining`, someone
may need to admit **Meeting Recorder** from the Teams lobby.

### Remove the bot from a meeting (leave / stop recording)

```powershell
Invoke-RestMethod -Uri http://localhost:3000/leave -Method POST
```

After leaving, check `state: idle`. Files appear automatically in the `Recordings\` folder next to
this project:

| File | What it is |
|---|---|
| `<timestamp>.wav` | Meeting audio |
| `<timestamp>.transcript.txt` | Named transcript from Teams live captions (automatic) |
| `<timestamp>.captions.json` | Speaker timeline (used by faster-whisper for names) |

### Transcribe with faster-whisper (optional, higher accuracy)

Run this **after** the meeting, using the `.wav` file from `Recordings\`. Default model is
`small`:

```powershell
cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot\transcribe
.\transcribe.ps1 ..\Recordings\<timestamp>.wav
```

Example (use your actual filename):

```powershell
.\transcribe.ps1 ..\Recordings\2026-06-23T12-06-22-062Z.wav
```

Output: `Recordings\<timestamp>.named_transcript.txt` — verbatim Whisper text with real speaker
names from the caption timeline.

For **better accuracy** (slower, larger download on first run):

```powershell
.\transcribe.ps1 ..\Recordings\2026-06-23T12-06-22-062Z.wav --model large-v3-turbo
```

### Stop the bot when you are done for the day

In the PowerShell window where `docker compose up` is running, press **Ctrl+C**, then:

```powershell
docker compose down
```

### Watch the bot join live (optional debugging)

Connect a VNC viewer to `localhost:5900` (password: `debug`) to see the browser the bot uses.

---

## Things likely to need tuning on a real run

- **Lobby/waiting room**: if the organizer has "people from outside the org wait in the lobby"
  enabled (common default), someone needs to actually admit the guest from Teams' lobby UI
  within the join timeout (5 minutes by default — change `maxWaitMs` in `bot.ts` if you need
  longer). Watch this happen over VNC the first time.
- **Guest access may simply be disabled** for some tenants/meetings, in which case this approach
  doesn't work at all regardless of code — that's a Teams admin policy, not something to debug
  in this project.
- **UI drift**: if `/join` keeps timing out, connect over VNC and watch where the bot gets stuck
  — almost always it's sitting on a pre-join screen because a button's exact text changed.
  `src/teamsJoin.ts` has every selector in one place.
- **Single meeting at a time** by design, to keep this readable. Running more than one
  concurrently means one container (one Xvfb/Pulse pair) per meeting — straightforward to add
  if/when you need it.

## Next steps

- Run the merge script automatically when a recording finalizes (instead of manually).
- Add basic auth to the HTTP API before exposing it beyond localhost.
- Multi-meeting support (one container per active meeting, behind a small dispatcher).

---

## Step-by-step guide (for non-technical users)

This section explains the same workflow in plain language. You will mostly copy-paste commands into
**PowerShell** (Windows' command window). If a step says "open a second PowerShell window", do that
— one window runs the bot, the other sends it instructions.

### What you need before you start

1. **Docker Desktop** installed and running (whale icon in the system tray, not red).
2. The **teams-guest-bot** project folder on your computer.
3. A **Teams meeting link** (from your calendar invite or "Share" in the meeting).
4. **Python** — only if you want the optional higher-quality transcription step later.

### Part 1 — Set up the bot (first time only)

1. Open **PowerShell**.
2. Go to the project folder (change the path if yours is different):
   ```powershell
   cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot
   ```
3. Start the bot:
   ```powershell
   docker compose up --build
   ```
4. Wait until you see **`teams-guest-bot listening on :3000`**. The first time can take several
   minutes while Docker downloads things.
5. **Leave this window open.** Minimize it if you like, but do not close it while using the bot.

### Part 2 — Set up transcription (first time only, optional)

Skip this part if Teams' automatic `.transcript.txt` is good enough for you.

1. Open a **new** PowerShell window.
2. Run these three commands once:
   ```powershell
   cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot\transcribe
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```
3. Done — you never need to repeat this unless you delete the `transcribe\.venv` folder.

### Part 3 — Start the bot (every time you use it)

If you already did Part 1 today and the bot is still running, skip to Part 4.

1. Open Docker Desktop and make sure it is running.
2. Open PowerShell and run:
   ```powershell
   cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot
   docker compose up --build
   ```
3. Wait for **`listening on :3000`**, then open a **second** PowerShell window for the next steps.

### Part 4 — Add the bot to your meeting

1. Copy your Teams meeting link.
   - **Personal / free Teams** links look like: `https://teams.live.com/meet/...`
   - **Work Teams** links look like: `https://teams.microsoft.com/meet/...`
   - If the link has **`goskope`** or **`rproxy`** in it, use the normal Teams link instead (ask IT
     or copy the link from the calendar invite without the proxy part).
2. In your **second** PowerShell window:
   ```powershell
   cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot
   ```
3. Paste and run (replace the URL with yours):
   ```powershell
   Invoke-RestMethod -Uri http://localhost:3000/join -Method POST -ContentType "application/json" -Body '{"meetingUrl": "PASTE_YOUR_LINK_HERE", "displayName": "Meeting Recorder"}'
   ```
4. In Teams, look for **Meeting Recorder** in the participant list.
5. If your org uses a **lobby**, admit **Meeting Recorder** like any other guest.
6. To confirm it is recording:
   ```powershell
   Invoke-RestMethod http://localhost:3000/status
   ```
   You want **`in_meeting`**.

### Part 5 — Remove the bot from the meeting

When the meeting is over (or you want to stop recording):

```powershell
Invoke-RestMethod -Uri http://localhost:3000/leave -Method POST
```

Check status again — it should say **`idle`**.

### Part 6 — Find your files

Open the **`Recordings`** folder inside the project folder. You will see:

- **`.wav`** — the audio recording
- **`.transcript.txt`** — transcript with **real names** (created automatically when the bot leaves)
- **`.captions.json`** — technical file used for better transcription (you can ignore it)

Example path:

`C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot\Recordings`

Open the `.transcript.txt` file in Notepad to read the meeting.

### Part 7 — Better transcription with faster-whisper (optional)

Use this when you want **more accurate wording** than Teams captions provide. Run this **after**
the meeting, in PowerShell:

```powershell
cd C:\Users\xsaad\Downloads\teams-guest-bot\teams-guest-bot\transcribe
.\transcribe.ps1 ..\Recordings\YOUR-FILE-NAME.wav
```

Replace `YOUR-FILE-NAME.wav` with the actual `.wav` from `Recordings\` (e.g.
`2026-06-23T12-06-22-062Z.wav`).

When it finishes, open **`YOUR-FILE-NAME.named_transcript.txt`** in the same `Recordings` folder.
That is your final transcript with real speaker names and Whisper-quality text.

For even better accuracy (takes longer on a laptop):

```powershell
.\transcribe.ps1 ..\Recordings\YOUR-FILE-NAME.wav --model large-v3-turbo
```

### Part 8 — Shut down when you are done

1. In the PowerShell window running Docker, press **Ctrl+C**.
2. Then run:
   ```powershell
   docker compose down
   ```
3. You can close Docker Desktop if you are not using it for anything else.

### Quick troubleshooting

| Problem | What to try |
|---|---|
| Bot never appears in Teams | Admit it from the lobby; make sure the meeting link is correct |
| No `.transcript.txt` or it says "No captions were captured" | Captions may not have turned on — try again; work Teams may use different UI |
| `docker compose` not found | Make sure Docker Desktop is running; run commands from the project folder |
| Transcription command fails | Run Part 2 (one-time transcribe setup) first |
| Recording folder empty | Call `/leave` before checking; wait a few seconds after leaving |
