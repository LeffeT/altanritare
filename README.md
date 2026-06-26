# Altanritare

Webbaserat ritverktyg för altaner, altantak och bygganmälan.
Byggt med React, Three.js (3D) och SVG (ritningar). Allt körs i webbläsaren.

## Köra lokalt på datorn
Kräver Node.js 18 eller nyare (ladda ner från nodejs.org).

```bash
npm install      # installeras en gång
npm run dev      # startar på http://localhost:5173
```

## Bygga för publicering
```bash
npm run build    # skapar färdiga filer i mappen dist/
npm run preview  # förhandsgranska den byggda versionen lokalt
```

## Lägga upp på webben (gratisalternativ)

### Enklast – dra och släpp (ingen GitHub behövs)
1. Kör `npm run build`.
2. Gå till https://app.netlify.com/drop och dra in mappen `dist`.
   Du får direkt en publik adress.
   (Cloudflare Pages och Vercel har liknande "drag-and-drop".)

### Via GitHub (uppdateras automatiskt vid ändringar)
1. Lägg projektet i ett GitHub-repo.
2. Koppla repot i Vercel, Netlify eller Cloudflare Pages.
   - Build command: `npm run build`
   - Output / publish directory: `dist`

### GitHub Pages
Ligger appen på `användarnamn.github.io/altanritare/` måste du sätta
`base: "/altanritare/"` i `vite.config.js` innan du bygger.

## Prova online utan att installera något
Ladda upp projektet (eller bara `src/App.jsx`) i StackBlitz (stackblitz.com)
eller CodeSandbox – då kör det direkt i webbläsaren och du får en delbar länk.

## Struktur
- `src/App.jsx` – hela appen (en fil)
- `src/main.jsx` – startpunkt som visar appen
- `index.html`, `vite.config.js` – byggkonfiguration

## Köra på mobilen
1. Lägg upp appen på en adress (se ovan, t.ex. Netlify).
2. Öppna adressen i mobilens webbläsare.
3. Lägg till på hemskärmen för att köra den som en app i helskärm:
   - iPhone (Safari): Dela-knappen → "Lägg till på hemskärmen".
   - Android (Chrome): meny (⋮) → "Lägg till på startskärmen" / "Installera app".
Appen är responsiv: på mobil blir inställningarna en utfällbar meny (☰) så att
rit- och 3D-ytan får hela skärmen. I 3D-vyn finns en helskärmsknapp.

OBS: Add to home screen / PWA kräver att sidan körs över https (vilket Netlify,
Vercel och Cloudflare Pages ger automatiskt).
