import css from './SiteSignature.module.css';

/**
 * SiteSignature — the author's imprint, identical on every page (landing, docs, verify).
 * Mirrors the colophon on vissarion's personal site: "Lovecrafted by · [sigil] · name".
 * Both the sigil and the name link out to the personal site.
 */

// TODO(links): confirm the destination — defaulting to the email's domain for now.
const PERSONAL_SITE = 'https://zounarakis.com';

export function SiteSignature() {
  return (
    <div className={css.wrap}>
      <small className={css.sig}>
        <span className={css.lead}>Lovecrafted by</span>
        <span className={css.sep} aria-hidden="true">·</span>
        <a
          className={css.sigilLink}
          href={PERSONAL_SITE}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Vissarion Zounarakis — personal site"
        >
          <picture>
            <source srcSet="/sigil/no-bg-seal-sigil.webp" type="image/webp" />
            <img
              className={css.sigil}
              src="/sigil/no-bg-seal-sigil.png"
              alt=""
              loading="lazy"
              decoding="async"
              width={44}
              height={44}
            />
          </picture>
        </a>
        <span className={css.sep} aria-hidden="true">·</span>
        <a
          className={css.name}
          href={PERSONAL_SITE}
          target="_blank"
          rel="noopener noreferrer"
        >
          Vissarion Zounarakis
        </a>
      </small>
    </div>
  );
}
