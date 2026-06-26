# Convenience wrapper: runs the named-transcript step using the ISOLATED virtual environment in
# .venv, so it never touches your Anaconda/base Python (which keeps Streamlit etc. unaffected).
#
# Usage (from the transcribe folder):
#   .\transcribe.ps1 ..\Recordings\<name>.wav
#   .\transcribe.ps1 ..\Recordings\<name>.wav --model small.en
#
# First-time setup (only once):
#   python -m venv .venv
#   .\.venv\Scripts\python.exe -m pip install -r requirements.txt

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $here ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Error "Isolated venv not found at .venv. Create it first:`n  python -m venv .venv`n  .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
    exit 1
}

& $py (Join-Path $here "transcribe_with_names.py") @args
