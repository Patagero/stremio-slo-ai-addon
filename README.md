# Slo AI Subtitle Translator

Stremio addon that translates English, Croatian or Italian subtitles into natural, gender-correct
Slovenian, using a two-pass Claude (Anthropic) pipeline plus TMDB cast metadata.

## How translation works

1. **Source fetch**: searches OpenSubtitles for the film/episode. Language priority is
   `?sourceLanguage=` (if given) → the title's original TMDB language (en/hr/it) → the remaining
   supported languages. Preferring the original language helps pass 2, since Croatian and Italian
   already mark grammatical gender on verbs.
2. **Pass 1 — character/gender ledger**: Claude reads the full dialogue plus TMDB cast metadata
   (method #5) and returns a structured JSON ledger of every named character with their gender,
   confidence, and supporting evidence (method #4).
3. **Pass 2 — translation**: Claude translates the subtitles using the ledger as the authoritative
   source of truth for on/ona, with an explicit reading-speed budget (characters-per-second) computed
   per cue from its on-screen duration, so lines stay natural-length instead of racing past.
4. **Reading-speed repair pass**: any cue that comes back over its character budget is sent back for
   a targeted shortening pass before the subtitle is served.
5. Every response is validated: cue count, ids and timestamps must exactly match the source before
   the translation is cached and served.

## Local

```sh
npm install
npm test
ANTHROPIC_API_KEY=... TMDB_API_KEY=... OPENSUBTITLES_API_KEY=... PUBLIC_BASE_URL=http://127.0.0.1:7002 npm start
```

Install in Stremio with `http://127.0.0.1:7002/manifest.json` on the same PC, or the Mini PC LAN URL from another device.

## Render

Create a new Render Web Service from this repository, use the included Dockerfile, and set
`PUBLIC_BASE_URL`, `ANTHROPIC_API_KEY`, `TMDB_API_KEY`, and `OPENSUBTITLES_API_KEY` as secrets. The
manifest is `/manifest.json`.

It validates cue count, ids and timestamps before returning a translated subtitle.

For a production Render deployment, replace the placeholder `PUBLIC_BASE_URL` with the actual
service URL.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (required) | — |
| `ANTHROPIC_MODEL` | Claude model id | `claude-sonnet-5` |
| `TMDB_API_KEY` | Cast gender metadata (method #5) | — (falls back to ledger-only) |
| `OPENSUBTITLES_API_KEY` | Source subtitle downloads | — (required) |
| `TARGET_CPS` | Target reading speed, characters/second | `17` |
| `MAX_LINE_CHARS` | Hard cap per subtitle line | `42` |
| `CHUNK_SIZE` | Cues per translation request (currently the whole file goes in one request) | `45` |

## Important limitation

Stremio subtitle requests often contain only an IMDb ID. This addon therefore uses OpenSubtitles as
its EN/HR/IT source and TMDB for cast metadata. It does not inspect the player's media stream or
perform audio diarization — gender is inferred from dialogue text and cast metadata only, so very
minor, unnamed characters with no textual clues can occasionally still be mistranslated.

## Security

Never commit `.env` or API keys. Configure secrets in Render's environment settings.

## Test

```sh
npm test
```

The tests cover the character-gender ledger (pass 1), the reading-speed budget and repair logic,
metadata-aware gender instructions, strict SRT validation, and Stremio manifest shape.
