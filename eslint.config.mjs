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
      // Her release kapısı canlı `.next`'i ezmemek için KENDİ distDir'ine derliyor
      // (real-clone-gate, stage10-perf, restore-drill, …). Bu satır tek tek adlar yerine
      // sınıfın tamamını kapsıyor — çünkü liste iki kez ardından güncellenmeyi unuttu ve
      // her seferinde `pnpm lint` derlenmiş Next çıktısında binlerce hata sayıp kırmızıya
      // düştü. Yeni bir kapı yeni bir distDir açtığında burada değişiklik gerekmez.
      ".next-*/**",
      "out/**",
      "build/**",
      // AŞAMA 11 / B6: eski bir commit'in `git archive` ile çıkarılmış ağacı. Kod/şema
      // eşleşmesi provası için VAR OLMASI gerekir ama bugünkü lint kurallarıyla denetlenmez —
      // amacı zaten "eski kod böyleydi"yi göstermek.
      ".stage11-oldcode/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
