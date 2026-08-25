import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-corrupt-*/**",
      ".next-turbopack-incomplete-*/**",
      // Aşama 05-06 gerçek-veri clone kapısının ürettiği build çıktısı. .gitignore'da zaten
      // var ama eslint onu okumuyordu: dizin diskte durduğu sürece `pnpm lint` derlenmiş
      // Next çıktısında 4393 hata sayıp kırmızıya düşüyor. Yukarıdaki iki .next-* satırıyla
      // aynı sınıf.
      ".next-real-clone-gate/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
