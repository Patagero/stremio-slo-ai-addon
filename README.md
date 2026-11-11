# Slo AI Subtitle Translator (Gemini Flash)

Stremio addon za vrhunske slovenske podnapise s samodejno izbiro vira (Prioriteta: HR -> IT -> EN) ter Whisper zvočnim virom, poganjano z Google Gemini: prevaja cenejši `gemini-3.1-flash-lite`, like in njihov spol pa enkrat na film določi močnejši `gemini-3.6-flash` (če model pri Googlu ni na voljo, se samodejno uporabi naslednji).

## Glavne funkcionalnosti

1. **Avtomatska izbira vira podnapisov (Prioriteta)**:
   - Sistem samodejno pregleda razpoložljive podnapise na internetu po prioriteti:
     1. **Hrvaški** (`hr` / `srp` / `hrv` / `bos`)
     2. **Italijanski** (`it` / `ita`)
     3. **Angleški** (`en` / `eng`)
   - V Stremio in konzolo takoj izpiše izbran jezik in točno datoteko (npr. `[Subtitles] Izbran jezik za prevod: HRVAŠČINA (film.hr.srt)`).

2. **Natančno čiščenje SDH (Subtitles for the Deaf and Hard of Hearing)**:
   - Samodejno odstrani opise zvokov (`[Music]`, `[Laughs]`, `*gasp*`, `(laughter)`, `♪...♪`) in oznake govorcev (`JOHN:`).
   - Ohrani izključno čisto besedilo dialogov ter nedotaknjeno SRT strukturo (številke in časovne žige).

3. **Vrhunski prevod z Gemini Flash**:
   - **Spolno ujemanje (ona/on)**: spol se določa iz več virov — TMDB zasedba (lik -> spol igralca, pri serijah tudi gostujoči igralci epizode), SDH oznake govorcev v izvirniku (`JOHN:`), slovnične končnice hrvaškega/italijanskega izvirnika (*rekla sam*), AI analiza likov celotnega dialoga (imena, vzdevki, zaimki, sorodstvo) in kontekst prejšnjih podnapisov. Model za vsak podnapis najprej določi spol govorca in nagovorjenega, šele nato prevede (*rekla sem* / *rekel sem*, *Kje si bila?* / *Kje si bil?*).
   - **Omejitev vrstic**: Vsak podnapis (cue) je razdeljen na **največ 2 kratki vrstici** (do 42 znakov), prilagojeni za udobno branje na zaslonu (17 CPS).
   - **Naraven pogovorni jezik**: Tekoča, idiomatska slovenščina brez dobesednih prevodov.
   - **Tehnična integriteta**: Točno ohranjeni časovni žigi in številke podnapisov.

4. **Shranjevanje rezultata**:
   - Prevedeni slovenski podnapisi se trajno shranijo v `.sl.srt` datoteke na disk v predpomnilnik (`CACHE_DIR`).

## Lokalni zagon

Za zagon na Windows računalniku preprosto zaženite **`start-local.bat`** ali:

```sh
npm install
npm test
GEMINI_API_KEY=... TMDB_API_KEY=... OPENSUBTITLES_API_KEY=... node index.js
```

Povezava za Stremio:
`http://127.0.0.1:7002/manifest.json`

## Render namestitev

V Renderju nastavite okoljske spremenljivke:
- `GEMINI_API_KEY` (vaš Gemini API ključ)
- `GEMINI_MODEL` (model za prevajanje, privzeto `gemini-3.1-flash-lite`)
- `ANALYSIS_MODEL` (model za analizo likov in spolov, privzeto `gemini-3.6-flash`)
- `TMDB_API_KEY` (brezplačni ključ na themoviedb.org)
- `OPENSUBTITLES_API_KEY` (OpenSubtitles REST API ključ)
- `PUBLIC_BASE_URL` (npr. `https://stremio-slo-ai-addon.onrender.com`)
