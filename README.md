# Slo AI Subtitle Translator (Sonnet 5.5 & Whisper)

Stremio addon za visokokakovostne slovenske podnapise iz angleških, hrvaških in italijanskih podnapisov ter Whisper angleškega vira, z uporabo Sonnet 5.5 ter TMDB metapodatkov o igralcih in likih.

## Možnosti izbire v Stremio

V Stremio meniju za podnapise so na voljo 4 možnosti:
1. **Slovenian AI · Prevod iz ANG podnapisov** (Angleščina -> Slovenščina via Sonnet 5.5)
2. **Slovenian AI · Prevod iz HR podnapisov** (Hrvaščina -> Slovenščina via Sonnet 5.5)
3. **Slovenian AI · Prevod iz ITA podnapisov** (Italijanščina -> Slovenščina via Sonnet 5.5)
4. **Slovenian AI · Whisper prevod (ANG)** (Whisper govor/podnapisi -> Slovenščina via Sonnet 5.5)

Vsak prevod se začne šele ob kliku uporabnika (lazy), progresivno servira že prevedene dele ter se shranjuje v predpomnilnik.

## Kako deluje prevajanje

1. **Izbor in prenos vira**: Iskanje izvirnih podnapisov na OpenSubtitles (z natančnim moviehash ujemanjem za popolno sinhronizacijo s predvajanim videom) ali Whisper vir.
2. **Čiščenje SDH**: Odstranitev opisov zvokov za gluhe in naglušne (`[sound]`, `♪`, oznake govorcev).
3. **1. korak — Analiza likov in spolov (Character Ledger)**: Sonnet 5.5 pregleda celoten dialog in TMDB podatke o igralcih ter določi spol za vsakega nastopajočega (za natančne oblike `on/ona`, `rekla/rekel`, `bila/bil`, `dvojina`, `tikanje/vikanje`).
4. **2. korak — Prevajanje po kosih s Sonnet 5.5**: Prevod z upoštevanjem določenega spola in Netflix hitrosti branja (CPS - characters per second).
5. **Korekcija dolžine (Reading Speed)**: Če je vrstica predolga za prikazni čas na zaslonu, jo Sonnet samodejno strne v naravno slovenščino.
6. **Validacija in predpomnjenje**: Strogo preverjanje SRT strukture, časovnih kod in števila vrstic pred serviranjem.

## Lokalni zagon

```sh
npm install
npm test
ANTHROPIC_API_KEY=... TMDB_API_KEY=... OPENSUBTITLES_API_KEY=... PUBLIC_BASE_URL=http://127.0.0.1:7002 npm start
```

V Stremio dodaj: `http://127.0.0.1:7002/manifest.json`

## Render namestitev

V Renderju zaženite Web Service (Docker runtime z `Dockerfile`), ter nastavite okoljske spremenljivke:
- `ANTHROPIC_API_KEY` (ključ za Sonnet 5.5)
- `ANTHROPIC_MODEL` (privzeto `claude-3-5-sonnet-20241022` / `sonnet-5.5`)
- `TMDB_API_KEY` (za igralsko zasedbo in spole)
- `OPENSUBTITLES_API_KEY` (in opcijsko `OPENSUBTITLES_USERNAME`, `OPENSUBTITLES_PASSWORD`)
- `PUBLIC_BASE_URL` (npr. `https://tvoj-addon.onrender.com`)

## Testi

```sh
npm test
```
