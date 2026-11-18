# Bundled fonts

Every font file here is licensed under the SIL Open Font License 1.1; the
license text and the copyright notice of each family are in [OFL.txt](OFL.txt),
which the web build copies to `dist/assets/fonts/` together with the fonts.
The fonts are declared in `apps/web/src/fonts.css` ([style guide](../../../../../docs/dev/styles.md)).
The web build copies every font file here into `dist/assets/fonts/` twice: under its
plain name (a page opened before a rebuild still references it) and under a
content-addressed name such as `inter-normal-<HASH>.woff2`, which is what the
built stylesheet uses. A redeploy that leaves a font's bytes unchanged therefore
keeps the same URL, so a warm launch does not request it again.

Most files are Latin-only subsets, so other scripts fall back to a system
font. JetBrains Mono also ships its Cyrillic as separate files that
`fonts.css` declares with a `unicode-range`, so they load only for Cyrillic
text. They were cut from Version 2.211 of the variable fonts in
[google/fonts `ofl/jetbrainsmono`](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono)
(the same version as the Latin files) with fontTools:

```sh
pyftsubset 'JetBrainsMono[wght].ttf' --flavor=woff2 \
  --unicodes='U+0300-0301,U+0306,U+0308,U+0400-045F,U+0490-0491,U+04AE-04AF,U+04E8-04E9,U+2116' \
  --output-file=jetbrains-mono-cyrillic-normal.woff2
# the same for 'JetBrainsMono-Italic[wght].ttf' -> jetbrains-mono-cyrillic-italic.woff2
```

The range is every Cyrillic code point that version contains; keep the
`unicode-range` in `fonts.css` equal to it.

Its box drawing and block elements (U+2500–259F, all 160 code points) are cut
the same way into `jetbrains-mono-box.woff2`. The italic font draws them
identically, so `fonts.css` declares this one upright file for both styles:

```sh
pyftsubset 'JetBrainsMono[wght].ttf' --flavor=woff2 --unicodes='U+2500-259F' \
  --output-file=jetbrains-mono-box.woff2
```

When adding a font, add its copyright notice (the `name` table copyright
string of the file) to `OFL.txt` and a row here. A font under any other
license needs its own license file next to it.

| Family | Files | Upstream |
| --- | --- | --- |
| Atkinson Hyperlegible Next | `atkinson-italic.woff2`, `atkinson-normal.woff2` | https://github.com/googlefonts/atkinson-hyperlegible-next |
| Cascadia Code | `cascadia-code-italic.woff2`, `cascadia-code-normal.woff2` | https://github.com/microsoft/cascadia-code |
| DM Sans | `dm-sans-italic.woff2`, `dm-sans-normal.woff2` | https://github.com/googlefonts/dm-fonts |
| Figtree | `figtree-italic.woff2`, `figtree-normal.woff2` | https://github.com/erikdkennedy/figtree |
| Fira Code | `fira-code-normal.woff2` | https://github.com/tonsky/FiraCode |
| Geist | `geist-italic.woff2`, `geist-normal.woff2` | https://github.com/vercel/geist-font |
| Geist Mono | `geist-mono-italic.woff2`, `geist-mono-normal.woff2` | https://github.com/vercel/geist-font |
| Inter | `inter-italic.woff2`, `inter-normal.woff2` | https://github.com/rsms/inter |
| JetBrains Mono | `jetbrains-mono-italic.woff2`, `jetbrains-mono-normal.woff2`, `jetbrains-mono-cyrillic-italic.woff2`, `jetbrains-mono-cyrillic-normal.woff2`, `jetbrains-mono-box.woff2` | https://github.com/JetBrains/JetBrainsMono |
| Manrope | `manrope-normal.woff2` | https://github.com/sharanda/manrope |
| Montserrat | `montserrat-italic.woff2`, `montserrat-normal.woff2` | https://github.com/JulietaUla/Montserrat |
| Noto Sans | `noto-sans-italic.woff2`, `noto-sans-normal.woff2` | https://github.com/notofonts/latin-greek-cyrillic |
| Open Sans | `open-sans-italic.woff2`, `open-sans-normal.woff2` | https://github.com/googlefonts/opensans |
| Outfit | `outfit-normal.woff2` | https://github.com/Outfitio/Outfit-Fonts |
| Plus Jakarta Sans | `plus-jakarta-sans-italic.woff2`, `plus-jakarta-sans-normal.woff2` | https://github.com/tokotype/PlusJakartaSans |
| Roboto | `roboto-italic.woff2`, `roboto-normal.woff2` | https://github.com/googlefonts/roboto-classic |
| Source Serif 4 | `source-serif-4-italic.woff2`, `source-serif-4-normal.woff2` | https://github.com/adobe-fonts/source-serif |
