import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "/" funkar för eget domännamn samt Netlify/Vercel/Cloudflare Pages.
// Ska appen ligga i en undermapp (t.ex. GitHub Pages: användarnamn.github.io/altanritare/)
// ändra till base: "/altanritare/".
export default defineConfig({
  plugins: [react()],
  base: "/",
});
