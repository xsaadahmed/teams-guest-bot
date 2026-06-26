#!/usr/bin/env python3
"""
Produce a verbatim, speaker-attributed transcript by combining:

  1. faster-whisper transcription of the recorded .wav  (high-quality, verbatim text)
  2. the real speaker names + timestamps the bot scraped from Teams' live captions
     (saved next to the .wav as <name>.captions.json)

Whisper gives accurate text but no speaker identity; Teams captions give the real speaker name
for every moment of the meeting. We align them by time overlap, so each Whisper segment is labeled
with the person Teams says was speaking then.

The bot starts the audio recording and the caption capture at the same instant, so both share the
same t=0 - that's what makes this time alignment work.

Usage:
    python transcribe_with_names.py path/to/recording.wav
    python transcribe_with_names.py path/to/recording.wav --model small --device cpu

Outputs (next to the .wav):
    <name>.named_transcript.txt    human-readable, e.g.  [00:12] Jane Doe: Let's get started.
    <name>.named_transcript.json   structured segments with speaker + start/end
"""
import argparse
import json
import os
import sys

# Anaconda ships its own OpenMP runtime (libiomp5md.dll via MKL/numpy) and so does ctranslate2,
# the engine faster-whisper runs on. With both loaded, the process aborts with
# "OMP: Error #15: ... libiomp5md.dll already initialized". Setting this before importing
# faster-whisper tells the loader to tolerate the duplicate. The venv keeps deps isolated, but
# Windows can still resolve a stray OpenMP DLL off PATH, so we set this defensively regardless.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")


def load_speaker_intervals(captions_path):
    """Return a list of (start_s, end_s, speaker) from the bot's captions.json (ms -> seconds)."""
    if not os.path.exists(captions_path):
        return []
    with open(captions_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    intervals = []
    for entry in data.get("captions", []):
        start_s = entry.get("tStartMs", 0) / 1000.0
        end_s = entry.get("tEndMs", start_s * 1000) / 1000.0
        # Teams marks a caption line at a single instant for short utterances; give it a small
        # minimum duration so it can still overlap a Whisper segment.
        if end_s - start_s < 1.5:
            end_s = start_s + 1.5
        intervals.append((start_s, end_s, entry.get("speaker", "Unknown")))
    intervals.sort(key=lambda x: x[0])
    return intervals


def speaker_for_segment(seg_start, seg_end, intervals):
    """Pick the speaker whose caption window overlaps this segment the most."""
    best_speaker = None
    best_overlap = 0.0
    for cs, ce, speaker in intervals:
        overlap = min(seg_end, ce) - max(seg_start, cs)
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = speaker

    if best_speaker is not None:
        return best_speaker

    # No overlap (e.g. Whisper heard speech Teams didn't caption): fall back to whoever was the
    # most recent active speaker at this segment's midpoint.
    mid = (seg_start + seg_end) / 2.0
    candidate = None
    for cs, _ce, speaker in intervals:
        if cs <= mid:
            candidate = speaker
        else:
            break
    return candidate or "Unknown"


def fmt_ts(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def main():
    parser = argparse.ArgumentParser(description="Whisper transcription with real Teams speaker names.")
    parser.add_argument("wav", help="Path to the recording .wav file.")
    parser.add_argument("--model", default="small", help="Whisper model size (tiny/base/small/medium/large-v3).")
    parser.add_argument("--device", default="cpu", help="cpu or cuda.")
    parser.add_argument(
        "--compute-type",
        default="int8",
        help="ctranslate2 compute type (int8 for CPU, float16 for GPU).",
    )
    parser.add_argument("--language", default=None, help="Force a language code (e.g. en); default auto-detect.")
    args = parser.parse_args()

    if not os.path.exists(args.wav):
        sys.exit(f"WAV not found: {args.wav}")

    base = os.path.splitext(args.wav)[0]
    captions_path = base + ".captions.json"
    intervals = load_speaker_intervals(captions_path)
    if not intervals:
        print(
            f"WARNING: no speaker timeline found at {captions_path} - output will be transcribed "
            "but every line will be labeled 'Unknown'. Make sure the bot captured captions for this "
            "meeting.",
            file=sys.stderr,
        )

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper is not installed. Run:  pip install -r requirements.txt")

    print(f"Loading Whisper model '{args.model}' ({args.device}/{args.compute_type})...", file=sys.stderr)
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    print("Transcribing (this can take a while on CPU)...", file=sys.stderr)
    segments, info = model.transcribe(args.wav, vad_filter=True, language=args.language)

    results = []
    lines = []
    for seg in segments:
        speaker = speaker_for_segment(seg.start, seg.end, intervals)
        text = seg.text.strip()
        if not text:
            continue
        results.append({"start": seg.start, "end": seg.end, "speaker": speaker, "text": text})
        lines.append(f"[{fmt_ts(seg.start)}] {speaker}: {text}")

    txt_path = base + ".named_transcript.txt"
    json_path = base + ".named_transcript.json"

    header = f"--- Verbatim transcript (Whisper '{args.model}') with Teams speaker names ---\n"
    header += f"Detected language: {info.language} (p={info.language_probability:.2f})\n\n"
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(lines) + "\n")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"language": info.language, "segments": results}, f, ensure_ascii=False, indent=2)

    print(f"\nDone. Wrote:\n  {txt_path}\n  {json_path}")


if __name__ == "__main__":
    main()
