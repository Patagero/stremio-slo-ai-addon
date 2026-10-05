#!/usr/bin/env python3
"""
Lokalni Whisper Engine za Stremio Slo AI Addon.
Izvleče zvočni tok z FFmpeg in izvede hitro transkripcijo s faster-whisper.
"""

import sys
import os
import json
import argparse
import subprocess
import shutil

def find_ffmpeg():
    # Preveri sistemski PATH
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    # Preveri znano Gyan.FFmpeg pot na Windows
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        winget_path = os.path.join(
            local_app_data,
            "Microsoft", "WinGet", "Packages"
        )
        if os.path.exists(winget_path):
            for root, dirs, files in os.walk(winget_path):
                if "ffmpeg.exe" in files:
                    return os.path.join(root, "ffmpeg.exe")
    return "ffmpeg"

def extract_and_transcribe(stream_url, start_sec=0, duration_sec=120, model_size="small", cpu_threads=4):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({"error": "faster-whisper is not installed in Python environment"}))
        return

    ffmpeg_bin = find_ffmpeg()
    
    # FFmpeg ukaz za zajem 16kHz mono WAV avdia neposredno v pomnilnik
    cmd = [
        ffmpeg_bin,
        "-reconnect", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "2",
        "-ss", str(start_sec),
        "-t", str(duration_sec),
        "-probesize", "64k",
        "-analyzeduration", "500000",
        "-fflags", "nobuffer+fastseek+discardcorrupt",
        "-flags", "low_delay",
        "-nostdin",
        "-i", stream_url,
        "-vn", "-sn", "-dn",
        "-ac", "1",
        "-ar", "16000",
        "-af", "aresample=async=1000:first_pts=0,dynaudnorm=p=0.95:m=12.0:r=0.9,highpass=f=100,lowpass=f=7500",
        "-c:a", "pcm_s16le",
        "-f", "wav",
        "pipe:1"
    ]

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        audio_data, err = proc.communicate(timeout=60)
    except Exception as e:
        print(json.dumps({"error": f"FFmpeg extraction failed: {str(e)}"}))
        return

    if not audio_data or len(audio_data) < 1000:
        print(json.dumps({"error": "FFmpeg extracted empty audio stream", "ffmpeg_err": err.decode('utf-8', errors='ignore')[:300]}))
        return

    # Začasno shranimo audio v scratch/temp
    temp_dir = os.environ.get("TEMP", os.environ.get("TMP", "."))
    temp_wav = os.path.join(temp_dir, f"stremio_chunk_{os.getpid()}_{int(start_sec)}.wav")
    try:
        with open(temp_wav, "wb") as f:
            f.write(audio_data)

        compute_type = "int8"
        model = WhisperModel(model_size, device="cpu", compute_type=compute_type, cpu_threads=cpu_threads)
        
        segments, info = model.transcribe(
            temp_wav,
            language="en",
            task="transcribe",
            beam_size=1,
            vad_filter=True,
            vad_parameters=dict(threshold=0.18, min_speech_duration_ms=60, speech_pad_ms=300)
        )

        cues = []
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            abs_start = start_sec + segment.start
            abs_end = start_sec + segment.end
            cues.append({
                "start": abs_start,
                "end": abs_end,
                "text": text
            })

        print(json.dumps({"cues": cues, "language": info.language, "duration": duration_sec}))
    except Exception as e:
        print(json.dumps({"error": f"Whisper transcription failed: {str(e)}"}))
    finally:
        if os.path.exists(temp_wav):
            try:
                os.remove(temp_wav)
            except Exception:
                pass

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Video stream URL or file path")
    parser.add_argument("--start", type=float, default=0, help="Start offset in seconds")
    parser.add_argument("--duration", type=float, default=120, help="Duration in seconds")
    parser.add_argument("--model", default="small", help="Whisper model size")
    parser.add_argument("--threads", type=int, default=4, help="CPU threads")
    
    args = parser.parse_args()
    extract_and_transcribe(args.url, args.start, args.duration, args.model, args.threads)
