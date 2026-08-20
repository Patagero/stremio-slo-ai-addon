# Slo AI Subtitle Translator

Separate Stremio addon for English-to-Slovenian subtitle translation.

## Local

```sh
npm install
npm test
GEMINI_API_KEY=... OPENSUBTITLES_API_KEY=... PUBLIC_BASE_URL=http://127.0.0.1:7002 npm start
```

Install in Stremio with `http://127.0.0.1:7002/manifest.json` on the same PC, or the Mini PC LAN URL from another device.

## Render

Create a new Render Web Service from this repository, use the included Dockerfile, and set `PUBLIC_BASE_URL`, `GEMINI_API_KEY`, and `OPENSUBTITLES_API_KEY` as secrets. The manifest is `/manifest.json`.

The service is intentionally separate from the existing SubMaker addon. It validates cue count, IDs and timestamps before returning a translated subtitle.

The current first version retrieves a popular English OpenSubtitles result, enriches the request with Cinemeta metadata, translates with Gemini, validates the SRT, and returns a Slovenian subtitle resource.

For a production Render deployment, replace the placeholder `PUBLIC_BASE_URL` with the actual service URL.

## Important limitation

Stremio subtitle requests often contain only an IMDb ID. This standalone version therefore uses OpenSubtitles as its English source. It does not inspect the player's media stream or perform audio diarization.

## Security

Never commit `.env` or API keys. Configure secrets in Render's environment settings.

## Test

```sh
npm test
```

The tests cover metadata-aware gender instructions, strict SRT validation, and Stremio manifest shape.

